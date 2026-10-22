// In-browser thumbnail rendering — the Plots rail's FALLBACK path (worker unavailable, WebP the
// worker cannot decode, the web/demo build) and the dev fixture bridge's plotThumb (so the ui
// tier walks the same client path the desktop app does). It runs Chromium's own raster on the
// renderer's main thread, which is exactly what the worker exists to avoid — so the rail caps
// what it sends here (FALLBACK_SVG_MAX) and runs these one at a time.
//
// The ink analysis is the same analyzeInk the worker runs (electron/plotThumbRules.mjs), on a
// straight-alpha ANALYSIS_WIDTH render, so a plot's backdrop does not depend on which path drew it.

import { ANALYSIS_WIDTH, analyzeInk, type InkStats } from "./rules";

/** SVGs above this go unrendered in the fallback (a big SVG decode is a main-thread stall). */
export const FALLBACK_SVG_MAX = 2 * 1024 * 1024;
export const FALLBACK_RASTER_MAX = 24 * 1024 * 1024;

const mimeFor = (name: string) => {
  const n = name.toLowerCase();
  if (n.endsWith(".svg")) return "image/svg+xml";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  return "image/png";
};

async function decode(bytes: Uint8Array, name: string): Promise<{ img: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(name) }));
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
  if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) { URL.revokeObjectURL(url); throw new Error("Image has no size"); }
  return { img, url };
}

function draw(img: HTMLImageElement, width: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round((width * img.naturalHeight) / img.naturalWidth));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

export interface BrowserThumb { png: Uint8Array; width: number; height: number; stats: InkStats; naturalWidth: number; naturalHeight: number }

/** Render `bytes` (an image file named `name`) at `bucket` px wide, plus its ink analysis. */
export async function renderThumbInBrowser(bytes: Uint8Array, name: string, bucket: number): Promise<BrowserThumb> {
  const { img, url } = await decode(bytes, name);
  try {
    const isRaster = !/\.svg$/i.test(name);
    const width = isRaster ? Math.min(bucket, img.naturalWidth) : bucket;
    const { canvas } = draw(img, width);
    const a = draw(img, isRaster ? Math.min(ANALYSIS_WIDTH, img.naturalWidth) : ANALYSIS_WIDTH);
    const data = a.ctx.getImageData(0, 0, a.canvas.width, a.canvas.height).data;
    const stats = analyzeInk(data, a.canvas.width, a.canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, stats, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
