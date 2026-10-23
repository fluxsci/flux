// ---------------------------------------------------------------------------
// Flux Slide — ARC SUGGESTIONS (T5). Pure and DOM-free (twin-engine rule: the GUI's
// "Suggest arcs", the CLI/MCP verb and the gates all call this one module).
//
// Two boxes that swap places pass THROUGH each other on straight paths. A track `arc`
// (tween.arcBox: a quadratic bend of apex arc·d/4, sign relative to each box's own travel)
// separates them — opposite displacements bend to opposite sides on their own. manim's Swap
// defaults to a 90° arc (= Flux arc 2·tan(θ/4) = 0.83); the owner's own authored arcs are 0.2–0.45
// (≈ 23–50°). `suggestArcs` finds the boxes whose flights collide and returns the smallest of
// {0.25, 0.45, 0.83} that clears them, picking each box's sign to maximise the worst clearance.
// Nothing is written here: the caller decides (authoring-time suggestion, explicit and undoable).
//
// Flights are judged on their REAL clocks (resolved start, duration, easing curve — springs may
// overshoot), not one shared eased clock, and an arc inherited from a linked style counts as authored.
// ---------------------------------------------------------------------------

import type { Slide, Track, Deck } from "./types";
import type { Element } from "../types";
import { elementBBox } from "../geometry";
import { familyOf } from "./family";
import { hasPartBinding, isHandoff } from "./targets";
import { transformPreState, transformEndState } from "./tween";
import { resolveBeat } from "./resolve";
import { resolveCurve } from "./curves";
import { trackDuration } from "./timing";

export interface Rect { x: number; y: number; w: number; h: number }
/** One box move. `start`/`duration`/`ease` (ms; raw → eased u) default to the SHARED unit clock (0, 1, identity). */
export interface FlightBox { id: string; pre: Rect; end: Rect; start?: number; duration?: number; ease?: (raw: number) => number }

/** Candidate magnitudes, smallest first: the owner's modal 0.25 and 0.45 (≈ 28° / 50°), then manim's 90° Swap. */
export const ARC_CANDIDATES = [0.25, 0.45, 0.83] as const;
/** manim's Swap default (2·tan(90°/4)): the top of the ladder. */
export const SWAP_ARC = 0.83;
/** Stage units of daylight a suggestion aims for between two flights. */
export const CLEAR_MARGIN = 2;
/** Exhaustive sign search up to this many flagged flights (2^8 masks); greedy coordinate descent beyond. */
export const EXACT_SIGNS = 8;
/** More flagged flights than this: no suggestion (the verb says why). A dozen alternating bows already read as a
 *  chorus; a denser tangle (DNA rungs, a molecule) wants staggering, not arcs. */
export const MAX_FLAGGED = 12;
/** When no magnitude clears every pair, take the smallest that earns this share of the ladder's best gain. */
export const GAIN_SHARE = 0.85;
const STEPS = 48;
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const unit = (raw: number) => raw;

/** The pose of a box at absolute time T with a given arc (arcBox's formula on the centre; u is NOT clamped,
 *  exactly as `compile.sample` hands arcBox the unclamped eased progress). */
function poseAt(b: FlightBox, T: number, arc: number) {
  const dur = b.duration ?? 1, raw = dur > 0 ? Math.min(1, Math.max(0, (T - (b.start ?? 0)) / dur)) : 1;
  const u = (b.ease ?? unit)(raw);
  const c0 = centre(b.pre), c1 = centre(b.end);
  const bend = arc * u * (1 - u), dx = c1.x - c0.x, dy = c1.y - c0.y;
  return { x: c0.x + dx * u - dy * bend, y: c0.y + dy * u + dx * bend,
    w: b.pre.w + (b.end.w - b.pre.w) * u, h: b.pre.h + (b.end.h - b.pre.h) * u };
}
const span = (b: FlightBox) => [b.start ?? 0, (b.start ?? 0) + (b.duration ?? 1)] as const;

