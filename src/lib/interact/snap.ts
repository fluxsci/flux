// WS-3.2 (fortify plan): edge snapping shared by Canvas + SlideStage.
// `snap` was a byte-identical copy in both; `boxSnapTargets` generalizes the
// two hand-rolled target builders — Canvas passes the figure frame + ruler
// guides, SlideStage passes the stage frame and no guides. Framework-free.

import { elementBBox } from "../geometry";
import type { ElementBase } from "../types";

/** Nearest target within `thr` across all edges; `off` is the correction to
 *  add, `line` the target that grabbed (null = no snap). */
export function snap(edges: number[], targets: number[], thr: number): { off: number; line: number | null } {
  let best = thr;
  let off = 0;
  let line: number | null = null;
  for (const edge of edges)
    for (const t of targets) {
      const d = t - edge;
      if (Math.abs(d) < best) {
        best = Math.abs(d);
        off = d;
        line = t;
      }
    }
  return { off, line };
}

/** Snap targets from a frame (edges + centre) plus every non-excluded element's
 *  bbox edges/centres, plus optional ruler guides. Preserves both originals
 *  exactly: no hidden-element filtering (Canvas never filtered here). */
export function boxSnapTargets<E extends ElementBase>(
  els: readonly E[],
  excludeIds: Set<string>,
  frame: { w: number; h: number },
  guides?: { x?: number[]; y?: number[] },
): { xs: number[]; ys: number[] } {
  const xs = [0, frame.w, frame.w / 2];
  const ys = [0, frame.h, frame.h / 2];
  for (const el of els) {
    if (excludeIds.has(el.id)) continue;
    const b = elementBBox(el);
    xs.push(b.x, b.x + b.w, b.x + b.w / 2);
    ys.push(b.y, b.y + b.h, b.y + b.h / 2);
  }
  if (guides?.x) xs.push(...guides.x);
  if (guides?.y) ys.push(...guides.y);
  return { xs, ys };
}
