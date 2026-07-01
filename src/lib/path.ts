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

/** Bounding box of nodes + their handle control points (a superset of the curve,
 *  since a cubic lies within its control hull). Local coords. */
export function nodesExtent(nodes: VectorNode[]): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of nodes) {
    xs.push(n.x);
    ys.push(n.y);
    if (n.hIn) { xs.push(n.x + n.hIn.dx); ys.push(n.y + n.hIn.dy); }
    if (n.hOut) { xs.push(n.x + n.hOut.dx); ys.push(n.y + n.hOut.dy); }
  }
  if (!xs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** Re-fit a path element to its `nodes`: normalize so the content's top-left sits
 *  at local (0,0) (shifting x/y to preserve the on-canvas position), set
 *  width/height from the node+handle extent, and regenerate `d`. Call after any
 *  edit to `nodes`. Mutates and returns the element. */
export function refitPath(el: PathElement): PathElement {
  if (!el.nodes || !el.nodes.length) return el;
  const ext = nodesExtent(el.nodes);
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
  el.d = nodesToPath(el.nodes, el.closed);
  return el;
}

/** Constrain a handle/segment vector to the nearest 0/45/90° (Shift behavior). */
export function constrain45(dx: number, dy: number): { dx: number; dy: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { dx, dy };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { dx: Math.cos(ang) * len, dy: Math.sin(ang) * len };
}
