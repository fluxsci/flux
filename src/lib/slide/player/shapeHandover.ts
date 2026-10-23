// ---------------------------------------------------------------------------
// The hand-over of a SHAPE flight to the renders at its two ends (R2 F3; the law lane F2 built for text, textMorph.ts HANDOVER_EPS).
//
// A flight is drawn by the player (a stroke band, the path stroker over a resampled chain, pieces re-cut at arbitrary stations) and the ends
// are drawn by the browser from the element's own markup. The pictures are the same shape and differ by the rasteriser alone: about 0.1 px
// along a thick ring's edge (an exact stroke band against the path stroker), 0.1 px along pieces cut at other stations than the resting ellipse.
// Seen as a seam that is a step of 8 to 20 stage px^2 on the first moving frame and on the landing frame. The frames beside the seam differ by
// the motion itself, so the seam is the only thing a viewer could feel.
//
// ONE law: the resting render (A at the start, B at the end) and the flight are ADDED (plus-lighter, inside an isolated host, set once and never
// toggled) with weights from the DISTANCE still to travel, over the first and the last HANDOVER_EPS stage px of change. The window is a distance,
// not a time (a short move gets a long hand-over), the two pictures are never more than HANDOVER_EPS apart while both show, and the first moving
// frame is A and the landing frame is B. Every term of change belongs in the distance: positions, a turn, a stroke that thickens, a colour that
// changes (lane F2's lesson: a weight that reads only position freezes a glide whose look changes in place).
//
// Pure: the weights are a function of the frame alone, so forward, reverse and shuffled seeks are identical.
// ---------------------------------------------------------------------------
import type { VectorNode } from "../../types";
import { HANDOVER_EPS, handoverEase, handoverWeights } from "./textMorph";

export { HANDOVER_EPS };

/** The opacity of the three layers while the flight shows: A (the start render), M (the flight), B (the end render). They sum to 1 and are ADDED.
 *  `away` / `settle` = how far the flight has travelled from A / still has to travel to B (stage px). A flight whose whole travel is shorter than the
 *  window crossfades A into B directly (the two windows overlap: the weights are normalised). The same law as the text hand-over (textMorph.ts). */
export function shapeWeights(away: number, settle: number): { a: number; m: number; b: number } {
  return handoverWeights({ entry: handoverEase(away), landing: 1 - handoverEase(settle) });
}

/** A layer whose weight is a thousandth short of 1 is drawn as an effect layer (group opacity), and the browser rounds gradients and translucent fills
 *  a level or two differently there than in the direct paint (a viridis fill: 223,000 px one to two levels off, which the settle sweep's raw windows
 *  read as a second-frame pop). The weights are therefore SNAPPED: a layer within SNAP of owning the picture owns it, the others are not drawn, so the
 *  frames before the hand-over really starts are exactly the end render and no layer state changes until a layer has a visible share. */
export const SNAP = 0.001;
export function snapWeights(w: { a: number; m: number; b: number }): { a: number; m: number; b: number } {
  for (const k of ["a", "m", "b"] as const) if (w[k] >= 1 - SNAP) return { a: 0, m: 0, b: 0, [k]: 1 } as { a: number; m: number; b: number };
  return { a: w.a < SNAP ? 0 : w.a, m: w.m < SNAP ? 0 : w.m, b: w.b < SNAP ? 0 : w.b };
}

/** The points of a path that make its shape, flat [x0, y0, x1, y1, ...] in stage px: every node's anchor, then the end points of its two handles
 *  (a handle that is absent sits on its anchor). A change that lives in the handles alone (a circle's round handles becoming a diamond's none, the
 *  anchors staying put) is a change of shape: measuring anchors only left the picture on A until an anchor finally moved, then jumped to the flight. */
export function pathPoints(nodes: readonly VectorNode[], dx = 0, dy = 0): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    const x = dx + n.x, y = dy + n.y;
    out.push(x, y, x + (n.hIn?.dx ?? 0), y + (n.hIn?.dy ?? 0), x + (n.hOut?.dx ?? 0), y + (n.hOut?.dy ?? 0));
  }
  return out;
}

/** The furthest any point has moved: two flat [x0, y0, x1, y1, ...] arrays (stage px; `pathPoints`). Only the points both lists hold are compared. */
export function maxShift(cur: ArrayLike<number>, ref: ArrayLike<number>): number {
  let d = 0;
  const n = Math.min(cur.length, ref.length);
  for (let i = 0; i + 1 < n; i += 2) d = Math.max(d, Math.hypot(cur[i] - ref[i], cur[i + 1] - ref[i + 1]));
  return d;
}

/** What a look change (a colour, an opacity, a dash) counts for: it has all but arrived after a quarter of the flight, however little moves. */
export const LOOK_TRAVEL = 4 * HANDOVER_EPS;
