// N↔M outline correspondence. Planning is pure and deferred; prepare() belongs
// in the player's warm hook, never its frame callback. All placements are stage px.
import type { VectorNode } from "../types";
import type { FluxPlotAxis } from "../plot/types";
import type { PairPolicy, TransformMethod } from "./types";
import type { StageOutline, OutlineOwner, OutlinePaint } from "./stageOutline";
import { nodesExtent, reverseNodes, segPoint, segLength, splitSeg, type PathSeg } from "../path";
import { lerpColor, prepareColorLerp } from "../color/interp";
import { lerpDash } from "./tween";
import { axisFit, projectWith } from "../plot/project";
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
  /** A filled ring's INTERIOR while its outline splits (a-only) or pieces merge into
   *  it (b-only), under a transform method other than shatter: the sampler fades,
   *  shrinks or drains the ring's fill-only copy instead of flying it anywhere. */
  interior?: InteriorSpec;
}
export interface InteriorSpec {
  method: Exclude<TransformMethod, "shatter">;
  /** The ring's centre (collapse shrinks toward it; drain measures from it). */
  centre: { x: number; y: number };
  /** Unit direction from the ring toward its partners (drain's front moves along it). */
  dir: { x: number; y: number };
  /** The ring's extent projected on `dir`, relative to `centre`. */
  lo: number;
  hi: number;
}
/** How much of the flight (eased progress) the interior takes to leave or arrive —
 *  collapse and drain are MOTION, so they scale with the flight. */
export const INTERIOR_WINDOW: Record<InteriorSpec["method"], number> = { dissolve: 0.3, collapse: 0.45, drain: 0.45 };
/** Dissolve is a FADE and reads right only when quick: given the flight's timing
 *  it runs over this many real ms however long the transform is (owner, 2026-10-03);
 *  `INTERIOR_WINDOW.dissolve` is the fallback when a caller has no timing. */
export const DISSOLVE_MS = 220;
/** The flight's real timing, so time-based interiors (dissolve) can ignore its length. */
export interface SampleTiming { raw: number; durationMs: number }
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
/** Ring ↔ ring sets morph outline to outline up to this many pairs (the driver choice
 *  in planCorrespondence); beyond it they fall back to glyph flights. Measured in the
 *  portable player on the reference workstation (2026-10-05, scratch-probe/frame-cost):
 *  88 ring morphs 1.6 ms of main thread per frame, 400 → 4.9 ms (p95 6.2, rAF held at
 *  16.7), 1,200 → 15 ms with rAF p95 at 33 ms — so 400 keeps a third of the frame. */
export const RING_MORPH_THRESHOLD = 400;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const center = (o: StageOutline) => ({ x: o.bbox.x + o.bbox.w / 2, y: o.bbox.y + o.bbox.h / 2 });
const boxOnly = (o: StageOutline) => !!(o.paint.text || o.paint.raster);
/** A marker-sized ring (a scatter point, a logo dot): what a glyph flight may carry. */
const smallRing = (o: StageOutline) => o.closed && !boxOnly(o) && o.bbox.w <= 12 && o.bbox.h <= 12;
const length = (o: Outline) => parameterize(o.nodes, o.closed).total;
const copyNode = (n: VectorNode): VectorNode => ({ ...n, hIn: n.hIn && { ...n.hIn }, hOut: n.hOut && { ...n.hOut } });
const members = (o: StageOutline) => o.owner.members ?? [{ elementId: o.owner.elementId, ...(o.owner.partId === undefined ? {} : { partId: o.owner.partId }) }];

/** Two chains may fuse into one only when one stroke could have drawn them:
 *  same colour, width, dash and alpha. A boxplot's box is a 7-px half-alpha
 *  stroke whose ends touch its 1-px whiskers; fused, the merged chain took the
 *  whiskers' paint and the box simply appeared when the flight landed. */
const samePaint = (a: OutlinePaint, b: OutlinePaint) =>
  a.stroke === b.stroke && a.fill === b.fill && Math.abs(a.strokeWidth - b.strokeWidth) < 1e-6 &&
  (a.opacity ?? 1) === (b.opacity ?? 1) && (a.dash?.join() ?? "") === (b.dash?.join() ?? "") &&
  !!a.arrowStart === !!b.arrowStart && !!a.arrowEnd === !!b.arrowEnd;

