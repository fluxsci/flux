// ---------------------------------------------------------------------------
// Flux Slide — OUTLINE morphing: how one drawn kind becomes another (Become).
//
// Every kind the pen, line and shape tools can draw has an OUTLINE — one ring
// (rect, ellipse, closed path) or one open stroke (line, open path) — in the
// element's own unrotated, unflipped local frame. Two outlines are put into
// correspondence (same node count, aligned start and direction, closed rings
// cut open when the other side is a stroke) and the intermediate at time t is
// a synthetic PATH element: nodes lerped in each box's UNIT frame and mapped
// into the lerped box, style blended (OKLab colors, lerped widths/dashes),
// arrowheads carried by either side and faded by the driver.
//
// Pure and DOM-free by contract (the tween core, flux-core, the export
// runtime and the GUI all load it). The plan is built once per (pre, end)
// pair; sampling is O(nodes) per frame.
// ---------------------------------------------------------------------------

import type { Element, PathElement, VectorNode, GradientFill } from "../types";
import { elementBBox } from "../geometry";
import { lerpColor, prepareColorLerp, parseColor, formatColor } from "../color/interp";
import {
  pathD, pathToNodes, pathRender, roundCorners, reverseNodes, segsFromNodes, segLength, splitSeg, segPoint, segTangent,
  type PathSeg,
} from "../path";
import { normalMatchRings } from "./normalMatch";

export type OutlineKind = "rect" | "ellipse" | "line" | "path";
const OUTLINE_KINDS = new Set<string>(["rect", "ellipse", "line", "path"]);

/** An outline in element-local px: one ring or one open chain. */
export interface Outline {
  nodes: VectorNode[];
  closed: boolean;
}

export function hasOutline(el: Pick<Element, "type">): boolean {
  return OUTLINE_KINDS.has(el.type);
}

/** Two states of one element interpolate through an outline morph when their
 *  kinds differ (any pair of drawn kinds) or a path changes closedness. Same
 *  kind, same topology keeps the ordinary per-property tween. */
export function outlineMorphable(pre: Element, end: Element): boolean {
  if (!hasOutline(pre) || !hasOutline(end)) return false;
  if (pre.type !== end.type) return true;
  return pre.type === "path" && end.type === "path" && Boolean(pre.closed) !== Boolean(end.closed);
}

const KAPPA = 0.5522847498307936; // 4/3·tan(π/8) — the cubic circle constant
const cp = (n: VectorNode): VectorNode => ({ ...n, hIn: n.hIn && { ...n.hIn }, hOut: n.hOut && { ...n.hOut } });

/** The element's outline in its own local frame (origin = its unrotated bbox
 *  corner, flips baked in so the intermediate carries none). Null when the
 *  kind has no outline or the geometry is degenerate (< 2 nodes). */
export function elementOutline(el: Element): Outline | null {
  let out: Outline | null = null;
  const w = Math.max(0, el.width), h = Math.max(0, el.height);
  if (el.type === "rect") {
    const corners: VectorNode[] = [
      { x: 0, y: 0, type: "corner" }, { x: w, y: 0, type: "corner" },
      { x: w, y: h, type: "corner" }, { x: 0, y: h, type: "corner" },
    ];
    out = { nodes: el.cornerRadius > 0 ? roundCorners(corners, true, el.cornerRadius) : corners, closed: true };
  } else if (el.type === "ellipse") {
    const rx = w / 2, ry = h / 2, cx = rx, cy = ry, kx = rx * KAPPA, ky = ry * KAPPA;
    out = {
      nodes: [
        { x: cx + rx, y: cy, type: "smooth", hIn: { dx: 0, dy: -ky }, hOut: { dx: 0, dy: ky } },
        { x: cx, y: cy + ry, type: "smooth", hIn: { dx: kx, dy: 0 }, hOut: { dx: -kx, dy: 0 } },
        { x: cx - rx, y: cy, type: "smooth", hIn: { dx: 0, dy: ky }, hOut: { dx: 0, dy: -ky } },
        { x: cx, y: cy - ry, type: "smooth", hIn: { dx: -kx, dy: 0 }, hOut: { dx: kx, dy: 0 } },
      ],
      closed: true,
    };
  } else if (el.type === "line") {
    // the wrapper box of a line is its endpoint box — express the stroke
    // relative to THAT corner, exactly where elementBBox puts the element.
    const bx = Math.min(el.x1, el.x2), by = Math.min(el.y1, el.y2);
    out = {
      nodes: [{ x: el.x1 - bx, y: el.y1 - by, type: "corner" }, { x: el.x2 - bx, y: el.y2 - by, type: "corner" }],
      closed: false,
    };
  } else if (el.type === "path") {
    const sharp = el.nodes?.length ? el.nodes.map(cp) : pathToNodes(el.d);
    const closed = Boolean(el.closed);
    out = { nodes: el.cornerRadius && el.cornerRadius > 0 ? roundCorners(sharp, closed, el.cornerRadius) : sharp, closed };
  }
  if (!out || out.nodes.length < 2) return null;
  if (el.flipX || el.flipY) {
    // mirror about the box (the wrapper's scaleX/Y pivot is the box centre, so
    // x ↦ w − x is the same picture); the planner re-aligns winding afterwards
    const bb = elementBBox({ ...el, rotation: 0 });
    const mx = el.flipX ? bb.w : 0, my = el.flipY ? bb.h : 0;
    const sx = el.flipX ? -1 : 1, sy = el.flipY ? -1 : 1;
    out.nodes = out.nodes.map((n) => ({
      x: mx + n.x * sx, y: my + n.y * sy, type: n.type,
      ...(n.hIn ? { hIn: { dx: n.hIn.dx * sx, dy: n.hIn.dy * sy } } : {}),
      ...(n.hOut ? { hOut: { dx: n.hOut.dx * sx, dy: n.hOut.dy * sy } } : {}),
    }));
  }
  return out;
}

// --- arc-length parameterization + splitting ------------------------------------

interface Param { segs: PathSeg[]; lens: number[]; total: number }

export function parameterize(nodes: VectorNode[], closed: boolean): Param {
  const segs = segsFromNodes(nodes, closed);
  const lens = segs.map((s) => segLength(s, 24));
  return { segs, lens, total: lens.reduce((a, b) => a + b, 0) };
}

/** The point at normalized arc length s in [0,1]. Computed every time: a
 *  per-plan station memo used to sit here to offset a slow arcT; with arcT
 *  allocation-free (below) the memo measured as noise on the cold path
 *  (verify-v020-morph-startup, 2026-09-24/25) and was removed. */
export function pointAt(p: Param, s: number): { x: number; y: number } {
  if (!p.segs.length) return { x: 0, y: 0 };
  let d = Math.max(0, Math.min(1, s)) * p.total;
  for (let i = 0; i < p.segs.length; i++) {
    const len = p.lens[i];
    if (d <= len || i === p.segs.length - 1) return segPoint(p.segs[i], arcT(p.segs[i], len, Math.min(d, len)));
    d -= len;
  }
  const last = p.segs[p.segs.length - 1];
  return { x: last.x3, y: last.y3 };
}

