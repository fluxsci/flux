// WS-3.2 (fortify plan): resize-box math shared by Canvas + SlideStage
// (verified byte-identical copies before extraction; the pure battery in
// scripts/verify-fig-geometry.ts pins bit-for-bit equality with the originals).
// Framework-free — no Svelte, no DOM.

import type { Rect } from "../geometry";
import type { Handle } from "./handles";

/** New selection box for dragging `h` to local point `lp`; `shift` keeps the
 *  original aspect (scaling about the anchored corner/edge). Sizes floor at 1. */
export function computeResizeBox(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean): Rect {
  const horizontal = h.includes("w") || h.includes("e");
  const vertical = h.includes("n") || h.includes("s");
  const right = ob.x + ob.w;
  const bottom = ob.y + ob.h;
  let w = h.includes("w") ? right - lp.x : h.includes("e") ? lp.x - ob.x : ob.w;
  let height = h.includes("n") ? bottom - lp.y : h.includes("s") ? lp.y - ob.y : ob.h;
  const keepAspect = shift && ob.w > 0 && ob.h > 0;
  if (keepAspect) {
    // A one-axis handle must be allowed to shrink. The inactive axis does not
    // contribute a spurious ratio of 1. Corners retain the dominant-axis rule.
    const ratio = horizontal && vertical ? Math.max(w / ob.w, height / ob.h)
      : horizontal ? w / ob.w : height / ob.h;
    const scale = Math.max(ratio, 1 / ob.w, 1 / ob.h);
    w = ob.w * scale;
    height = ob.h * scale;
  } else {
    w = Math.max(1, w);
    height = Math.max(1, height);
  }
  return { x: h.includes("w") ? (!keepAspect && right - lp.x >= 1 ? lp.x : right - w) : ob.x,
    y: h.includes("n") ? (!keepAspect && bottom - lp.y >= 1 ? lp.y : bottom - height) : ob.y, w, h: height };
}
