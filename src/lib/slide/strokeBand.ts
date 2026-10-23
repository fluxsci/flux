// ---------------------------------------------------------------------------
// Flux Slide — STROKE BAND geometry (R2 follow-up F1): the OUTER and INNER contour of a stroke, as bezier rings.
//
// A stroked shape that becomes another used to be morphed through its CENTRELINE with a stroke on top. A stroke's
// outer corner is round with radius w/2 + r the moment the centreline's corner radius r is above zero, so a sharp
// 12 px rect corner jumped from radius 0 to 6 on the first frame of its Become (31 stage px^2, the owner's slides 11
// and 13), and a rect that a Become lands on arrives with a round outer corner against the destination's sharp one.
// The fix is to morph what is DRAWN: the stroke is the band between two contours, the outer one (the centreline
// offset outwards by w/2 with the element's own join: mitred, rounded or bevelled) and the inner one (offset
// inwards, always sharp). The planner (outline.ts `planStrokeBand`) normal-matches outer to outer and inner to inner
// (the same Minkowski pairing as every convex Become), so the outer corner is exactly the source's at t = 0, rounds
// continuously, and is exactly the destination's at t = 1.
//
// Pure and DOM-free (twin-engine rule: the GUI player, the export runtime, flux-core). No import from outline.ts
// (outline.ts imports this module).
//
// Scope, by construction: a CONVEX closed ring (rect, ellipse, rounded rect, a convex path with line / smooth
// joins) or a STRAIGHT line (a capsule), undashed. Anything else answers `null` and the caller keeps the centreline
// law. An inner contour that does not exist (a stroke thicker than the shape's smallest curvature radius, a corner
// whose neighbour is a curve) answers `null` too: never a wrong picture, only the old one.
// ---------------------------------------------------------------------------

import type { VectorNode } from "../types";
import { segsFromNodes, segTangent, splitSeg, reverseNodes, type PathSeg } from "../path";

export type BandJoin = "miter" | "round";
export type BandCap = "butt" | "round" | "square";
/** SVG's default stroke-miterlimit: a corner sharper than this ratio is bevelled, exactly as the static stroke does. */
export const MITER_LIMIT = 4;

type V = { x: number; y: number };
const MAX_PIECE_TURN = Math.PI / 6;     // a cubic is offset in pieces turning at most this much (Hermite + curvature error ~1e-5 d)
const MIN_SCALE = 0.02;                 // an inward offset whose handle scale falls below this has inverted (radius <= |d|)
const SMOOTH_TURN = 1e-5;               // junction turn under which two pieces are one smooth curve
const EPS = 1e-9;

const rightNormal = (t: V): V => ({ x: t.y, y: -t.x });
const cross = (a: V, b: V) => a.x * b.y - a.y * b.x;
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const lineSeg = (a: V, b: V): PathSeg => ({ x0: a.x, y0: a.y, x1: a.x, y1: a.y, x2: b.x, y2: b.y, x3: b.x, y3: b.y, line: true });
const segLen = (s: PathSeg) => Math.hypot(s.x3 - s.x0, s.y3 - s.y0);

/** A seg is straight when flagged so or when both controls lie on its chord. */
function straight(s: PathSeg): boolean {
  if (s.line) return true;
  const cx = s.x3 - s.x0, cy = s.y3 - s.y0, L = Math.hypot(cx, cy);
  if (L < EPS) return false;
  const off = (px: number, py: number) => Math.abs((px - s.x0) * cy - (py - s.y0) * cx) / L;
  return off(s.x1, s.y1) < 1e-7 * L + 1e-9 && off(s.x2, s.y2) < 1e-7 * L + 1e-9;
}
function degenerate(s: PathSeg): boolean {
  return segLen(s) < EPS && (s.line || Math.hypot(s.x1 - s.x0, s.y1 - s.y0) + Math.hypot(s.x2 - s.x3, s.y2 - s.y3) < EPS);
}

/** Signed area (shoelace, 8 samples per segment): > 0 is the orientation whose outside lies to the RIGHT of travel. */
function signedArea(segs: PathSeg[]): number {
  let area = 0, prev: V | null = null, first: V | null = null;
  for (const s of segs) for (let i = 0; i < 8; i++) {
    const t = i / 8, u = 1 - t;
    const p: V = s.line ? { x: s.x0 + (s.x3 - s.x0) * t, y: s.y0 + (s.y3 - s.y0) * t } : { x: u * u * u * s.x0 + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x3, y: u * u * u * s.y0 + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y3 };
    if (!first) first = p;
    if (prev) area += prev.x * p.y - p.x * prev.y;
    prev = p;
  }
  if (prev && first) area += prev.x * first.y - first.x * prev.y;
  return area / 2;
}