/** Stations closer than this (normalized arc length) are one station — the
 *  same tolerance the splitter uses to skip a cut on an existing boundary, so
 *  two outlines split at one merged station list always get equal node counts. */
const STATION_EPS = 1e-5;

function mergeStations(stations: number[], eps = STATION_EPS): number[] {
  const sorted = stations.map((s) => Math.max(0, Math.min(1, s))).sort((a, b) => a - b);
  const out: number[] = [];
  for (const s of sorted) if (!out.length || s - out[out.length - 1] > eps) out.push(s);
  return out;
}

// Bernstein weights of the 16 polyline stations arcT samples, computed with the
// exact expression order segPoint uses, so each product matches it bit for bit.
const ARC_SAMPLES = 16;
const ARC_C0 = new Float64Array(ARC_SAMPLES + 1), ARC_C1 = new Float64Array(ARC_SAMPLES + 1);
const ARC_C2 = new Float64Array(ARC_SAMPLES + 1), ARC_C3 = new Float64Array(ARC_SAMPLES + 1);
for (let i = 1; i <= ARC_SAMPLES; i++) {
  const t = i / ARC_SAMPLES, u = 1 - t;
  ARC_C0[i] = u * u * u; ARC_C1[i] = 3 * u * u * t; ARC_C2[i] = 3 * u * t * t; ARC_C3[i] = t * t * t;
}

/** Parameter t on a segment at arc length `dist` from its start (bisection
 *  for curves — a cubic's t is not proportional to arc length).
 *
 *  Each step measures the left half of a de Casteljau split at t as a
 *  16-station polyline — the same quantity as
 *  `segLength(splitSeg(seg, t)[0], 16)`, with the same arithmetic, but with no
 *  allocation and `Math.sqrt` in place of `Math.hypot`. This is the hot loop of
 *  morph planning (86 of 89 ms of the first preview, 2026-09-22): the rewrite is
 *  ~12x faster and returned bit-identical t on 16,000 random segments, because
 *  the bisection only compares the length against `dist`. */
export function arcT(seg: PathSeg, len: number, dist: number): number {
  if (seg.line || len < 1e-9) return len < 1e-9 ? 0 : Math.max(0, Math.min(1, dist / len));
  if (dist <= 0) return 0;
  if (dist >= len) return 1;
  const { x0, y0, x1, y1, x2, y2, x3, y3 } = seg;
  let lo = 0, hi = 1, t = dist / len;
  for (let k = 0; k < 20; k++) {
    t = (lo + hi) / 2;
    // left half of the de Casteljau split at t (splitSeg's arithmetic)
    const q0x = x0 + (x1 - x0) * t, q0y = y0 + (y1 - y0) * t;
    const q1x = x1 + (x2 - x1) * t, q1y = y1 + (y2 - y1) * t;
    const q2x = x2 + (x3 - x2) * t, q2y = y2 + (y3 - y2) * t;
    const r0x = q0x + (q1x - q0x) * t, r0y = q0y + (q1y - q0y) * t;
    const r1x = q1x + (q2x - q1x) * t, r1y = q1y + (q2y - q1y) * t;
    const px = r0x + (r1x - r0x) * t, py = r0y + (r1y - r0y) * t;
    let length = 0, prevX = x0, prevY = y0;
    for (let i = 1; i <= ARC_SAMPLES; i++) {
      const bx = ARC_C0[i] * x0 + ARC_C1[i] * q0x + ARC_C2[i] * r0x + ARC_C3[i] * px;
      const by = ARC_C0[i] * y0 + ARC_C1[i] * q0y + ARC_C2[i] * r0y + ARC_C3[i] * py;
      const dx = bx - prevX, dy = by - prevY;
      length += Math.sqrt(dx * dx + dy * dy);
      prevX = bx; prevY = by;
    }
    if (length < dist) lo = t;
    else hi = t;
  }
  return t;
}

/** The normalized arc-length parameter of every node boundary (closed rings:
 *  n boundaries at the seam and after each segment; open chains: n). */
export function boundaryParams(p: Param, closed: boolean): number[] {
  const out = [0];
  let acc = 0;
  const n = closed ? p.segs.length - 1 : p.segs.length;
  for (let i = 0; i < n; i++) {
    acc += p.lens[i];
    out.push(p.total > 0 ? acc / p.total : 0);
  }
  return out;
}

/** Split an outline at the given normalized arc-length stations (any values in
 *  [0,1]; duplicates and existing boundaries are harmless) and return the
 *  resulting node chain — every original node boundary is preserved, so a
 *  rect keeps its corners exactly, and curved segments keep their handles
 *  (de Casteljau cuts — the curve is unchanged). Closed rings return the ring
 *  nodes (the seam node once); open chains include both endpoints. */
export function splitOutline(outline: Outline, stations: number[]): VectorNode[] {
  return splitAtStations(outline, stations, STATION_EPS);
}

/** Tiling retains very close distinct stations (unlike correspondence's
 *  near-boundary coalescing). Original corners and curve handles survive. */
export function arcStations(outline: Outline, stations: number[]): VectorNode[] {
  return splitAtStations(outline, stations, 1e-12);
}

function splitAtStations(outline: Outline, stations: number[], tolerance: number): VectorNode[] {
  const { nodes, closed } = outline;
  const p = parameterize(nodes, closed);
  if (!p.segs.length || p.total < 1e-9) return nodes.map(cp);
  const wanted = mergeStations(stations, tolerance);
  const eps = tolerance * p.total; // the station tolerance in arc-length units
  const chains: PathSeg[] = [];
  let acc = 0, wi = 0;
  for (let i = 0; i < p.segs.length; i++) {
    let seg = p.segs[i];
    let len = p.lens[i];
    let segStart = acc;
    const segEnd = acc + p.lens[i];
    while (wi < wanted.length && wanted[wi] * p.total <= segStart + eps) wi++; // on/before this boundary
    while (wi < wanted.length && wanted[wi] * p.total < segEnd - eps) {
      const dist = wanted[wi] * p.total - segStart;
      if (dist > eps && dist < len - eps) {
        const [left, right] = splitSeg(seg, arcT(seg, len, dist));
        chains.push(left);
        seg = right;
        len -= dist;
        segStart += dist;
      }
      wi++;
    }
    chains.push(seg);
    acc = segEnd;
  }
  // sub-segment chain → nodes (the resampleNodes conversion, generalized)
  const out: VectorNode[] = [];
  const count = closed ? chains.length : chains.length + 1;
  for (let i = 0; i < count; i++) {
    const after = i < chains.length ? chains[i] : null;
    const before = i === 0 ? (closed ? chains[chains.length - 1] : null) : chains[i - 1];
    const px = after ? after.x0 : before!.x3, py = after ? after.y0 : before!.y3;
    const node: VectorNode = { x: px, y: py, type: "corner" };
    if (before && !before.line) node.hIn = { dx: before.x2 - px, dy: before.y2 - py };
    if (after && !after.line) node.hOut = { dx: after.x1 - px, dy: after.y1 - py };
    out.push(node);
  }
  return out;
}

/** Re-seam a ring so its node 0 sits at normalized arc length `s0` (splitting a
 *  segment there when needed), optionally reversing the traversal. */
