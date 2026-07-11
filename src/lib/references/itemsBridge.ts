// Renderer-side access to the FluxLib items/ store (the browser/Electron twin of
// flux-core/items.ts) — reads a stored PDF's bytes / provenance over window.fig.
// Reuses the pure path helpers (items.ts) + the resolved FluxLib path.
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import {
  itemDir,
  itemsBase,
  pdfPath,
  fulltextPath,
  sourcePath,
  failurePath,
  safeKey,
  readerContextPath,
  oaMissesPath,
  supplementsDir,
  supplementFilePath,
  safeSupplementName,
  PAPER_PDF,
  FETCH_FAILURE_JSON,
  type SourceInfo,
  type FetchFailure,
  type ReaderContext,
  type OaMissMap,
  type OaMissFile,
} from "./items";
import { isPdfBytes } from "./pdfFinder";
import { seededItem, seededSupplements } from "./devSeed";
import { pushToast } from "../toast";

/** Manual ingest has no size ceiling (unlike netGet's 80MB fetch cap) — warn on huge
 *  scans so the memory cost of opening them isn't a surprise. Never blocks the ingest. */
function warnHugePdf(bytes: Uint8Array, what: string): void {
  const MB = 1024 * 1024;
  if (bytes.length > 80 * MB) {
    pushToast("info", `That ${what} is ${Math.round(bytes.length / MB)}MB`, {
      detail: "It will open, but the reader holds the whole file in memory while it's open — very large scans read slowly.",
    });
  }
}

/** Write the live reader context (what the human is reading) so the agent's
 *  get_reading_context MCP tool can see it. Fills in the on-disk paths. Best-effort,
 *  debounced by the caller. */
export async function writeReaderContext(ctx: ReaderContext): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  const full: ReaderContext = { ...ctx };
  if (ctx.citekey) {
    full.pdfPath = pdfPath(lib, ctx.citekey);
    full.fulltextPath = fulltextPath(lib, ctx.citekey);
  }
  try {
    if (fb.mkdir) await fb.mkdir(`${lib}/.fluxlib`);
    await fb.writeText(readerContextPath(lib), JSON.stringify(full, null, 2));
  } catch {
    /* best-effort */
  }
}
/** Clear the reader context when the reader closes / no paper is open. */
export async function clearReaderContext(): Promise<void> {
  await writeReaderContext({ citekey: "", updatedAt: new Date().toISOString() });
}

/** File a hand-downloaded PDF (chosen via the OS picker) into items/<key>/ — the manual
 *  fallback for paywalled papers. Validates the %PDF- header. Returns false if the file
 *  isn't a PDF or can't be read. */
export async function ingestPdfFile(key: string, filePath: string): Promise<boolean> {
  const fb = fileBridge();
  if (!fb) return false;
  let buf: ArrayBuffer | null;
  try {
    buf = await fb.readFile(filePath);
  } catch {
    return false;
  }
  if (!buf) return false;
  const bytes = new Uint8Array(buf);
  if (!isPdfBytes(bytes)) return false;
  warnHugePdf(bytes, "PDF");
  return writePdfItem(key, bytes, { source: "ingest", url: filePath, finalUrl: filePath });
}

/** The set of citekeys (safeKey form) that have a paper.pdf on disk — one readdir of
 *  items/ + a presence check per item dir (scales with fetched papers, not library
 *  size). Used by the Library to show a "has PDF" pill and gate the "Read" action. */
