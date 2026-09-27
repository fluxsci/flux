// N↔M outline correspondence. Planning is pure and deferred; prepare() belongs
// in the player's warm hook, never its frame callback. All placements are stage px.
import type { VectorNode } from "../types";
import type { FluxPlotAxis } from "../plot/types";
import type { PairPolicy } from "./types";
import type { StageOutline, OutlineOwner, OutlinePaint } from "./stageOutline";
import { nodesExtent, reverseNodes, segPoint, segLength, splitSeg, type PathSeg } from "../path";
import { lerpColor, prepareColorLerp } from "../color/interp";
import { lerpDash } from "./tween";
import { axisFit, projectWith } from "./player/morph";
import {
  arcStations, boundaryParams, parameterize, pointAt, openRing, morphIsClosed,
  planOutlines, sampleNodes, type RingStrategy, type Outline,
} from "./outline";

export interface CorrespondencePair {
  a: StageOutline | null;
  b: StageOutline | null;
  /** Exact planOutlines UNIT chains; a/b.bbox place them in stage pixels. */
  plan?: { a: VectorNode[]; b: VectorNode[]; closed: boolean; strategy: RingStrategy; prepare(): void };
  landing?: { x: number; y: number; scale: number };
  crossfade?: true;
  boxes?: { a: StageOutline["bbox"]; b: StageOutline["bbox"] };
}
export interface CorrespondencePlan {
  pairs: CorrespondencePair[];
  policy: Exclude<PairPolicy, "auto">;
  driver: "path" | "glyph";
  /** Unsliced destinations, including every merged constituent's identity. */
  destinations: StageOutline[];
  prepare(): void;
}
export interface DataHint {
  /** Data variable and pixel direction; y selects horizontal-series data y. */
  axis?: "x" | "y";
  /** Fit/anchors must already map into STAGE pixels. */
  destAxisFit?: ReturnType<typeof axisFit> | FluxPlotAxis;
  /** For summary → data, the summary's fit (defaults to destAxisFit). */
  sourceAxisFit?: ReturnType<typeof axisFit> | FluxPlotAxis;
}
export interface SampledPath {
  nodes: VectorNode[];
  closed: boolean;
  paint: OutlinePaint;
  opacity: number;
  owner: { a?: OutlineOwner; b?: OutlineOwner };
}
export const GLYPH_FLIGHT_THRESHOLD = 64;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const center = (o: StageOutline) => ({ x: o.bbox.x + o.bbox.w / 2, y: o.bbox.y + o.bbox.h / 2 });
const boxOnly = (o: StageOutline) => !!(o.paint.text || o.paint.raster);
const length = (o: Outline) => parameterize(o.nodes, o.closed).total;
const copyNode = (n: VectorNode): VectorNode => ({ ...n, hIn: n.hIn && { ...n.hIn }, hOut: n.hOut && { ...n.hOut } });
const members = (o: StageOutline) => o.owner.members ?? [{ elementId: o.owner.elementId, ...(o.owner.partId === undefined ? {} : { partId: o.owner.partId }) }];

/** Greedy endpoint joins; reversing a chain also reverses its Bézier handles. */
export function mergeChains(outlines: StageOutline[], eps?: number): StageOutline[] {
  const result = outlines.slice();
  const lengths = result.map((o) => o.closed || boxOnly(o) ? 0 : length(o));
  for (let i = 0; i < result.length; i++) {
    if (result[i].closed || boxOnly(result[i]) || result[i].nodes.length < 2) continue;
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i], b = result[j];
      if (b.closed || boxOnly(b) || b.nodes.length < 2) continue;
      const tolerance = eps ?? Math.max(0.75, 0.01 * Math.min(lengths[i], lengths[j]));
      let join: [boolean, boolean] | undefined;
      for (const ra of [false, true]) {
        for (const rb of [false, true]) {
          const p = a.nodes[ra ? 0 : a.nodes.length - 1], q = b.nodes[rb ? b.nodes.length - 1 : 0];
          if (Math.hypot(p.x - q.x, p.y - q.y) <= tolerance) { join = [ra, rb]; break; }
        }
        if (join) break;
      }
      if (!join) continue;
      const an = join[0] ? reverseNodes(a.nodes) : a.nodes.map(copyNode);
      const bn = join[1] ? reverseNodes(b.nodes) : b.nodes;
      const corner = an[an.length - 1], head = bn[0];
      corner.type = "corner";
      if (head.hOut) corner.hOut = { dx: head.x + head.hOut.dx - corner.x, dy: head.y + head.hOut.dy - corner.y };
      else delete corner.hOut;
      const nodes = an.concat(bn.slice(1).map(copyNode));
      result[i] = { ...a, nodes, bbox: nodesExtent(nodes), owner: { ...a.owner, members: [...members(a), ...members(b)] } };
      lengths[i] = length(result[i]);
      result.splice(j, 1); lengths.splice(j, 1);
      j = i; // a new endpoint can connect a chain skipped earlier
    }
  }
  return result;
}

