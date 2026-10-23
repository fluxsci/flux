// ---------------------------------------------------------------------------
// Flux Slide — NORMAL-MATCHED ring correspondence (the "Gauss-map" pairing).
//
// outline.ts pairs two rings by normalized ARC LENGTH. For two CONVEX rings that
// pairs a square's corner with a circle's 45° point and its mid-side with the
// circle's N point, so every in-between frame keeps the square's four corners
// (a corner's turning angle only decays linearly in t) while the sides bulge
// outward: the "pillow". Pairing by TANGENT ANGLE instead — the point of A whose
// outward normal is ψ against the point of B whose outward normal is ψ — makes
// the straight lerp of the two paired chains the MINKOWSKI blend
//     (1 − t)·A ⊕ t·B
// of the two shapes: convex at every t, area monotone, corners rounded from the
// first frame by t·(B's local radius), t = 0 and t = 1 exactly A and B.
//
// A corner of A (a jump in tangent angle) is one point of A paired with the arc
// of B that spans the same angles; a straight edge of A (zero angular width) is
// a segment of A paired with ONE point of B. Both are degenerate pieces, and a
// piece whose far side is a point lerps to a scaled copy of the near side — a
// quarter circle stays an exact cubic quarter circle at every t.
//
// Pure and DOM-free (twin-engine rule: shared by the GUI, flux-core, the export
// runtime). Each ring arrives in ONE frame chosen by the caller (outline.ts
// `correspond`): its own UNIT frame (an affine image of a convex ring is convex,
// so ellipse→ellipse stays an exact ellipse and roundness scales with the box),
// or pixels for a stroke-thin box. Normals are not invariant under a non-uniform
// scale, so both rings of a pair must be in the frame the caller means.
// `null` means "not two convex rings" — the caller keeps arc-length stations.
// ---------------------------------------------------------------------------

import type { VectorNode } from "../types";
import { segsFromNodes, splitSeg, segTangent, reverseNodes, segPoint, type PathSeg } from "../path";

const TAU = Math.PI * 2;
const TOL_REVERSE = 2.5e-3; // rad of tolerated backwards turning on a "convex" cubic
const MIN_CHORD = 1e-9;
const MAX_ARC_STEP = Math.PI / 2 + 1e-6; // one cubic never spans more than a quarter turn when paired with a curve
/** A dense traced ring would plan to 2n+4 nodes (a corner piece + a flat per vertex): above this it keeps the arc-length planner. */
const MAX_NODES = 600;
const MAX_PAIRED_STEP = 0.5; // rad: two curved pieces paired against each other are cut at least this finely

type Pt = { x: number; y: number };
type Kind = "flat" | "arc" | "corner";
interface Item { kind: Kind; a: number; b: number; seg?: PathSeg; at?: Pt }
interface Ring { nodes: VectorNode[]; items: Item[]; psi0: number; start: Pt; flipped: boolean }

const wrapPi = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const wrap2pi = (a: number) => { a %= TAU; return a < 0 ? a + TAU : a; };
const ang = (v: Pt) => Math.atan2(v.y, v.x);

function shoelace(nodes: VectorNode[]): number {
  let area = 0, prev: Pt | null = null, first: Pt | null = null;
  for (const s of segsFromNodes(nodes, true)) {
    for (let i = 0; i < 8; i++) {
      const p = segPoint(s, i / 8);
      if (!first) first = p;
      if (prev) area += prev.x * p.y - p.x * prev.y;
      prev = p;
    }
  }
  if (prev && first) area += prev.x * first.y - first.x * prev.y;
  return area / 2;
}

const isPoint = (s: PathSeg) => s.line && Math.hypot(s.x3 - s.x0, s.y3 - s.y0) < MIN_CHORD;