export function reseam(outline: Outline, s0: number, reverse: boolean): Outline {
  let nodes = splitOutline(outline, [s0]);
  const p = parameterize(nodes, true);
  const params = boundaryParams(p, true);
  // the node nearest the requested seam (exact after the split, up to float)
  let idx = 0, best = Infinity;
  for (let i = 0; i < params.length; i++) {
    const d = Math.min(Math.abs(params[i] - s0), Math.abs(params[i] - s0 + 1), Math.abs(params[i] - s0 - 1));
    if (d < best) { best = d; idx = i; }
  }
  nodes = [...nodes.slice(idx), ...nodes.slice(0, idx)];
  if (reverse) {
    const rev = reverseNodes(nodes);
    nodes = [rev[rev.length - 1], ...rev.slice(0, -1)]; // keep the seam node first
  }
  return { nodes, closed: true };
}

/** Open a ring at normalized arc length `c`: the chain runs from the cut around
 *  the ring back to the cut (its first and last nodes coincide). */
export function openRing(outline: Outline, c: number, reverse: boolean): Outline {
  const ring = reseam(outline, c, reverse);
  const first = ring.nodes[0];
  const last: VectorNode = { x: first.x, y: first.y, type: "corner" };
  if (first.hIn) last.hIn = { ...first.hIn };
  const head: VectorNode = { ...cp(first) };
  delete head.hIn;
  return { nodes: [head, ...ring.nodes.slice(1).map(cp), last], closed: false };
}

// --- correspondence ---------------------------------------------------------

/** Unit-frame coordinates (u = x / w, v = y / h) — a zero-extent axis maps to 0. */
function unit(nodes: VectorNode[], w: number, h: number): VectorNode[] {
  const sx = w > 1e-9 ? 1 / w : 0, sy = h > 1e-9 ? 1 / h : 0;
  return nodes.map((n) => ({
    x: n.x * sx, y: n.y * sy, type: n.type,
    hIn: n.hIn && { dx: n.hIn.dx * sx, dy: n.hIn.dy * sy },
    hOut: n.hOut && { dx: n.hOut.dx * sx, dy: n.hOut.dy * sy },
  }));
}

const CANDIDATES = 48; // seam / cut candidates around a ring

