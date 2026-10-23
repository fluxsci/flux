// ---------------------------------------------------------------------------
// Flux Slide — GLIDE LANES (R4_T9 §3.1, WP 2.5). A crossing-aware add-on to the blind per-glide
// `crossArc` of a text morph. Pure + DOM-free and deliberately NEUTRAL (it imports only
// `crossArc`): T5 can route hand-off / set flights through the same planner later.
//
// Law: today's look is the BASE. Every glide keeps `crossArc` unless the planner finds that today's
// paths collide (ink boxes overlap > ENGAGE at some progress); only those *active* glides move onto a
// lane, chosen to minimise total collision against EVERY glide of the morph (static and non-active
// ones are fixed obstacles carrying their classic arc). More than `maxActive` colliding glides keep
// the classic arcs (cost is quadratic; a crowd reads as a crowd either way). Deterministic,
// endpoint-exact (the offset is 0 at progress 0 and 1, so a flight lands ON the static render),
// and a pure function of geometry, so seeks / reverse / video-by-seek are exact. UNCONDITIONAL:
// there is no flag; it can only change a path that collides today.
//
// Sign (ruling X6): a lane is a SIGNED BOW in stage px, and its normal is the canvas-wide
// `arcBox`/`arcOffset` one, (−dy, dx)/d. Positive bow = the clockwise side of travel (DOWN for a
// rightward glide); today's `crossArc` lifts rightward movers and dips leftward ones, i.e. the
// LEFT of travel, which is a NEGATIVE bow here. `LEFT_OF_TRAVEL` names it.
// ---------------------------------------------------------------------------
import { crossArc } from "./textMatch";

/** One word's flight, box-relative: baseline start/end, drawn width and font size (stage px). */
export interface GlideGeom { ax: number; ay: number; bx: number; by: number; w: number; size: number }
/** Optional keep-inside box in the same (box-relative) coordinates; a lane that would push a glide's
 *  ink (y - size .. y + 0.25 size, x .. x + w) outside it is refused. */
export interface LaneBounds { x0: number; y0: number; x1: number; y1: number }

/** FROZEN (gate-pinned): never tune silently. */
export const LANE_POLICY = Object.freeze({
  /** collision = x-extents overlap by more than this many em AND |dy| < bandEm (em) at the same progress */
  marginEm: 0.08, bandEm: 0.6, steps: 24,
  /** a classic path counts as colliding only when depth (1 - |dy|/band) exceeds this: |dy| < 0.45 em */
  engage: 0.1,
  /** more active glides than this: leave the classic arcs alone (cost is quadratic) */
  maxActive: 16,
  /** work bound: each active glide is scored against at most this many obstacles (the deepest by the wide band), so a
   *  dense page (48 glides: a long reversal between two static paragraphs) costs the same as a dozen-word one */
  maxObstacles: 12,
  /** lane ladder in em (the sign is tried both ways, the travel-preferred side first) */
  ladderEm: Object.freeze([0.3, 0.6, 0.9, 1.2]),
  sweeps: 4,
});

/** The sign of a bow that bends to the LEFT of travel (rightward glide: up). It is today's `crossArc` side. */
export const LEFT_OF_TRAVEL = -1;

export interface LaneOffset { dx: number; dy: number }

/** The offset a bow adds at progress t (zero at both ends): (−dy, dx)/d · bow · 4t(1−t), the same normal as
 *  `arcBox` (tween.ts). Positive bow = clockwise of travel (down for a rightward glide). */
export function bowOffset(g: GlideGeom, bow: number, t: number): LaneOffset {
  if (!bow) return { dx: 0, dy: 0 };
  const dx = g.bx - g.ax, dy = g.by - g.ay, d = Math.hypot(dx, dy) || 1, k = bow * 4 * t * (1 - t);
  return { dx: (-dy / d) * k, dy: (dx / d) * k };
}
/** The classic offset (vertical only): today's `crossArc`, bit for bit. */
export function classicOffset(g: GlideGeom, t: number): LaneOffset {
  return { dx: 0, dy: crossArc(g.bx - g.ax, g.by - g.ay, g.size, t) };
}

type Path = (t: number) => { x: number; y: number };
const pathOf = (g: GlideGeom, bow: number | undefined): Path => (t) => {
  const o = bow === undefined ? classicOffset(g, t) : bowOffset(g, bow, t);
  return { x: g.ax + (g.bx - g.ax) * t + o.dx, y: g.ay + (g.by - g.ay) * t + o.dy };
};

/** Deepest collision of two glides over the morph (0 = never; 1 = same baseline). `bandEm` > the policy band
 *  widens the vertical band (used only to decide who can ever interact). */
export function depth(g: GlideGeom, h: GlideGeom, pg: Path, ph: Path, bandEm: number = LANE_POLICY.bandEm): number {
  const P = LANE_POLICY, band = bandEm * (g.size + h.size) / 2;
  let worst = 0;
  for (let n = 1; n < P.steps; n++) {
    const t = n / P.steps, p = pg(t), q = ph(t);
    const ox = Math.min(p.x + g.w, q.x + h.w) - Math.max(p.x, q.x);
    if (ox > P.marginEm * g.size) worst = Math.max(worst, 1 - Math.abs(p.y - q.y) / band);
  }
  return Math.max(0, worst);
}

/** The optimiser's overlap measure: mean over the steps of (x overlap × vertical overlap), in em² — proportional
 *  to the ink area the viewer sees overprinted, so a lane that merely shortens a collision wins over one that
 *  only lowers its peak. */