function dataAxis(A: StageOutline[], B: StageOutline[], hint?: DataHint): "x" | "y" | undefined {
  const axes = hint?.axis ? [hint.axis] : ["x", "y"] as const;
  return axes.find((axis) => A.length > 0 && B.length > 0 &&
    A.every((o) => Number.isFinite(o.owner.data?.[axis])) && B.every((o) => Number.isFinite(o.owner.data?.[axis])));
}
export function choosePolicy(A: StageOutline[], B: StageOutline[], hint?: DataHint): Exclude<PairPolicy, "auto"> {
  if (hint?.destAxisFit && dataAxis(A, B, hint)) return "data";
  if (A.length === B.length && A.length && A.every((o) => Number.isFinite(o.owner.index)) && B.every((o) => Number.isFinite(o.owner.index))) return "order";
  if (A.length === 1 || B.length === 1) return "tile";
  return "spatial";
}

function spatial(A: StageOutline[], B: StageOutline[]): CorrespondencePair[] {
  const pairs: CorrespondencePair[] = [];
  if (A.length * B.length > 4096) {
    const rank = (a: StageOutline, b: StageOutline) => center(a).x - center(b).x || center(a).y - center(b).y;
    const as = A.slice().sort(rank), bs = B.slice().sort(rank);
    for (let i = 0; i < Math.max(as.length, bs.length); i++) pairs.push({ a: as[i] ?? null, b: bs[i] ?? null });
    return pairs;
  }
  const ac = A.map(center), bc = B.map(center);
  const edges: { a: number; b: number; distance: number }[] = [];
  for (let a = 0; a < A.length; a++) for (let b = 0; b < B.length; b++) edges.push({ a, b, distance: (ac[a].x - bc[b].x) ** 2 + (ac[a].y - bc[b].y) ** 2 });
  edges.sort((a, b) => a.distance - b.distance || a.a - b.a || a.b - b.b);
  const usedA = new Set<number>(), usedB = new Set<number>();
  for (const e of edges) if (!usedA.has(e.a) && !usedB.has(e.b)) {
    pairs.push({ a: A[e.a], b: B[e.b] }); usedA.add(e.a); usedB.add(e.b);
  }
  A.forEach((a, i) => { if (!usedA.has(i)) pairs.push({ a, b: null }); });
  B.forEach((b, i) => { if (!usedB.has(i)) pairs.push({ a: null, b }); });
  return pairs;
}

/** Nearest station, either in 2D or along the projected data axis. Original
 *  segments remain intact; a bounded search refines curved segments only. */