export function signedArea(p: Param, samples = 64): number {
  let area = 0;
  let prev = pointAt(p, 0);
  for (let i = 1; i <= samples; i++) {
    const cur = pointAt(p, i / samples);
    area += prev.x * cur.y - cur.x * prev.y;
    prev = cur;
  }
  return area / 2;
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Summed squared distance between two unit-frame outlines sampled at `m`
 *  stations, with B traversed from offset `s0` (forward or reversed). */
export function matchCost(a: Param, b: Param, s0: number, reverse: boolean, closed: boolean, m = 32): number {
  return matchCostFromSamples(a, b, closed, m)(s0, reverse);
}

/** A's stations are identical for every candidate seam/direction. Prepare
 *  them once per search; only B moves. Keep the station and sum order exact. */
function matchCostFromSamples(a: Param, b: Param, closed: boolean, m = 32): (s0: number, reverse: boolean) => number {
  const points = Array.from({ length: m + 1 }, (_, i) => pointAt(a, i / m));
  return (s0, reverse) => {
    let cost = 0;
    for (let i = 0; i <= m; i++) {
      const s = i / m;
      const sb = closed ? ((reverse ? s0 - s : s0 + s) % 1 + 1) % 1 : reverse ? 1 - s : s;
      cost += dist2(points[i], pointAt(b, sb));
    }
    return cost;
  };
}

export interface OutlineMorphPlan {
  /** Corresponding node chains in UNIT coordinates (equal length). */
  a: VectorNode[];
  b: VectorNode[];
  /** The intermediate's topology: closed when both sides are rings, or when a
   *  stroke INFLATES into a filled ring (below). */
  closed: boolean;
  /** Arrowhead presence on an OPEN intermediate (either side draws one). */
  arrowStart: boolean;
  arrowEnd: boolean;
  /** Normal-matched rings only: arc length (px, along the chain) from the chain's
   *  start to B's OWN start node. The driver lerps `stroke-dashoffset` from 0 to
   *  −dashShift (mod the dash period), so a dashed B lands on its static pattern.
   *  `dashReversed`: the chain runs against B's direction (see dashOffsetAt). */
  dashShift?: number;
  dashReversed?: boolean;
}

/** How a stroke and a ring meet. A stroke becoming a FILLED ring inflates: the
 *  stroke doubles back on itself as a degenerate ring that swells into the
 *  shape (no wedge, the fill grows with it). A stroke-only ring instead CUTS
 *  open where it is nearest the stroke's ends and unrolls into it. */
export type RingStrategy = "cut" | "inflate";

/** A stroke as a degenerate ring: out along the chain, back along it. Handles
 *  retrace exactly, so the ring's two turns are hairpins (round linejoins
 *  render them as the stroke's round caps). */
export function inflateChain(nodes: VectorNode[]): VectorNode[] {
  if (nodes.length < 2) return nodes.map(cp);
  const rev = reverseNodes(nodes); // [nk', …, n0']: hIn/hOut swapped
  const first = cp(nodes[0]), last = cp(nodes[nodes.length - 1]);
  if (rev[rev.length - 1].hIn) first.hIn = { ...rev[rev.length - 1].hIn! };
  if (rev[0].hOut) last.hOut = { ...rev[0].hOut! };
  return [first, ...nodes.slice(1, -1).map(cp), last, ...rev.slice(1, -1)];
}

/** Build the correspondence between two outlines (in their own unit frames).
 *  Both chains come back with the same node count, aligned start and
 *  direction; every original node of either side is a node of both. */
/** The correspondence is a pure function of the two outlines, their boxes and
 *  the strategy, and it is the most expensive thing in this file by a wide
 *  margin — a 200-node ring against an ellipse costs ~30ms, nearly all of it
 *  inverting arc length. Two facts make caching it worth the key: a deck that
 *  morphs a ROW of identical shapes asks the identical question once per shape,
 *  and the animator warms a slide's morphs when it opens so that pressing play
 *  finds them already built (`warmSlideMorphs`). Keyed on everything the result
 *  depends on and nothing else; the entries are immutable and read-only to
 *  every caller (`sampleElementMorph` builds fresh nodes), so they are shared,
 *  not copied. Bounded, oldest-out — a long editing session must not grow it
 *  without limit. */
const CORRESPONDENCE_CACHE_MAX = 256;
export interface PlannedChains { a: VectorNode[]; b: VectorNode[]; closed: boolean; dashShift?: number; dashReversed?: boolean }
const correspondenceCache = new Map<string, PlannedChains>();

function outlineKey(o: Outline, w: number, h: number): string {
  let s = (o.closed ? "C" : "O") + w + ":" + h;
  for (const n of o.nodes) {
    s += "|" + n.x + "," + n.y + "," + (n.type ?? "");
    if (n.hIn) s += ";" + n.hIn.dx + "," + n.hIn.dy;
    if (n.hOut) s += ":" + n.hOut.dx + "," + n.hOut.dy;
  }
  return s;
}

export function planOutlines(A: Outline, aw: number, ah: number, B: Outline, bw: number, bh: number, strategy: RingStrategy = "cut"): PlannedChains {
  const key = strategy + " " + outlineKey(A, aw, ah) + " " + outlineKey(B, bw, bh);
  const hit = correspondenceCache.get(key);
  if (hit) return hit;
  const built = correspond(A, aw, ah, B, bw, bh, strategy);
  if (correspondenceCache.size >= CORRESPONDENCE_CACHE_MAX) {
    const oldest = correspondenceCache.keys().next().value;
    if (oldest !== undefined) correspondenceCache.delete(oldest);
  }
  correspondenceCache.set(key, built);
  return built;
}

/** A box thinner than this (stage units) is a stroke, not a shape: its unit frame
 *  is degenerate (a line's h = 0 maps every node to v = 0), so such a pair is
 *  planned and sampled in PIXELS instead of in the two unit frames. */
export const THIN_BOX = 1;
export interface PlanBoxes { wa: number; ha: number; wb: number; hb: number }
export const pixelLaw = (e: PlanBoxes): boolean => Math.min(e.wa, e.ha, e.wb, e.hb) < THIN_BOX;

/** Arc length (px) along a unit chain from node 0 to node `j`, in a w×h box. */
function chainLengthTo(chain: VectorNode[], j: number, w: number, h: number): number {
  const px = chain.map((n) => ({
    x: n.x * w, y: n.y * h, type: n.type,
    hIn: n.hIn && { dx: n.hIn.dx * w, dy: n.hIn.dy * h }, hOut: n.hOut && { dx: n.hOut.dx * w, dy: n.hOut.dy * h },
  }));
  const segs = segsFromNodes(px, true);
  let L = 0;
  for (let i = 0; i < j && i < segs.length; i++) L += segLength(segs[i]);
  return L;
}

function correspond(A: Outline, aw: number, ah: number, B: Outline, bw: number, bh: number, strategy: RingStrategy): PlannedChains {
  // a stroke meeting a FILLED ring doubles back on itself first (a hairpin ring)
  let oa = A, ob = B;
  if (oa.closed !== ob.closed && strategy === "inflate") {
    if (!oa.closed) oa = { nodes: inflateChain(oa.nodes), closed: true };
    else ob = { nodes: inflateChain(ob.nodes), closed: true };
  }
  // two CONVEX rings pair by tangent angle (the Minkowski blend): no pinched corners.
  // The pairing runs in each ring's UNIT frame (an affine image of a convex ring is
  // convex, ellipse→ellipse stays an exact ellipse, roundness scales with the box);
  // only a stroke-thin box needs the pixel frame.
  if (oa.closed && ob.closed) {
    const px = pixelLaw({ wa: aw, ha: ah, wb: bw, hb: bh });
    const nm = px ? normalMatchRings(oa.nodes, ob.nodes) : normalMatchRings(unit(oa.nodes, aw, ah), unit(ob.nodes, bw, bh));
    if (nm) {
      const a = px ? unit(nm.a, aw, ah) : nm.a, b = px ? unit(nm.b, bw, bh) : nm.b;
      return { a, b, closed: true, ...(nm.bStart != null && (nm.bStart > 0 || nm.bReversed) ? { dashShift: chainLengthTo(b, nm.bStart, bw, bh), ...(nm.bReversed ? { dashReversed: true } : {}) } : {}) };
    }
  }
  let ua: Outline = { nodes: unit(oa.nodes, aw, ah), closed: oa.closed };
  let ub: Outline = { nodes: unit(ob.nodes, bw, bh), closed: ob.closed };
  if (ua.closed && ub.closed) {
    // rings: same winding, then the seam offset (+ direction) of B that best
    // overlays A — continuous candidates, not just B's own nodes.
    const pa = parameterize(ua.nodes, true), pb = parameterize(ub.nodes, true);
    const flip = Math.sign(signedArea(pa)) * Math.sign(signedArea(pb)) < 0;
    let best = { s0: 0, reverse: flip, cost: Infinity };
    const costAt = matchCostFromSamples(pa, pb, true);
    const candidates = new Set<number>([...Array.from({ length: CANDIDATES }, (_, i) => i / CANDIDATES), ...boundaryParams(pb, true)]);
    for (const s0 of candidates) {
      for (const reverse of [flip, !flip]) {
        const cost = costAt(s0, reverse) + (reverse !== flip ? 1e-6 : 0);
        if (cost < best.cost) best = { s0, reverse, cost };
      }
    }
    ub = reseam(ub, best.s0, best.reverse);
  } else if (!ua.closed && !ub.closed) {
    const pa = parameterize(ua.nodes, false), pb = parameterize(ub.nodes, false);
    const costAt = matchCostFromSamples(pa, pb, false);
    if (costAt(0, true) + 1e-9 < costAt(0, false)) ub = { nodes: reverseNodes(ub.nodes), closed: false };
  } else {
    // one ring, one stroke: cut the ring where it is nearest BOTH ends of the
    // stroke, so the ring opens there and its two ends travel to the stroke's.
    const ringIsA = ua.closed;
    const ring = ringIsA ? ua : ub, chain = ringIsA ? ub : ua;
    const pr = parameterize(ring.nodes, true), pc = parameterize(chain.nodes, false);
    const c0 = pointAt(pc, 0), c1 = pointAt(pc, 1);
    let best = { c: 0, cost: Infinity };
    const candidates = new Set<number>([...Array.from({ length: CANDIDATES }, (_, i) => i / CANDIDATES), ...boundaryParams(pr, true)]);
    for (const c of candidates) {
      const p = pointAt(pr, c);
      const cost = Math.sqrt(dist2(p, c0)) + Math.sqrt(dist2(p, c1));
      if (cost < best.cost) best = { c, cost };
    }
    const fwd = openRing(ring, best.c, false), rev = openRing(ring, best.c, true);
    const pf = parameterize(fwd.nodes, false), prv = parameterize(rev.nodes, false);
    const opened = matchCost(pc, prv, 0, false, false) + 1e-9 < matchCost(pc, pf, 0, false, false) ? rev : fwd;
    if (ringIsA) ua = opened; else ub = opened;
  }
  // union of stations: uniform resolution + every boundary of both sides
  const closed = ua.closed && ub.closed;
  const pa = parameterize(ua.nodes, closed), pb = parameterize(ub.nodes, closed);
  const uniform = Array.from({ length: closed ? 32 : 33 }, (_, i) => i / 32);
  const stations = mergeStations([...uniform, ...boundaryParams(pa, closed), ...boundaryParams(pb, closed)]);
  let a = splitOutline(ua, stations), b = splitOutline(ub, stations);
  // float drift can leave the two chains one node apart at a coincident
  // station — trim to the common length (never in practice; keeps sampling safe)
  const n = Math.min(a.length, b.length);
  a = a.slice(0, n); b = b.slice(0, n);
  return { a: withImplicitHandles(a, closed), b: withImplicitHandles(b, closed), closed };
}

/** Give every straight segment its implicit 1/3-chord handles. A straight side
 *  then lerps like every other cubic: with no handles the node tangent of a
 *  half-way frame is the OTHER side's tangent, not a blend, and each segment
 *  between two nodes becomes an S (convex start, concave end). */
export function withImplicitHandles(chain: VectorNode[], closed: boolean): VectorNode[] {
  const n = chain.length;
  const out = chain.map(cp);
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = chain[i], b = chain[(i + 1) % n];
    if (a.hOut || b.hIn) continue; // already a curve
    const dx = (b.x - a.x) / 3, dy = (b.y - a.y) / 3;
    if (dx === 0 && dy === 0) continue;
    out[i].hOut = { dx, dy };
    out[(i + 1) % n].hIn = { dx: -dx, dy: -dy };
  }
  return out;
}

