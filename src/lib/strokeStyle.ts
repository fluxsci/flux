// T7 join policy: ONE place that says how a stroke's corners are drawn, for the static serializer's contract
// (export.ts) and every live morph layer (player/transform.ts, handoff.ts).
// The static look is unchanged (existing decks stay byte-identical). export.ts writes NO stroke-linejoin on rect,
// ellipse, line (SVG default MITER, limit 4) and "round" on path / polyline vees. Only kinds that HAVE corners
// matter: rect (miter) and path (round); ellipse and line have no corner to join, so they carry no preference.
export type StrokeJoin = "miter" | "round";
/** The corner join a resting element of this kind is drawn with, or null when the kind has no corners. */
export function cornerJoinOf(el: { type: string }): StrokeJoin | null {
  return el.type === "rect" ? "miter" : el.type === "path" ? "round" : null;
}
/** The join a MORPH layer draws with at progress t: the source's until the midpoint, the destination's after; a kind with
 *  no corners inherits the other side's, so rect -> ellipse stays miter all the way (no switch) and the first/last frame of a
 *  Become match the resting source/destination. Falls back to round (the morph layers' historical value). */
export function morphJoin(pre: { type: string }, end: { type: string }, t: number): StrokeJoin {
  return pairJoin(cornerJoinOf(pre), cornerJoinOf(end), t);
}
/** The same law for two sides that already carry their resting join (the hand-off and glyph flights read it from
 *  `OutlinePaint.join`): the side just left wins, a side with no preference inherits the other's, round if neither. */
export function pairJoin(a: StrokeJoin | null | undefined, b: StrokeJoin | null | undefined, t: number): StrokeJoin {
  return (t < 0.5 ? a ?? b : b ?? a) ?? "round";
}