// Planning asks "nearest station on this chain" once per source outline —
// 1,200 times for a dense scatter — so the chain is parameterized once, not
// per question (measured: the re-parameterization was most of a 35 ms plan).
const paramCache = new WeakMap<Outline, ReturnType<typeof parameterize>>();
function paramOf(o: Outline): ReturnType<typeof parameterize> {
  let p = paramCache.get(o);
  if (!p) { p = parameterize(o.nodes, o.closed); paramCache.set(o, p); }
  return p;
}
function nearest(o: Outline, p: { x: number; y: number }, axis?: "x" | "y"): { station: number; distance: number } {
  const param = paramOf(o);
  let station = 0, distance = Infinity, acc = 0;
  const cost = (s: PathSeg, t: number) => {
    const q = segPoint(s, t);
    return axis ? (q[axis] - p[axis]) ** 2 : (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  };
  for (let i = 0; i < param.segs.length; i++) {
    const s = param.segs[i];
    let t = 0;
    if (s.line) {
      const dx = s.x3 - s.x0, dy = s.y3 - s.y0;
      const denom = axis === "x" ? dx * dx : axis === "y" ? dy * dy : dx * dx + dy * dy;
      t = denom ? clamp((axis === "x" ? (p.x - s.x0) * dx : axis === "y" ? (p.y - s.y0) * dy : (p.x - s.x0) * dx + (p.y - s.y0) * dy) / denom) : 0;
    } else {
      let k = 0, best = Infinity;
      for (let j = 0; j <= 24; j++) { const c = cost(s, j / 24); if (c < best) { best = c; k = j; } }
      let lo = Math.max(0, (k - 1) / 24), hi = Math.min(1, (k + 1) / 24);
      for (let j = 0; j < 32; j++) {
        const u = (2 * lo + hi) / 3, v = (lo + 2 * hi) / 3;
        if (cost(s, u) <= cost(s, v)) hi = v; else lo = u;
      }
      t = (lo + hi) / 2;
    }
    const d = cost(s, t);
    if (d < distance) {
      distance = d;
      // Convert curve parameter to arc fraction using the same parameterizer.
      const sub = s.line ? t * param.lens[i] : curvePrefix(s, t);
      station = param.total ? (acc + sub) / param.total : 0;
    }
    acc += param.lens[i];
  }
  return { station: clamp(station), distance };
}

function curvePrefix(s: PathSeg, t: number): number { return segLength(splitSeg(s, t)[0], 24); }

/** Split once for all tiles, retaining the original corners and sharing each
 *  boundary exactly. Duplicate stations deliberately yield zero-length tiles. */
function pieces(outline: StageOutline, cuts: number[]): StageOutline[] {
  const chain = outline.closed ? openRing(outline, 0, false) : outline;
  const param = parameterize(chain.nodes, false);
  if (param.total < 1e-9) return cuts.slice(1).map(() => ({ ...outline, closed: false, nodes: chain.nodes.map(copyNode) }));
  const stations = boundaryParams(param, false);
  for (const cut of cuts) if (!stations.some((s) => Math.abs(s - cut) <= 1e-12)) stations.push(cut);
  stations.sort((a, b) => a - b);
  const nodes = arcStations(chain, cuts);
  const indices = cuts.map((cut) => stations.findIndex((s) => Math.abs(s - cut) <= 1e-12));
  return cuts.slice(1).map((_, i) => {
    const ns = nodes.slice(indices[i], indices[i + 1] + 1).map(copyNode);
    if (ns.length === 1) ns.push(copyNode(ns[0]));
    delete ns[0].hIn; delete ns[ns.length - 1].hOut;
    return { ...outline, nodes: ns, closed: false, bbox: nodesExtent(ns) };
  });
}

function tile(single: StageOutline, partners: StageOutline[], source: boolean): CorrespondencePair[] {
  if (!partners.length) return [{ a: source ? single : null, b: source ? null : single }];
  if (partners.length === 1) return [{ a: source ? single : partners[0], b: source ? partners[0] : single }];
  if (boxOnly(single)) return source ? spatial([single], partners) : spatial(partners, [single]);
  // Rings start beside the first partner, then all partners rank along that seam.
  const seam = single.closed ? nearest(single, center(partners[0])).station : 0;
  const splitSide = single.closed ? { ...single, ...openRing(single, seam, false) } : single;
  const ordered = partners.map((o, index) => ({ o, index, s: nearest(splitSide, center(o)).station, len: length(o) }));
  ordered.sort((a, b) => a.s - b.s || a.index - b.index);
  const total = ordered.reduce((sum, p) => sum + p.len, 0);
  let acc = 0;
  const cuts = [0];
  for (const p of ordered) { acc += total ? p.len / total : 1 / ordered.length; cuts.push(clamp(acc)); }
  cuts[cuts.length - 1] = 1;
  const tiles = pieces(splitSide, cuts);
  return ordered.map((p, i) => ({ a: source ? tiles[i] : p.o, b: source ? p.o : tiles[i] }));
}

function byData(A: StageOutline[], B: StageOutline[], hint: DataHint): CorrespondencePair[] {
  const axis = hint.axis ?? dataAxis(A, B, hint) ?? "x";
  const rawFit = hint.destAxisFit;
  if (!rawFit) return spatial(A, B);
  const fit = "m" in rawFit ? rawFit : axisFit(rawFit);
  const groups = B.map(() => [] as { o: StageOutline; station: number; index: number }[]);
  const unused: StageOutline[] = [];
  A.forEach((o, index) => {
    const value = o.owner.data?.[axis];
    if (value === undefined || !Number.isFinite(value) || (fit.log && value <= 0)) { unused.push(o); return; }
    const pixel = projectWith(fit, value);
    if (!Number.isFinite(pixel)) { unused.push(o); return; }
    const p = center(o); p[axis] = pixel;
    let best = -1, distance = Infinity, station = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i], bb = b.bbox;
      const lo = axis === "x" ? bb.x : bb.y, hi = lo + (axis === "x" ? bb.w : bb.h);
      const bin = b.closed && /bar|box|hist/.test(b.owner.role ?? "");
      const q = nearest(b, p, axis);
      // Containing bars/boxes win before nearest-outline fallback. Boundaries
      // go to the first bin, deterministically, including identical data values.
      const d = bin && pixel >= lo && pixel <= hi ? -1 : q.distance;
      if (d < distance) { best = i; distance = d; station = q.station; }
    }
    if (best < 0) unused.push(o); else groups[best].push({ o, station, index });
  });
  const result: CorrespondencePair[] = [];
  const remainingB: StageOutline[] = [];
  B.forEach((b, i) => {
    const group = groups[i];
    if (!group.length) { remainingB.push(b); return; }
    group.sort((a, b) => a.station - b.station || a.index - b.index);
    if (group.length === 1 || boxOnly(b)) {
      result.push({ a: group[0].o, b });
      for (const p of group.slice(1)) unused.push(p.o);
      return;
    }
    const cuts = [0];
    for (let j = 1; j < group.length; j++) cuts.push((group[j - 1].station + group[j].station) / 2);
    cuts.push(1);
    const tiles = pieces(b, cuts);
    for (let j = 0; j < group.length; j++) {
      const o = group[j].o;
      result.push({ a: o, b: tiles[j], landing: {
        ...pointAt(paramOf(b), group[j].station),
        scale: b.paint.strokeWidth / (Math.max(o.bbox.w, o.bbox.h) || 1),
      } });
    }
  });
  return result.concat(spatial(unused, remainingB));
}