/** Whether the correspondence `planOutlines` builds will be a ring, decided
 *  from the two outlines alone so a caller can know it without paying for the
 *  correspondence. It mirrors that function exactly: `inflate` closes the open
 *  side, so the pair is a ring when EITHER side is one, and every other
 *  strategy opens the closed side, so the pair is a ring only when BOTH are.
 *  `verify-slide-outline` holds the two in step. */
export function morphIsClosed(a: Outline, b: Outline, strategy: RingStrategy): boolean {
  return strategy === "inflate" ? a.closed || b.closed : a.closed && b.closed;
}

// --- same-kind path alignment (T5 / H2) ------------------------------------
// A same-kind path -> path Change lerps node positions in element-local px
// (tween.lerpNodes). Index pairing is the right law for an authored edit (the
// dragged corner moves) but collapses a RING whose start or winding differs (a
// reversed-start square passes through zero area). alignChains keeps the authored
// pairing unless another start/direction beats it by a clear margin.
//
// Scope: this is NOT the Become pairing. A Become between drawn kinds, or a path
// changing closedness, goes through `correspond` above (normal matching for convex
// pairs, its own seam search for the rest); alignChains only governs what
// `outlineMorphable` leaves to the per-property tween.
//
// OPEN chains are never re-paired: an open 2-node stick is a bond or a rung that
// shares its end points with neighbouring elements (a per-element re-pairing
// decouples the shared vertex, measured on the owner's DNA and Beckmann decks), and
// its arrowhead / dash / gradient direction belongs to the end element.

/** An alternative pairing is taken only when it costs less than ALIGN_GAIN x the authored one. */
export const ALIGN_GAIN = 0.8;
const ALIGN_GRID = 128, ALIGN_STATIONS = 32;

export interface AlignedChains { a: VectorNode[]; b: VectorNode[]; reversed: boolean }

export interface AlignOptions {
  /** Pin the direction (true = B reversed, false = B forward) while still allowing a start-node shift: a
   *  compound path's holes follow the direction decision of their outer ring so their relative winding
   *  never changes mid-flight. */
  force?: boolean;
  /** Keep the authored pairing even for a ring. A dash pattern runs from the path's FIRST node and cannot
   *  be re-phased per frame, so a dashed ring that were re-seamed or reversed would land (or start) with
   *  its dashes in another place: a snap at the boundary. A dashed ring keeps the pairing it was authored
   *  with (and a reversed one still collapses mid-flight, as before) until the Change carries a dash offset. */
  authored?: boolean;
}

/** The two chains as `lerpNodes` should pair them (see `AlignOptions`). */
export function alignChains(a: VectorNode[], b: VectorNode[], closed: boolean, opts: AlignOptions = {}): AlignedChains {
  const { force, authored } = opts;
  if (!closed || authored) return { ...splitPair(a, b, closed), reversed: false };
  if (a.length === b.length && a.length >= 2) {
    const n = a.length, bRev = reverseNodes(b);
    const cost = (src: VectorNode[], k: number) => {
      let c = 0;
      for (let i = 0; i < n; i++) c += dist2(a[i], src[(i + k) % n]);
      return c;
    };
    const base = force ?? false;
    const c0 = cost(base ? bRev : b, 0);
    let best = { rev: base, k: 0, c: c0 };
    for (let k = 0; k < n; k++) for (const rev of force === undefined ? [false, true] : [force]) {
      const c = cost(rev ? bRev : b, k);
      if (c < best.c) best = { rev, k, c };
    }
    const pick = best.c < c0 * ALIGN_GAIN - 1e-9 ? best : { rev: base, k: 0 };
    const src = pick.rev ? bRev : b;
    return { a, b: pick.k ? [...src.slice(pick.k), ...src.slice(0, pick.k)] : src, reversed: pick.rev };
  }
  const pa = parameterize(a, true), pb = parameterize(b, true);
  if (!(pa.total > 1e-9 && pb.total > 1e-9)) return { ...splitPair(a, b, true), reversed: false };
  // rings of different node counts: pair stations along the arc length. One sampling of each ring
  // (A at 33 stations, B at 128), then every seam / direction is a rotation of the table, O(grid)
  // per candidate, so a 300-node ring costs about a millisecond cold instead of 30.
  const S = ALIGN_STATIONS, G = ALIGN_GRID, step = G / S;
  const pointsA = Array.from({ length: S + 1 }, (_, i) => pointAt(pa, i / S));
  const pointsB = Array.from({ length: G }, (_, j) => pointAt(pb, j / G));
  const costAt = (k: number, rev: boolean) => {
    let c = 0;
    for (let i = 0; i <= S; i++) c += dist2(pointsA[i], pointsB[((rev ? k - step * i : k + step * i) % G + G) % G]);
    return c;
  };
  // winding decides the free direction: opposite windings only line up reversed
  const flip = Math.sign(signedArea(pa)) * Math.sign(signedArea(pb)) < 0;
  const base = force ?? flip;
  const c0 = costAt(0, base);
  let best = { rev: base, k: 0, c: c0 };
  for (let k = 0; k < G; k++) for (const rev of force === undefined ? [false, true] : [force]) {
    const c = costAt(k, rev);
    if (c < best.c) best = { rev, k, c };
  }
  const pick = best.c < c0 * ALIGN_GAIN - 1e-9 ? best : { rev: base, k: 0 };
  let ub = b;
  if (pick.rev || pick.k) ub = reseam({ nodes: b, closed: true }, pick.k / G, pick.rev).nodes;
  const pu = ub === b ? pb : parameterize(ub, true);
  const stations = [...boundaryParams(pa, true), ...boundaryParams(pu, true)];
  return { a: splitOutline({ nodes: a, closed: true }, stations), b: splitOutline({ nodes: ub, closed: true }, stations), reversed: pick.rev };
}

/** Today's pairing for chains the aligner leaves alone: equal counts index-paired, unequal counts both
 *  split at the union of their normalized arc-length node stations (every corner survives). */
function splitPair(a: VectorNode[], b: VectorNode[], closed: boolean): { a: VectorNode[]; b: VectorNode[] } {
  if (a.length === b.length) return { a, b };
  const pa = parameterize(a, closed), pb = parameterize(b, closed);
  if (!(pa.total > 1e-9 && pb.total > 1e-9)) return { a, b };
  const stations = [...boundaryParams(pa, closed), ...boundaryParams(pb, closed)];
  return { a: splitOutline({ nodes: a, closed }, stations), b: splitOutline({ nodes: b, closed }, stations) };
}

// --- the element-level plan + sampler --------------------------------------