/** Cubic segs -> nodes of a CLOSED ring (a node's handles are its two flanking controls). */
function segsToNodes(segs: PathSeg[]): VectorNode[] {
  const out: VectorNode[] = [];
  for (let i = 0; i < segs.length; i++) {
    const after = segs[i], before = segs[(i + segs.length - 1) % segs.length];
    const node: VectorNode = { x: after.x0, y: after.y0, type: "corner" };
    if (!before.line) node.hIn = { dx: before.x2 - node.x, dy: before.y2 - node.y };
    if (!after.line) node.hOut = { dx: after.x1 - node.x, dy: after.y1 - node.y };
    out.push(node);
  }
  return out;
}

/** The turn (radians, left positive, in [-pi, pi]) from one unit tangent to the next. */
const turnBetween = (a: V, b: V) => Math.atan2(cross(a, b), dot(a, b));

/** A circular arc about `c` of radius `r` from angle `a0` sweeping `sweep` (> 0: the direction of travel), as cubic segs of at most a quarter turn. */
function arcSegs(c: V, r: number, a0: number, sweep: number): PathSeg[] {
  const m = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9)), alpha = sweep / m, k = (4 / 3) * Math.tan(alpha / 4) * r, out: PathSeg[] = [];
  for (let i = 0; i < m; i++) {
    const s = a0 + i * alpha, e = s + alpha, c0 = Math.cos(s), s0 = Math.sin(s), c1 = Math.cos(e), s1 = Math.sin(e);
    out.push({ x0: c.x + r * c0, y0: c.y + r * s0, x1: c.x + r * c0 - k * s0, y1: c.y + r * s0 + k * c0, x2: c.x + r * c1 + k * s1, y2: c.y + r * s1 - k * c1, x3: c.x + r * c1, y3: c.y + r * s1, line: false });
  }
  return out;
}

/** Split every cubic into pieces turning at most MAX_PIECE_TURN (a convex piece's end tangents bound its turning). Straights stay whole. */
function subdivide(s: PathSeg): PathSeg[] {
  if (straight(s)) return [{ ...s, line: true, x1: s.x0, y1: s.y0, x2: s.x3, y2: s.y3 }];
  const turn = Math.abs(turnBetween(segTangent(s, 0), segTangent(s, 1)));
  const k = Math.max(1, Math.ceil(turn / MAX_PIECE_TURN - 1e-9));
  const out: PathSeg[] = [];
  let rest = s;
  for (let i = 0; i < k - 1; i++) { const [a, b] = splitSeg(rest, 1 / (k - i)); out.push(a); rest = b; }
  out.push(rest);
  return out;
}

/** The offset of one piece by signed `d` (> 0 outward = to the right of travel): the endpoints move along their normals and the
 *  handles are scaled by (R + d) / R at each end (curvature-matched Hermite), so the piece keeps its end tangents and curvatures.
 *  null when an inward offset has inverted (the radius at an end is at most |d|). */
function offsetPiece(s: PathSeg, d: number): PathSeg | null {
  const t0 = segTangent(s, 0), t3 = segTangent(s, 1), n0 = rightNormal(t0), n3 = rightNormal(t3);
  const p0: V = { x: s.x0 + d * n0.x, y: s.y0 + d * n0.y }, p3: V = { x: s.x3 + d * n3.x, y: s.y3 + d * n3.y };
  if (s.line) return lineSeg(p0, p3);
  const h0x = s.x1 - s.x0, h0y = s.y1 - s.y0, h3x = s.x2 - s.x3, h3y = s.y2 - s.y3, m0x = s.x2 - s.x1, m0y = s.y2 - s.y1;
  const l0 = Math.hypot(h0x, h0y), l3 = Math.hypot(h3x, h3y);
  // curvature at each end of a cubic: (2/3) |(P1 - P0) x (P2 - P1)| / |P1 - P0|^3 (and mirrored at the far end)
  const k0 = l0 > 1e-9 ? (2 / 3) * (h0x * m0y - h0y * m0x) / (l0 * l0 * l0) : 0;
  const k3 = l3 > 1e-9 ? (2 / 3) * (m0y * h3x - m0x * h3y) / (l3 * l3 * l3) : 0;   // h3 points back from the end: cross(P2 - P1, P3 - P2) = m0y h3x - m0x h3y
  // signed curvature positive when turning LEFT (the interior side of a positive-area ring)
  const s0 = 1 + d * Math.max(0, k0), s3 = 1 + d * Math.max(0, k3);
  if (d < 0 && (s0 < MIN_SCALE || s3 < MIN_SCALE)) return null;
  return { x0: p0.x, y0: p0.y, x1: p0.x + h0x * s0, y1: p0.y + h0y * s0, x2: p3.x + h3x * s3, y2: p3.y + h3y * s3, x3: p3.x, y3: p3.y, line: false };
}