export function overlapCost(g: GlideGeom, h: GlideGeom, pg: Path, ph: Path): number {
  const P = LANE_POLICY, band = P.bandEm * (g.size + h.size) / 2, em2 = ((g.size + h.size) / 2) ** 2;
  let sum = 0;
  for (let n = 1; n < P.steps; n++) {
    const t = n / P.steps, p = pg(t), q = ph(t);
    const ox = Math.min(p.x + g.w, q.x + h.w) - Math.max(p.x, q.x), oy = band - Math.abs(p.y - q.y);
    if (ox > 0 && oy > 0) sum += ox * oy;
  }
  return sum / (P.steps - 1) / em2;
}

/** Does the path keep the glide's ink inside `b` at every planner station? */
function insideBounds(g: GlideGeom, bow: number | undefined, b: LaneBounds): boolean {
  const p = pathOf(g, bow);
  for (let n = 1; n < LANE_POLICY.steps; n++) {
    const q = p(n / LANE_POLICY.steps);
    if (q.x < b.x0 || q.x + g.w > b.x1 || q.y - g.size < b.y0 || q.y + 0.25 * g.size > b.y1) return false;
  }
  return true;
}

/** Per-glide signed bow in stage px, or `undefined` = keep today's `crossArc` (every glide that does not collide,
 *  and ALL of them when more than `maxActive` collide). */
export function glideLanes(gs: GlideGeom[], bounds?: LaneBounds): (number | undefined)[] {
  const P = LANE_POLICY, n = gs.length, out: (number | undefined)[] = new Array(n).fill(undefined);
  if (n < 2) return out;
  const classic = gs.map((g) => pathOf(g, undefined));
  const active: number[] = [];
  for (let i = 0; i < n; i++) {
    let hit = false;
    for (let j = 0; j < n && !hit; j++) if (j !== i && depth(gs[i], gs[j], classic[i], classic[j]) > P.engage) hit = true;
    if (hit) active.push(i);
  }
  if (!active.length || active.length > P.maxActive) return out;
  const size = Math.max(...gs.map((g) => g.size));
  // obstacles for glide i: every other glide that can come within the widest lane + a band
  const reach = (P.ladderEm[P.ladderEm.length - 1] + P.bandEm) * size;
  const wide = (g: GlideGeom, h: GlideGeom, pg: Path, ph: Path) => depth(g, h, pg, ph, reach / ((g.size + h.size) / 2));
  const straight = gs.map((g) => pathOf(g, 0));
  // the deepest `maxObstacles` neighbours of each active glide (stable: ties keep the lower index)
  const obstacles = (i: number): number[] => {
    const near: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; const d = wide(gs[i], gs[j], straight[i], straight[j]); if (d > 0) near.push({ j, d }); }
    if (near.length > P.maxObstacles) near.sort((p, q) => q.d - p.d || p.j - q.j).splice(P.maxObstacles);
    return near.map((o) => o.j).sort((p, q) => p - q);
  };
  const nbr = new Map<number, number[]>(active.map((i) => [i, obstacles(i)]));
  const cur = new Array<number | undefined>(n).fill(undefined); // current lane per glide (undefined = classic)
  const pathNow = (j: number) => pathOf(gs[j], cur[j]);
  const cost = (i: number, bow: number | undefined) => { const pi = pathOf(gs[i], bow); return nbr.get(i)!.reduce((c, j) => c + overlapCost(gs[i], gs[j], pi, pathNow(j)), 0); };
  const total = () => active.reduce((c, i) => c + cost(i, cur[i]), 0);
  const travel = (i: number) => Math.hypot(gs[i].bx - gs[i].ax, gs[i].by - gs[i].ay);
  const mag = (v: number | undefined) => (v === undefined ? 0 : Math.abs(v));
  const cap = (i: number) => Math.max(0.3 * gs[i].size, 0.25 * travel(i));
  const baseline = total();
  // Start every active glide on its first lane, on the crossArc side (left of travel: rightward lifts, leftward
  // dips, down-movers go east, up-movers west: opposite travel takes opposite sides), then coordinate descent over
  // {classic} U ladder; ties keep the smaller excursion.
  for (const i of active) { const m = LEFT_OF_TRAVEL * P.ladderEm[0] * gs[i].size; if (Math.abs(m) <= cap(i) + 1e-9 && (!bounds || insideBounds(gs[i], m, bounds))) cur[i] = m; }
  for (let sweep = 0; sweep < P.sweeps; sweep++) {
    let moved = false;
    for (const i of active) {
      let best = cur[i], bestCost = bounds && !insideBounds(gs[i], best, bounds) ? Infinity : cost(i, best);
      const cands: (number | undefined)[] = [undefined, ...(bounds ? [0] : []), ...P.ladderEm.flatMap((em) => [LEFT_OF_TRAVEL * em * gs[i].size, -LEFT_OF_TRAVEL * em * gs[i].size])];
      for (const m of cands) {
        // the classic arc is refused too when it would leave the box (then straight, bow 0, is the floor)
        if ((m !== undefined && Math.abs(m) > cap(i) + 1e-9) || (bounds && !insideBounds(gs[i], m, bounds))) continue;
        const c = cost(i, m);
        if (c < bestCost - 1e-9 || (Math.abs(c - bestCost) <= 1e-9 && mag(m) < mag(best) - 1e-9)) { best = m; bestCost = c; }
      }
      if (best !== cur[i]) { cur[i] = best; moved = true; }
    }
    if (!moved) break;
  }
  // never worse than today by the planner's own metric
  if (total() >= baseline - 1e-9) return out;
  active.forEach((i) => { out[i] = cur[i]; });
  return out;
}

/** The offset one glide adds at clamped progress t, whichever law applies. */
export function laneOffset(g: GlideGeom, lane: number | undefined, t: number): LaneOffset {
  return lane === undefined ? classicOffset(g, t) : bowOffset(g, lane, t);
}
