// Figures inside a journal manuscript PDF — rasterized at print resolution.
//
// A dense plot's figure SVG runs to 10–15 MB; placed as vectors (rsvg-convert
// → PDF) five of them made a 26 MB manuscript, past Cell's 20 MB and close to
// Nature's 30 MB initial-submission caps, and slow for every reviewer. Every
// venue takes 300 dpi at submission (the vector files come later, separately),
// so the PDF path swaps each figure for a PNG rendered from the same SVG — the
// Word path does the same inside the .docx (docxSvgFallback raster-only mode).
//
// This module only PLANS (which embeds, what pixel width); each engine
// rasterizes with its own renderer (flux-core: resvg child; Paper: canvas) and
// hands the assembler a label → image-path map. Pure: no Svelte, no DOM, no Node.

import { EMBED_RE, resolveInclude } from "../exportQmd";
import { mapUnprotected } from "../manuscript/documentContext";

/** Hidden per-render folder beside the document that holds the PNGs (removed after). */
export const JOURNAL_FIGURE_DIR_PREFIX = ".flux-journal-figures-";

/** Figure SVG user units are CSS pixels. */
export const SVG_PX_PER_INCH = 96;
/** Never ask a rasterizer for more than this many pixels on a side. */
const MAX_EDGE = 6000;

const UNIT_PER_INCH: Record<string, number> = { px: 96, pt: 72, pc: 6, in: 1, mm: 25.4, cm: 2.54, "": 96 };

/** Pixel width for `svg` at `dpi`, from its width attribute (any CSS unit) or viewBox. */
export function rasterWidthFor(svg: string, dpi: number): number {
  const head = svg.slice(0, 2000);
  const w = /<svg\b[^>]*\swidth="([\d.]+)\s*(px|pt|pc|in|mm|cm)?"/.exec(head);
  let inches = 0;
  if (w) inches = Number(w[1]) / (UNIT_PER_INCH[w[2] ?? ""] ?? 96);
  if (!inches) {
    const vb = /viewBox="[\d.\-\s]*?([\d.]+)\s+[\d.]+"/.exec(head);
    inches = vb ? Number(vb[1]) / SVG_PX_PER_INCH : 6;
  }
  return Math.max(1, Math.min(MAX_EDGE, Math.round(inches * dpi)));
}

/** Every figure embed in `text` whose image is an SVG: label + absolute path. */
export function svgFigureEmbeds(text: string, docAbs: string): { label: string; svgPath: string }[] {
  const out: { label: string; svgPath: string }[] = [];
  mapUnprotected(text, (chunk) => {
    for (const line of chunk.split("\n")) {
      const m = EMBED_RE.exec(line);
      if (!m || !/\.svg$/i.test(m[2].trim()) || out.some((e) => e.label === m[3])) continue;
      const target = m[2].trim();
      out.push({ label: m[3], svgPath: /^([a-z]:)?[\\/]/i.test(target) ? target : resolveInclude(docAbs, target) });
    }
    return chunk;
  });
  return out;
}
