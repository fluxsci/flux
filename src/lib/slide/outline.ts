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

import type { Element, PathElement, VectorNode } from "../types";
import { elementBBox } from "../geometry";
import { lerpColor } from "../color/interp";
import {
  pathD, pathToNodes, pathRender, roundCorners, reverseNodes, segsFromNodes, segLength, splitSeg, segPoint,
  type PathSeg,
} from "../path";

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

function parameterize(nodes: VectorNode[], closed: boolean): Param {
  const segs = segsFromNodes(nodes, closed);
  const lens = segs.map((s) => segLength(s, 24));
  return { segs, lens, total: lens.reduce((a, b) => a + b, 0) };
}

/** The point at normalized arc length s ∈ [0,1]. */
function pointAt(p: Param, s: number): { x: number; y: number } {
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

function mergeStations(stations: number[]): number[] {
  const sorted = stations.map((s) => Math.max(0, Math.min(1, s))).sort((a, b) => a - b);
  const out: number[] = [];
  for (const s of sorted) if (!out.length || s - out[out.length - 1] > STATION_EPS) out.push(s);
  return out;
}

/** Parameter t on a segment at arc length `dist` from its start (bisection
 *  for curves — a cubic's t is not proportional to arc length). */
function arcT(seg: PathSeg, len: number, dist: number): number {
  if (seg.line || len < 1e-9) return len < 1e-9 ? 0 : Math.max(0, Math.min(1, dist / len));
  if (dist <= 0) return 0;
  if (dist >= len) return 1;
  let lo = 0, hi = 1, t = dist / len;
  for (let k = 0; k < 20; k++) {
    t = (lo + hi) / 2;
    if (segLength(splitSeg(seg, t)[0], 16) < dist) lo = t;
    else hi = t;
  }
  return t;
}

/** The normalized arc-length parameter of every node boundary (closed rings:
 *  n boundaries at the seam and after each segment; open chains: n). */
function boundaryParams(p: Param, closed: boolean): number[] {
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
  const { nodes, closed } = outline;
  const p = parameterize(nodes, closed);
  if (!p.segs.length || p.total < 1e-9) return nodes.map(cp);
  const wanted = mergeStations(stations);
  const eps = STATION_EPS * p.total; // the station tolerance in arc-length units
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
function reseam(outline: Outline, s0: number, reverse: boolean): Outline {
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
function openRing(outline: Outline, c: number, reverse: boolean): Outline {
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

function signedArea(p: Param, samples = 64): number {
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
function matchCost(a: Param, b: Param, s0: number, reverse: boolean, closed: boolean, m = 32): number {
  let cost = 0;
  for (let i = 0; i <= m; i++) {
    const s = i / m;
    const sb = closed ? ((reverse ? s0 - s : s0 + s) % 1 + 1) % 1 : reverse ? 1 - s : s;
    cost += dist2(pointAt(a, s), pointAt(b, sb));
  }
  return cost;
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
}

/** How a stroke and a ring meet. A stroke becoming a FILLED ring inflates: the
 *  stroke doubles back on itself as a degenerate ring that swells into the
 *  shape (no wedge, the fill grows with it). A stroke-only ring instead CUTS
 *  open where it is nearest the stroke's ends and unrolls into it. */
export type RingStrategy = "cut" | "inflate";

/** A stroke as a degenerate ring: out along the chain, back along it. Handles
 *  retrace exactly, so the ring's two turns are hairpins (round linejoins
 *  render them as the stroke's round caps). */
function inflateChain(nodes: VectorNode[]): VectorNode[] {
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
export function planOutlines(A: Outline, aw: number, ah: number, B: Outline, bw: number, bh: number, strategy: RingStrategy = "cut"): { a: VectorNode[]; b: VectorNode[]; closed: boolean } {
  let ua: Outline = { nodes: unit(A.nodes, aw, ah), closed: A.closed };
  let ub: Outline = { nodes: unit(B.nodes, bw, bh), closed: B.closed };
  if (ua.closed !== ub.closed && strategy === "inflate") {
    if (!ua.closed) ua = { nodes: inflateChain(ua.nodes), closed: true };
    else ub = { nodes: inflateChain(ub.nodes), closed: true };
  }
  if (ua.closed && ub.closed) {
    // rings: same winding, then the seam offset (+ direction) of B that best
    // overlays A — continuous candidates, not just B's own nodes.
    const pa = parameterize(ua.nodes, true), pb = parameterize(ub.nodes, true);
    const flip = Math.sign(signedArea(pa)) * Math.sign(signedArea(pb)) < 0;
    let best = { s0: 0, reverse: flip, cost: Infinity };
    const candidates = new Set<number>([...Array.from({ length: CANDIDATES }, (_, i) => i / CANDIDATES), ...boundaryParams(pb, true)]);
    for (const s0 of candidates) {
      for (const reverse of [flip, !flip]) {
        const cost = matchCost(pa, pb, s0, reverse, true) + (reverse !== flip ? 1e-6 : 0);
        if (cost < best.cost) best = { s0, reverse, cost };
      }
    }
    ub = reseam(ub, best.s0, best.reverse);
  } else if (!ua.closed && !ub.closed) {
    const pa = parameterize(ua.nodes, false), pb = parameterize(ub.nodes, false);
    if (matchCost(pa, pb, 0, true, false) + 1e-9 < matchCost(pa, pb, 0, false, false)) ub = { nodes: reverseNodes(ub.nodes), closed: false };
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
  return { a, b, closed };
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
}

export interface FixedHead {
  side: "pre" | "end";
  filled: boolean;
  /** Head vertices in the side's unit frame (u = x/w, v = y/h). */
  pts: [number, number][];
}

/** Opacity of a fixed (inflate) head at time t: a pre head melts away over the
 *  first 40 % of the morph, an end head condenses over the last 40 %. */
export function fixedHeadOpacity(head: FixedHead, t: number): number {
  return head.side === "pre" ? Math.max(0, Math.min(1, 1 - t / 0.4)) : Math.max(0, Math.min(1, (t - 0.6) / 0.4));
}

/** The arrowheads a stroke side draws, in its unit frame. */
function strokeHeads(el: Element, outline: Outline, box: { w: number; h: number }, side: "pre" | "end"): FixedHead[] {
  const st = styleOf(el);
  if (outline.closed || (!st.arrowStart && !st.arrowEnd) || outline.nodes.length < 2) return [];
  const pr = pathRender({ d: pathD(outline.nodes, false), nodes: outline.nodes, closed: false, strokeWidth: st.strokeWidth, arrowStart: st.arrowStart, arrowEnd: st.arrowEnd, arrowStyle: st.arrowStyle, arrowSize: st.arrowSize });
  const sx = box.w > 1e-9 ? 1 / box.w : 0, sy = box.h > 1e-9 ? 1 / box.h : 0;
  const map = (pts: number[][]): [number, number][] => pts.map(([x, y]) => [x * sx, y * sy]);
  return [...pr.polys.map((pts) => ({ side, filled: true, pts: map(pts) })), ...pr.vees.map((pts) => ({ side, filled: false, pts: map(pts) }))];
}

interface OutlineStyle {
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
function styleOf(el: Element): OutlineStyle {
  const e = el as unknown as Record<string, unknown>;
  const open = el.type === "line" || (el.type === "path" && !el.closed);
  return {
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
  const strategy: RingStrategy = ringStyle && !isNoneColor(ringStyle.fill) ? "inflate" : "cut";
  const { a, b, closed } = planOutlines(A, pb.w, pb.h, B, eb.w, eb.h, strategy);
  const fixedHeads = strategy === "inflate" ? [...strokeHeads(pre, A, pb, "pre"), ...strokeHeads(end, B, eb, "end")] : [];
  return {
    a, b, closed, pre, end, strategy, fixedHeads,
    preBox: pb, endBox: eb, preStyle, endStyle,
    arrowStart: !closed && (preStyle.arrowStart || endStyle.arrowStart),
    arrowEnd: !closed && (preStyle.arrowEnd || endStyle.arrowEnd),
  };
}

function isNoneColor(c: string): boolean {
  const t = c.trim().toLowerCase();
  return t === "none" || t === "transparent" || t === "";
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
export function sampleElementMorph(plan: ElementMorphPlan, t: number): PathElement {
  const { pre, end, preBox, endBox, preStyle, endStyle } = plan;
  const w = lerp(preBox.w, endBox.w, t), h = lerp(preBox.h, endBox.h, t);
  const nodes: VectorNode[] = new Array(plan.a.length);
  for (let i = 0; i < plan.a.length; i++) {
    const na = plan.a[i], nb = plan.b[i];
    const node: VectorNode = { x: lerp(na.x, nb.x, t) * w, y: lerp(na.y, nb.y, t) * h, type: nb.type };
    const hIn = handle(na.hIn, nb.hIn, t, w, h), hOut = handle(na.hOut, nb.hOut, t, w, h);
    if (hIn) node.hIn = hIn;
    if (hOut) node.hOut = hOut;
    nodes[i] = node;
  }
  const fill = lerpColor(preStyle.fill, endStyle.fill, t);
  const stroke = lerpColor(preStyle.stroke, endStyle.stroke, t);
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
    strokeWidth: lerp(preStyle.strokeWidth, endStyle.strokeWidth, t),
    closed: plan.closed,
    nodes,
    cap: t < 0.5 ? preStyle.cap : endStyle.cap,
  };
  const opA = pre.opacity ?? 1, opB = end.opacity ?? 1;
  if (opA !== 1 || opB !== 1) out.opacity = lerp(opA, opB, t);
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

function handle(a: { dx: number; dy: number } | undefined, b: { dx: number; dy: number } | undefined, t: number, w: number, h: number) {
  if (!a && !b) return undefined;
  return { dx: lerp(a?.dx ?? 0, b?.dx ?? 0, t) * w, dy: lerp(a?.dy ?? 0, b?.dy ?? 0, t) * h };
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