export async function listPdfKeys(): Promise<Set<string>> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const out = new Set<string>();
  if (!fb || !lib) return out;
  // WS-8.5: prefer the derived .fluxlib/items.json (flux-core maintains it)
  // when it is at least as fresh as the items/ DIRECTORY (whose mtime moves on
  // item-dir add/remove — the reload-relevant events). One read replaces a
  // readdir + per-dir exists sweep; the in-memory optimistic tick stays the
  // live-update path for this session's own writes, and any parse/stat problem
  // falls straight back to the sweep below.
  try {
    const idxPath = `${lib}/.fluxlib/items.json`;
    const [idxSt, dirSt] = await Promise.all([fb.stat?.(idxPath), fb.stat?.(itemsBase(lib))]);
    if (idxSt && dirSt && idxSt.mtimeMs >= dirSt.mtimeMs) {
      const idx = JSON.parse(await fb.readText(idxPath)) as Record<string, { hasPdf?: boolean }>;
      for (const [k, st] of Object.entries(idx)) if (st && st.hasPdf) out.add(safeKey(k).normalize("NFC"));
      return out;
    }
  } catch {
    /* missing/stale/corrupt index — sweep */
  }
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out; // no items/ yet
  }
  await Promise.all(
    entries
      .filter((e) => e.dir)
      .map(async ({ name }) => {
        try {
          // Store NFC-normalized: macOS/APFS returns readdir names as NFD while the .bib
          // stores citekeys as NFC — without this, accented keys (buzsáki, yüzgeç…) miss
          // the presence check and their PDFs flicker as "missing" between launches.
          if (await fb.exists(`${itemsBase(lib)}/${name}/${PAPER_PDF}`)) out.add(name.normalize("NFC"));
        } catch {
          /* ignore */
        }
      }),
  );
  return out;
}

/** True if `key`'s PDF dir-name is in a set produced by listPdfKeys(). NFC-normalized so
 *  the join is Unicode-normalization-invariant (see listPdfKeys). */
export const hasPdfIn = (pdfKeys: Set<string>, key: string): boolean =>
  pdfKeys.has(safeKey(key).normalize("NFC"));

/** File a fetched PDF into items/<key>/ + write source.json provenance (renderer twin
 *  of flux-core writePdf). Computes a SHA-256 via WebCrypto for parity, and extracts
 *  fulltext.txt best-effort — this is the ONE place every GUI acquisition path funnels
 *  through (bulk fetch, proxy capture, manual ingest, assign), so GUI-acquired papers
 *  are full-text-searchable exactly like Node-acquired ones. */
export async function writePdfItem(
  key: string,
  bytes: Uint8Array,
  info: { source: string; url?: string; finalUrl?: string; isOa?: boolean; license?: string },
): Promise<boolean> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  if (fb.mkdir) await fb.mkdir(itemDir(lib, key));
  await fb.writeFile(pdfPath(lib, key), bytes);
  let sha256: string | undefined;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    /* WebCrypto unavailable — provenance still useful without the hash */
  }
  const source: SourceInfo = {
    key,
    source: info.source,
    url: info.url,
    finalUrl: info.finalUrl,
    fetchedAt: new Date().toISOString(),
    sha256,
    bytes: bytes.length,
    isOa: info.isOa,
    license: info.license,
  };
  await fb.writeText(sourcePath(lib, key), JSON.stringify(source, null, 2) + "\n");
  // Fulltext parity with flux-core attach/acquire (dynamic import keeps pdf.js out of
  // the Library chunk until a PDF actually lands; scanned PDFs simply yield no text).
  try {
    const { extractFulltextText } = await import("../pdf/pdfFulltext");
    const ft = await extractFulltextText(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
    if (ft.chars > 0) await fb.writeText(fulltextPath(lib, key), ft.text);
  } catch {
    /* best-effort — paper.pdf is filed regardless */
  }
  return true;
}

/** Read a stored PDF's bytes (ArrayBuffer) for the reader, or null if absent. */
export async function readerPdfBytes(key: string): Promise<ArrayBuffer | null> {
  const s = seededItem(key);
  if (s) return s.pdf.slice().buffer; // headless harness fixture (devSeed.ts)
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  const p = pdfPath(lib, key);
  try {
    return (await fb.exists(p)) ? await fb.readFile(p) : null;
  } catch {
    return null;
  }
}

export async function readerHasPdf(key: string): Promise<boolean> {
  if (seededItem(key)) return true;
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  try {
    return await fb.exists(pdfPath(lib, key));
  } catch {
    return false;
  }
}

export async function readerSource(key: string): Promise<SourceInfo | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  try {
    return JSON.parse(await fb.readText(sourcePath(lib, key))) as SourceInfo;
  } catch {
    return null;
  }
}

// --- supplements (items/<key>/supplements/) --------------------------------------
// Optional supplementary PDFs the reader's "Switch PDF" dropdown lists beside paper.pdf.
// The folder is populated by hand (attach), the mis-stored-supplement repair, or a future
// auto-capture — never required for a paper to be readable.