/** Greedy endpoint joins; reversing a chain also reverses its Bézier handles. */
export function mergeChains(outlines: StageOutline[], eps?: number): StageOutline[] {
  const result = outlines.slice();
  const lengths = result.map((o) => o.closed || boxOnly(o) ? 0 : length(o));
  for (let i = 0; i < result.length; i++) {
    if (result[i].closed || boxOnly(result[i]) || result[i].nodes.length < 2) continue;
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i], b = result[j];
      if (b.closed || boxOnly(b) || b.nodes.length < 2 || !samePaint(a.paint, b.paint)) continue;
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

const isLetter = (o: StageOutline) => (o.owner.role === "glyph" || o.owner.role === "glyph-box") && Number.isFinite(o.owner.index);
const filled = (o: StageOutline) => !["", "none", "transparent"].includes(o.paint.fill.trim().toLowerCase());

/** Sutherland–Hodgman against the vertical band lo ≤ x ≤ hi (a convex window,
 *  so any subject polygon clips correctly). */
function clipBand(poly: { x: number; y: number }[], lo: number, hi: number): { x: number; y: number }[] {
  const edge = (pts: { x: number; y: number }[], keep: (p: { x: number }) => boolean, at: number) => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length], kp = keep(p), kq = keep(q);
      if (kp) out.push(p);
      if (kp !== kq) { const t = (at - p.x) / (q.x - p.x || 1e-12); out.push({ x: at, y: p.y + (q.y - p.y) * t }); }
    }
    return out;
  };
  return edge(edge(poly, (p) => p.x >= lo, lo), (p) => p.x <= hi, hi);
}

/** A FILLED shape splitting into letters splits its AREA: vertical strips, one
 *  per letter in reading order, each as wide as its share of the letters'
 *  widths — closed filled rings that morph ring-to-ring into their letters
 *  (cutting the outline into open pieces instead dropped the fill at t = 0+).
 *  The strips tile the shape exactly; the hand-off covers their seams with the
 *  shape itself for the first (or last) 15 %. Null when a strip would vanish. */
export function sliceIntoLetters(single: StageOutline, letters: StageOutline[]): StageOutline[] | null {
  const ordered = letters.slice().sort((a, b) => a.owner.index! - b.owner.index!);
  const param = paramOf(single), samples = Math.max(96, 12 * ordered.length);
  const poly = Array.from({ length: samples }, (_, i) => pointAt(param, i / samples));
  const total = ordered.reduce((sum, o) => sum + Math.max(o.bbox.w, 1e-3), 0);
  const { x, w } = single.bbox;
  let acc = 0;
  const strips: StageOutline[] = [];
  for (const o of ordered) {
    const lo = x + (acc / total) * w; acc += Math.max(o.bbox.w, 1e-3);
    const hi = x + (acc / total) * w;
    // opaque strips overlap by half a stage px so no anti-aliased seam shows
    const over = opaque(single.paint) ? SEAM_OVERLAP : 0;
    const pts = clipBand(poly, lo - over, hi + over);
    if (pts.length < 3) return null;
    const nodes = pts.map((p) => ({ x: p.x, y: p.y, type: "corner" as const }));
    const bbox = nodesExtent(nodes, true);
    if (bbox.w < 1e-6 || bbox.h < 1e-6) return null;
    // Strips carry the shape's FILL only: an outline per strip would draw every
    // seam; the hand-off holds the shape itself (outline and all) over the seams.
    strips.push({ ...single, nodes, closed: true, bbox, owner: { ...single.owner, role: "slice", index: o.owner.index }, paint: { ...single.paint, stroke: "none", strokeWidth: 0, dash: undefined } });
  }
  return strips;
}

