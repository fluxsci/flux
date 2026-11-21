/**
 * The frame of an image: a crop in level-0 image pixels, clipped to the image. Its own tiny module so that pure
 * callers which only need the rectangle (the view tween, and through it the slide player and the exported deck's
 * runtime) do not pull the still renderer, the reader and the codecs into their import graph.
 */
import type { FluximgManifest } from "./types";
import type { PixelRect } from "./view";

/** The whole image as a crop. */
export function fullCrop(manifest: FluximgManifest): PixelRect {
  const s = manifest.pixels.shape, nd = s.length;
  return { x: 0, y: 0, width: s[nd - 1], height: s[nd - 2] };
}

/** A crop clipped to the image and never empty (a crop wholly outside becomes the nearest 1 x 1 corner). */
export function clampCrop(manifest: FluximgManifest, crop: PixelRect | null | undefined): PixelRect {
  const full = fullCrop(manifest);
  if (!crop || !(crop.width > 0) || !(crop.height > 0)) return full;
  const x0 = Math.min(full.width - 1e-6, Math.max(0, crop.x)), y0 = Math.min(full.height - 1e-6, Math.max(0, crop.y));
  const x1 = Math.max(x0 + 1e-6, Math.min(full.width, crop.x + crop.width)), y1 = Math.max(y0 + 1e-6, Math.min(full.height, crop.y + crop.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Fractions of the crop's own resolution a displayed still is drawn at (coarser steps halve; 3/4 steps between). */
const TIER_STEPS = [1, 0.75];

/**
 * The size of a still that is DISPLAYED (and then scaled by the display): the smallest tier that gives at least
 * one still pixel per needed pixel, so resizing or zooming within a tier draws nothing new. Tiers are fractions
 * of the crop's own pixels (1, 3/4, 1/2, 3/8, ...); never more than the crop holds, never more than `maxPixels`.
 * `native` says whether the still is the crop's true pixels (only then may the display magnify it without smoothing).
 */
export function tieredStillSize(crop: PixelRect, box: { width: number; height: number }, scale: number, maxPixels = 4_194_304): { width: number; height: number; native: boolean } {
  const need = Math.max((box.width * scale) / crop.width, (box.height * scale) / crop.height);
  const cap = Math.sqrt(maxPixels / Math.max(1, crop.width * crop.height));
  let r = 1;
  // Walk down while the next tier still covers the need, or while this one is over the pixel cap.
  for (let k = 0; k < 64; k++) {
    const half = Math.pow(0.5, Math.floor(k / TIER_STEPS.length)) * TIER_STEPS[k % TIER_STEPS.length];
    const next = Math.pow(0.5, Math.floor((k + 1) / TIER_STEPS.length)) * TIER_STEPS[(k + 1) % TIER_STEPS.length];
    r = half;
    if (r > cap) continue;
    if (!(next >= need) || crop.width * next < 1 || crop.height * next < 1) break;
  }
  return { width: Math.max(1, Math.round(crop.width * r)), height: Math.max(1, Math.round(crop.height * r)), native: r === 1 };
}

export interface StillSizeOptions {
  /**
   * false (the editor): never more pixels than the crop holds; the display magnifies true pixels itself.
   * true (exports, flux-core): draw every requested pixel, so a viewer that smooths magnified images cannot blur it.
   */
  magnify?: boolean;
  /** Upper bound on width x height. The aspect is kept. */
  maxPixels?: number;
}

/**
 * How many pixels a still needs: the box at `scale` device pixels per canvas pixel, bounded by the crop's own
 * pixels (unless `magnify`) and by `maxPixels`. Always at least 1 x 1, and never a different aspect than the box
 * by more than rounding.
 */
export function stillSize(crop: PixelRect, box: { width: number; height: number }, scale: number, options: StillSizeOptions = {}): { width: number; height: number } {
  let w = Math.max(1, box.width * scale), h = Math.max(1, box.height * scale);
  if (!options.magnify) {
    // Bound by the denser axis: a box narrower than its crop on one axis only still wants the crop's pixels on the other.
    const k = Math.min(1, Math.max(crop.width / w, crop.height / h));
    w *= k; h *= k;
  }
  const max = options.maxPixels ?? 16_777_216;
  if (w * h > max) { const k = Math.sqrt(max / (w * h)); w *= k; h *= k; }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
