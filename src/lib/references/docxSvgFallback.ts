// Give every SVG picture in a .docx the raster fallback Word requires.
//
// THE PROBLEM. Word's SVG support is an EXTENSION, not a replacement: a picture
// carries `<a:blip r:embed="…">` pointing at a RASTER part, and the vector rides
// alongside it in `<asvg:svgBlip r:embed="…">`. Word paints the raster unless it
// understands the extension. Pandoc can only produce that pair when `rsvg-convert`
// is on PATH; without it — which is every stock Windows/macOS machine, since Quarto
// does not bundle it — it emits a blip with the svgBlip extension and NO `r:embed`
// at all. Word then reserves the picture's space and paints NOTHING: the figure is
// silently, invisibly absent. Measured 2026-09-12: Word reported 2 InlineShapes at
// their correct 60×30pt, and the PDF it exported from that document contained zero
// image XObjects and zero draw operators.
//
// THE FIX. After Quarto runs, rasterize each such SVG and splice the PNG in as the
// blip's own `r:embed`, leaving the svgBlip extension untouched so a capable Word
// still renders the vector. That is exactly the shape Word itself writes.
//
// Rasterization is INJECTED rather than imported. The planning and OPC surgery here
// are pure and gate hermetically in Node; the pixels need a real rasterizer, which
// in Flux means the renderer's canvas (no native deps — hard rule 4). flux-core has
// no rasterizer, so a headless `compile` leaves the SVG-only blips alone and says so
// in its report rather than pretending.

import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

/** Rasterize `svg` at `width`×`height` device pixels. Returns PNG bytes. */
export type RasterizeSvg = (svg: string, width: number, height: number) => Promise<Uint8Array>;

export interface SvgFallbackReport {
  /** Pictures that received a PNG fallback. */
  added: number;
  /** Pictures already carrying a raster (nothing to do). */
  alreadyRaster: number;
  /** Pictures whose SVG could not be rasterized — left exactly as they were. */
  failed: string[];
}

/** EMU per pixel at 96 DPI — the unit `wp:extent` uses. */
const EMU_PER_PX = 9525;
/** Rasterize above the placed size so the picture stays crisp when scaled or printed. */
const OVERSAMPLE = 2;
/** Chromium's canvas ceiling, mirrored from io.ts's export guard. */
const MAX_EDGE = 32767;

/** A `<a:blip …>` opening tag through its matching close (or self-close). */
const BLIP_RE = /<a:blip\b([^>]*?)(\/>|>([\s\S]*?)<\/a:blip>)/g;
const SVG_BLIP_EMBED_RE = /<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/;

