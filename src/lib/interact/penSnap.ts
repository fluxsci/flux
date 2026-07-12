// Pen-tool placement assist (pure math — no DOM, no stores): given the draft's
// placed nodes and the raw cursor point (figure-local px), compute where a
// click would land and which construction guides to show. Canvas calls this
// from BOTH pointermove (preview + indicators) and pointerdown (placement), so
// a click always lands exactly where the preview showed.
//
// Assists (tolerances are SCREEN px, zoom-corrected here):
//   close  — within PEN_CLOSE_PX of the FIRST node (≥2 placed): a click closes
//            the path; pt snaps onto the first node. Beats every other snap.
//   shift  — constrain the prospective segment to 0/45/90° from the last node
//            (same convention as the line tool), then snap the distance ALONG
//            that ray to an alignment crossing or an equal edge length.
//   align  — snap x and/or y (independently) to any placed node or any edge
//            midpoint (midpoints give perpendicular-bisector placements).
//   equal  — snap the prospective edge's LENGTH to an existing edge's length:
//            free-angle rescale, or single-axis solve when one axis is pinned
//            by an alignment. Squares / 45-45-90 triangles fall out of these.
//   alt    — disable everything (raw placement; also suppresses close, so a
//            node CAN be placed right beside the start without closing).

import type { VectorNode } from "../types";
import { constrain45 } from "../path";

export interface PenPt {
  x: number;
  y: number;
}
export type PenGuide =
  | { kind: "align"; from: PenPt; to: PenPt }
  | { kind: "equal"; a: [PenPt, PenPt]; b: [PenPt, PenPt] };
export interface PenSnapResult {
  pt: PenPt;
  close: boolean;
  guides: PenGuide[];
}

export const PEN_CLOSE_PX = 14; // close-the-shape radius (was a bare 8 in Canvas)
export const PEN_ALIGN_PX = 6; // h/v alignment snap
export const PEN_EQUAL_PX = 7; // equal-edge-length snap

