// Paper snips — the ONE shared core for PDF-region screenshots (twin-engine, §2).
// Owns naming, citation composition, the sidecar/tEXt metadata shape, rect
// normalization, and the raster plan (scale→dpi math). Consumed by the reader GUI
// (capture via ctrl+alt+drag) and flux-core/snips.ts (headless snip_paper verb) —
// the pixel encoders differ per engine by design; everything else lives here.
// Pure: no DOM, no Node, no Svelte.

import type { RefEntry } from "./types";
import { inTextAuthorYear } from "./format";
import { abbrevJournal } from "./journalAbbrev";
import { safeKey } from "./items";

/** tEXt keyword carrying the snip metadata inside the PNG bytes themselves —
 *  a pasted/copied snip keeps its provenance without any sidecar. */
export const SNIP_TEXT_KEYWORD = "flux-snip";
/** Project-relative home of saved snips (under the user-owned plots/ drop zone). */
export const SNIP_DIR = "plots/paper_snips";
/** Default render scale. pdf.js pixels = PDF points × scale, and physical size is
 *  points/72 inch, so declared dpi = 72×scale: 4 ⇒ 288dpi. The physical-size-true
 *  import path (io.ts buildIncoming, readPngDpi) then places the snip at
 *  natW×96/288 css px = its exact printed size on the page. */
export const SNIP_SCALE = 4;

/** Snip rects are PDF points, y-up, [x1,y1,x2,y2] — exactly what the reader's
 *  viewport.convertToPdfPoint emits and what the snip_paper verb accepts, so an
 *  agent can re-capture a region a human snipped (round-trip via the sidecar). */
export type SnipRect = [number, number, number, number];

export interface SnipMeta {
  citekey: string;
  /** 1-based page in the source PDF. */
  page: number;
  rect: SnipRect;
  /** Which PDF of the paper the snip came from (supplements are allowed). */
  sourcePdf: "main" | { supplement: string };
  /** ISO timestamp. */
  capturedAt: string;
  /** Pre-formatted minimal citation, e.g. "Driessen et al., 2026, Nat. Neurosci." */
  citation: string;
}

/** Compose the minimal snip citation: in-text author-year (format.ts, the one
 *  "Smith et al." rule) + ISO-4-abbreviated journal. Falls back to the bare
 *  citekey when the paper has no bib entry — capture must never block. */
export function composeSnipCitation(entry: RefEntry | null | undefined, key: string): string {
  if (!entry) return key;
  const head = inTextAuthorYear(entry);
  const journal = entry.container ? abbrevJournal(entry.container) : "";
  return journal ? `${head}, ${journal}` : head;
}

/** Filesystem-safe snip name: lowercase, [a-z0-9_-] only, collapsed dashes. */
export function sanitizeSnipName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/** The auto-name a fresh snip is offered under: "<citekey>-p<page>". */
export function defaultSnipName(key: string, page: number): string {
  return sanitizeSnipName(`${safeKey(key)}-p${page}`) || `snip-p${page}`;
}

/** Probe name, name-2, name-3… until `exists` says free. The existence check is
 *  injected so the GUI passes fileBridge().exists and flux-core passes fs — and
 *  deliberately not readdir, which is optional on FileBridge. */
export async function dedupSnipName(base: string, exists: (name: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
}

/** Normalize a snip rect: min/max corner order, clamped to the page view box
 *  ([bx1,by1,bx2,by2], PDF points, y-up). A marquee dragged past the page edge
 *  must not inflate the rect — the pHYs physical size stays truthful. */
export function normSnipRect(rect: SnipRect, pageBox: SnipRect): SnipRect {
  const [bx1, by1, bx2, by2] = pageBox;
  const clampX = (v: number) => Math.min(Math.max(v, Math.min(bx1, bx2)), Math.max(bx1, bx2));
  const clampY = (v: number) => Math.min(Math.max(v, Math.min(by1, by2)), Math.max(by1, by2));
  const x1 = clampX(Math.min(rect[0], rect[2]));
  const x2 = clampX(Math.max(rect[0], rect[2]));
  const y1 = clampY(Math.min(rect[1], rect[3]));
  const y2 = clampY(Math.max(rect[1], rect[3]));
  return [x1, y1, x2, y2];
}

/** The raster plan both engines follow: pixel dims + the dpi to stamp (72×scale). */
export function snipRasterPlan(rect: SnipRect, scale: number): { widthPx: number; heightPx: number; dpi: number } {
  const w = Math.abs(rect[2] - rect[0]);
  const h = Math.abs(rect[3] - rect[1]);
  return {
    widthPx: Math.max(1, Math.ceil(w * scale)),
    heightPx: Math.max(1, Math.ceil(h * scale)),
    dpi: 72 * scale,
  };
}

/** Serialize meta for the PNG tEXt chunk. tEXt is Latin-1, so every non-ASCII
 *  char is \uXXXX-escaped (JSON.parse decodes escapes natively — diacritic author
 *  names survive the byte round-trip losslessly). */
export function encodeSnipMeta(meta: SnipMeta): string {
  return JSON.stringify(meta).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Parse tEXt-carried meta; null on anything malformed (never throws). */
export function decodeSnipMeta(text: string | null | undefined): SnipMeta | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as SnipMeta;
    if (!v || typeof v !== "object") return null;
    if (typeof v.citekey !== "string" || !v.citekey) return null;
    if (typeof v.page !== "number" || !Array.isArray(v.rect) || v.rect.length !== 4) return null;
    if (typeof v.citation !== "string") return null;
    return v;
  } catch {
    return null;
  }
}

/** The human/agent-readable sidecar (<name>.snip.json) — same shape, pretty. */
export function sidecarText(meta: SnipMeta): string {
  return JSON.stringify(meta, null, 2) + "\n";
}

/** Parse a sidecar; null on malformed (never throws). */
export function parseSidecar(text: string | null | undefined): SnipMeta | null {
  return decodeSnipMeta(text);
}

/** Sidecar path beside a snip PNG: "x/y.png" → "x/y.snip.json". */
export function snipSidecarPath(pngPath: string): string {
  return pngPath.replace(/\.png$/i, "") + ".snip.json";
}