/** List the supplement PDFs for `key` (bare filenames, sorted). Empty if the folder is
 *  absent. Only .pdf files are returned — the reader can only display PDFs. */
export async function listSupplements(key: string): Promise<string[]> {
  const s = seededSupplements(key);
  if (s) return [...s.keys()].sort((a, b) => a.localeCompare(b)); // headless harness fixture
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib || !fb.readdir) return [];
  try {
    const ents = await fb.readdir(supplementsDir(lib, key));
    return ents
      .filter((e) => !e.dir && /\.pdf$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return []; // no supplements/ folder
  }
}

/** Read a supplement PDF's bytes for the reader, or null if absent. `name` is a bare
 *  filename (re-sanitized to stay inside the folder). */
export async function readerSupplementBytes(key: string, name: string): Promise<ArrayBuffer | null> {
  const seed = seededSupplements(key)?.get(name);
  if (seed) return seed.slice().buffer; // headless harness fixture
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  const p = supplementFilePath(lib, key, name);
  try {
    return (await fb.exists(p)) ? await fb.readFile(p) : null;
  } catch {
    return null;
  }
}

/** Copy a hand-picked PDF into items/<key>/supplements/. Validates the %PDF header. Returns
 *  the stored filename (suffixed -2, -3, … on a name collision so nothing is overwritten),
 *  or null if the file isn't a readable PDF. */
export async function ingestSupplementFile(key: string, filePath: string): Promise<string | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  let buf: ArrayBuffer | null;
  try {
    buf = await fb.readFile(filePath);
  } catch {
    return null;
  }
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  if (!isPdfBytes(bytes)) return null;
  warnHugePdf(bytes, "supplement");
  if (fb.mkdir) await fb.mkdir(supplementsDir(lib, key));
  let name = safeSupplementName(filePath);
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  const base = name.replace(/\.pdf$/i, "");
  for (let i = 2; await fb.exists(supplementFilePath(lib, key, name)); i++) name = `${base}-${i}.pdf`;
  try {
    await fb.writeFile(supplementFilePath(lib, key, name), bytes);
    return name;
  } catch {
    return null;
  }
}

// --- OA-miss ledger (single aggregated file — see items.ts) ----------------------

/** Load the OA-miss ledger (one read). Missing/corrupt file → empty map. */
export async function loadOaMisses(): Promise<OaMissMap> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return {};
  try {
    const p = oaMissesPath(lib);
    if (!(await fb.exists(p))) return {};
    const parsed = JSON.parse(await fb.readText(p)) as OaMissFile;
    return parsed && typeof parsed.misses === "object" && parsed.misses ? parsed.misses : {};
  } catch {
    return {};
  }
}

