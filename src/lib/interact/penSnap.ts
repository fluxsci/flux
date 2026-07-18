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
//   anchor — (path-edit pen sub-mode) snap onto a node of the path being
//            edited, within the close radius; endpoints beat mids. Lands the
//            point EXACTLY on the node (no grid/assist re-snap) — that's the
//            whole point of connecting.
//   grid   — hard-quantize placement to the (n·G, m·G) lattice (the visible
//            background grid): assists are skipped (they'd fight the lattice);
//            under shift the 0/45/90 direction wins and the lattice point is
//            projected back onto the ray (h/v rays land exactly on vertices).
//   alt    — disable everything (raw placement; also suppresses close, so a
//            node CAN be placed right beside the start without closing).
//
// Precedence: alt-disable → close → anchor → grid → shift-ray/free assists.

import type { VectorNode } from "../types";
import { constrain45 } from "../path";

export interface PenPt {
  x: number;
  y: number;
}
export type PenGuide =
  | { kind: "align"; from: PenPt; to: PenPt }
  | { kind: "equal"; a: [PenPt, PenPt]; b: [PenPt, PenPt] };
export interface PenAnchor {
  pt: PenPt;
  role: "endpoint-start" | "endpoint-end" | "mid";
  /** node index in the edited path */
  i: number;
}
export interface PenSnapResult {
  pt: PenPt;
  close: boolean;
  guides: PenGuide[];
  /** placement was quantized to the grid lattice */
  onGrid?: boolean;
  /** placement landed on an edited-path node (pen sub-mode connect) */
  anchor?: PenAnchor;
}

export const PEN_CLOSE_PX = 14; // close-the-shape radius (was a bare 8 in Canvas)
export const PEN_ALIGN_PX = 6; // h/v alignment snap
export const PEN_EQUAL_PX = 7; // equal-edge-length snap

export function penSnap(
  nodes: readonly VectorNode[],
  raw: PenPt,
  opts: {
    zoom: number;
    shift?: boolean;
    disable?: boolean;
    /** grid spacing (figure-local units); > 0 restricts placement to vertices */
    grid?: number;
    /** connectable nodes of the path being edited (pen sub-mode) */
    anchors?: readonly PenAnchor[];
    /** suppress self-close (seeded sub-mode drafts: a loop back onto the seed
     *  endpoint would be a branch, not a close) */
    noClose?: boolean;
  },
): PenSnapResult {
  if (opts.disable) return { pt: { ...raw }, close: false, guides: [] };
  const z = Math.max(opts.zoom || 1, 1e-6);

  // Close check runs on the RAW point (works with or without shift held).
  if (nodes.length >= 2 && !opts.noClose) {
    const f = nodes[0];
    if (Math.hypot(raw.x - f.x, raw.y - f.y) <= PEN_CLOSE_PX / z)
      return { pt: { x: f.x, y: f.y }, close: true, guides: [] };
  }

  // Anchor snap: nearest connectable node within the close radius; endpoint
  // roles beat mids (an endpoint continues/joins the path — the primary act).
  if (opts.anchors?.length) {
    const R = PEN_CLOSE_PX / z;
    let best: PenAnchor | null = null;
    let bestD = Infinity;
    let bestEnd = false;
    for (const a of opts.anchors) {
      const d = Math.hypot(raw.x - a.pt.x, raw.y - a.pt.y);
      if (d > R) continue;
      const isEnd = a.role !== "mid";
      if (best && bestEnd && !isEnd) continue;
      if (best && bestEnd === isEnd && d >= bestD) continue;
      best = a;
      bestD = d;
      bestEnd = isEnd;
    }
    if (best) return { pt: { ...best.pt }, close: false, guides: [], anchor: best };
  }

  const grid = opts.grid && opts.grid > 0 ? opts.grid : 0;
  const q = (v: number) => Math.round(v / grid) * grid;

  // First node of a draft: only anchors (above) and the grid apply.
  if (!nodes.length) {
    if (grid) return { pt: { x: q(raw.x), y: q(raw.y) }, close: false, guides: [], onGrid: true };
    return { pt: { ...raw }, close: false, guides: [] };
  }

  const last = nodes[nodes.length - 1];

  if (grid) {
    if (opts.shift) {
      // Direction always wins: constrain to the 0/45/90 ray, quantize the ray
      // point to the lattice, project the lattice point back onto the ray. On
      // h/v rays the moving axis lands exactly on n·G.
      const c45 = constrain45(raw.x - last.x, raw.y - last.y);
      const len0 = Math.hypot(c45.dx, c45.dy);
      if (len0 < 1e-9) return { pt: { x: last.x, y: last.y }, close: false, guides: [], onGrid: true };
      const ray = { x: c45.dx / len0, y: c45.dy / len0 };
      const gp = { x: q(last.x + ray.x * len0), y: q(last.y + ray.y * len0) };
      const t = Math.max(0, (gp.x - last.x) * ray.x + (gp.y - last.y) * ray.y);
      return { pt: { x: last.x + ray.x * t, y: last.y + ray.y * t }, close: false, guides: [], onGrid: true };
    }
    return { pt: { x: q(raw.x), y: q(raw.y) }, close: false, guides: [], onGrid: true };
  }
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