/** Worst Chebyshev box gap between two flights over the time both are in motion (open interval of the
 *  union of their windows; < 0 = overlapping at some moment). */
export function flightGap(a: FlightBox, arcA: number, b: FlightBox, arcB: number): number {
  const [a0, a1] = span(a), [b0, b1] = span(b), lo = Math.min(a0, b0), hi = Math.max(a1, b1);
  let worst = Infinity;
  for (let i = 1; i < STEPS; i++) {
    const T = lo + (hi - lo) * i / STEPS, p = poseAt(a, T, arcA), q = poseAt(b, T, arcB);
    worst = Math.min(worst, Math.max(Math.abs(p.x - q.x) - (p.w + q.w) / 2, Math.abs(p.y - q.y) - (p.h + q.h) / 2));
  }
  return worst;
}
const overlapsAt = (a: Rect, b: Rect) => Math.abs(centre(a).x - centre(b).x) < (a.w + b.w) / 2 && Math.abs(centre(a).y - centre(b).y) < (a.h + b.h) / 2;
const travel = (b: FlightBox) => Math.hypot(centre(b.end).x - centre(b.pre).x, centre(b.end).y - centre(b.pre).y);

/** Pairs of flights that collide on their CURRENT paths (`fixed` = arcs already in force, by id; the rest are
 *  straight): they overlap mid-move although they are not overlapping at the start or at the end. A pair that
 *  overlaps at either end is composed that way on purpose (a label inside its box) and no arc can clear it. */
export function collidingFlights(boxes: FlightBox[], fixed: Record<string, number> = {}): number[][] {
  const pairs: number[][] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (travel(a) < 4 && travel(b) < 4) continue; // neither really moves
    if (overlapsAt(a.pre, b.pre) || overlapsAt(a.end, b.end)) continue;
    if (flightGap(a, fixed[a.id] ?? 0, b, fixed[b.id] ?? 0) < 0) pairs.push([i, j]);
  }
  return pairs;
}

export interface ArcSuggestion {
  /** id → arc for the flights to write (UNSET flights only; absent ids stay straight). */
  arcs: Record<string, number>;
  /** How many flight pairs collide on today's paths. */
  collisions: number;
  /** Why `arcs` is empty although something collides (shown by the Animator / returned by the verb). */
  reason?: string;
}