function tile(single: StageOutline, partners: StageOutline[], source: boolean, method: TransformMethod = "shatter"): CorrespondencePair[] {
  if (!partners.length) return [{ a: source ? single : null, b: source ? null : single }];
  if (partners.length === 1) return [{ a: source ? single : partners[0], b: source ? partners[0] : single }];
  if (boxOnly(single)) return source ? spatial([single], partners) : spatial(partners, [single]);
  if (single.closed && filled(single) && partners.every(isLetter) && method === "shatter") {
    const strips = sliceIntoLetters(single, partners);
    if (strips) {
      const ordered = partners.slice().sort((a, b) => a.owner.index! - b.owner.index!);
      return ordered.map((o, i) => ({ a: source ? strips[i] : o, b: source ? o : strips[i] }));
    }
  }
  // Rings start beside the first partner, then all partners rank along that seam.
  const seam = single.closed ? nearest(single, center(partners[0])).station : 0;
  const splitSide = single.closed ? { ...single, ...openRing(single, seam, false) } : single;
  const ordered = partners.map((o, index) => ({ o, index, s: nearest(splitSide, center(o)).station, len: length(o) }));
  // Letters (text glyph outlines) take their pieces in READING order — the
  // shape pours into the word left to right — rather than around the seam.
  const letters = partners.every((o) => (o.owner.role === "glyph" || o.owner.role === "glyph-box") && Number.isFinite(o.owner.index));
  if (letters) ordered.sort((a, b) => a.o.owner.index! - b.o.owner.index!);
  else ordered.sort((a, b) => a.s - b.s || a.index - b.index);
  const total = ordered.reduce((sum, p) => sum + p.len, 0);
  let acc = 0;
  const cuts = [0];
  for (const p of ordered) { acc += total ? p.len / total : 1 / ordered.length; cuts.push(clamp(acc)); }
  cuts[cuts.length - 1] = 1;
  let tiles = pieces(splitSide, cuts);
  const interior = single.closed && filled(single);
  // Under every method but shatter the arcs carry the STROKE only: the interior is
  // one fill-only ring the sampler fades, shrinks or drains (below), never a set
  // of chord-filled segments flying apart.
  if (interior && method !== "shatter") tiles = tiles.map((t) => ({ ...t, paint: { ...t.paint, fill: "none" } }));
  const pairs: CorrespondencePair[] = ordered.map((p, i) => ({ a: source ? tiles[i] : p.o, b: source ? p.o : tiles[i] }));
  if (interior && method !== "shatter") {
    const ring = fillOnly(single);
    const c = center(single);
    const x0 = Math.min(...partners.map((o) => o.bbox.x)), y0 = Math.min(...partners.map((o) => o.bbox.y));
    const x1 = Math.max(...partners.map((o) => o.bbox.x + o.bbox.w)), y1 = Math.max(...partners.map((o) => o.bbox.y + o.bbox.h));
    const dx = (x0 + x1) / 2 - c.x, dy = (y0 + y1) / 2 - c.y, len = Math.hypot(dx, dy);
    const dir = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
    const param = paramOf(single);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 64; i++) { const q = pointAt(param, i / 64); const d = (q.x - c.x) * dir.x + (q.y - c.y) * dir.y; lo = Math.min(lo, d); hi = Math.max(hi, d); }
    const spec: InteriorSpec = { method, centre: c, dir, lo, hi };
    pairs.unshift(source ? { a: ring, b: null, interior: spec } : { a: null, b: ring, interior: spec });
  }
  // A FILLED ring's open arcs paint only their chord-closed segments, so with
  // three or more partners the polygon between the chords would go blank on the
  // first flight frame (and pop in on the last, merging). Its area rides along
  // too: one fill-only triangle per piece, from the chord polygon's centroid to
  // the piece's two ends, paired with the piece's own partner (as a fill-only
  // copy of it) — the interior pours into the partner with its arc and fades
  // where the partner has no fill. Beneath the arcs; the hand-off covers the
  // triangles' seams with the live shape over the flight's first (or last)
  // 15 % — `slice`, the letter-strip rule. (A travelling fill-only copy of the
  // whole ring was tried for this and read as a blob floating off and fading,
  // 2026-10-02.)
  if (interior && method === "shatter" && tiles.length >= 3) {
    const corners = tiles.map((t) => t.nodes[0]);
    const centroid = polygonCentroid(corners);
    if (centroid) {
      const fills: CorrespondencePair[] = [];
      tiles.forEach((t, i) => {
        const o = ordered[i].o;
        if (boxOnly(o)) return; // a text/raster partner crossfades its clone; no fill to pour into it
        const p0 = t.nodes[0], p1 = t.nodes[t.nodes.length - 1];
        // Adjacent fills share edges, and two anti-aliased edges never quite meet:
        // an OPAQUE fill overlaps its neighbours by half a stage px (hidden under
        // them and under the arcs drawn on top), so the shape never shows seams.
        const pts = expandPolygon([centroid, p0, p1], opaque(single.paint) ? SEAM_OVERLAP : 0);
        const nodes: VectorNode[] = pts.map((q) => ({ x: q.x, y: q.y, type: "corner" as const }));
        const tri: StageOutline = { ...fillOnly(single), nodes, closed: true, bbox: nodesExtent(nodes, true), owner: { ...single.owner, role: "slice", index: o.owner.index } };
        fills.push(source ? { a: tri, b: fillOnly(o) } : { a: fillOnly(o), b: tri });
      });
      pairs.unshift(...fills);
    }
  }
  return pairs;
}