export interface ElementMorphPlan extends OutlineMorphPlan {
  pre: Element;
  end: Element;
  preBox: { x: number; y: number; w: number; h: number };
  endBox: { x: number; y: number; w: number; h: number };
  /** Style endpoints (a "none" side interpolates as the alpha-0 twin). */
  preStyle: OutlineStyle;
  endStyle: OutlineStyle;
  strategy: RingStrategy;
  /** Inflate only: the stroke side's arrowheads, in ITS unit frame, which the
   *  driver draws mapped into the current box and fades (out for `pre`, in for
   *  `end`) while the ring swells or deflates. */
  fixedHeads: FixedHead[];
  /** Force the deferred node correspondence (see planElementMorph). Safe to
   *  call more than once; reading a/b/closed does it implicitly. */
  prepare?: () => void;
}

export interface FixedHead {
  side: "pre" | "end";
  filled: boolean;
  /** Head vertices in PIXELS, local to the side's box origin. (They used to be in
   *  the unit frame, which divides by 0 for an axis-aligned arrow's h = 0 and
   *  flattened the head to a sliver on the first morph frame.) */
  pts: [number, number][];
  /** Unit direction the head points (the stroke's end tangent). */
  dir: [number, number];
}

/** The point of a (closed) chain farthest along `dir` (a unit vector): the visible TIP of a
 *  stroke's end while the stroke swells into a ring. Pure; 12 samples per segment. */
export function supportPoint(nodes: VectorNode[], closed: boolean, dir: [number, number]): [number, number] {
  let best = -Infinity, bx = 0, by = 0;
  for (const s of segsFromNodes(nodes, closed)) {
    for (let k = 0; k <= 12; k++) {
      const p = segPoint(s, k / 12), d = p.x * dir[0] + p.y * dir[1];
      if (d > best) { best = d; bx = p.x; by = p.y; }
    }
  }
  return [bx, by];
}

/** Unit direction a stroke LEAVES its first node (negated: the way a head at the START points)
 *  or ARRIVES at its last node (the way a head at the END points). */
export function strokeEndDirection(nodes: VectorNode[], atFirst: boolean): [number, number] {
  const segs = segsFromNodes(nodes, false);
  if (!segs.length) return [1, 0];
  const v = atFirst ? segTangent(segs[0], 0) : segTangent(segs[segs.length - 1], 1);
  const len = Math.hypot(v.x, v.y) || 1;
  return atFirst ? [-v.x / len, -v.y / len] : [v.x / len, v.y / len];
}

const headBuffers = new WeakMap<FixedHead, { buf: VectorNode[]; ref: [number, number] }>();
/** A fixed head's vertices in the CURRENT box at time t: its authored shape (rigid, never
 *  stretched with the box), carried by the displacement of the swelling ring's extreme point
 *  along the head's own direction — the visible end of the stroke while it inflates — from
 *  that point on the head's OWN state (t = 0 for a pre head, t = 1 for an end head). The
 *  displacement is zero there by construction, so the head sits exactly where it was drawn
 *  even on a hooked stroke whose end is not its extreme point along its end tangent. */
export function fixedHeadPoints(plan: ElementMorphPlan, head: FixedHead, t: number): [number, number][] {
  const pb = plan.preBox, eb = plan.endBox;
  const tipAt = (u: number, buf: VectorNode[]) => supportPoint(sampleNodes(plan.a, plan.b, u, lerp(pb.w, eb.w, u), lerp(pb.h, eb.h, u), buf, { wa: pb.w, ha: pb.h, wb: eb.w, hb: eb.h }), true, head.dir);
  let st = headBuffers.get(head);
  if (!st) headBuffers.set(head, st = { buf: [], ref: tipAt(head.side === "pre" ? 0 : 1, []) });
  const tip = tipAt(t, st.buf);
  const dx = tip[0] - st.ref[0], dy = tip[1] - st.ref[1];
  return head.pts.map(([x, y]) => [x + dx, y + dy]);
}

/** Opacity of a fixed (inflate) head at time t: a pre head melts away over the
 *  first 40 % of the morph, an end head condenses over the last 40 %. */
export function fixedHeadOpacity(head: FixedHead, t: number): number {
  return head.side === "pre" ? Math.max(0, Math.min(1, 1 - t / 0.4)) : Math.max(0, Math.min(1, (t - 0.6) / 0.4));
}

/** `stroke-dashoffset` of the live path at progress t: 0 at the start (A's dashes lie where
 *  A's markup laid them), the offset that makes the pattern equal B's static one at t = 1.
 *  Forward chain: −shift (mod period). Reversed chain (A and B wind oppositely): the pattern
 *  [d, g] read backwards is [g, d], i.e. the same pattern shifted by d − shift; only a
 *  two-entry (or odd, doubled) pattern is its own reversal up to a shift, so any other
 *  reversed pattern keeps offset 0. Seek-pure. */
export function dashOffsetAt(shift: number, endDash: number[], t: number, reversed = false): number {
  const even = endDash.length % 2 ? [...endDash, ...endDash] : endDash;
  const period = even.reduce((m, v) => m + v, 0);
  if (!(period > 0) || (!shift && !reversed)) return 0;
  if (reversed && even.length !== 2) return 0;
  const mod = (v: number) => ((v % period) + period) % period;
  return lerp(0, mod(reversed ? even[0] - shift : -shift), t);
}

/** The arrowheads a stroke side draws, in pixels local to its box. */
function strokeHeads(el: Element, outline: Outline, box: { w: number; h: number }, side: "pre" | "end"): FixedHead[] {
  const st = styleOf(el);
  if (outline.closed || (!st.arrowStart && !st.arrowEnd) || outline.nodes.length < 2) return [];
  const pr = pathRender({ d: pathD(outline.nodes, false), nodes: outline.nodes, closed: false, strokeWidth: st.strokeWidth, arrowStart: st.arrowStart, arrowEnd: st.arrowEnd, arrowStyle: st.arrowStyle, arrowSize: st.arrowSize });
  const first = outline.nodes[0], last = outline.nodes[outline.nodes.length - 1];
  const mk = (pts: number[][], filled: boolean): FixedHead => {
    const tip = pts.reduce((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length], [0, 0]);
    const nearFirst = (tip[0] - first.x) ** 2 + (tip[1] - first.y) ** 2 < (tip[0] - last.x) ** 2 + (tip[1] - last.y) ** 2;
    return { side, filled, pts: pts.map(([x, y]) => [x, y] as [number, number]), dir: strokeEndDirection(outline.nodes, nearFirst) };
  };
  return [...pr.polys.map((pts) => mk(pts, true)), ...pr.vees.map((pts) => mk(pts, false))];
}

interface OutlineStyle {
  fillMap?: GradientFill | null;
  strokeMap?: GradientFill | null;
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash?: number[];
  cap: "butt" | "round" | "square";
  arrowStart: boolean;
  arrowEnd: boolean;
  arrowStyle: "filled" | "vee";
  arrowSize?: number;
}

/** The paint of one side. Open strokes never fill (the serializer's own rule)
 *  and only open strokes carry caps/arrowheads. */