/** Items of one ring in positive-area order, or null when it is not convex. */
function analyse(input: VectorNode[]): Ring | null {
  let nodes = input;
  const area0 = shoelace(nodes);
  // a ring of ~zero area is a HAIRPIN: a stroke that doubles back on itself
  // (`inflateChain`). It is the degenerate convex ring whose two ends are π-wide
  // corners, so (1−t)·segment ⊕ t·shape is a stadium that swells into the shape.
  let per = 0;
  for (const s of segsFromNodes(nodes, true)) per += Math.hypot(s.x3 - s.x0, s.y3 - s.y0);
  const hairpin = Math.abs(area0) < 1e-9 * per * per;
  const flipped = !hairpin && area0 < 0;
  if (flipped) { const rev = reverseNodes(nodes); nodes = [rev[rev.length - 1], ...rev.slice(0, -1)]; }
  const segs = segsFromNodes(nodes, true).filter((s) => !(isPoint(s) || (!s.line && Math.hypot(s.x3 - s.x0, s.y3 - s.y0) < MIN_CHORD && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) + Math.hypot(s.x2 - s.x3, s.y2 - s.y3) < MIN_CHORD)));
  if (segs.length < 2) return null;
  const items: Item[] = [];
  let psi = 0, psi0 = 0, first = true;
  for (let i = 0; i < segs.length; i++) {
    const s0 = segs[i], next = segs[(i + 1) % segs.length];
    let s = s0;
    const ts = ang(segTangent(s, 0)), te = ang(segTangent(s, 1));
    if (first) { psi0 = ts; first = false; }
    let d = wrapPi(te - ts);
    // a cubic whose controls are collinear with its chord is a straight edge
    if (!s.line) {
      const cx = s.x3 - s.x0, cy = s.y3 - s.y0, L = Math.hypot(cx, cy) || 1;
      const off1 = Math.abs((s.x1 - s.x0) * cy - (s.y1 - s.y0) * cx) / L, off2 = Math.abs((s.x2 - s.x0) * cy - (s.y2 - s.y0) * cx) / L;
      if (off1 < 1e-7 * L + 1e-9 && off2 < 1e-7 * L + 1e-9) { s = { x0: s.x0, y0: s.y0, x1: s.x0, y1: s.y0, x2: s.x3, y2: s.y3, x3: s.x3, y3: s.y3, line: true }; d = 0; }
    }
    if (s.line) d = 0;
    if (d < -TOL_REVERSE) return null;
    if (!s.line) {
      // monotone turning along the cubic (no inflection)
      let prev = ts, acc = 0;
      for (let k = 1; k <= 8; k++) {
        const a = ang(segTangent(s, k / 8)), step = wrapPi(a - prev);
        if (step < -TOL_REVERSE) return null;
        acc += step; prev = a;
      }
      d = Math.max(0, acc);
    }
    if (s.line || d < 1e-9) items.push({ kind: "flat", a: psi, b: psi, seg: s.line ? s : { ...s, line: true, x1: s.x0, y1: s.y0, x2: s.x3, y2: s.y3 } });
    else { items.push({ kind: "arc", a: psi, b: psi + d, seg: s }); psi += d; }
    // corner at the end of this segment
    const nextStart = ang(segTangent(next, 0));
    const endAng = s.line ? ang({ x: s.x3 - s.x0, y: s.y3 - s.y0 }) : te;
    let c = wrapPi(nextStart - endAng);
    if (hairpin && Math.abs(c) > Math.PI - 1e-3) c = Math.PI; // the reversal is +π by construction (sign is float noise)
    if (c < -TOL_REVERSE) return null;
    if (c > Math.PI - 1e-3 && !hairpin) return null; // a needle spike has no single normal fan
    c = Math.max(0, c);
    if (c > 1e-6) { items.push({ kind: "corner", a: psi, b: psi + c, at: { x: s.x3, y: s.y3 } }); psi += c; }
  }
  if (Math.abs(psi - TAU) > 0.02) return null;
  // pin the total to exactly 2π so the partition closes
  const k = TAU / psi;
  for (const it of items) { it.a *= k; it.b *= k; }
  return { nodes, items, psi0, start: { x: segs[0].x0, y: segs[0].y0 }, flipped };
}

