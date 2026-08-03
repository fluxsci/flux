// Viewport navigation: moving the view to something, without editing anything.
//
// World→screen is `screen = pan + world * zoom` with the origin at the canvas
// host's top-left (Canvas.svelte's scene transform, and clientToWorld is its
// inverse). So centering a world-space rect is a pure pan solve — no zoom
// change, no model mutation, no history entry.

import { get } from "svelte/store";
import { canvasBox, project, viewport } from "./store";
import type { Id } from "./types";

/**
 * Centre the view on a figure at the CURRENT zoom.
 *
 * Zoom is deliberately untouched: the user picked it, and a click in the
 * sidebar is a "take me there", not a "reframe everything". A figure larger
 * than the viewport therefore stays larger — centred, overflowing evenly — which
 * is the honest result rather than a surprise zoom-out.
 *
 * Returns false when there is nothing to do (unknown figure, or no canvas has
 * mounted and published its size yet) so a caller can fall back.
 */
export function centerOnFigure(figId: Id): boolean {
  const fig = get(project).figures.find((f) => f.id === figId);
  if (!fig) return false;
  const box = get(canvasBox);
  if (box.w <= 0 || box.h <= 0) return false;

  const { zoom } = get(viewport);
  viewport.set({
    zoom,
    panX: box.x + (box.w - fig.width * zoom) / 2 - fig.x * zoom,
    panY: box.y + (box.h - fig.height * zoom) / 2 - fig.y * zoom,
  });
  return true;
}