/** `fixed` arcs (authored or style-inherited, 0 included) are never changed and are honoured when judging a collision. */
export function suggestArcs(boxes: FlightBox[], fixed: Record<string, number> = {}): ArcSuggestion {
  const pairs = collidingFlights(boxes, fixed);
  const flagged = [...new Set(pairs.flat())].filter((n) => fixed[boxes[n].id] === undefined).sort((a, b) => a - b);
  if (!pairs.length) return { arcs: {}, collisions: 0 };
  if (!flagged.length) return { arcs: {}, collisions: pairs.length, reason: "every colliding move already has an arc" };
  if (flagged.length > MAX_FLAGGED) return { arcs: {}, collisions: pairs.length, reason: `too many colliding moves (${flagged.length}); arcs cannot untangle them` };
  const slot = new Map(flagged.map((n, k) => [n, k] as const));
  const arcOf = (n: number, arcs: number[]) => fixed[boxes[n].id] ?? (slot.has(n) ? arcs[slot.get(n)!] : 0);
  // judged on the pairs a suggestion can change (at least one flight unset): a collision between two flights whose arcs are both set is
  // the author's, and must not block the suggestion for the others
  const open = pairs.filter(([i, j]) => slot.has(i) || slot.has(j));
  const worstGap = (arcs: number[]) => {
    let w = Infinity;
    for (const [i, j] of open) w = Math.min(w, flightGap(boxes[i], arcOf(i, arcs), boxes[j], arcOf(j, arcs)));
    return w;
  };
  const straight = worstGap(flagged.map(() => 0));
  // The sign each flight bends to: exhaustive while 2^k is small, else greedy coordinate descent from all-positive.
  const bestSigns = (mag: number): { arcs: number[]; gap: number } => {
    const k = flagged.length;
    if (k <= EXACT_SIGNS) {
      let top = { arcs: [] as number[], gap: -Infinity };
      for (let mask = 0; mask < 1 << k; mask++) {
        const arcs = flagged.map((_, n) => (mask >> n & 1 ? -mag : mag)), gap = worstGap(arcs);
        if (gap > top.gap + 1e-9) top = { arcs, gap };
      }
      return top;
    }
    const arcs = flagged.map(() => mag);
    let gap = worstGap(arcs);
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let n = 0; n < k; n++) {
        arcs[n] = -arcs[n];
        const g = worstGap(arcs);
        if (g > gap + 1e-9) { gap = g; moved = true; } else arcs[n] = -arcs[n];
      }
      if (!moved) break;
    }
    return { arcs, gap };
  };
  // The smallest magnitude that clears every pair; failing that (equal boxes swapping cannot be cleared by any arc
  // <= 1) the smallest that earns GAIN_SHARE of the best improvement over straight — never a bigger bow than needed.
  const tops = ARC_CANDIDATES.map((mag) => bestSigns(mag));
  let best: { arcs: number[]; gap: number } | null = tops.find((t) => t.gap >= CLEAR_MARGIN) ?? null;
  if (!best) {
    const bestGain = Math.max(...tops.map((t) => t.gap - straight));
    if (bestGain > 1e-6) best = tops.find((t) => t.gap - straight >= GAIN_SHARE * bestGain) ?? null;
  }
  if (!best) return { arcs: {}, collisions: pairs.length, reason: "no arc improves these moves" };
  return { arcs: Object.fromEntries(flagged.map((n, k) => [boxes[n].id, best!.arcs[k]])), collisions: pairs.length };
}

/** The beat's plain box-move tracks as flights on their resolved clocks (hand-offs and part-bound tracks fly their own pieces).
 *  `arc` is the RESOLVED arc (own value, else the linked style's); `own` says whether the track itself stores one. */
export function beatFlights(slide: Slide, beatIndex: number, deck: Pick<Deck, "animStyles"> = {}): { track: Track; arc: number | undefined; box: FlightBox }[] {
  const beat = slide.beats[beatIndex];
  if (!beat) return [];
  const resolved = resolveBeat(beat, deck).tracks;
  const out: { track: Track; arc: number | undefined; box: FlightBox }[] = [];
  beat.tracks.forEach((track, i) => {
    const r = resolved[i];
    if (track.disabled || familyOf(r) !== "transform" || isHandoff(r) || hasPartBinding(r) || !r.to?.state) return;
    const pre = transformPreState(slide, track.target, beatIndex);
    if (!pre) return;
    const end: Element = transformEndState(pre, r);
    const ease = resolveCurve(r, "transform").fn;
    out.push({ track, arc: r.arc, box: {
      id: track.id ?? track.target, pre: elementBBox({ ...pre, rotation: 0 }), end: elementBBox({ ...end, rotation: 0 }),
      start: Math.max(0, r.start ?? 0), duration: Math.max(1, trackDuration(r)), ease } });
  });
  return out;
}

/** Suggestions for the tracks of one beat whose RESOLVED arc is unset; a resolved 0 stays straight. */
export function suggestBeatArcs(slide: Slide, beatIndex: number, deck: Pick<Deck, "animStyles"> = {}): ArcSuggestion {
  const flights = beatFlights(slide, beatIndex, deck);
  const fixed = Object.fromEntries(flights.filter((f) => f.arc !== undefined).map((f) => [f.box.id, f.arc!]));
  return suggestArcs(flights.map((f) => f.box), fixed);
}
