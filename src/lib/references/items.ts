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