export interface BandRings {
  outer: VectorNode[]; inner: VectorNode[];
  /** The stroke has a CORNER the centreline law cannot carry: the stroker rounds a mitred outer corner by w/2 the moment the centreline's own corner
   *  rounds (a jump), approximates the offset of a NEARLY straight cubic (the morphed edge of a polygon) differently from the exact offset of the
   *  rest render's straight edge, and a line's butt / square cap is not a round join. A ring without a corner (an ellipse, a rounded rect) keeps
   *  the stroke law, whose path stroker is the very rasteriser the resting ellipse is drawn with (render.ts `stageMarkup`). */
  corners: boolean;
}

/** The outer and inner contour of the stroke of a CLOSED convex ring (centreline nodes, any local frame). null when the ring is not a
 *  clean convex ring, a corner meets a curve on the inner side, or the stroke is thicker than the ring can carry inwards. */
export function ringBand(nodes: VectorNode[], width: number, join: BandJoin): BandRings | null {
  if (nodes.length < 3) return null;
  let ring = nodes;
  if (signedArea(segsFromNodes(ring, true)) < 0) { const rev = reverseNodes(ring); ring = [rev[rev.length - 1], ...rev.slice(0, -1)]; }
  const raw = segsFromNodes(ring, true).filter(s => !degenerate(s));
  if (raw.length < 3 && !(raw.length >= 2 && raw.some(s => !straight(s)))) return null;
  const pieces = raw.flatMap(subdivide);
  // a corner: a tangent jump between consecutive pieces (a rect, a polygon)
  let corners = false;
  for (let i = 0; i < pieces.length; i++) if (turnBetween(segTangent(pieces[i], 1), segTangent(pieces[(i + 1) % pieces.length], 0)) > 1e-3) corners = true;
  if (!(width > 0)) return { outer: copyNodes(ring), inner: copyNodes(ring), corners };
  const outer = offsetRing(pieces, width / 2, join), inner = offsetRing(pieces, -width / 2, join);
  return outer && inner ? { outer: segsToNodes(outer), inner: segsToNodes(inner), corners } : null;
}

const copyNodes = (n: VectorNode[]): VectorNode[] => n.map(x => ({ ...x, hIn: x.hIn && { ...x.hIn }, hOut: x.hOut && { ...x.hOut } }));