function angleAt(it: Item, t: number): number {
  const s = it.seg!;
  return it.a + wrapPi(ang(segTangent(s, t)) - ang(segTangent(s, 0)));
}
function paramAt(it: Item, psi: number): number {
  if (psi <= it.a) return 0;
  if (psi >= it.b) return 1;
  let lo = 0, hi = 1;
  for (let k = 0; k < 36; k++) {
    const mid = (lo + hi) / 2;
    if (angleAt(it, mid) < psi) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Re-express B's items on A's angle origin (rel angle = B angle + `o`), cut at
 *  2π and rotated so the list starts at 0. */
function rotate(items: Item[], o: number): Item[] {
  const head: Item[] = [], tail: Item[] = [];
  const shift = (it: Item, d: number): Item => ({ ...it, a: it.a + d, b: it.b + d });
  for (const it of items) {
    const a = it.a + o, b = it.b + o;
    if (it.kind === "flat") {
      if (a >= TAU - 1e-9) head.push({ ...it, a: a - TAU, b: a - TAU }); else tail.push({ ...it, a, b: a });
      continue;
    }
    if (a >= TAU - 1e-12) head.push(shift(it, o - TAU));
    else if (b <= TAU + 1e-12) tail.push(shift(it, o));
    else if (it.kind === "corner") {
      tail.push({ ...it, a: a, b: TAU });
      head.push({ ...it, a: 0, b: b - TAU });
    } else {
      const t = paramAt(it, TAU - o);
      const [l, r] = splitSeg(it.seg!, t);
      tail.push({ kind: "arc", a, b: TAU, seg: l });
      head.push({ kind: "arc", a: 0, b: b - TAU, seg: r });
    }
  }
  return [...head, ...tail];
}

function chordLen(s: PathSeg) { return Math.hypot(s.x3 - s.x0, s.y3 - s.y0); }
const pointSeg = (p: Pt): PathSeg => ({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, x2: p.x, y2: p.y, x3: p.x, y3: p.y, line: true });

/** The piece of an arc item between two angles. */
function subArc(it: Item, p0: number, p1: number): PathSeg {
  const t0 = paramAt(it, p0), t1 = paramAt(it, p1);
  if (t1 - t0 < 1e-12) return pointSeg(segPoint(it.seg!, t0));
  const head = t1 >= 1 ? it.seg! : splitSeg(it.seg!, t1)[0];
  return t0 <= 0 ? head : splitSeg(head, t0 / t1)[1];
}

interface Discrete { pieces: PathSeg[]; flats: PathSeg[][] }

function discretize(items: Item[], cuts: number[]): Discrete {
  const K = cuts.length - 1;
  const pieces: PathSeg[] = [], flats: PathSeg[][] = Array.from({ length: K + 1 }, () => []);
  const body = items.filter((i) => i.kind !== "flat");
  let ptr = 0;
  for (let k = 0; k < K; k++) {
    const p0 = cuts[k], p1 = cuts[k + 1], mid = (p0 + p1) / 2;
    while (ptr < body.length - 1 && body[ptr].b < mid) ptr++;
    const it = body[ptr];
    pieces.push(it.kind === "corner" ? pointSeg(it.at!) : subArc(it, Math.max(p0, it.a), Math.min(p1, it.b)));
  }
  for (const f of items) if (f.kind === "flat") {
    let best = 0, bd = Infinity;
    for (let k = 0; k <= K; k++) { const d = Math.abs(cuts[k] - f.a); if (d < bd) { bd = d; best = k; } }
    flats[best].push(f.seg!); // a flat at angle 2π (a ring that starts mid-edge) is the LAST thing walked, not the first
  }
  return { pieces, flats };
}

/** Corresponding node chains, in the frames the rings arrived in. */
export interface NormalMatch {
  a: VectorNode[];
  b: VectorNode[];
  /** Index of the chain node that sits on B's OWN start node (the origin of B's static
   *  dash pattern), or null when B's start is not a chain node. */
  bStart: number | null;
  /** The chain runs AGAINST B's own direction (A and B wind oppositely). */
  bReversed: boolean;
}

/** Pairs two closed rings by tangent angle; null when either ring is not convex
 *  (or the pair is degenerate, or a ring has more than MAX_NODES nodes).
 *  `A`'s own start node and direction are kept (a counter-clockwise A is matched
 *  on its reversed copy, then both chains are reversed back), so the t = 0+ frame
 *  lays dashes exactly where A's markup did. */
export function normalMatchRings(A: VectorNode[], B: VectorNode[]): NormalMatch | null {
  if (A.length < 2 || B.length < 2 || A.length > MAX_NODES || B.length > MAX_NODES) return null;
  const ra = analyse(A);
  if (!ra) return null;
  const rb0 = analyse(B);
  if (!rb0) return null;
  const itemsA = ra.items;
  const o = wrap2pi(rb0.psi0 - ra.psi0);
  const itemsB = rotate(rb0.items, o);

  // the common angle partition: every boundary of either side, then finer
  // cuts wherever two curved pieces face each other
  const raw = [0, TAU];
  for (const it of [...itemsA, ...itemsB]) { raw.push(it.a, it.b); }
  raw.sort((x, y) => x - y);
  let cuts: number[] = [];
  for (const v of raw) if (v >= -1e-12 && v <= TAU + 1e-12 && (!cuts.length || v - cuts[cuts.length - 1] > 1e-9)) cuts.push(Math.min(Math.max(v, 0), TAU));
  if (cuts[0] !== 0) cuts.unshift(0);
  if (cuts[cuts.length - 1] < TAU - 1e-9) cuts.push(TAU); else cuts[cuts.length - 1] = TAU;
  const kindAt = (items: Item[], mid: number) => items.find((i) => i.kind !== "flat" && i.a - 1e-12 <= mid && mid <= i.b + 1e-12)?.kind ?? "corner";
  const finer: number[] = [cuts[0]];
  for (let k = 0; k < cuts.length - 1; k++) {
    const p0 = cuts[k], p1 = cuts[k + 1], mid = (p0 + p1) / 2;
    const ka = kindAt(itemsA, mid), kb = kindAt(itemsB, mid);
    const step = ka === "arc" && kb === "arc" ? MAX_PAIRED_STEP : ka === "arc" || kb === "arc" ? MAX_ARC_STEP : Infinity;
    const n = Math.max(1, Math.ceil((p1 - p0) / step - 1e-9));
    for (let j = 1; j <= n; j++) finer.push(p0 + ((p1 - p0) * j) / n);
  }
  cuts = finer;

  const da = discretize(itemsA, cuts), db = discretize(itemsB, cuts);
  const K = cuts.length - 1;
  const segA: PathSeg[] = [], segB: PathSeg[] = [];
  let curA: Pt = ra.start, curB: Pt = { x: db.pieces[0].x0, y: db.pieces[0].y0 };
  // B's start is the point of B whose normal is A's start normal: the first
  // piece (or first flat) of B begins there
  const firstB = db.flats[0][0] ?? db.pieces[0];
  curB = { x: firstB.x0, y: firstB.y0 };
  const firstA = da.flats[0][0] ?? da.pieces[0];
  curA = { x: firstA.x0, y: firstA.y0 };
  const walkFlats = (k: number) => {
    const fa = da.flats[k], fb = db.flats[k];
    for (let j = 0; j < Math.max(fa.length, fb.length); j++) {
      const sa = fa[j] ?? pointSeg(curA), sb = fb[j] ?? pointSeg(curB);
      segA.push(sa); segB.push(sb);
      curA = { x: sa.x3, y: sa.y3 }; curB = { x: sb.x3, y: sb.y3 };
    }
  };
  for (let k = 0; k < K; k++) {
    walkFlats(k);
    const pa = da.pieces[k], pb = db.pieces[k];
    segA.push(pa); segB.push(pb);
    curA = { x: pa.x3, y: pa.y3 }; curB = { x: pb.x3, y: pb.y3 };
  }
  walkFlats(K); // flats at angle 2π close the ring (they end on the start node)
  // closure sanity: the walk must come back to where it began
  const closeErr = (s: PathSeg[]) => Math.hypot(s[s.length - 1].x3 - s[0].x0, s[s.length - 1].y3 - s[0].y0);
  const scale = Math.max(1, ...segA.map(chordLen), ...segB.map(chordLen));
  if (closeErr(segA) > 1e-4 * scale || closeErr(segB) > 1e-4 * scale) return null;
  let a = nodesFromSegs(segA), b = nodesFromSegs(segB);
  // B's own start node: a boundary of every chain (nodes are corners / joins / the seam)
  const bs = rb0.nodes[0];
  let bStart: number | null = null;
  for (let i = 0; i < b.length; i++) if (Math.hypot(b[i].x - bs.x, b[i].y - bs.y) < 1e-6 * scale) { bStart = i; break; }
  if (ra.flipped) {
    // restore A's traversal: reverse both chains, keeping node 0 first
    const rot = (c: VectorNode[]) => { const r = reverseNodes(c); return [r[r.length - 1], ...r.slice(0, -1)]; };
    a = rot(a); b = rot(b);
    if (bStart !== null && bStart > 0) bStart = b.length - bStart;
  }
  return { a, b, bStart, bReversed: ra.flipped !== rb0.flipped };
}

/** Piece list → closed node ring. A curved piece carries its own handles; a
 *  straight piece carries 1/3-chord handles (it is a uniform cubic, so its lerp
 *  with a curve stays tangent-consistent); a point piece carries none. */
function nodesFromSegs(segs: PathSeg[]): VectorNode[] {
  const n = segs.length;
  const nodes: VectorNode[] = segs.map((s) => ({ x: s.x0, y: s.y0, type: "corner" as const }));
  for (let i = 0; i < n; i++) {
    const s = segs[i], next = nodes[(i + 1) % n];
    if (s.line) {
      if (chordLen(s) < MIN_CHORD) continue;
      const dx = (s.x3 - s.x0) / 3, dy = (s.y3 - s.y0) / 3;
      nodes[i].hOut = { dx, dy };
      next.hIn = { dx: -dx, dy: -dy };
    } else {
      nodes[i].hOut = { dx: s.x1 - s.x0, dy: s.y1 - s.y0 };
      next.hIn = { dx: s.x2 - s.x3, dy: s.y2 - s.y3 };
    }
  }
  return nodes;
}
