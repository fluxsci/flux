// ---------------------------------------------------------------------------
// Pure vector-path core (Feature 1). Converts between an editable node list
// (VectorNode[]) and the SVG `d` string that Element.svelte/export.ts render —
// so the pen can author curves, node-edit mode can round-trip them, and legacy
// d-only paths become editable. No DOM, no Svelte; unit-tested via figenh-01.
//
// Coordinate model: nodes + handle offsets are element-local. `nodesToPath`
// emits `L` for a segment with no handle on either end, else a cubic `C`
// (a missing handle collapses to the node point). `pathToNodes` parses ONLY the
// M/L/C/Q/Z grammar WE emit (+ the old straight-pen output), classifying a node
// as `smooth` when its two handles are mirrored, else `corner`.
// ---------------------------------------------------------------------------

import type { PathElement, VectorNode } from "./types";
import { arrowTri, arrowVee, arrowHeadLen } from "./geometry";

const nf = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

function abs(node: VectorNode, h?: { dx: number; dy: number }): { x: number; y: number } | null {
  return h ? { x: node.x + h.dx, y: node.y + h.dy } : null;
}

function segment(a: VectorNode, b: VectorNode): string {
  const c1 = abs(a, a.hOut);
  const c2 = abs(b, b.hIn);
  if (!c1 && !c2) return `L ${nf(b.x)} ${nf(b.y)}`;
  const p1 = c1 ?? { x: a.x, y: a.y };
  const p2 = c2 ?? { x: b.x, y: b.y };
  return `C ${nf(p1.x)} ${nf(p1.y)} ${nf(p2.x)} ${nf(p2.y)} ${nf(b.x)} ${nf(b.y)}`;
}

/** Serialize nodes to an SVG path `d`. Closed appends the wrap segment + Z. */
export function nodesToPath(nodes: VectorNode[], closed: boolean): string {
  if (!nodes.length) return "";
  let d = `M ${nf(nodes[0].x)} ${nf(nodes[0].y)}`;
  for (let i = 0; i < nodes.length - 1; i++) d += " " + segment(nodes[i], nodes[i + 1]);
  if (closed && nodes.length >= 2) {
    d += " " + segment(nodes[nodes.length - 1], nodes[0]);
    d += " Z";
  }
  return d;
}

const MIRROR_EPS = 0.01;
function classify(n: VectorNode): "corner" | "smooth" {
  if (
    n.hIn &&
    n.hOut &&
    Math.abs(n.hIn.dx + n.hOut.dx) < MIRROR_EPS &&
    Math.abs(n.hIn.dy + n.hOut.dy) < MIRROR_EPS
  )
    return "smooth";
  return "corner";
}

/** Parse the M/L/C/Q/Z grammar we emit into editable nodes (best-effort for any
 *  legacy straight-pen `d`). Handles command repeats; treats coords as absolute. */
export function pathToNodes(d: string): VectorNode[] {
  const toks = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:[eE]-?\d+)?/g) || [];
  const nodes: VectorNode[] = [];
  let i = 0;
  let cmd = "";
  let sawZ = false;
  const num = () => parseFloat(toks[i++]);
  const cur = () => nodes[nodes.length - 1];
  while (i < toks.length) {
    const t = toks[i];
    if (/[MLCQZmlcqz]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        sawZ = true;
        continue;
      }
    }
    const c = cmd.toUpperCase();
    if (c === "M") {
      const x = num(), y = num();
      nodes.push({ x, y, type: "corner" });
      cmd = cmd === "m" ? "l" : "L"; // subsequent coords after M are implicit L
    } else if (c === "L") {
      const x = num(), y = num();
      nodes.push({ x, y, type: "corner" });
    } else if (c === "C") {
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), x = num(), y = num();
      const prev = cur();
      if (prev) prev.hOut = { dx: c1x - prev.x, dy: c1y - prev.y };
      nodes.push({ x, y, type: "corner", hIn: { dx: c2x - x, dy: c2y - y } });
    } else if (c === "Q") {
      const qx = num(), qy = num(), x = num(), y = num();
      const prev = cur();
      if (prev) prev.hOut = { dx: (2 / 3) * (qx - prev.x), dy: (2 / 3) * (qy - prev.y) };
      nodes.push({ x, y, type: "corner", hIn: { dx: (2 / 3) * (qx - x), dy: (2 / 3) * (qy - y) } });
    } else {
      i++; // unknown token — skip defensively
    }
  }
  // A closed path we emitted ends with an explicit wrap segment back to the
  // first point (+ Z), which parses as a duplicate closing node. Fold its
  // incoming handle onto the first node and drop it, so the node count matches
  // the authoring list (round-trip stable).
  if (sawZ && nodes.length >= 2) {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (Math.abs(last.x - first.x) < 0.01 && Math.abs(last.y - first.y) < 0.01) {
      if (last.hIn) first.hIn = last.hIn;
      nodes.pop();
    }
  }
  for (const n of nodes) n.type = classify(n);
  return nodes;
}