const ready = new WeakMap<CorrespondencePair, ReturnType<typeof planOutlines>>();
function planPair(pair: CorrespondencePair): void {
  const { a, b } = pair;
  if (!a || !b) return;
  if (boxOnly(a) || boxOnly(b)) { pair.crossfade = true; pair.boxes = { a: a.bbox, b: b.bbox }; return; }
  const ring = a.closed === b.closed ? undefined : a.closed ? a : b;
  const strategy: RingStrategy = ring && !["", "none", "transparent"].includes(ring.paint.fill.trim().toLowerCase()) ? "inflate" : "cut";
  const local = (o: StageOutline): Outline => ({ closed: o.closed, nodes: o.nodes.map((n) => ({ ...n, x: n.x - o.bbox.x, y: n.y - o.bbox.y })) });
  const prepare = () => {
    let p = ready.get(pair);
    if (!p) {
      p = planOutlines(local(a), a.bbox.w, a.bbox.h, local(b), b.bbox.w, b.bbox.h, strategy);
      ready.set(pair, p);
    }
    return p;
  };
  pair.plan = {
    get a() { return prepare().a; }, get b() { return prepare().b; },
    closed: morphIsClosed(a, b, strategy), strategy,
    prepare() { prepare(); },
  };
}

// A warm N↔M plan must survive the 256-entry 1↔1 cache even when it has 1,200
// pairs. Content keys catch in-place edits; a small bounded cache owns prepared
// batches. No key construction, geometry planning or cache lookup in sampling.
const batches = new Map<string, CorrespondencePlan>();
const BATCH_CACHE_MAX = 4;
export function planCorrespondence(A: StageOutline[], B: StageOutline[], opts: { pair?: PairPolicy; data?: DataHint } = {}): CorrespondencePlan {
  const key = JSON.stringify([A, B, opts.pair ?? "auto", opts.data]);
  const hit = batches.get(key);
  if (hit) return hit;
  // A later edit to a producer's arrays must not alter a cached earlier frame.
  A = structuredClone(A); B = structuredClone(B);
  const as = mergeChains(A), bs = mergeChains(B);
  let policy = opts.pair && opts.pair !== "auto" ? opts.pair : choosePolicy(as, bs, opts.data);
  let pairs: CorrespondencePair[];
  if (policy === "data" && opts.data?.destAxisFit) {
    // In reverse, project the destination data into the source summary's fit.
    if (as.length === 1 && bs.length > 1 && bs.every((o) => o.owner.data)) {
      pairs = byData(bs, as, { ...opts.data, destAxisFit: opts.data.sourceAxisFit ?? opts.data.destAxisFit }).map((p) => ({ a: p.b, b: p.a }));
    } else pairs = byData(as, bs, opts.data);
  } else if (policy === "tile" && (as.length === 1 || bs.length === 1)) {
    pairs = as.length === 1 ? tile(as[0], bs, true) : tile(bs[0], as, false);
  } else if (policy === "order" && as.length === bs.length) {
    const rank = (a: StageOutline, b: StageOutline) => (a.owner.index ?? Infinity) - (b.owner.index ?? Infinity) || (a.owner.series ?? "").localeCompare(b.owner.series ?? "");
    const indexedA = as.filter((o) => Number.isFinite(o.owner.index)), indexedB = bs.filter((o) => Number.isFinite(o.owner.index));
    if (indexedA.length === indexedB.length) {
      indexedA.sort(rank); indexedB.sort(rank);
      pairs = indexedA.map((a, i) => ({ a, b: indexedB[i] }));
      pairs.push(...spatial(as.filter((o) => !Number.isFinite(o.owner.index)), bs.filter((o) => !Number.isFinite(o.owner.index))));
    } else { policy = "spatial"; pairs = spatial(as, bs); }
  } else { policy = "spatial"; pairs = spatial(as, bs); }
  const driver = pairs.length > GLYPH_FLIGHT_THRESHOLD && as.length > 0 && as.every((o) => o.closed && !boxOnly(o) && o.bbox.w <= 12 && o.bbox.h <= 12) ? "glyph" : "path";
  for (const pair of pairs) {
    // A glyph flight moves the marker nodes themselves and never samples a
    // path plan, so planning 1,200 outline correspondences would only burn the
    // warm hook (measured: ~65 of ~90 ms). Glyph pairs keep their landing only.
    if (driver !== "glyph") planPair(pair);
    if (driver === "glyph" && pair.a && pair.b && !pair.landing) {
      const station = pointAt(paramOf(pair.b), 0.5);
      pair.landing = { ...station, scale: pair.b.paint.strokeWidth / (Math.max(pair.a.bbox.w, pair.a.bbox.h) || 1) };
    }
  }
  const result: CorrespondencePlan = { pairs, policy, driver, destinations: bs, prepare() { for (const p of pairs) p.plan?.prepare(); } };
  if (batches.size >= BATCH_CACHE_MAX) batches.delete(batches.keys().next().value!);
  batches.set(key, result);
  return result;
}