/** Persist the OA-miss ledger. Best-effort (a lost save just means a re-check later). */
export async function saveOaMisses(misses: OaMissMap): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  try {
    if (fb.mkdir) await fb.mkdir(`${lib}/.fluxlib`);
    const file: OaMissFile = { version: 1, misses };
    await fb.writeText(oaMissesPath(lib), JSON.stringify(file, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

// --- fetch-failure log (Part C) -------------------------------------------------
// Records WHY a paper couldn't be fetched after exhausting every route, so the bulk run
// skips it by default (no re-grinding the same DOI) and the user can see/diagnose the
// backlog. Cleared on any later success. Never written for environment failures.

/** Record (or increment) a paper's fetch failure. Merges with any prior record so
 *  `attempts` accumulates across runs. Best-effort; returns false if it couldn't write. */
export async function writeFetchFailure(
  key: string,
  rec: Omit<FetchFailure, "key" | "attempts" | "attemptedAt"> & { attemptedAt?: string },
): Promise<boolean> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  const prior = await readFetchFailure(key);
  const full: FetchFailure = {
    key,
    target: rec.target,
    host: rec.host ?? prior?.host,
    attemptedAt: rec.attemptedAt ?? new Date().toISOString(),
    attempts: (prior?.attempts ?? 0) + 1,
    oa: rec.oa ?? prior?.oa,
    proxy: rec.proxy ?? prior?.proxy,
    lastError: rec.lastError ?? prior?.lastError,
  };
  try {
    if (fb.mkdir) await fb.mkdir(itemDir(lib, key));
    await fb.writeText(failurePath(lib, key), JSON.stringify(full, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Read a paper's fetch-failure record, or null if it never failed (or later succeeded). */
export async function readFetchFailure(key: string): Promise<FetchFailure | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  try {
    const p = failurePath(lib, key);
    if (!(await fb.exists(p))) return null;
    return JSON.parse(await fb.readText(p)) as FetchFailure;
  } catch {
    return null;
  }
}

/** Delete a paper's fetch-failure record (called on any successful fetch). */
export async function clearFetchFailure(key: string): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  try {
    const p = failurePath(lib, key);
    if (await fb.exists(p)) await fb.remove?.(p);
  } catch {
    /* best-effort */
  }
}

/** The set of citekeys (safeKey/NFC form) with a fetch-failure record — one readdir of
 *  items/ + a presence check (mirrors listPdfKeys; scales with attempted papers). Drives
 *  the bulk-run skip-list and the Library "failed N" filter. */
export async function listFailedKeys(): Promise<Set<string>> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const out = new Set<string>();
  if (!fb || !lib) return out;
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out;
  }
  await Promise.all(
    entries
      .filter((e) => e.dir)
      .map(async ({ name }) => {
        try {
          if (await fb.exists(`${itemsBase(lib)}/${name}/${FETCH_FAILURE_JSON}`)) out.add(name.normalize("NFC"));
        } catch {
          /* ignore */
        }
      }),
  );
  return out;
}

/** LR-7: like listFailedKeys, but reads each failure record so the Library can show a durable
 *  per-row outcome pill (no DOI / no OA / failed) without expanding the row. Keyed NFC. Failures
 *  are the minority (only attempted-and-failed papers have a record), so the extra reads are few. */
// 2.3 Full-text search over items/*/fulltext.txt. The scan is a Node streaming job
// (flux-core/fulltextSearch.ts) run in the main process via the bundled CLI, so the
// renderer stays jank-free even over a 1k-paper library. Mirrors FulltextResult; a
// missing bridge (web/demo) or an error yields an empty result rather than throwing.
export interface FulltextSnippet {
  page: number;
  text: string;
}
export interface FulltextHit {
  key: string;
  count: number;
  snippets: FulltextSnippet[];
}
export interface FulltextResult {
  hits: FulltextHit[];
  scanned: number;
  missingText: string[];
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

const EMPTY_FT: FulltextResult = { hits: [], scanned: 0, missingText: [], truncated: false, elapsedMs: 0 };

export async function searchFulltext(
  query: string,
  opts?: { limit?: number; keys?: string[] },
): Promise<FulltextResult> {
  // DEV/test seam: a headless harness (no Electron bridge) injects results here to
  // exercise the Library's full-text UI. Mirrors __fluxSeedBib / __fluxSeedFigures.
  if (import.meta.env?.DEV && typeof window !== "undefined") {
    const hook = (window as unknown as { __fluxFulltextHook?: (q: string, o?: unknown) => Partial<FulltextResult> }).__fluxFulltextHook;
    if (typeof hook === "function") return { ...EMPTY_FT, ...hook(query, opts) };
  }
  const fb = fileBridge() as { searchFulltext?: (q: string, o?: unknown) => Promise<Partial<FulltextResult>> } | null;
  if (!fb?.searchFulltext || !query.trim()) return EMPTY_FT;
  try {
    const r = await fb.searchFulltext(query, opts);
    return {
      hits: r.hits ?? [],
      scanned: r.scanned ?? 0,
      missingText: r.missingText ?? [],
      truncated: r.truncated ?? false,
      elapsedMs: r.elapsedMs ?? 0,
      error: r.error,
    };
  } catch (e) {
    return { ...EMPTY_FT, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listFailures(): Promise<Record<string, FetchFailure>> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const out: Record<string, FetchFailure> = {};
  if (!fb || !lib) return out;
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out;
  }
  await Promise.all(
    entries
      .filter((e) => e.dir)
      .map(async ({ name }) => {
        try {
          const p = `${itemsBase(lib)}/${name}/${FETCH_FAILURE_JSON}`;
          if (await fb.exists(p)) out[name.normalize("NFC")] = JSON.parse(await fb.readText(p)) as FetchFailure;
        } catch {
          /* a corrupt/racing record just omits its pill */
        }
      }),
  );
  return out;
}
