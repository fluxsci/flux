// WS-3.2 (fortify plan): resize-box math shared by Canvas + SlideStage
// (verified byte-identical copies before extraction; the pure battery in
// scripts/verify-fig-geometry.ts pins bit-for-bit equality with the originals).
// Framework-free — no Svelte, no DOM.

import type { Rect } from "../geometry";
import type { Handle } from "./handles";

/** New selection box for dragging `h` to local point `lp`; `shift` keeps the
 *  original aspect (scaling about the anchored corner/edge). Sizes floor at 1.
 *  `centre` (Alt, Figma) resizes about the box centre: the dragged edge's
 *  travel is mirrored onto the opposite edge, so the centre never moves; with
 *  `shift` the aspect is kept about the centre too. */
export function computeResizeBox(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean, centre = false): Rect {
  if (centre) return resizeAboutCentre(ob, h, lp, shift);
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
    // An EDGE drag that keeps the aspect anchors the OPPOSITE edge's midpoint
    // (Figma, 2026-10-21): the inactive axis grows symmetrically about the
    // box centre, so a right-edge Shift-drag never also walks the box
    // downward from a pinned top-left corner.
    if (horizontal !== vertical) {
      return horizontal
        ? { x: h.includes("w") ? right - w : ob.x, y: ob.y + (ob.h - height) / 2, w, h: height }
        : { x: ob.x + (ob.w - w) / 2, y: h.includes("n") ? bottom - height : ob.y, w, h: height };
    }
  } else {
    w = Math.max(1, w);
    height = Math.max(1, height);
  }
  return { x: h.includes("w") ? (!keepAspect && right - lp.x >= 1 ? lp.x : right - w) : ob.x,
    y: h.includes("n") ? (!keepAspect && bottom - lp.y >= 1 ? lp.y : bottom - height) : ob.y, w, h: height };
}

/** The Alt (from-centre) law: the box the plain drag would make, then every
 *  driven axis grows symmetrically — the moved edge's travel is applied to the
 *  opposite edge in reverse — about the ORIGINAL centre. Pure, monotone, and
 *  exactly the plain box when no edge moved. Sizes floor at 1 (so a drag past
 *  the centre stops at a 1-px box rather than flipping). */
export function resizeAboutCentre(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean): Rect {
  const cx = ob.x + ob.w / 2;
  const cy = ob.y + ob.h / 2;
  const horizontal = h.includes("w") || h.includes("e");
  const vertical = h.includes("n") || h.includes("s");
  // half-sizes from the pointer's distance to the centre along each driven axis
  let hw = horizontal ? Math.abs(lp.x - cx) : ob.w / 2;
  let hh = vertical ? Math.abs(lp.y - cy) : ob.h / 2;
  const keepAspect = shift && ob.w > 0 && ob.h > 0;
  if (keepAspect) {
    const ratio = horizontal && vertical ? Math.max(hw / (ob.w / 2), hh / (ob.h / 2)) : horizontal ? hw / (ob.w / 2) : hh / (ob.h / 2);
    const scale = Math.max(ratio, 0.5 / ob.w, 0.5 / ob.h);
    hw = (ob.w / 2) * scale;
    hh = (ob.h / 2) * scale;
  }
  hw = Math.max(0.5, hw);
  hh = Math.max(0.5, hh);
  return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
}
