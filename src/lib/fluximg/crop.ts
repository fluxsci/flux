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