/** Does the path close (ends with Z)? Pairs with pathToNodes for legacy paths. */
export function pathIsClosed(d: string): boolean {
  return /z\s*$/i.test(d.trim());
}

/** Scale a node list about the local origin (0,0) by (sx, sy) — points AND
 *  handle offsets. Backs the path branch of the resize fix. */
export function scaleNodes(nodes: VectorNode[], sx: number, sy: number): VectorNode[] {
  return nodes.map((n) => ({
    x: n.x * sx,
    y: n.y * sy,
    type: n.type,
    hIn: n.hIn ? { dx: n.hIn.dx * sx, dy: n.hIn.dy * sy } : undefined,
    hOut: n.hOut ? { dx: n.hOut.dx * sx, dy: n.hOut.dy * sy } : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Concrete segment geometry. A segment between two nodes is a cubic (any
// flanking handle present) or a straight line — represented uniformly as the
// four cubic control points, with `line` marking true straights.
// ---------------------------------------------------------------------------

export interface PathSeg {
  x0: number; y0: number; // start point
  x1: number; y1: number; // control 1 (= start for straights)
  x2: number; y2: number; // control 2 (= end for straights)
  x3: number; y3: number; // end point
  line: boolean;
}

function segOf(a: VectorNode, b: VectorNode): PathSeg {
  const c1 = abs(a, a.hOut);
  const c2 = abs(b, b.hIn);
  const line = !c1 && !c2;
  const p1 = c1 ?? { x: a.x, y: a.y };
  const p2 = c2 ?? { x: b.x, y: b.y };
  return { x0: a.x, y0: a.y, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: b.x, y3: b.y, line };
}

/** The path's segments in order (includes the wrap segment when closed). */
export function segsFromNodes(nodes: VectorNode[], closed: boolean): PathSeg[] {
  const out: PathSeg[] = [];
  for (let i = 0; i < nodes.length - 1; i++) out.push(segOf(nodes[i], nodes[i + 1]));
  if (closed && nodes.length >= 2) out.push(segOf(nodes[nodes.length - 1], nodes[0]));
  return out;
}

/** Point on a segment at parameter t. Straights interpolate LINEARLY — a
 *  degenerate cubic with controls at the endpoints is NOT linear in t (the
 *  parameterization bunches toward the ends), so `line` must special-case. */
export function segPoint(s: PathSeg, t: number): { x: number; y: number } {
  if (s.line) return { x: s.x0 + (s.x3 - s.x0) * t, y: s.y0 + (s.y3 - s.y0) * t };
  const u = 1 - t;
  const x = u * u * u * s.x0 + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x3;
  const y = u * u * u * s.y0 + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y3;
  return { x, y };
}

/** Unit tangent at parameter t, with degenerate-handle fallbacks (a zero-length
 *  derivative at an endpoint falls back through the control polygon / chord). */
export function segTangent(s: PathSeg, t: number): { x: number; y: number } {
  let dx: number;
  let dy: number;
  if (s.line) {
    dx = s.x3 - s.x0;
    dy = s.y3 - s.y0;
  } else {
    const u = 1 - t;
    dx = 3 * u * u * (s.x1 - s.x0) + 6 * u * t * (s.x2 - s.x1) + 3 * t * t * (s.x3 - s.x2);
    dy = 3 * u * u * (s.y1 - s.y0) + 6 * u * t * (s.y2 - s.y1) + 3 * t * t * (s.y3 - s.y2);
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = s.x3 - s.x0;
      dy = s.y3 - s.y0;
    }
  }
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Split a segment at t; returns the [0,t] and [t,1] halves (de Casteljau). */
export function splitSeg(s: PathSeg, t: number): [PathSeg, PathSeg] {
  if (s.line) {
    const p = segPoint(s, t);
    return [
      { x0: s.x0, y0: s.y0, x1: s.x0, y1: s.y0, x2: p.x, y2: p.y, x3: p.x, y3: p.y, line: true },
      { x0: p.x, y0: p.y, x1: p.x, y1: p.y, x2: s.x3, y2: s.y3, x3: s.x3, y3: s.y3, line: true },
    ];
  }
  const lerp = (ax: number, ay: number, bx: number, by: number) => [ax + (bx - ax) * t, ay + (by - ay) * t];
  const [q0x, q0y] = lerp(s.x0, s.y0, s.x1, s.y1);
  const [q1x, q1y] = lerp(s.x1, s.y1, s.x2, s.y2);
  const [q2x, q2y] = lerp(s.x2, s.y2, s.x3, s.y3);
  const [r0x, r0y] = lerp(q0x, q0y, q1x, q1y);
  const [r1x, r1y] = lerp(q1x, q1y, q2x, q2y);
  const [px, py] = lerp(r0x, r0y, r1x, r1y);
  return [
    { x0: s.x0, y0: s.y0, x1: q0x, y1: q0y, x2: r0x, y2: r0y, x3: px, y3: py, line: false },
    { x0: px, y0: py, x1: r1x, y1: r1y, x2: q2x, y2: q2y, x3: s.x3, y3: s.y3, line: false },
  ];
}

/** Approximate arc length by sampling (plenty for arrowhead trims). */
export function segLength(s: PathSeg, samples = 16): number {
  if (s.line) return Math.hypot(s.x3 - s.x0, s.y3 - s.y0);
  let len = 0;
  let prev = { x: s.x0, y: s.y0 };
  for (let i = 1; i <= samples; i++) {
    const p = segPoint(s, i / samples);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/** Nearest parameter on a segment to a point (sampled + one refinement pass). */
export function nearestTOnSeg(s: PathSeg, px: number, py: number): { t: number; dist: number } {
  let bestT = 0;
  let bestD = Infinity;
  const probe = (t: number) => {
    const p = segPoint(s, t);
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  };
  const N = 32;
  for (let i = 0; i <= N; i++) probe(i / N);
  const span = 1 / N;
  for (let i = -4; i <= 4; i++) probe(Math.min(1, Math.max(0, bestT + (i * span) / 4)));
  return { t: bestT, dist: bestD };
}

/** Per-axis exact extrema of one cubic segment (endpoints + interior roots of
 *  the derivative). Straights contribute only their endpoints. */
function segExtents(s: PathSeg, xs: number[], ys: number[]): void {
  xs.push(s.x0, s.x3);
  ys.push(s.y0, s.y3);
  if (s.line) return;
  const axisRoots = (p0: number, p1: number, p2: number, p3: number, into: number[], axis: "x" | "y") => {
    // B'(t)/3 = at² + bt + c with:
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const ts: number[] = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) ts.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
      }
    }
    for (const t of ts)
      if (t > 0 && t < 1) {
        const p = segPoint(s, t);
        into.push(axis === "x" ? p.x : p.y);
      }
  };
  axisRoots(s.x0, s.x1, s.x2, s.x3, xs, "x");
  axisRoots(s.y0, s.y1, s.y2, s.y3, ys, "y");
}

/** TRUE bounding box of the rendered curve (exact cubic extrema — NOT the
 *  control hull, so a long bezier handle never inflates the box). Includes the
 *  wrap segment when `closed`. Local coords. */
export function nodesExtent(nodes: VectorNode[], closed = false): { x: number; y: number; w: number; h: number } {
  if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs: number[] = [];
  const ys: number[] = [];
  if (nodes.length === 1) {
    xs.push(nodes[0].x);
    ys.push(nodes[0].y);
  } else {
    for (const s of segsFromNodes(nodes, closed)) segExtents(s, xs, ys);
  }
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

// ---------------------------------------------------------------------------
// resampleNodes — geometry-preserving arc-length resample (animation rework).
// Splits the existing segments (de Casteljau — the CURVE is unchanged) at N
// equally-spaced arc-length stations, so two paths with different node counts
// can be tweened node-by-node. Open paths keep both endpoints exactly (N ≥ 2,
// stations at i·L/(N−1)); closed paths keep node 0 as the seam and place N
// stations at i·L/N around the loop (N ≥ 3). Straight sub-segments stay
// handle-free (their nodes carry no hIn/hOut), so a resampled polyline is
// still a polyline.
// ---------------------------------------------------------------------------

export function resampleNodes(nodes: VectorNode[], closed: boolean, n: number): VectorNode[] {
  const minN = closed ? 3 : 2;
  if (nodes.length < 2 || n < minN) {
    return nodes.map((x) => ({ ...x, hIn: x.hIn && { ...x.hIn }, hOut: x.hOut && { ...x.hOut } }));
  }
  const segs = segsFromNodes(nodes, closed);
  const lens = segs.map((s) => segLength(s, 24));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total < 1e-9) {
    return Array.from({ length: n }, () => ({ x: nodes[0].x, y: nodes[0].y, type: "corner" as const }));
  }

  // Split the whole path into `linkCount` equal-arc-length LINKS (open: n−1
  // links between n nodes incl. both endpoints; closed: n links around the
  // loop, node 0 = the seam). Each link is a chain of sub-segments cut from
  // the originals by de Casteljau, so the geometry is exact; a link spanning
  // several original segments is then summarized by its first/last controls.
  const linkCount = closed ? n : n - 1;
  const per = total / linkCount;
  const links: PathSeg[][] = [];
  let chain: PathSeg[] = [];
  let need = per; // arc length still to collect into the current link
  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i];
    let len = lens[i];
    while (len > need + 1e-7 && links.length < linkCount - 1) {
      // cut `seg` at arc length `need` (bisect t for curves; exact for lines)
      let t = need / len;
      if (!seg.line) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 22; k++) {
          t = (lo + hi) / 2;
          if (segLength(splitSeg(seg, t)[0], 16) < need) lo = t;
          else hi = t;
        }
      }
      const [left, right] = splitSeg(seg, t);
      chain.push(left);
      links.push(chain);
      chain = [];
      seg = right;
      len -= need;
      need = per;
    }
    chain.push(seg);
    need -= len;
    // a station landing exactly on a segment boundary closes the link here —
    // without this, the next iteration would cut a degenerate zero-length
    // sliver whose collapsed controls put noise handles on the node.
    if (need <= 1e-7 && links.length < linkCount - 1) {
      links.push(chain);
      chain = [];
      need = per;
    }
  }
  if (chain.length) links.push(chain);
  // numeric drift can leave one link short — pad defensively (never in practice)
  while (links.length < linkCount) links.push([links[links.length - 1]?.at(-1) ?? segs[segs.length - 1]]);

  // links → nodes. node i sits between links[i−1] and links[i]; handles come
  // from the adjoining sub-segments (straight neighbours contribute none).
  // Open: n−1 link-start nodes + the final endpoint; closed: n seam-to-seam.
  const out: VectorNode[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const after = links[i] ?? null; // link leaving this node (open: absent on last)
    const before = i === 0 ? (closed ? links[links.length - 1] : null) : links[i - 1];
    const a = after?.[0] ?? null;
    const b = before?.[before.length - 1] ?? null;
    const px = a ? a.x0 : b!.x3;
    const py = a ? a.y0 : b!.y3;
    const node: VectorNode = { x: px, y: py, type: "corner" };
    if (b && !b.line) node.hIn = { dx: b.x2 - px, dy: b.y2 - py };
    if (a && !a.line) node.hOut = { dx: a.x1 - px, dy: a.y1 - py };
    out.push(node);
  }
  if (!closed) {
    const last = links[links.length - 1];
    const b = last[last.length - 1];
    const node: VectorNode = { x: b.x3, y: b.y3, type: "corner" };
    if (!b.line) node.hIn = { dx: b.x2 - b.x3, dy: b.y2 - b.y3 };
    out.push(node);
  }
  return out;
}

