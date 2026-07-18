// Shift-constrained node dragging (node-edit mode, pure math — no DOM, no
// stores): while shift is held, a node's movement is limited to the closest of
// horizontal, vertical, or the directions of the path segments flanking that
// node — Figma-style axis constraint, computed from the ORIGINAL drag-start
// geometry so the axes stay stable through the drag. Gated in
// verify-interact-core.ts.

import type { VectorNode } from "../types";
import { segsFromNodes, segTangent } from "../path";

export interface Axis {
  x: number;
  y: number;
}

/** Candidate constraint axes for moving node `i`: H, V, plus the unit tangents
 *  of the flanking segments AT the node (t=1 of the incoming, t=0 of the
 *  outgoing — exact for straights, endpoint tangents for curves). Near-parallel
 *  axes dedupe (undirected, |cross| < sin 3°), so a smooth node's two mirrored
 *  tangents contribute one axis and an axis-aligned segment folds into H/V. */
export function nodeMoveAxes(orig: VectorNode[], closed: boolean, i: number): Axis[] {
  const axes: Axis[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  const segs = segsFromNodes(orig, closed);
  const add = (a: Axis) => {
    const L = Math.hypot(a.x, a.y);
    if (L < 1e-9) return;
    const u = { x: a.x / L, y: a.y / L };
    if (axes.some((b) => Math.abs(u.x * b.y - u.y * b.x) < 0.05)) return;
    axes.push(u);
  };
  // segment s runs orig[s] → orig[(s+1)%n]; incoming to node i is s = i−1
  // (wrapping when closed), outgoing is s = i (absent on an open path's ends).
  const inIdx = i - 1 >= 0 ? i - 1 : closed ? segs.length - 1 : -1;
  const outIdx = i < segs.length ? i : -1;
  if (inIdx >= 0 && segs[inIdx]) add(segTangent(segs[inIdx], 1));
  if (outIdx >= 0 && segs[outIdx]) add(segTangent(segs[outIdx], 0));
  return axes;
}

/** Project (dx,dy) onto the axis with the largest |projection| (the closest
 *  direction). Returns the constrained delta + the chosen axis (for guides). */
export function constrainDelta(dx: number, dy: number, axes: Axis[]): { dx: number; dy: number; axis: Axis } {
  let best = axes[0] ?? { x: 1, y: 0 };
  let bestDot = -Infinity;
  for (const a of axes) {
    const d = Math.abs(dx * a.x + dy * a.y);
    if (d > bestDot) {
      bestDot = d;
      best = a;
    }
  }
  const t = dx * best.x + dy * best.y;
  return { dx: best.x * t, dy: best.y * t, axis: best };
}