/** The outline's fill alone: no stroke, dash or heads. */
const fillOnly = (o: StageOutline): StageOutline => ({ ...o, paint: { ...o.paint, stroke: "none", strokeWidth: 0, dash: undefined, arrowStart: false, arrowEnd: false } });

/** Half a stage px of overlap between adjacent opaque fill pieces (device px
 *  ≥ 1 at any presentation scale), so no anti-aliased seam can show. */
const SEAM_OVERLAP = 0.5;
/** Whether a fill (with the outline's own alpha) paints fully opaque — only then
 *  may pieces overlap invisibly; a translucent fill would darken where it did. */
export function opaque(paint: OutlinePaint): boolean {
  if ((paint.opacity ?? 1) < 1) return false;
  const c = paint.fill.trim().toLowerCase();
  if (["", "none", "transparent"].includes(c)) return false;
  if (c.startsWith("#")) return c.length === 7 || c.length === 4 || /ff$/.test(c) && (c.length === 9) || (c.length === 5 && c.endsWith("f"));
  const fn = /^(?:rgba?|hsla?|oklch|oklab|color)\((.*)\)$/.exec(c);
  if (!fn) return true; // named colours
  const alpha = fn[1].includes("/") ? fn[1].split("/")[1] : fn[1].split(",")[3];
  if (alpha === undefined) return true;
  const v = alpha.trim(); return v.endsWith("%") ? parseFloat(v) >= 100 : parseFloat(v) >= 1;
}
/** Offset a convex polygon's edges outward by `d` (mitred corners, mitre length
 *  capped at 3·d so a needle-thin triangle never grows a spike). d = 0 → copy. */
export function expandPolygon(pts: { x: number; y: number }[], d: number): { x: number; y: number }[] {
  const n = pts.length;
  if (!d || n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  let area = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p.x * q.y - q.x * p.y; }
  const sign = area >= 0 ? 1 : -1; // outward = right of travel for a CCW ring in y-down… both handled by sign
  const normal = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
    return { x: sign * dy / len, y: -sign * dx / len };
  };
  return pts.map((v, i) => {
    const n1 = normal(pts[(i + n - 1) % n], v), n2 = normal(v, pts[(i + 1) % n]);
    const dot = n1.x * n2.x + n1.y * n2.y;
    let mx = (n1.x + n2.x) / (1 + dot), my = (n1.y + n2.y) / (1 + dot);
    const len = Math.hypot(mx, my);
    if (!Number.isFinite(len) || len > 3) { const k = 3 / (len || 1); mx = Number.isFinite(mx) ? mx * k : n1.x * 3; my = Number.isFinite(my) ? my * k : n1.y * 3; }
    return { x: v.x + d * mx, y: v.y + d * my };
  });
}