/** Re-fit a path element to its `nodes`: normalize so the content's top-left sits
 *  at local (0,0) (shifting x/y to preserve the on-canvas position), set
 *  width/height from the TRUE curve extent, and regenerate `d`. Call after any
 *  edit to `nodes`. Mutates and returns the element. */
export function refitPath(el: PathElement): PathElement {
  if (!el.nodes || !el.nodes.length) return el;
  const ext = nodesExtent(el.nodes, el.closed);
  if (ext.x !== 0 || ext.y !== 0) {
    for (const n of el.nodes) {
      n.x -= ext.x;
      n.y -= ext.y;
    }
    el.x += ext.x;
    el.y += ext.y;
  }
  el.width = Math.max(1, ext.w);
  el.height = Math.max(1, ext.h);
  // Extent stays on the SHARP nodes: fillets lie inside the corner wedge, so
  // the sharp box contains the rounded shape and x/y hold still under a
  // radius scrub (no re-normalization churn).
  el.d = pathD(el.nodes, el.closed, el.cornerRadius);
  return el;
}

// ---------------------------------------------------------------------------
// Corner rounding (Figma-style geometric fillets). `nodes` stays the SHARP
// authoritative skeleton; rounding is applied where `d` is generated (pathD),
// so node-edit shows true corners while the geometry renders rounded.
// v1 contract: only corner nodes whose BOTH flanking segments are straight
// and non-collinear are filleted (curve-flanked corners already blend; a
// curve fillet has no exact clamp). Open-path endpoints never round; the
// closed wrap corners do. radius <= 0 returns the input array unchanged.
// ---------------------------------------------------------------------------

