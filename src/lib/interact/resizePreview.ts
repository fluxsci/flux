// Resize preview without re-rendering (perf 2026-09-30). A plot's preview used to be an overlay
// COPY re-mounted on every pointermove (its box is part of mountPlot's content signature, so each
// move = importNode + prefixIds + overrides + view + pt-true compensation of the whole plot,
// ~120 ms for a 3k-node plot → ~7 fps). Instead the LIVE scene group carries a transient CSS
// transform mapping the element's original rendering onto its remapped box, and the single
// commit on release renders it once (with true-pt text and strokes).
//
// Element.svelte renders an element as  T(c)·R(θ)·F·T(−c) · content(box)  (rotation, then flip,
// both about the bbox centre c). A box-only remap stretches the content by S = diag(w'/w, h'/h)
// about the centre, in the element's LOCAL axes, so the rendering at the new box is
//   T(c')·R(θ')·F'·S·F⁻¹·R(−θ)·T(−c) · rendering(old box)
// and F, F', S are diagonal, so F'·S·F⁻¹ = diag(f'x·fx·sx, f'y·fy·sy). Cardinal rotations map the
// axes exactly and oblique ones are forced uniform (resizeRemap's contract), so no shear appears.
import type { Element } from "../types";
import { elementBBox } from "../geometry";

/** Element kinds whose resize preview is the transient transform (the rest keep the overlay
 *  copy, which is cheap for them). A plot's box is pure geometry at render time: the outer
 *  <svg> gets width/height with preserveAspectRatio="none" over a fixed viewBox, so the only
 *  non-affine part is pt-true compensation — stretched during the drag, exact at release. */
export const transientResizeKind = (el: Element): boolean => el.type === "plot";

const num = (v: number) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));

/** CSS transform (figure-local user units; px == user unit on an SVG <g>) taking the element's
 *  rendering at `orig` to its rendering at `next`. Null when the box is degenerate. */
export function resizePreviewTransform(orig: Element, next: Element): string | null {
  const a = elementBBox(orig);
  const b = elementBBox(next);
  if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return null;
  // The element's LOCAL (pre-rotation) width/height carry the stretch; elementBBox of a rotated
  // element is still its local box (Element.svelte pivots on its centre), so the ratio is local.
  const sx = (b.w / a.w) * (orig.flipX ? -1 : 1) * (next.flipX ? -1 : 1);
  const sy = (b.h / a.h) * (orig.flipY ? -1 : 1) * (next.flipY ? -1 : 1);
  const t0 = orig.rotation ?? 0;
  const t1 = next.rotation ?? 0;
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  const nx = b.x + b.w / 2, ny = b.y + b.h / 2;
  const rot1 = t1 ? ` rotate(${num(t1)}deg)` : "";
  const rot0 = t0 ? ` rotate(${num(-t0)}deg)` : "";
  return `translate(${num(nx)}px, ${num(ny)}px)${rot1} scale(${num(sx)}, ${num(sy)})${rot0} translate(${num(-cx)}px, ${num(-cy)}px)`;
}