/** Highest rIdN in a rels part, so fresh ids cannot collide with existing ones. */
function maxRelId(relsXml: string): number {
  let max = 0;
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** The pixel size to rasterize at, read from the `wp:extent` that governs this blip
 *  (the nearest one BEFORE it in document order — `wp:extent` precedes `a:blip`
 *  inside a drawing). Falls back to the SVG's own viewBox, then to a sane default:
 *  a wrong size costs sharpness, never correctness, because the picture's displayed
 *  dimensions come from the drawing, not from the pixels. */
export function rasterSizeFor(documentXml: string, blipAt: number, svg: string): { width: number; height: number } {
  let cx = 0;
  let cy = 0;
  for (const m of documentXml.slice(0, blipAt).matchAll(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/g)) {
    cx = Number(m[1]);
    cy = Number(m[2]);
  }
  let width = cx ? Math.round((cx / EMU_PER_PX) * OVERSAMPLE) : 0;
  let height = cy ? Math.round((cy / EMU_PER_PX) * OVERSAMPLE) : 0;
  if (!width || !height) {
    const vb = /viewBox="[\d.\-\s]*?([\d.]+)\s+([\d.]+)"/.exec(svg);
    const w = vb ? Number(vb[1]) : 0;
    const h = vb ? Number(vb[2]) : 0;
    width = w ? Math.round(w * OVERSAMPLE) : 1600;
    height = h ? Math.round(h * OVERSAMPLE) : 1200;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Resolve a relationship target to its part name inside the package. */
function partFor(target: string): string {
  return `word/${target.replace(/^\.\//, "")}`;
}

export async function addSvgRasterFallbacks(
  docxBytes: Uint8Array,
  rasterize: RasterizeSvg,
): Promise<{ bytes: Uint8Array; report: SvgFallbackReport }> {
  const report: SvgFallbackReport = { added: 0, alreadyRaster: 0, failed: [] };
  const parts = unzipSync(docxBytes);
  const DOC = "word/document.xml";
  const RELS = "word/_rels/document.xml.rels";
  if (!parts[DOC] || !parts[RELS]) return { bytes: docxBytes, report };

  const documentXml = strFromU8(parts[DOC]);
  let relsXml = strFromU8(parts[RELS]);
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g))
    targets.set(m[1], m[2]);
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"[^>]*\/>/g))
    targets.set(m[2], m[1]);

  let nextId = maxRelId(relsXml);
  const newRels: string[] = [];
  const edits: { from: number; to: number; text: string }[] = [];

  for (const m of documentXml.matchAll(BLIP_RE)) {
    const [whole, attrs, , inner = ""] = m;
    if (/\br:(embed|link)="/.test(attrs)) {
      report.alreadyRaster++;
      continue;
    }
    const svgRef = SVG_BLIP_EMBED_RE.exec(inner);
    if (!svgRef) continue; // a blip with neither a raster nor an svg — not ours to repair
    const relId = svgRef[1];
    const part = partFor(targets.get(relId) ?? "");
    const svgBytes = parts[part];
    if (!svgBytes) {
      report.failed.push(relId);
      continue;
    }
    const svg = strFromU8(svgBytes);
    const { width, height } = rasterSizeFor(documentXml, m.index ?? 0, svg);
    let png: Uint8Array;
    try {
      png = await rasterize(svg, width, height);
    } catch {
      report.failed.push(part);
      continue; // leave this picture exactly as it was
    }
    const pngPart = `word/media/${part.split("/").pop()!.replace(/\.svg$/i, "")}-fallback.png`;
    parts[pngPart] = new Uint8Array(png);
    const newId = `rId${++nextId}`;
    newRels.push(
      `<Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${pngPart.split("/").pop()}"/>`,
    );
    // Keep the svgBlip extension: a capable Word still paints the vector.
    edits.push({
      from: m.index ?? 0,
      to: (m.index ?? 0) + whole.length,
      text: `<a:blip r:embed="${newId}"${attrs}>${inner}</a:blip>`,
    });
    report.added++;
  }

  if (!edits.length) return { bytes: docxBytes, report };

  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += documentXml.slice(cursor, e.from) + e.text;
    cursor = e.to;
  }
  out += documentXml.slice(cursor);
  parts[DOC] = strToU8(out);

  relsXml = relsXml.replace(/<\/Relationships>\s*$/, `${newRels.join("")}</Relationships>`);
  parts[RELS] = strToU8(relsXml);

  // Every part needs a declared content type or the package is invalid.
  const CT = "[Content_Types].xml";
  let ct = strFromU8(parts[CT]);
  if (!/<Default\b[^>]*Extension="png"/i.test(ct))
    ct = ct.replace(/<Types\b[^>]*>/, (t) => `${t}<Default Extension="png" ContentType="image/png"/>`);
  parts[CT] = strToU8(ct);

  return { bytes: zipSync(parts), report };
}

/** Renderer-side rasterizer: the same Image → canvas path the figure PNG export uses
 *  (io.ts), which is the rasterization Chromium's SVG renderer produces. Renderer
 *  only — it needs `document`, `Image` and a 2D canvas. */
export function domRasterizeSvg(): RasterizeSvg {
  return async (svg, width, height) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("the SVG could not be rasterized"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("could not allocate a rasterization canvas");
      // Figures are placed on the page, not composited: paint white behind them so a
      // transparent SVG does not read as a grey box in Word's own background.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      canvas.width = canvas.height = 1;
      if (!blob) throw new Error("the rasterized figure could not be encoded");
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      URL.revokeObjectURL(url);
    }
  };
}