export function roundCorners(nodes: VectorNode[], closed: boolean, radius: number): VectorNode[] {
  if (!(radius > 0) || nodes.length < 3) return nodes;
  const n = nodes.length;
  const copy = (nd: VectorNode): VectorNode => ({ ...nd, hIn: nd.hIn && { ...nd.hIn }, hOut: nd.hOut && { ...nd.hOut } });
  const out: VectorNode[] = [];
  for (let i = 0; i < n; i++) {
    const cur = nodes[i];
    const isEnd = !closed && (i === 0 || i === n - 1);
    const prev = nodes[(i - 1 + n) % n];
    const next = nodes[(i + 1) % n];
    // Both flanking segments straight = no handle on any relevant end.
    const qualifies = !isEnd && !cur.hIn && !cur.hOut && !prev.hOut && !next.hIn;
    if (!qualifies) {
      out.push(copy(cur));
      continue;
    }
    const Lin = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const Lout = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (Lin < 1e-9 || Lout < 1e-9) {
      out.push(copy(cur));
      continue;
    }
    const u = { x: (cur.x - prev.x) / Lin, y: (cur.y - prev.y) / Lin }; // into the corner
    const v = { x: (next.x - cur.x) / Lout, y: (next.y - cur.y) / Lout }; // out of the corner
    // Interior angle θ between (−u) and v: sin from the cross, cos from the dot.
    const sin = Math.abs(u.x * v.y - u.y * v.x);
    if (sin < 1e-4) {
      out.push(copy(cur)); // collinear pass-through or a degenerate spike
      continue;
    }
    const theta = Math.atan2(sin, -(u.x * v.x + u.y * v.y)); // ∈ (0, π)
    const tanHalf = Math.tan(theta / 2);
    // Trim distance along each leg; each leg donates at most HALF its length
    // to each end, so adjacent fillets can never overlap by construction.
    const t = Math.min(radius / tanHalf, Lin / 2, Lout / 2);
    if (!(t > 1e-6)) {
      out.push(copy(cur));
      continue;
    }
    const re = t * tanHalf; // effective radius after the clamp
    const phi = Math.PI - theta; // arc turn angle
    const k = (4 / 3) * Math.tan(phi / 4) * re; // cubic arc approximation
    out.push({ x: cur.x - u.x * t, y: cur.y - u.y * t, type: "corner", hOut: { dx: u.x * k, dy: u.y * k } });
    out.push({ x: cur.x + v.x * t, y: cur.y + v.y * t, type: "corner", hIn: { dx: -v.x * k, dy: -v.y * k } });
  }
  return out;
}

