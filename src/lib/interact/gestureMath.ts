// WS-3.2 (fortify plan): resize-box math shared by Canvas + SlideStage
// (verified byte-identical copies before extraction; the pure battery in
// scripts/verify-fig-geometry.ts pins bit-for-bit equality with the originals).
// Framework-free — no Svelte, no DOM.

import type { Rect } from "../geometry";
import type { Handle } from "./handles";

/** New selection box for dragging `h` to local point `lp`; `shift` keeps the
 *  original aspect (scaling about the anchored corner/edge). Sizes floor at 1. */
export function computeResizeBox(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean): Rect {
  let x = ob.x,
    y = ob.y,
    w = ob.w,
    hh = ob.h;
  const right = ob.x + ob.w;
  const bottom = ob.y + ob.h;
  if (h.includes("w")) {
    x = lp.x;
    w = right - lp.x;
  }
  if (h.includes("e")) w = lp.x - ob.x;
  if (h.includes("n")) {
    y = lp.y;
    hh = bottom - lp.y;
  }
  if (h.includes("s")) hh = lp.y - ob.y;
  if (shift && ob.w > 0 && ob.h > 0) {
    const s = Math.max(w / ob.w, hh / ob.h);
    w = ob.w * s;
    hh = ob.h * s;
    if (h.includes("w")) x = right - w;
    if (h.includes("n")) y = bottom - hh;
  }
  return { x, y, w: Math.max(1, w), h: Math.max(1, hh) };
}