/** Signed-area centroid of a simple polygon; null when it has no area. */
function polygonCentroid(pts: { x: number; y: number }[]): { x: number; y: number } | null {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-6) return null;
  return { x: cx / (6 * a), y: cy / (6 * a) };
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
export function planCorrespondence(A: StageOutline[], B: StageOutline[], opts: { pair?: PairPolicy; data?: DataHint; method?: TransformMethod } = {}): CorrespondencePlan {
  const key = JSON.stringify([A, B, opts.pair ?? "auto", opts.data, opts.method ?? "shatter"]);
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
    pairs = as.length === 1 ? tile(as[0], bs, true, opts.method) : tile(bs[0], as, false, opts.method);
  } else if (policy === "order" && as.length === bs.length) {
    const rank = (a: StageOutline, b: StageOutline) => (a.owner.index ?? Infinity) - (b.owner.index ?? Infinity) || (a.owner.series ?? "").localeCompare(b.owner.series ?? "");
    const indexedA = as.filter((o) => Number.isFinite(o.owner.index)), indexedB = bs.filter((o) => Number.isFinite(o.owner.index));
    if (indexedA.length === indexedB.length) {
      indexedA.sort(rank); indexedB.sort(rank);
      pairs = indexedA.map((a, i) => ({ a, b: indexedB[i] }));
      pairs.push(...spatial(as.filter((o) => !Number.isFinite(o.owner.index)), bs.filter((o) => !Number.isFinite(o.owner.index))));
    } else { policy = "spatial"; pairs = spatial(as, bs); }
  } else { policy = "spatial"; pairs = spatial(as, bs); }
  // The glyph driver is the BUDGET route for markers pouring into a STROKE: a dense
  // scatter's points fly to their stations on a fitted line, shrink to its width and
  // fade, because planning and sampling 1,200 outline morphs there would not hold a
  // frame. It is never the truest picture for a ring that has a RING to become: 88
  // logo dots becoming 88 drawn ellipses must morph outline to outline exactly as one
  // dot does (owner, 2026-10-05 — "truly becoming, not a fade unless nothing better
  // exists"), so a ring ↔ ring set stays on the path driver up to RING_MORPH_THRESHOLD
  // pairs (a ring morph is a handful of nodes; the budget's measurement sits on the
  // constant). Only a set whose rings land on open pieces, or one beyond that budget,
  // flies as glyphs.
  const markers = pairs.length > GLYPH_FLIGHT_THRESHOLD && as.length > 0 && as.every(smallRing);
  const ringToRing = markers && pairs.every((p) => !p.a || !p.b || (p.b.closed && !boxOnly(p.b)));
  const driver = markers && !(ringToRing && pairs.length <= RING_MORPH_THRESHOLD) ? "glyph" : "path";
  for (const pair of pairs) {
    // A glyph flight moves the marker nodes themselves and never samples a
    // path plan, so planning 1,200 outline correspondences would only burn the
    // warm hook (measured: ~65 of ~90 ms). Glyph pairs keep their landing only.
    if (driver !== "glyph") planPair(pair);
    if (driver === "glyph" && pair.a && pair.b && !pair.landing) {
      const b = pair.b, size = Math.max(pair.a.bbox.w, pair.a.bbox.h) || 1;
      // A marker landing on a RING (a ring ↔ ring set over the morph budget) lands on
      // the ring's centre at the ring's size; one landing on a stroke sits on the
      // stroke's station at the stroke's width.
      if (b.closed) pair.landing = { x: b.bbox.x + b.bbox.w / 2, y: b.bbox.y + b.bbox.h / 2, scale: Math.max(b.bbox.w, b.bbox.h) / size };
      else { const station = pointAt(paramOf(b), 0.5); pair.landing = { ...station, scale: b.paint.strokeWidth / size }; }
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
  /** drain: the ring sampled as a polygon once; `morph` holds the clipped result. */
  ring?: { x: number; y: number }[];
}
const buffers = new WeakMap<SampledPath, SampleBuffers>();
const smooth = (p: number) => p * p * (3 - 2 * p);
/** Keep the part of `poly` on the far side of the line through `centre + s·dir`
 *  perpendicular to `dir` (points whose projection ≥ s), as reused nodes in `out`. */
function clipBeyond(poly: { x: number; y: number }[], centre: { x: number; y: number }, dir: { x: number; y: number }, s: number, out: VectorNode[]): VectorNode[] {
  let n = 0;
  const put = (x: number, y: number) => { const node = out[n] ?? (out[n] = { x, y, type: "corner" }); node.x = x; node.y = y; node.type = "corner"; delete node.hIn; delete node.hOut; n++; };
  const proj = (p: { x: number; y: number }) => (p.x - centre.x) * dir.x + (p.y - centre.y) * dir.y;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], dp = proj(p) - s, dq = proj(q) - s;
    if (dp >= 0) put(p.x, p.y);
    if ((dp >= 0) !== (dq >= 0)) { const u = dp / (dp - dq); put(p.x + (q.x - p.x) * u, p.y + (q.y - p.y) * u); }
  }
  out.length = n;
  return out;
}