/** The rendered `d` for a path's nodes — nodesToPath with corner rounding
 *  applied (radius <= 0 → identity). The ONE d-generation wrapper: every site
 *  that turns a PathElement's nodes into its `d` goes through here, so canvas,
 *  export, resize, and tween can never disagree about fillets. */
export function pathD(nodes: VectorNode[], closed: boolean, cornerRadius?: number): string {
  const r = cornerRadius ?? 0;
  return nodesToPath(r > 0 ? roundCorners(nodes, closed, r) : nodes, closed);
}

// ---------------------------------------------------------------------------
// pathRender — the DISPLAY geometry of a path: arrowheads on open paths (same
// conventions as geometry.ts lineRender) with the body trimmed back under
// filled heads so the stroke cap never pokes past the tip. One pure function
// feeding Element.svelte AND export.ts elementToSvg, so canvas and export can
// never drift. Fast-bails to the model `d` when no arrows apply.
// ---------------------------------------------------------------------------

export interface PathRenderOut {
  d: string;
  polys: number[][][];
  vees: number[][][];
}

function segsToD(segs: PathSeg[]): string {
  if (!segs.length) return "";
  let d = `M ${nf(segs[0].x0)} ${nf(segs[0].y0)}`;
  for (const s of segs)
    d += s.line
      ? ` L ${nf(s.x3)} ${nf(s.y3)}`
      : ` C ${nf(s.x1)} ${nf(s.y1)} ${nf(s.x2)} ${nf(s.y2)} ${nf(s.x3)} ${nf(s.y3)}`;
  return d;
}

