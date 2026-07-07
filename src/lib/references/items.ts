// Pure path helpers + types for the FluxLib "items/" store — the long-reserved
// "Tier 1" per-paper artifact area (flux-core/fluxlib.ts:8 "items/ is future").
//
//   <lib>/items/<citekey>/
//     paper.pdf            the main PDF (the filesystem IS the source of truth)
//     supplement-N.<ext>   supplementary materials
//     source.json          provenance (where/how the PDF was obtained)
//     fulltext.txt         extracted text (full-text search + agent context)
//     annotations.json     highlights/notes (anchored to text; see annotations.ts)
//
// No I/O here (imports cleanly in the browser + Node). The Node engine
// (flux-core/items.ts) and the renderer twin file these under window.fig / fs.
// POSIX-joined to match src/lib/project/types.ts joinPath (Node accepts "/").

export const ITEMS_DIR = "items";
export const PAPER_PDF = "paper.pdf";
export const SOURCE_JSON = "source.json";
export const FULLTEXT_TXT = "fulltext.txt";
export const ANNOTATIONS_JSON = "annotations.json";
export const FETCH_FAILURE_JSON = "fetch-failure.json";

function j(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}

/** Citekeys are deterministic + filename-safe, but guard against separators / traversal. */
export function safeKey(key: string): string {
  return key
    .replace(/[\\/]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .trim();
}

export const itemsBase = (lib: string): string => j(lib, ITEMS_DIR);

/** Live FluxReader context (what the human is reading right now) — written by the
 *  reader, read by the get_reading_context MCP tool so an agent can "see" the paper,
 *  page, selection, and highlights. Transient (derived), under .fluxlib/. */
export const readerContextPath = (lib: string): string => j(lib, ".fluxlib", "reader-context.json");
export interface ReaderContext {
  citekey: string;
  title?: string;
  authors?: string[];
  year?: string;
  doi?: string;
  page?: number; // 1-based, if known
  selection?: string; // the human's current text selection, if any
  annotations?: { page: number; color: string; quote: string; note?: string }[];
  pdfPath?: string;
  fulltextPath?: string;
  updatedAt: string; // ISO
}
export const itemDir = (lib: string, key: string): string => j(lib, ITEMS_DIR, safeKey(key));
export const pdfPath = (lib: string, key: string): string => j(itemDir(lib, key), PAPER_PDF);
export const sourcePath = (lib: string, key: string): string => j(itemDir(lib, key), SOURCE_JSON);
export const fulltextPath = (lib: string, key: string): string => j(itemDir(lib, key), FULLTEXT_TXT);
export const annotationsPath = (lib: string, key: string): string => j(itemDir(lib, key), ANNOTATIONS_JSON);
export const failurePath = (lib: string, key: string): string => j(itemDir(lib, key), FETCH_FAILURE_JSON);
export const supplementPath = (lib: string, key: string, n: number, ext: string): string =>
  j(itemDir(lib, key), `supplement-${n}.${ext.replace(/^\./, "")}`);

/** Provenance for a stored PDF — written alongside it as source.json. */
export interface SourceInfo {
  key: string; // citekey
  source: string; // resolver that produced it: "openalex-oa" | "unpaywall" | "europepmc" | "pmc-oa" | "arxiv" | "biorxiv" | "crossref" | "proxy" | "ingest"
  url?: string; // the URL we requested
  finalUrl?: string; // after redirects
  fetchedAt: string; // ISO
  sha256?: string;
  bytes?: number;
  isOa?: boolean; // true = open-access copy; false = version-of-record via proxy
  license?: string;
}

/** Why a PDF fetch genuinely failed, recorded per-paper as items/<key>/fetch-failure.json
 *  so the failure is directly associated to the paper, survives restarts, is cleared on any
 *  later success, and lets the bulk run SKIP papers that already exhausted every route (no
 *  re-grinding the same DOI with the same failing methods). NEVER written for environment
 *  failures (session-expired / cancelled / not-configured) — those stay merely "missing". */
export interface FetchFailure {
  key: string; // citekey
  target: string; // the DOI/landing URL we tried
  host?: string; // publisher host we landed on (from proxy diag)
  attemptedAt: string; // ISO of the most recent attempt
  attempts: number; // increments across runs
  oa?: string; // OA outcome: "no-oa" | "no-id" | an error string
  proxy?: {
    reason?: string; // engine reason: "no-affordances" | "not-a-pdf" | "error" | ...
    landedUrl?: string;
    affordancesFound?: string[];
    detail?: string;
  };
  lastError?: string; // human-readable last error (OA or proxy)
}

// --- OA-miss ledger ---------------------------------------------------------------
// ONE aggregated file (<lib>/.fluxlib/oa-misses.json) remembering every paper whose OA
// waterfall came up empty, so a bulk run never re-grinds the whole library's open-access
// checks. Deliberately NOT per-item files: the ledger is read once at run start (1 read)
// and throttle-saved during the run — minimal and fast at any library size. A miss is
// only honored while it is FRESH: same identifier signature (a new DOI / OA URL / PMCID
// from enrichment invalidates it) and younger than the TTL (papers become OA over time —
// PMC embargoes lapse). "Retry failed" bypasses the ledger entirely.

export const OA_MISSES_JSON = "oa-misses.json";
export const oaMissesPath = (lib: string): string => j(lib, ".fluxlib", OA_MISSES_JSON);

/** Re-check a missed paper after this long even if nothing changed (embargoes lapse). */
export const OA_MISS_TTL_MS = 30 * 24 * 3600_000;

export interface OaMiss {
  at: string; // ISO of the last OA attempt
  attempts: number; // accumulates across runs
  sig: string; // identifier signature at attempt time (see oaSig)
}
export type OaMissMap = Record<string, OaMiss>; // keyed by safeKey(key).normalize("NFC")
export interface OaMissFile {
  version: 1;
  misses: OaMissMap;
}

/** The identifiers the OA waterfall would use — when these change (enrichment found a new
 *  DOI/OA URL/PMCID), a recorded miss is stale and the paper is re-checked. */
export function oaSig(x: { doi?: string; openAccessUrl?: string; pmcid?: string }): string {
  return [(x.doi ?? "").trim().toLowerCase(), x.openAccessUrl ?? "", x.pmcid ?? ""].join("|");
}

/** True if `miss` still applies: same identifiers and younger than the TTL. */
export function isFreshOaMiss(miss: OaMiss | undefined, sig: string, now = Date.now()): boolean {
  if (!miss || miss.sig !== sig) return false;
  const at = Date.parse(miss.at);
  return Number.isFinite(at) && now - at < OA_MISS_TTL_MS;
}

/** LR-7: the durable per-row outcome for a recorded failure — drives the Library's fetch pill.
 *  (Environment failures — session-expired/cancelled — are never recorded per the note above,
 *  so they stay "missing", not any of these.) */
export type FetchOutcome = "no-id" | "no-oa" | "failed";
export function fetchOutcome(f: FetchFailure): FetchOutcome {
  if (f.oa === "no-id") return "no-id"; // no DOI/identifier to even attempt OA
  if (f.oa === "no-oa") return "no-oa"; // no open-access copy; the publisher route also failed
  return "failed"; // a route erred (wall / not-a-pdf / network) — see lastError
}

/** One row of the derived items index (.fluxlib/items.json) — a fast cache of
 *  "what's on disk", rebuildable by scanning items/. Never the source of truth. */
export interface ItemStatus {
  key: string;
  hasPdf: boolean;
  supplements: number;
  hasFulltext: boolean;
  annotations: number; // count
  source?: string; // from source.json
  fetchedAt?: string;
}

export type ItemsIndex = Record<string, ItemStatus>;