/** prepare() must run before sampling. Endpoint nodes are the exact authored
 *  chains (the aligned intermediate may have additional corner-preserving
 *  splits). Reuse out to retain every path, node, handle and dash buffer. */
export function sampleCorrespondence(plan: CorrespondencePlan, t: number, out: SampledPath[] = [], timing?: SampleTiming): SampledPath[] {
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
    if (pair.interior) {
      // The interior of a splitting (a-only) or merging (b-only) filled ring: how
      // much of it is PRESENT runs 1 → 0 over the first window of the flight
      // leaving, 0 → 1 over the last window arriving, eased so it starts and
      // ends without a step. Its paint is the ring's own fill; nothing lerps.
      const spec = pair.interior;
      // dissolve runs on REAL time when the caller has it (DISSOLVE_MS, clamped to the
      // flight); collapse and drain run on eased progress like the pieces they leave with
      const timed = spec.method === "dissolve" && timing && timing.durationMs > 0;
      const W = timed ? Math.min(1, Math.max(0.02, DISSOLVE_MS / timing.durationMs)) : INTERIOR_WINDOW[spec.method];
      const u = timed ? clamp(timing.raw) : t;
      const present = smooth(a ? 1 - clamp(u / W) : clamp((u - (1 - W)) / W));
      const base = a ? buf.a : buf.b;
      path.closed = true;
      if (spec.method === "dissolve") { path.nodes = base; path.opacity = present; }
      else if (spec.method === "collapse") {
        // shrink about the centre; the last fifth also fades so no dot remains
        const k = present, c = spec.centre;
        if (buf.morph.length !== base.length) buf.morph = base.map(copyNode);
        for (let j = 0; j < base.length; j++) {
          const src = base[j], dst = buf.morph[j];
          dst.x = c.x + (src.x - c.x) * k; dst.y = c.y + (src.y - c.y) * k;
          if (src.hIn) dst.hIn = { dx: src.hIn.dx * k, dy: src.hIn.dy * k }; else delete dst.hIn;
          if (src.hOut) dst.hOut = { dx: src.hOut.dx * k, dy: src.hOut.dy * k }; else delete dst.hOut;
        }
        path.nodes = buf.morph; path.opacity = clamp(k / 0.2);
      } else {
        // drain: a straight front sweeps along `dir` (toward the partners); what
        // remains lies beyond the front — leaving, it empties toward the pieces;
        // arriving, it fills from the side the pieces come from
        if (!buf.ring) { const param = parameterize(base, true); buf.ring = Array.from({ length: 64 }, (_, j) => pointAt(param, j / 64)); }
        const front = lerp(spec.lo, spec.hi, 1 - present);
        path.nodes = clipBeyond(buf.ring, spec.centre, spec.dir, front, buf.morph);
        path.opacity = path.nodes.length >= 3 ? 1 : 0;
      }
      const p = (a ?? b)!.paint, paint = path.paint;
      paint.fill = p.fill; paint.stroke = "none"; paint.strokeWidth = 0; paint.dash = undefined; paint.cap = p.cap; paint.opacity = p.opacity ?? 1;
      paint.arrowStart = false; paint.arrowEnd = false; paint.text = p.text; paint.raster = p.raster;
      continue;
    }
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