/** Cut the path back to the first point at EUCLIDEAN distance `dist` from the
 *  original endpoint (for filled heads). Euclidean — NOT arc length: the head
 *  sits along the end TANGENT, so on a curve an arc-length trim lands short of
 *  the head's base and opens a visible gap. A euclidean cut at a fraction of
 *  the head length leaves a stub that always ends underneath the filled
 *  triangle instead. Never eats more than 90% of the end segment. */
function trimEnd(segs: PathSeg[], dist: number, end: "start" | "end"): void {
  if (!segs.length || dist <= 0) return;
  const idx = end === "end" ? segs.length - 1 : 0;
  const s = segs[idx];
  const L = segLength(s);
  if (L < 1e-6) return;
  if (s.line) {
    // analytic for straights (euclidean == arc length)
    const frac = Math.min(dist / L, 0.9);
    if (end === "end") {
      const t = 1 - frac;
      const p = segPoint(s, t);
      segs[idx] = { ...s, x2: p.x, y2: p.y, x3: p.x, y3: p.y };
    } else {
      const p = segPoint(s, frac);
      segs[idx] = { ...s, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
    return;
  }
  // walk from the endpoint to the first sample beyond `dist`, then bisect the
  // bracketing pair so the cut lands ON the target distance (sample spacing
  // alone can overshoot by px — enough to resurface the gap on sharp curves)
  const N = 32;
  const tip = end === "end" ? { x: s.x3, y: s.y3 } : { x: s.x0, y: s.y0 };
  const from = end === "end" ? N : 0;
  const step = end === "end" ? -1 : 1;
  const distAt = (t: number) => {
    const p = segPoint(s, t);
    return Math.hypot(p.x - tip.x, p.y - tip.y);
  };
  let tSplit = end === "end" ? 0.1 : 0.9; // fallback: whole segment closer than dist
  for (let i = from + step; i >= 0 && i <= N; i += step) {
    if (distAt(i / N) >= dist) {
      let beyond = i / N;
      let within = (i - step) / N;
      for (let k = 0; k < 20; k++) {
        const mid = (beyond + within) / 2;
        if (distAt(mid) >= dist) beyond = mid;
        else within = mid;
      }
      tSplit = beyond;
      break;
    }
  }
  tSplit = end === "end" ? Math.min(Math.max(tSplit, 0.1), 1) : Math.max(Math.min(tSplit, 0.9), 0);
  const [left, right] = splitSeg(s, tSplit);
  segs[idx] = end === "end" ? left : right;
}

/** How deep the body tucks under a filled head: the cut lands at this fraction
 *  of the head length from the tip — inside the triangle on straights AND
 *  curves (the head half-angle is ~23°, far more than gentle end curvature),
 *  so there is never a gap. The stub is invisible under the solid head; the
 *  only trade is double-painting under sub-1 opacity. */
const HEAD_TUCK = 0.65;

export function pathRender(e: {
  d: string;
  nodes?: VectorNode[];
  closed: boolean;
  strokeWidth: number;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  arrowStyle?: "filled" | "vee";
  arrowSize?: number;
  cornerRadius?: number;
}): PathRenderOut {
  if (e.closed || (!e.arrowStart && !e.arrowEnd)) return { d: e.d, polys: [], vees: [] };
  const sharp = e.nodes && e.nodes.length ? e.nodes : pathToNodes(e.d);
  if (sharp.length < 2) return { d: e.d, polys: [], vees: [] };
  // Fillet BEFORE building segments — the arrow-trim path below re-emits
  // segsToD(segs), which would silently strip the rounding otherwise.
  // Endpoints never round, so the head tangents are unaffected.
  const nodes = e.cornerRadius && e.cornerRadius > 0 ? roundCorners(sharp, false, e.cornerRadius) : sharp;
  const segs = segsFromNodes(nodes, false);
  let total = 0;
  for (const s of segs) total += segLength(s, 8);
  const headCount = (e.arrowStart ? 1 : 0) + (e.arrowEnd ? 1 : 0);
  const head = arrowHeadLen(e.strokeWidth, e.arrowSize, total, headCount);
  const filled = (e.arrowStyle ?? "filled") === "filled";
  const polys: number[][][] = [];
  const vees: number[][][] = [];
  if (e.arrowEnd) {
    const s = segs[segs.length - 1];
    const dir = segTangent(s, 1);
    (filled ? polys : vees).push(
      filled ? arrowTri(s.x3, s.y3, dir.x, dir.y, head) : arrowVee(s.x3, s.y3, dir.x, dir.y, head),
    );
    if (filled) trimEnd(segs, head * HEAD_TUCK, "end");
  }
  if (e.arrowStart) {
    const s = segs[0];
    const dir = segTangent(s, 0);
    (filled ? polys : vees).push(
      filled ? arrowTri(s.x0, s.y0, -dir.x, -dir.y, head) : arrowVee(s.x0, s.y0, -dir.x, -dir.y, head),
    );
    if (filled) trimEnd(segs, head * HEAD_TUCK, "start");
  }
  return { d: segsToD(segs), polys, vees };
}

// ---------------------------------------------------------------------------
// bendSegment — the Figma ctrl-drag bend: pull the curve point at parameter t
// of segment i by (dx,dy) by moving the two flanking handles. The cubic's
// change at t from moving c1/c2 is w1·Δc1 + w2·Δc2 (w1 = 3(1−t)²t,
// w2 = 3(1−t)t²); distributing Δ ∝ (w1, w2)/(w1²+w2²) makes the curve pass
// exactly through the dragged point. Straight segments first sprout 1/3–2/3
// handles; both end nodes become `corner` (independent tangents, per Figma).
// ---------------------------------------------------------------------------

export function bendSegment(
  nodes: VectorNode[],
  segIndex: number,
  closed: boolean,
  t: number,
  dx: number,
  dy: number,
): VectorNode[] {
  const out = nodes.map((n) => ({
    ...n,
    hIn: n.hIn ? { ...n.hIn } : undefined,
    hOut: n.hOut ? { ...n.hOut } : undefined,
  }));
  const i = segIndex;
  const j = i === out.length - 1 && closed ? 0 : i + 1;
  const a = out[i];
  const b = out[j];
  if (!a || !b) return out;
  if (!a.hOut && !b.hIn) {
    a.hOut = { dx: (b.x - a.x) / 3, dy: (b.y - a.y) / 3 };
    b.hIn = { dx: (a.x - b.x) / 3, dy: (a.y - b.y) / 3 };
  } else {
    a.hOut = a.hOut ?? { dx: 0, dy: 0 };
    b.hIn = b.hIn ?? { dx: 0, dy: 0 };
  }
  // Clamp t away from the ends: w1,w2 → 0 there and the handle moves explode.
  const tc = Math.min(0.85, Math.max(0.15, t));
  const u = 1 - tc;
  const w1 = 3 * u * u * tc;
  const w2 = 3 * u * tc * tc;
  const denom = w1 * w1 + w2 * w2;
  a.hOut.dx += (dx * w1) / denom;
  a.hOut.dy += (dy * w1) / denom;
  b.hIn.dx += (dx * w2) / denom;
  b.hIn.dy += (dy * w2) / denom;
  a.type = "corner";
  b.type = "corner";
  return out;
}

// ---------------------------------------------------------------------------
// Endpoint merge (path-edit pen sub-mode). A draft chain drawn with the pen
// attaches to an OPEN path's start/end node — the single-chain node model
// cannot represent branches, so endpoints are the only true merge points
// (mid-node connects stay coincident separate elements by design).
// ---------------------------------------------------------------------------

/** Reverse a chain: reverse order, swap hIn/hOut per node. Geometry unchanged;
 *  only the traversal direction flips. */
export function reverseNodes(nodes: VectorNode[]): VectorNode[] {
  return [...nodes].reverse().map((n) => ({
    x: n.x,
    y: n.y,
    type: n.type,
    hIn: n.hOut ? { ...n.hOut } : undefined,
    hOut: n.hIn ? { ...n.hIn } : undefined,
  }));
}

/** Attach `draft` (whose FIRST node coincides with base's `at` endpoint) to
 *  `base`. The seed node's pulled handles fold onto the base endpoint (its
 *  x/y are discarded — the base node's position is authoritative, so float
 *  drift can't creep in). `closes`: the draft's LAST node coincides with
 *  base's OTHER endpoint — it is dropped, its incoming handle folds onto that
 *  node, and the result is closed. Node types re-classify from the folded
 *  handles (mirrored → smooth). */
export function mergeNodeChains(
  base: VectorNode[],
  draft: VectorNode[],
  at: "start" | "end",
  closes: boolean,
): { nodes: VectorNode[]; closed: boolean } {
  const cp = (n: VectorNode): VectorNode => ({
    x: n.x,
    y: n.y,
    type: n.type,
    hIn: n.hIn ? { ...n.hIn } : undefined,
    hOut: n.hOut ? { ...n.hOut } : undefined,
  });
  const out = base.map(cp);
  const d = draft.map(cp);
  if (d.length < 2 || !out.length) return { nodes: out, closed: false };
  if (at === "end") {
    const E = out[out.length - 1];
    if (d[0].hOut) E.hOut = { ...d[0].hOut };
    E.type = classify(E);
    const tail = d.slice(1);
    if (closes) {
      const last = tail.pop()!; // coincides with out[0]
      if (last.hIn) out[0].hIn = { ...last.hIn };
      out[0].type = classify(out[0]);
      return { nodes: [...out, ...tail], closed: true };
    }
    return { nodes: [...out, ...tail], closed: false };
  }
  // at === "start": prepend the draft reversed so it flows INTO the old start.
  const rev = reverseNodes(d); // now ENDS at the seed (= base start) position
  const S = out[0];
  const seedRev = rev[rev.length - 1];
  if (seedRev.hIn) S.hIn = { ...seedRev.hIn };
  S.type = classify(S);
  const head = rev.slice(0, -1);
  if (closes) {
    const first = head.shift()!; // coincides with the base END
    const E = out[out.length - 1];
    if (first.hOut) E.hOut = { ...first.hOut };
    E.type = classify(E);
    return { nodes: [...head, ...out], closed: true };
  }
  return { nodes: [...head, ...out], closed: false };
}

/** Constrain a handle/segment vector to the nearest 0/45/90° (Shift behavior). */
export function constrain45(dx: number, dy: number): { dx: number; dy: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { dx, dy };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { dx: Math.cos(ang) * len, dy: Math.sin(ang) * len };
}