export { styleOf as elementPaint };
function styleOf(el: Element): OutlineStyle {
  const e = el as unknown as Record<string, unknown>;
  const open = el.type === "line" || (el.type === "path" && !el.closed);
  return {
    fillMap: open ? undefined : e.fillMap as GradientFill | undefined,
    strokeMap: e.strokeMap as GradientFill | undefined,
    fill: open ? "none" : String(e.fill ?? "none"),
    stroke: String(e.stroke ?? "none"),
    strokeWidth: Number(e.strokeWidth ?? 0) || 0,
    dash: Array.isArray(e.dash) && e.dash.length ? (e.dash as number[]) : undefined,
    cap: (e.cap as OutlineStyle["cap"]) ?? (open ? "round" : "butt"),
    arrowStart: open && Boolean(e.arrowStart),
    arrowEnd: open && Boolean(e.arrowEnd),
    arrowStyle: (e.arrowStyle as OutlineStyle["arrowStyle"]) ?? "filled",
    arrowSize: typeof e.arrowSize === "number" ? e.arrowSize : undefined,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRot = (a: number, b: number, t: number) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;

/** Build the plan for one element pair (the driver keeps it for the track's
 *  life; the pure tween builds it on demand). Null when either side has no
 *  usable outline — the caller crossfades. */
export function planElementMorph(pre: Element, end: Element): ElementMorphPlan | null {
  if (!outlineMorphable(pre, end)) return null;
  const A = elementOutline(pre), B = elementOutline(end);
  if (!A || !B) return null;
  const pb = elementBBox({ ...pre, rotation: 0 }), eb = elementBBox({ ...end, rotation: 0 });
  const preStyle = styleOf(pre), endStyle = styleOf(end);
  // a stroke meets a FILLED ring by inflating (no wedge); a stroke-only ring
  // opens up and unrolls instead
  const ringStyle = A.closed === B.closed ? null : A.closed ? preStyle : endStyle;
  const strategy: RingStrategy = ringStyle && (!!ringStyle.fillMap?.stops?.length || !isNoneColor(ringStyle.fill)) ? "inflate" : "cut";
  // `planOutlines` is the expensive half of this by a wide margin — three
  // become transforms measured 40.7ms inside it against 0.1ms to build the
  // outlines it works from — and nothing reads the corresponded chains until a
  // frame is actually drawn. Everything the compiler needs up front (can this
  // morph at all, is the result a ring, does it carry arrowheads) comes from
  // the outlines and the strategy alone, so the correspondence is computed on
  // first use and the player warms it once the preview is on screen.
  // (2026-09-22: the first preview cost 113ms against a 100ms budget, and this
  // was almost all of it.)
  let corresponded: ReturnType<typeof planOutlines> | null = null;
  const outlines = () => (corresponded ??= planOutlines(A, pb.w, pb.h, B, eb.w, eb.h, strategy));
  const closed = morphIsClosed(A, B, strategy);
  const fixedHeads = strategy === "inflate" ? [...strokeHeads(pre, A, pb, "pre"), ...strokeHeads(end, B, eb, "end")] : [];
  return {
    get a() { return outlines().a; },
    get b() { return outlines().b; },
    get dashShift() { return outlines().dashShift; },
    get dashReversed() { return outlines().dashReversed; },
    closed,
    arrowStart: !closed && (preStyle.arrowStart || endStyle.arrowStart),
    arrowEnd: !closed && (preStyle.arrowEnd || endStyle.arrowEnd),
    /** Force the correspondence now. The player calls this once the preview is
     *  on screen, so the first morph frame never pays for it. */
    prepare() { outlines(); },
    pre, end, strategy, fixedHeads,
    preBox: pb, endBox: eb, preStyle, endStyle,
  };
}

function isNoneColor(c: string): boolean {
  const t = c.trim().toLowerCase();
  return t === "none" || t === "transparent" || t === "";
}

/** A colormap gradient between two states. Two gradients (or a gradient and a flat
 *  colour, which is a gradient whose stops are all that colour) blend STOP BY STOP
 *  in OKLab — the old behaviour stepped the whole map at t = .5, a visible pop for
 *  every gradient-filled Become. Hard-banded (discrete) maps cannot blend and step
 *  at .5 as before. `cache` holds the prepared per-stop lerps (parsed once). */
export interface GradientLerp { prep?: ((t: number) => string)[] }
export function lerpGradientFill(a: GradientFill | null | undefined, b: GradientFill | null | undefined, flatA: string, flatB: string, t: number, cache: GradientLerp): GradientFill | undefined {
  const sa = a?.stops?.length ? a.stops : null, sb = b?.stops?.length ? b.stops : null;
  if (!sa && !sb) return undefined;
  const pick = t < 0.5 ? (sa ? a : b) : (sb ? b : a);
  if ((a?.discrete && sa) || (b?.discrete && sb)) return structuredClone(pick ?? undefined);
  // two maps are EXACT at the ends (whatever their stop counts): the ramp the Become hands over to
  if (sa && sb && t <= 0) return structuredClone(a ?? undefined);
  if (sa && sb && t >= 1) return structuredClone(b ?? undefined);
  if (!cache.prep) {
    const n = Math.max(sa?.length ?? 1, sb?.length ?? 1);
    // a ramp of m stops resampled to n evenly spaced ones: piecewise-linear in sRGB between its own stops (the space
    // SVG blends a gradient in), so 5 stops against 3 describe the same ramp as the 3 (SVG spaces stops evenly at i/(n-1))
    const at = (s: string[] | null, flat: string, i: number): string => {
      if (!s) return flat;
      const pos = (i * (s.length - 1)) / Math.max(1, n - 1), lo = Math.min(Math.floor(pos + 1e-9), s.length - 1), hi = Math.min(lo + 1, s.length - 1), f = pos - lo;
      if (f < 1e-6 || lo === hi) return s[lo];
      const c0 = parseColor(s[lo]), c1 = parseColor(s[hi]);
      if (!c0 || !c1) return f < 0.5 ? s[lo] : s[hi];
      return formatColor({ r: lerp(c0.r, c1.r, f), g: lerp(c0.g, c1.g, f), b: lerp(c0.b, c1.b, f), a: lerp(c0.a, c1.a, f) });
    };
    cache.prep = Array.from({ length: n }, (_, i) => prepareColorLerp(at(sa, flatA, i), at(sb, flatB, i)));
  }
  const g = pick ?? a ?? b!;
  return { map: g.map, axis: g.axis, stops: cache.prep.map((f) => f(t)) };
}
const gradientCaches = new WeakMap<ElementMorphPlan, { fill: GradientLerp; stroke: GradientLerp }>();
function lerpGradient(plan: ElementMorphPlan, which: "fill" | "stroke", t: number): GradientFill | undefined {
  let c = gradientCaches.get(plan);
  if (!c) gradientCaches.set(plan, c = { fill: {}, stroke: {} });
  const A = plan.preStyle, B = plan.endStyle;
  return which === "fill" ? lerpGradientFill(A.fillMap, B.fillMap, A.fill, B.fill, t, c.fill) : lerpGradientFill(A.strokeMap, B.strokeMap, A.stroke, B.stroke, t, c.stroke);
}

/** Per-frame arrowhead opacity for the intermediate: a head only one side
 *  draws fades out (pre-only) or in (end-only) instead of popping. */
export function arrowFade(plan: ElementMorphPlan, which: "start" | "end", t: number): number {
  const a = which === "start" ? plan.preStyle.arrowStart : plan.preStyle.arrowEnd;
  const b = which === "start" ? plan.endStyle.arrowStart : plan.endStyle.arrowEnd;
  if (a && b) return 1;
  if (a) return 1 - t;
  if (b) return t;
  return 0;
}

/** The synthetic PATH element at time t ∈ (0,1) — endpoints are the caller's
 *  business (they return the real elements verbatim). Identity/base props come
 *  from `end` (the state the element is becoming), box and style are lerped. */
export function sampleElementMorph(plan: ElementMorphPlan, t: number, raw = t): PathElement {
  const { pre, end, preBox, endBox, preStyle, endStyle } = plan;
  const w = lerp(preBox.w, endBox.w, t), h = lerp(preBox.h, endBox.h, t);
  const nodes = sampleNodes(plan.a, plan.b, t, w, h, [], { wa: preBox.w, ha: preBox.h, wb: endBox.w, hb: endBox.h });
  const fill = lerpColor(preStyle.fill, endStyle.fill, t, undefined, raw);
  const stroke = lerpColor(preStyle.stroke, endStyle.stroke, t, undefined, raw);
  const out: PathElement = {
    type: "path",
    id: end.id,
    ...(end.name !== undefined ? { name: end.name } : {}),
    ...(end.groupId !== undefined ? { groupId: end.groupId } : {}),
    ...(end.locked ? { locked: true } : {}),
    ...(end.hidden ? { hidden: true } : {}),
    x: lerp(preBox.x, endBox.x, t),
    y: lerp(preBox.y, endBox.y, t),
    width: Math.max(w, 0),
    height: Math.max(h, 0),
    rotation: lerpRot(pre.rotation ?? 0, end.rotation ?? 0, t),
    d: "",
    fill,
    stroke,
    // Unlike gradients use a deterministic endpoint paint; solid-color
    // interpolation remains continuous and authored endpoints remain exact.
    fillMap: lerpGradient(plan, "fill", t),
    strokeMap: lerpGradient(plan, "stroke", t),
    strokeWidth: lerp(preStyle.strokeWidth, endStyle.strokeWidth, t),
    closed: plan.closed,
    nodes,
    cap: t < 0.5 ? preStyle.cap : endStyle.cap,
  };
  const opA = pre.opacity ?? 1, opB = end.opacity ?? 1;
  if (opA !== 1 || opB !== 1) out.opacity = lerp(opA, opB, t);
  // per-channel alpha (absent = 1) rides the same t as everything else
  const chan = (k: "fillOpacity" | "strokeOpacity") => {
    const a = (pre as { fillOpacity?: number; strokeOpacity?: number })[k] ?? 1, b = (end as { fillOpacity?: number; strokeOpacity?: number })[k] ?? 1;
    const v = lerp(a, b, t);
    if (a !== 1 || b !== 1) out[k] = v;
  };
  chan("fillOpacity"); chan("strokeOpacity");
  const dash = lerpDashLocal(preStyle.dash, endStyle.dash, t);
  if (dash) out.dash = dash;
  if (!plan.closed) {
    if (plan.arrowStart) out.arrowStart = true;
    if (plan.arrowEnd) out.arrowEnd = true;
    if (plan.arrowStart || plan.arrowEnd) {
      // the head's look comes from whichever side draws one; both → step
      const preHas = preStyle.arrowStart || preStyle.arrowEnd, endHas = endStyle.arrowStart || endStyle.arrowEnd;
      const style = preHas && endHas ? (t < 0.5 ? preStyle : endStyle) : preHas ? preStyle : endStyle;
      out.arrowStyle = style.arrowStyle;
      const sa = preHas ? preStyle.arrowSize : endStyle.arrowSize, sb = endHas ? endStyle.arrowSize : preStyle.arrowSize;
      if (sa != null || sb != null) out.arrowSize = lerp(sa ?? 4, sb ?? 4, t);
    }
  }
  out.d = pathD(nodes, plan.closed);
  return out;
}

/** Sample aligned UNIT chains into a box. Two laws, picked by `pixelLaw(ends)`:
 *  - unit (the usual case): `lerp(ua, ub) · lerp(w)`, so an affine image of a convex
 *    pairing stays exact (ellipse→ellipse is an ellipse at every t);
 *  - pixel (a stroke-thin box on either side): `lerp(ua·wa, ub·wb)`, because a line's
 *    unit frame is degenerate (h = 0 ⇒ v = 0) and the product would be quadratic in t
 *    (the centre sagged 25 px at t = .5).
 *  `ends` is REQUIRED: without the two boxes the law cannot be chosen. An output buffer
 *  keeps node and handle identities stable; callers own placement of the box origin. */
export function sampleNodes(a: VectorNode[], b: VectorNode[], t: number, w: number, h: number, out: VectorNode[], ends: PlanBoxes): VectorNode[] {
  const px = pixelLaw(ends);
  const X = px ? (va: number, vb: number) => lerp(va * ends.wa, vb * ends.wb, t) : (va: number, vb: number) => lerp(va, vb, t) * w;
  const Y = px ? (va: number, vb: number) => lerp(va * ends.ha, vb * ends.hb, t) : (va: number, vb: number) => lerp(va, vb, t) * h;
  for (let i = 0; i < a.length; i++) {
    const na = a[i], nb = b[i];
    const node = out[i] ?? (out[i] = { x: 0, y: 0, type: nb.type });
    node.x = X(na.x, nb.x);
    node.y = Y(na.y, nb.y);
    node.type = nb.type;
    if (na.hIn || nb.hIn) {
      const v = node.hIn ?? (node.hIn = { dx: 0, dy: 0 });
      v.dx = X(na.hIn?.dx ?? 0, nb.hIn?.dx ?? 0);
      v.dy = Y(na.hIn?.dy ?? 0, nb.hIn?.dy ?? 0);
    } else delete node.hIn;
    if (na.hOut || nb.hOut) {
      const v = node.hOut ?? (node.hOut = { dx: 0, dy: 0 });
      v.dx = X(na.hOut?.dx ?? 0, nb.hOut?.dx ?? 0);
      v.dy = Y(na.hOut?.dy ?? 0, nb.hOut?.dy ?? 0);
    } else delete node.hOut;
  }
  out.length = a.length;
  return out;
}

// A local twin of tween.lerpDash (tween imports this module; no cycle).
function lerpDashLocal(a: number[] | undefined, b: number[] | undefined, t: number): number[] | undefined {
  const has = (d?: number[]) => !!d && d.length > 0;
  if (!has(a) && !has(b)) return undefined;
  if (t <= 0) return a ? [...a] : undefined;
  if (t >= 1) return b ? [...b] : undefined;
  const even = (d: number[]) => (d.length % 2 ? [...d, ...d] : [...d]);
  const solidTwin = (other: number[]) => even(other).map((v, i) => (i % 2 ? 0 : v));
  const da = has(a) ? even(a!) : solidTwin(b!);
  const db = has(b) ? even(b!) : solidTwin(a!);
  const n = Math.max(da.length, db.length);
  const pad = (d: number[]) => Array.from({ length: n }, (_, i) => d[i % d.length]);
  const pa = pad(da), pb = pad(db);
  return pa.map((v, i) => Math.max(0, lerp(v, pb[i], t)));
}
