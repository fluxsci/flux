// Identify an academic paper from a PDF's own content, with a "refuse rather than misassign"
// contract: the caller only acts on a `high`-confidence identity. Pure + dependency-injected
// (no I/O, no pdf.js) so it imports cleanly in the browser AND Node and is unit-testable —
// the environment-specific parts (extracting signals from bytes; resolving a DOI / searching a
// title over the network) are supplied by the caller, exactly like runWaterfall's deps.
//
// The pipeline is DOI-first and cross-validated:
//   Tier 1 — a DOI from embedded metadata (publisher-set → authoritative) or from the page text,
//            each RE-RESOLVED. A DOI found in TEXT (page 1 OR references) must ALSO title-match the
//            paper's own first page — a short report can print reference DOIs high on page 1, so
//            character position is NOT trustworthy; only the title cross-check is. A cited paper's
//            DOI (whose resolved title won't match page 1) is thereby rejected.
//   Tier 2 — no trustworthy DOI → a fuzzy title search, accepted only at a strict similarity AND
//            a year/author corroboration.
// Anything below the bar is `unresolved` (quarantined by the caller), never guessed.

/** Signals extracted from a PDF's bytes by the environment-specific `extractPdfSignals`. */
export interface PdfSignals {
  xmpDoi?: string; // XMP prism:doi / dc:identifier("doi:…") / crossmark
  infoDoi?: string; // Info dictionary /doi (or a DOI found in /Subject etc.)
  xmpTitle?: string; // XMP dc:title
  infoTitle?: string; // Info /Title
  titleGuess?: string; // largest-font line near the top of page 1 (font-size heuristic)
  arxivId?: string; // "2401.01234" (bare) if an arXiv id appears on page 1
  page1Text: string;
  tailText: string; // last ~2 pages (where a references-section DOI would live)
  numPages: number;
}

/** Canonical metadata for a resolved DOI (from Crossref/OpenAlex). */
export interface PaperMeta {
  doi: string;
  title: string;
  authors: string[]; // display names or family names, in order
  year?: string;
  container?: string;
}

/** One fuzzy-search hit (OpenAlex/Crossref bibliographic search). */
export interface SearchHit {
  doi?: string;
  title: string;
  authors: string[];
  year?: string;
  score?: number;
}

export interface IdentifyDeps {
  /** DOI → canonical metadata, or null if the DOI DEFINITIVELY does not resolve (404/410).
   *  MUST THROW on transient failures (offline / timeout / 429 / 5xx) — identify() then
   *  returns a `retryable` unresolved result so the caller leaves the PDF in the inbox
   *  instead of quarantining a perfectly good paper because the network blinked. */
  resolveDoi: (doi: string) => Promise<PaperMeta | null>;
  /** Free-text title query → ranked hits (best first). Same contract: throw = transient. */
  searchTitle: (query: string) => Promise<SearchHit[]>;
}

export interface IdDiagnostics {
  candidates: { doi: string; source: DoiSource }[];
  rejected: string[];
  query?: string;
  topHits?: { title: string; doi?: string; sim: number }[];
}

export type IdResult =
  | { status: "identified"; doi: string; meta: PaperMeta; method: string; confidence: "high" }
  | { status: "unresolved"; reason: string; retryable?: boolean; diagnostics: IdDiagnostics };

type DoiSource = "embedded" | "page1" | "refs";

// Tunables (pinned constants so the dry-run over real PDFs can calibrate them).
export const TAU = 0.8; // title-containment floor for a DOI found in text
export const SIM = 0.9; // title-similarity floor for the fuzzy fallback
/** Resolution budget per PDF: only the first N DOI candidates are resolved. A references
 *  section can carry dozens of DOIs — resolving them all hammers Crossref (and the 429s
 *  come back as failures). Candidates are source-ranked (embedded → page1 → refs) before
 *  the cap, so the paper's own DOI is virtually always inside the budget. */
export const MAX_RESOLVES = 4;

// --- DOI + title primitives (pure, exported for tests) ----------------------------

/** Normalize a DOI to bare lowercase form (strips doi:/doi.org prefixes + trailing junk). */
export function normDoi(raw?: string): string | undefined {
  if (!raw) return undefined;
  let d = String(raw)
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
  d = d.replace(/[)\].,;:'"><}]+$/, ""); // strip trailing punctuation glued on from running text
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : undefined;
}

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/gi;

/** Every DOI in `text` with its character offset (first occurrence of each, order preserved). */
export function findDois(text: string): { doi: string; index: number }[] {
  const out: { doi: string; index: number }[] = [];
  const seen = new Set<string>();
  for (const m of String(text || "").matchAll(DOI_RE)) {
    const doi = normDoi(m[0]);
    if (!doi || seen.has(doi)) continue;
    seen.add(doi);
    out.push({ doi, index: m.index ?? 0 });
  }
  return out;
}