export function penSnap(
  nodes: readonly VectorNode[],
  raw: PenPt,
  opts: { zoom: number; shift?: boolean; disable?: boolean },
): PenSnapResult {
  if (!nodes.length || opts.disable) return { pt: { ...raw }, close: false, guides: [] };
  const z = Math.max(opts.zoom || 1, 1e-6);

  // Close check runs on the RAW point (works with or without shift held).
  if (nodes.length >= 2) {
    const f = nodes[0];
    if (Math.hypot(raw.x - f.x, raw.y - f.y) <= PEN_CLOSE_PX / z)
      return { pt: { x: f.x, y: f.y }, close: true, guides: [] };
  }

  const last = nodes[nodes.length - 1];
  const alignTol = PEN_ALIGN_PX / z;
  const eqTol = PEN_EQUAL_PX / z;
  const guides: PenGuide[] = [];

  // Candidates: placed nodes + straight-chord edge midpoints.
  const cands: PenPt[] = nodes.map((n) => ({ x: n.x, y: n.y }));
  for (let i = 0; i < nodes.length - 1; i++)
    cands.push({ x: (nodes[i].x + nodes[i + 1].x) / 2, y: (nodes[i].y + nodes[i + 1].y) / 2 });
  // Existing edges (straight chords) for equal-length matching.
  const edges: [PenPt, PenPt][] = [];
  for (let i = 0; i < nodes.length - 1; i++)
    edges.push([
      { x: nodes[i].x, y: nodes[i].y },
      { x: nodes[i + 1].x, y: nodes[i + 1].y },
    ]);
  const elen = (e: [PenPt, PenPt]) => Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y);

  if (opts.shift) {
    // Constrain to the 45° ray (length-preserving), then snap t along the ray.
    const c45 = constrain45(raw.x - last.x, raw.y - last.y);
    const len0 = Math.hypot(c45.dx, c45.dy);
    if (len0 < 1e-9) return { pt: { x: last.x, y: last.y }, close: false, guides: [] };
    const ray = { x: c45.dx / len0, y: c45.dy / len0 };
    let t = len0;
    let bestAdj = Infinity;
    let bestGuide: PenGuide | null = null;
    for (const c of cands) {
      // t where the moving point crosses the candidate's vertical / horizontal.
      for (const axis of ["x", "y"] as const) {
        const r = axis === "x" ? ray.x : ray.y;
        if (Math.abs(r) < 1e-9) continue; // ray parallel to this alignment — no crossing
        const tc = ((axis === "x" ? c.x - last.x : c.y - last.y)) / r;
        const adj = Math.abs(tc - len0);
        if (tc > 1e-9 && adj <= alignTol && adj < bestAdj) {
          bestAdj = adj;
          t = tc;
          bestGuide = { kind: "align", from: c, to: { x: 0, y: 0 } }; // `to` patched below
        }
      }
    }
    for (const eg of edges) {
      const L = elen(eg);
      const adj = Math.abs(L - len0);
      if (L > 1e-9 && adj <= eqTol && adj < bestAdj) {
        bestAdj = adj;
        t = L;
        bestGuide = { kind: "equal", a: eg, b: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }; // patched below
      }
    }
    const pt = { x: last.x + ray.x * t, y: last.y + ray.y * t };
    if (bestGuide) {
      if (bestGuide.kind === "align") bestGuide.to = { ...pt };
      else bestGuide.b = [{ x: last.x, y: last.y }, { ...pt }];
      guides.push(bestGuide);
    }
    return { pt, close: false, guides };
  }

  // Free placement: independent x/y alignment first.
  const pt: PenPt = { x: raw.x, y: raw.y };
  let ax: PenPt | null = null;
  let ay: PenPt | null = null;
  let bx = Infinity;
  let by = Infinity;
  for (const c of cands) {
    const ddx = Math.abs(raw.x - c.x);
    if (ddx <= alignTol && ddx < bx) {
      bx = ddx;
      ax = c;
    }
    const ddy = Math.abs(raw.y - c.y);
    if (ddy <= alignTol && ddy < by) {
      by = ddy;
      ay = c;
    }
  }
  if (ax) pt.x = ax.x;
  if (ay) pt.y = ay.y;

  // Equal length vs the last node (skipped when both axes are pinned — the
  // point is fully determined by the alignments).
  let eqEdge: [PenPt, PenPt] | null = null;
  if (!(ax && ay)) {
    let best = Infinity;
    const vx0 = pt.x - last.x;
    const vy0 = pt.y - last.y;
    const cur = Math.hypot(vx0, vy0);
    for (const eg of edges) {
      const L = elen(eg);
      if (L < 1e-9) continue;
      if (ax && !ay) {
        // x pinned: solve y on the circle |P − last| = L, keep the raw side.
        const ddx = pt.x - last.x;
        if (Math.abs(ddx) <= L) {
          const yy = last.y + Math.sign(vy0 || 1) * Math.sqrt(L * L - ddx * ddx);
          const adj = Math.abs(yy - raw.y);
          if (adj <= eqTol && adj < best) {
            best = adj;
            pt.y = yy;
            eqEdge = eg;
          }
        }
      } else if (ay && !ax) {
        const ddy = pt.y - last.y;
        if (Math.abs(ddy) <= L) {
          const xx = last.x + Math.sign(vx0 || 1) * Math.sqrt(L * L - ddy * ddy);
          const adj = Math.abs(xx - raw.x);
          if (adj <= eqTol && adj < best) {
            best = adj;
            pt.x = xx;
            eqEdge = eg;
          }
        }
      } else {
        // Free: rescale the prospective vector to the matched length.
        const adj = Math.abs(cur - L);
        if (cur > 1e-9 && adj <= eqTol && adj < best) {
          best = adj;
          pt.x = last.x + (vx0 / cur) * L;
          pt.y = last.y + (vy0 / cur) * L;
          eqEdge = eg;
        }
      }
    }
  }

  if (ax) guides.push({ kind: "align", from: ax, to: { ...pt } });
  if (ay) guides.push({ kind: "align", from: ay, to: { ...pt } });
  if (eqEdge) guides.push({ kind: "equal", a: eqEdge, b: [{ x: last.x, y: last.y }, { ...pt }] });
  return { pt, close: false, guides };
}