interface SampleBuffers {
  pair: CorrespondencePair;
  a: VectorNode[];
  b: VectorNode[];
  morph: VectorNode[];
  dash: number[];
  aDash?: number[];
  bDash?: number[];
  fill: (t: number) => string;
  stroke: (t: number) => string;
}
const buffers = new WeakMap<SampledPath, SampleBuffers>();

/** prepare() must run before sampling. Endpoint nodes are the exact authored
 *  chains (the aligned intermediate may have additional corner-preserving
 *  splits). Reuse out to retain every path, node, handle and dash buffer. */
export function sampleCorrespondence(plan: CorrespondencePlan, t: number, out: SampledPath[] = []): SampledPath[] {
  t = clamp(t);
  for (let i = 0; i < plan.pairs.length; i++) {
    const pair = plan.pairs[i], { a, b } = pair;
    const aligned = ready.get(pair);
    if (pair.plan && !aligned) throw new Error("Call correspondence.prepare() before sampling");
    const one = a ?? b!;
    let path = out[i], buf = path && buffers.get(path);
    if (!buf || buf.pair !== pair) {
      const pa = (a ?? one).paint, pb = (b ?? one).paint;
      buf = {
        pair, a: (a?.nodes ?? []).map(copyNode), b: (b?.nodes ?? []).map(copyNode),
        morph: aligned ? sampleNodes(aligned.a, aligned.b, 0, 1, 1) : [],
        dash: lerpDash(pa.dash, pb.dash, 0.5) ?? [],
        aDash: lerpDash(pa.dash, pb.dash, 0), bDash: lerpDash(pa.dash, pb.dash, 1),
        fill: prepareColorLerp(pa.fill, pb.fill), stroke: prepareColorLerp(pa.stroke, pb.stroke),
      };
      path = { nodes: [], closed: one.closed, paint: { ...one.paint }, opacity: 1, owner: { a: a?.owner, b: b?.owner } };
      buffers.set(path, buf); out[i] = path;
    }
    path.opacity = !b ? clamp(1 - t / 0.4) : !a ? clamp((t - 0.6) / 0.4) : 1;
    if (!a || !b || t === 0 || t === 1 || pair.crossfade) {
      const end = !a ? b! : !b ? a : t < 0.5 ? a : b;
      path.nodes = end === a ? buf.a : buf.b;
      path.closed = end.closed;
    } else if (aligned) {
      const x = lerp(a.bbox.x, b.bbox.x, t), y = lerp(a.bbox.y, b.bbox.y, t);
      path.nodes = sampleNodes(aligned.a, aligned.b, t, lerp(a.bbox.w, b.bbox.w, t), lerp(a.bbox.h, b.bbox.h, t), buf.morph);
      for (const n of path.nodes) { n.x += x; n.y += y; }
      path.closed = aligned.closed;
    }
    const pa = a?.paint ?? one.paint, pb = b?.paint ?? one.paint, paint = path.paint;
    paint.fill = pa.fill === pb.fill ? pa.fill : lerpColor(pa.fill, pb.fill, t, buf.fill);
    paint.stroke = pa.stroke === pb.stroke ? pa.stroke : lerpColor(pa.stroke, pb.stroke, t, buf.stroke);
    paint.strokeWidth = lerp(pa.strokeWidth, pb.strokeWidth, t);
    paint.dash = t === 0 ? buf.aDash : t === 1 ? buf.bDash : lerpDash(pa.dash, pb.dash, t, buf.dash);
    paint.cap = t < 0.5 ? pa.cap : pb.cap;
    paint.opacity = lerp(pa.opacity ?? 1, pb.opacity ?? 1, t);
    const stepped = t < 0.5 ? pa : pb;
    paint.arrowStart = stepped.arrowStart; paint.arrowEnd = stepped.arrowEnd;
    paint.arrowStyle = stepped.arrowStyle; paint.arrowSize = stepped.arrowSize;
    paint.text = stepped.text; paint.raster = stepped.raster;
  }
  out.length = plan.pairs.length;
  return out;
}