// --- signal-extraction helpers (pure; shared by the Node + renderer extractPdfSignals, which
//     differ only in how they open the PDF and hand us pdf.js text items / metadata) ----------

/** Minimal shape of a pdf.js text-content item (both builds expose these fields). */
export interface TextItem {
  str?: string;
  transform?: number[]; // [a, b, c, d, e, f]; font size ≈ hypot(c, d); baseline y = f
  hasEOL?: boolean;
}

/** Join a page's text items into a string, re-inserting line breaks on large Y jumps. */
export function joinTextItems(items: TextItem[]): string {
  let out = "";
  let lastY: number | null = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = it.transform?.[5];
    if (lastY !== null && typeof y === "number" && Math.abs(y - lastY) > 4) out += "\n";
    else if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (typeof y === "number") lastY = y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Largest-font line near the top of a page → a title guess (font-size heuristic). */
export function guessTitleFromItems(items: TextItem[], pageHeight: number): string | undefined {
  const rows = items
    .filter((it) => typeof it.str === "string" && it.str.trim() && Array.isArray(it.transform))
    .map((it) => ({
      str: it.str as string,
      y: (it.transform as number[])[5],
      size: Math.hypot((it.transform as number[])[2] || 0, (it.transform as number[])[3] || 0) || Math.abs((it.transform as number[])[3] || 0),
    }))
    .filter((r) => r.y > pageHeight * 0.45); // upper ~half (PDF y grows upward)
  if (!rows.length) return undefined;
  const maxSize = Math.max(...rows.map((r) => r.size));
  if (!(maxSize > 0)) return undefined;
  const big = rows.filter((r) => r.size >= maxSize * 0.85).sort((a, b) => b.y - a.y);
  const topY = big[0].y;
  const title = big
    .filter((r) => topY - r.y <= maxSize * 3.2) // the top big-font run (title may wrap a line or two)
    .map((r) => r.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length >= 8 ? title : undefined;
}

/** First DOI found among an object's string values (scans a PDF Info dict / XMP map). */
export function firstDoiIn(obj: Record<string, unknown> | null | undefined): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const v of Object.values(obj)) {
    if (typeof v !== "string") continue;
    const d = findDois(v)[0]?.doi;
    if (d) return d;
  }
  return undefined;
}

const STOP = new Set(
  "the a an of and or to in on for with by from as at is are be we our this that these those using used via into over under between within their its effect effects role".split(
    " ",
  ),
);

/** lowercase, strip diacritics + punctuation → space-separated words. */
export function normTitle(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant tokens of a title (drop stopwords + <3-char words). */
export function titleTokens(s: string): Set<string> {
  return new Set(normTitle(s).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)));
}

/** Fraction of `candidate`'s significant tokens that appear anywhere in `hay`. Asymmetric —
 *  used to check a resolved title against the PDF's (much larger) page-1 text. */
export function titleContainment(candidate: string, hay: string): number {
  const c = titleTokens(candidate);
  if (!c.size) return 0;
  const h = titleTokens(hay);
  let hit = 0;
  for (const t of c) if (h.has(t)) hit++;
  return hit / c.size;
}

/** Symmetric Sørensen–Dice over title token sets — for comparing two titles. */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const surnameOf = (name: string): string => (name || "").trim().split(/\s+/).pop() ?? "";
const yearsIn = (text: string): string[] => [...String(text || "").matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => m[0]);
const firstText = (...xs: (string | undefined)[]): string | undefined => xs.find((x) => x && x.trim().length >= 8)?.trim();
const firstLine = (text: string): string | undefined =>
  String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length >= 8);

// --- the pipeline -----------------------------------------------------------------