/** Offset a positively oriented ring of pieces by signed `d`. */
function offsetRing(pieces: PathSeg[], d: number, join: BandJoin): PathSeg[] | null {
  const n = pieces.length, outward = d > 0;
  const tin = pieces.map(p => segTangent(p, 1)), tout = pieces.map(p => segTangent(p, 0));
  // every junction turns left (a convex ring) and the whole ring turns once round
  let total = 0;
  const turns: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pieces[i], t = straight(a) ? 0 : turnBetween(segTangent(a, 0), segTangent(a, 1));
    if (t < -1e-3) return null;
    const j = turnBetween(tin[i], tout[(i + 1) % n]);
    if (j < -1e-3 || j > Math.PI - 1e-3) return null;     // reflex, or a needle (a hairpin has no single normal fan: the caller's capsule)
    turns.push(j < SMOOTH_TURN ? 0 : j);
    total += Math.max(0, t) + Math.max(0, j);
  }
  if (Math.abs(total - 2 * Math.PI) > 0.05) return null;
  const off: PathSeg[] = [];
  for (const p of pieces) { const o = offsetPiece(p, d); if (!o) return null; off.push(o); }
  const out: PathSeg[] = [];
  if (!outward) {
    // inner: a corner's two offset edges meet at the mitre point; both neighbours must be straight lines (an arc's offset cannot be trimmed here)
    const tips = new Map<number, V>();
    for (let i = 0; i < n; i++) if (turns[i] > 0) {
      const a = i, b = (i + 1) % n;
      if (!straight(pieces[a]) || !straight(pieces[b])) return null;
      const n1 = rightNormal(tin[a]), n2 = rightNormal(tout[b]), den = 1 + dot(n1, n2), P: V = { x: pieces[a].x3, y: pieces[a].y3 };
      if (den < 1e-6) return null;
      tips.set(i, { x: P.x + d * (n1.x + n2.x) / den, y: P.y + d * (n1.y + n2.y) / den });
    }
    for (let i = 0; i < n; i++) {
      const o = off[i];
      const start = turns[(i + n - 1) % n] > 0 ? tips.get((i + n - 1) % n)! : { x: o.x0, y: o.y0 };
      const end = turns[i] > 0 ? tips.get(i)! : { x: o.x3, y: o.y3 };
      if (straight(pieces[i])) {
        // the edge keeps its direction and a positive length, or the contour has inverted
        const dir = { x: pieces[i].x3 - pieces[i].x0, y: pieces[i].y3 - pieces[i].y0 };
        if (dot({ x: end.x - start.x, y: end.y - start.y }, dir) <= 1e-9) return null;
        out.push(lineSeg(start, end));
      } else out.push({ ...o, x0: start.x, y0: start.y, x3: end.x, y3: end.y });
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const o = off[i], nx = off[(i + 1) % n];
    out.push(o);
    if (!(turns[i] > 0)) continue;
    const theta = turns[i], P: V = { x: pieces[i].x3, y: pieces[i].y3 };
    const n1 = rightNormal(tin[i]), n2 = rightNormal(tout[(i + 1) % n]);
    const S: V = { x: o.x3, y: o.y3 }, E: V = { x: nx.x0, y: nx.y0 };
    if (join === "round") { for (const a of arcSegs(P, d, Math.atan2(n1.y, n1.x), theta)) out.push(a); continue; }
    if (1 / Math.cos(theta / 2) <= MITER_LIMIT) {
      const den = 1 + dot(n1, n2), tip: V = { x: P.x + d * (n1.x + n2.x) / den, y: P.y + d * (n1.y + n2.y) / den };
      out.push(lineSeg(S, tip), lineSeg(tip, E));
    } else out.push(lineSeg(S, E));     // SVG bevels a corner past the miter limit
  }
  return out.filter(s => !degenerate(s));
}

/** The outline of a STRAIGHT stroke (a line): the capsule of its width and cap, as a positively oriented ring; and the stroke's own
 *  centreline as the degenerate inner ring (the erosion of a capsule by its half width is its spine: width zero, so no hole is painted). */
export function lineBand(p0: V, p1: V, width: number, cap: BandCap): BandRings | null {
  const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (!(L > EPS)) return null;
  const spine: VectorNode[] = [{ x: p0.x, y: p0.y, type: "corner" }, { x: p1.x, y: p1.y, type: "corner" }];
  if (!(width > 0)) return { outer: copyNodes(spine), inner: copyNodes(spine), corners: cap !== "round" };
  const d = width / 2, T: V = { x: (p1.x - p0.x) / L, y: (p1.y - p0.y) / L }, N = rightNormal(T);
  const a0: V = { x: p0.x + d * N.x, y: p0.y + d * N.y }, a1: V = { x: p1.x + d * N.x, y: p1.y + d * N.y };
  const b1: V = { x: p1.x - d * N.x, y: p1.y - d * N.y }, b0: V = { x: p0.x - d * N.x, y: p0.y - d * N.y };
  const segs: PathSeg[] = [lineSeg(a0, a1)];
  const capAt = (from: V, to: V, p: V, dir: V, nrm: V) => {     // the cap that turns the stroke round at `p` (dir = outward along the stroke there)
    if (cap === "round") { for (const s of arcSegs(p, d, Math.atan2(nrm.y, nrm.x), Math.PI)) segs.push(s); }
    else if (cap === "square") {
      const x0: V = { x: from.x + d * dir.x, y: from.y + d * dir.y }, x1: V = { x: to.x + d * dir.x, y: to.y + d * dir.y };
      segs.push(lineSeg(from, x0), lineSeg(x0, x1), lineSeg(x1, to));
    } else segs.push(lineSeg(from, to));
  };
  capAt(a1, b1, p1, T, N);
  segs.push(lineSeg(b1, b0));
  capAt(b0, a0, p0, { x: -T.x, y: -T.y }, { x: -N.x, y: -N.y });
  return { outer: segsToNodes(segs.filter(s => !degenerate(s))), inner: copyNodes(spine), corners: cap !== "round" };
}