export async function identify(
  sig: PdfSignals,
  deps: IdentifyDeps,
  opts: { maxResolves?: number } = {},
): Promise<IdResult> {
  const page1 = sig.page1Text || "";
  const rejected: string[] = [];
  const maxResolves = opts.maxResolves ?? MAX_RESOLVES;
  let sawTransient = false; // a dep threw (network) — the verdict below is not definitive

  // 1. Gather DOI candidates, tagged by where they came from.
  const cands: { doi: string; source: DoiSource }[] = [];
  const add = (raw: string | undefined, source: DoiSource) => {
    const d = normDoi(raw);
    if (d && !cands.some((c) => c.doi === d)) cands.push({ doi: d, source });
  };
  add(sig.xmpDoi, "embedded");
  add(sig.infoDoi, "embedded");
  if (sig.arxivId) add(`10.48550/arxiv.${sig.arxivId.replace(/^arxiv:/i, "")}`, "page1");
  for (const m of findDois(page1)) add(m.doi, "page1");
  for (const m of findDois(sig.tailText || "")) add(m.doi, "refs");

  const rank: Record<DoiSource, number> = { embedded: 0, page1: 1, refs: 2 };
  cands.sort((a, b) => rank[a.source] - rank[b.source]);

  // 2. Tier 1 — resolve DOI candidates (capped — see MAX_RESOLVES). Embedded (publisher-set)
  //    DOIs are authoritative; a DOI found in TEXT must also title-match page 1 (position on
  //    the page is NOT a reliable signal — a short report can print reference DOIs high up).
  for (const c of cands.slice(0, maxResolves)) {
    let meta: PaperMeta | null;
    try {
      meta = await deps.resolveDoi(c.doi);
    } catch (e) {
      sawTransient = true;
      rejected.push(`${c.doi} (${c.source}): network error (retryable): ${String((e as Error)?.message || e)}`);
      continue;
    }
    if (!meta) {
      rejected.push(`${c.doi} (${c.source}): did not resolve`);
      continue;
    }
    const contain = titleContainment(meta.title, page1);
    if (c.source === "embedded" || contain >= TAU) {
      return { status: "identified", doi: c.doi, meta, method: `doi:${c.source}`, confidence: "high" };
    }
    rejected.push(`${c.doi} (${c.source}): title match ${contain.toFixed(2)} < ${TAU}`);
  }
  for (const c of cands.slice(maxResolves)) rejected.push(`${c.doi} (${c.source}): not attempted (candidate cap ${maxResolves})`);

  // 3. Tier 2 — no trustworthy DOI: fuzzy title search, strictly gated.
  const query = firstText(sig.xmpTitle, sig.infoTitle, sig.titleGuess, firstLine(page1));
  const topHits: IdDiagnostics["topHits"] = [];
  if (query) {
    let hits: SearchHit[] = [];
    try {
      hits = (await deps.searchTitle(query)).slice(0, 5);
    } catch (e) {
      sawTransient = true;
      rejected.push(`title search: network error (retryable): ${String((e as Error)?.message || e)}`);
    }
    const yrs = yearsIn(page1);
    const p1lower = page1.toLowerCase();
    for (const h of hits) {
      const sim = titleSimilarity(h.title, query);
      topHits.push({ title: h.title, doi: h.doi, sim: +sim.toFixed(3) });
    }
    const h = hits[0];
    if (h && h.doi) {
      const sim = titleSimilarity(h.title, query);
      const yearOk = !!h.year && yrs.includes(h.year);
      const authorOk = h.authors.length > 0 && p1lower.includes(surnameOf(h.authors[0]).toLowerCase());
      if (sim >= SIM && (yearOk || authorOk)) {
        const doi = normDoi(h.doi)!;
        return {
          status: "identified",
          doi,
          meta: { doi, title: h.title, authors: h.authors, year: h.year },
          method: "search",
          confidence: "high",
        };
      }
      rejected.push(`search top "${h.title.slice(0, 48)}" sim ${sim.toFixed(2)} year=${yearOk} author=${authorOk}`);
    }
  }

  // A transient failure anywhere means this verdict is NOT definitive: the caller must
  // leave the PDF where it is and retry later, never quarantine on it.
  if (sawTransient) {
    return {
      status: "unresolved",
      reason: "network issue while identifying — left to retry",
      retryable: true,
      diagnostics: { candidates: cands, rejected, query, topHits },
    };
  }
  return {
    status: "unresolved",
    reason: cands.length ? "no DOI passed cross-validation" : query ? "no confident title match" : "no DOI or title in PDF",
    diagnostics: { candidates: cands, rejected, query, topHits },
  };
}

// --- reconcile (pure decision; the caller performs the I/O) ------------------------

export type AssignAction =
  | { kind: "attach"; key: string } // existing entry, no PDF yet — attach as main
  | { kind: "discard"; key: string } // existing entry already has a PDF — drop the incoming
  | { kind: "add" } // not in library — caller adds it, then attaches
  | { kind: "unresolved"; reason: string };

/** Map an identification + library state to the action. `existingKey` = the citekey of the
 *  library entry matching the identified DOI (or null if not in the library); `hasPdf` =
 *  whether that existing entry already has a paper.pdf. */
export function reconcile(id: IdResult, existingKey: string | null, hasPdf: boolean): AssignAction {
  if (id.status !== "identified") return { kind: "unresolved", reason: id.reason };
  if (existingKey && hasPdf) return { kind: "discard", key: existingKey };
  if (existingKey) return { kind: "attach", key: existingKey };
  return { kind: "add" };
}
