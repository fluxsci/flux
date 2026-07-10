import type { Element, LineElement } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Axis-aligned bounding box of an element in its figure-local coordinate space.
export function elementBBox(e: Element): Rect {
  if (e.type === "line") {
    const x1 = e.x + e.x1;
    const y1 = e.y + e.y1;
    const x2 = e.x + e.x2;
    const y2 = e.y + e.y2;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// --- rotation-aware bounds (FIG-4) ------------------------------------------------
// `rotation` visually spins an element about its bbox centre (Element.svelte /
// export.ts pivot), but elementBBox above deliberately stays the UNROTATED box (the
// stored x/y/w/h — what resize/ops mutate). These helpers give the ROTATED shape's
// geometry for everything user-facing: the selection box that should hug the shape,
// marquee hit-testing that shouldn't catch the empty corners of a tilted element's
// AABB, and culling that must not hide a partially-visible rotated element.

const rotationOf = (e: Element): number => ("rotation" in e ? ((e as { rotation?: number }).rotation ?? 0) : 0);

/** Rotate a point about a centre by `deg` degrees (the same convention the
 *  element transforms use). Shared by rotatedCorners and the crop gesture's
 *  pointer→local-frame mapping (editing.ts cropRemap inverse-rotates with -deg). */
export function rotatePoint(
  p: { x: number; y: number },
  c: { x: number; y: number },
  deg: number,
): { x: number; y: number } {
  if (!deg) return { x: p.x, y: p.y };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
    y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
  };
}

/** The element's four bbox corners AFTER its rotation (figure-local coords). */
export function rotatedCorners(e: Element): { x: number; y: number }[] {
  const b = elementBBox(e);
  const pts = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
  const rot = rotationOf(e);
  if (!rot) return pts;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pts.map((p) => ({
    x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
    y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
  }));
}

/** AABB of the ROTATED shape — the box a selection outline should enclose. */
export function rotatedAABB(e: Element): Rect {
  if (!rotationOf(e)) return elementBBox(e);
  const pts = rotatedCorners(e);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Box around a selection that HUGS rotated members (display/snap/resize frame). */
export function selectionBBox(els: Element[]): Rect | null {
  return unionRect(els.map(rotatedAABB));
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/** Convex-polygon overlap via the separating-axis theorem (both polys' edge normals). */
function polysIntersect(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const nx = p2.y - p1.y;
      const ny = p1.x - p2.x;
      let minA = Infinity,
        maxA = -Infinity,
        minB = Infinity,
        maxB = -Infinity;
      for (const p of a) {
        const d = p.x * nx + p.y * ny;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const p of b) {
        const d = p.x * nx + p.y * ny;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA < minB || maxB < minA) return false; // separating axis found
    }
  }
  return true;
}

/** rect ∩ element honoring rotation — a marquee no longer catches the empty AABB
 *  corners of a tilted element (unrotated elements keep the cheap rect test). */
export function rectIntersectsElement(r: Rect, e: Element): boolean {
  if (!rotationOf(e)) return rectsIntersect(elementBBox(e), r);
  const quad = rotatedCorners(e);
  const rectPts = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  return polysIntersect(rectPts, quad);
}

// Edge-to-edge gap between two rects, per axis (Feature 3 caliper). `dx`/`dy` are
// the positive clear distance along each axis (0 when the rects overlap on that
// axis); `overlapX`/`overlapY` say whether they share a band on that axis. Pure;
// backs the measurement overlay (which draws the gap where !overlap).
export function gapBetween(
  a: Rect,
  b: Rect,
): { dx: number; dy: number; overlapX: boolean; overlapY: boolean } {
  const ar = a.x + a.w;
  const ab = a.y + a.h;
  const br = b.x + b.w;
  const bb = b.y + b.h;
  let dx = 0;
  let overlapX = false;
  if (b.x >= ar) dx = b.x - ar; // b entirely right of a
  else if (a.x >= br) dx = a.x - br; // b entirely left of a
  else overlapX = true;
  let dy = 0;
  let overlapY = false;
  if (b.y >= ab) dy = b.y - ab;
  else if (a.y >= bb) dy = a.y - bb;
  else overlapY = true;
  return { dx, dy, overlapX, overlapY };
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// Everything needed to draw a line/arrow, in element-local coords, computed
// once and shared by the canvas AND SVG export (no reliance on SVG markers).
// The visible stroke is pulled back to a FILLED head's base so the tip sits
// EXACTLY on the model endpoint — a stroke running on through the head is
// what made arrows look broken. V-style heads are stroked chevrons through
// the endpoint, so the line keeps its full length there.
export interface LineRender {
  x1: number;
  y1: number;
  x2: number;
  y2: number; // visible stroke endpoints
  cap: "butt" | "round" | "square";
  polys: number[][][]; // filled triangle heads (tip first)
  vees: number[][][]; // open-V heads as 3-point polylines (leg, tip, leg)
}

/** A line's two endpoints in FIGURE coords with rotation/flip applied — the
 *  transform order mirrors Element.svelte's buildTransform (SVG lists apply
 *  right-to-left: flip about the bbox centre FIRST, then rotate about it).
 *  Feeds the endpoint handles + the pivot gesture's grab-time baking. */
export function lineWorldEndpoints(e: LineElement): {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
} {
  const b = elementBBox(e);
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const sx = e.flipX ? -1 : 1;
  const sy = e.flipY ? -1 : 1;
  const tp = (px: number, py: number) =>
    rotatePoint({ x: c.x + (px - c.x) * sx, y: c.y + (py - c.y) * sy }, c, e.rotation ?? 0);
  return { p1: tp(e.x + e.x1, e.y + e.y1), p2: tp(e.x + e.x2, e.y + e.y2) };
}

export function lineRender(e: LineElement): LineRender {
  const cap = e.cap ?? "round";
  const filled = (e.arrowStyle ?? "filled") === "filled";
  const sw = Math.max(e.strokeWidth, 0.5);
  const dx = e.x2 - e.x1;
  const dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy) || 1;
  // Head length: a user-tunable multiple of the stroke width. ≥1.2·sw keeps
  // the stroke's cap hidden inside a filled head; heads shrink to fit short
  // lines so a double-headed arrow never inverts.
  const headCount = (e.arrowStart ? 1 : 0) + (e.arrowEnd ? 1 : 0);
  let head = Math.max(6, sw * 1.2, sw * (e.arrowSize ?? 4));
  if (headCount) head = Math.min(head, (len * 0.9) / headCount);
  const ux = dx / len;
  const uy = dy / len;
  const out: LineRender = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, cap, polys: [], vees: [] };
  // sx/sy = direction from the line body toward this end's tip.
  const make = (tipX: number, tipY: number, sx: number, sy: number, end: "start" | "end") => {
    const px = -sy;
    const py = sx;
    if (filled) {
      const bx = tipX - sx * head;
      const by = tipY - sy * head;
      const half = head * 0.42;
      out.polys.push([
        [tipX, tipY],
        [bx + px * half, by + py * half],
        [bx - px * half, by - py * half],
      ]);
      if (end === "end") {
        out.x2 = bx;
        out.y2 = by;
      } else {
        out.x1 = bx;
        out.y1 = by;
      }
    } else {
      const c = 0.85; // ~32° half-opening, legs the full head length
      const s = 0.53;
      out.vees.push([
        [tipX - (sx * c - px * s) * head, tipY - (sy * c - py * s) * head],
        [tipX, tipY],
        [tipX - (sx * c + px * s) * head, tipY - (sy * c + py * s) * head],
      ]);
    }
  };
  if (e.arrowEnd) make(e.x2, e.y2, ux, uy, "end");
  if (e.arrowStart) make(e.x1, e.y1, -ux, -uy, "start");
  return out;
}

// ---------------------------------------------------------------------------
// Alignment — shift each element so a chosen edge/centre matches the group.
// Works for every element type because translating `x`/`y` translates its bbox.
// ---------------------------------------------------------------------------
export type AlignKind =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "centerH"
  | "centerV";

export function alignElements(els: Element[], kind: AlignKind) {
  if (els.length < 1) return;
  const boxes = els.map(elementBBox);
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  els.forEach((e, i) => {
    const b = boxes[i];
    switch (kind) {
      case "left":
        e.x += minX - b.x;
        break;
      case "right":
        e.x += maxX - (b.x + b.w);
        break;
      case "centerH":
        e.x += cx - (b.x + b.w / 2);
        break;
      case "top":
        e.y += minY - b.y;
        break;
      case "bottom":
        e.y += maxY - (b.y + b.h);
        break;
      case "centerV":
        e.y += cy - (b.y + b.h / 2);
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Flip — mirror each element about the selection's centre on one axis.
//
// Each element gets its flip flag toggled (rendered as a scale(-1) about its own
// centre, see Element.svelte/export.ts) and is repositioned so the *group*
// mirrors as a whole. For a single element the reposition is a no-op (its centre
// is the group centre), so it just mirrors in place.
// ---------------------------------------------------------------------------
export function flipElements(els: Element[], axis: "h" | "v") {
  const bb = selectionBBox(els);
  if (!bb) return;
  const cx = bb.x + bb.w / 2;
  const cy = bb.y + bb.h / 2;
  for (const e of els) {
    const b = elementBBox(e);
    if (axis === "h") {
      const c = b.x + b.w / 2;
      e.x += 2 * (cx - c);
      e.flipX = !e.flipX;
    } else {
      const c = b.y + b.h / 2;
      e.y += 2 * (cy - c);
      e.flipY = !e.flipY;
    }
  }
}

// ---------------------------------------------------------------------------
// Rotate — turn each element by `deltaDeg` about a shared pivot. Each element's
// rotation field is incremented (rendered as rotate() about its own centre in
// Element.svelte/export.ts) AND its centre orbits the pivot, so a multi-element
// selection rotates rigidly as a group. For a single element rotated about its
// own centre the orbit is a no-op (it just spins in place). Delta-based so the
// GUI can drive it live and ops.rotateElements/agents can apply a one-shot turn.
// ---------------------------------------------------------------------------
export function rotateAbout(els: Element[], pivot: { x: number; y: number }, deltaDeg: number) {
  if (!deltaDeg) {
    for (const e of els) e.rotation = (e.rotation ?? 0) + deltaDeg;
    return;
  }
  const rad = (deltaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (const e of els) {
    const b = elementBBox(e);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const nx = pivot.x + (cx - pivot.x) * cos - (cy - pivot.y) * sin;
    const ny = pivot.y + (cx - pivot.x) * sin + (cy - pivot.y) * cos;
    e.x += nx - cx;
    e.y += ny - cy;
    e.rotation = (e.rotation ?? 0) + deltaDeg;
  }
}

// Distribute spacing evenly between elements along an axis.
export function distributeElements(els: Element[], axis: "h" | "v", gap?: number) {
  // Exact-gap mode (Feature 7): anchor the first item along the axis and place
  // each subsequent one so every consecutive edge-to-edge gap equals `gap`.
  // Works with ≥2 items (unlike equal-distribution, which needs ≥3).
  if (gap != null) {
    if (els.length < 2) return;
    const items = els
      .map((e) => ({ e, b: elementBBox(e) }))
      .sort((a, z) => (axis === "h" ? a.b.x - z.b.x : a.b.y - z.b.y));
    if (axis === "h") {
      let cursor = items[0].b.x + items[0].b.w;
      for (let i = 1; i < items.length; i++) {
        cursor += gap;
        items[i].e.x += cursor - items[i].b.x;
        cursor += items[i].b.w;
      }
    } else {
      let cursor = items[0].b.y + items[0].b.h;
      for (let i = 1; i < items.length; i++) {
        cursor += gap;
        items[i].e.y += cursor - items[i].b.y;
        cursor += items[i].b.h;
      }
    }
    return;
  }
  if (els.length < 3) return;
  const items = els
    .map((e) => ({ e, b: elementBBox(e) }))
    .sort((a, z) =>
      axis === "h" ? a.b.x - z.b.x : a.b.y - z.b.y,
    );
  const first = items[0].b;
  const last = items[items.length - 1].b;
  if (axis === "h") {
    const totalGap =
      last.x - (first.x + first.w) -
      items.slice(1, -1).reduce((s, it) => s + it.b.w, 0);
    const gap = totalGap / (items.length - 1);
    let cursor = first.x + first.w;
    for (let i = 1; i < items.length - 1; i++) {
      cursor += gap;
      items[i].e.x += cursor - items[i].b.x;
      cursor += items[i].b.w;
    }
  } else {
    const totalGap =
      last.y - (first.y + first.h) -
      items.slice(1, -1).reduce((s, it) => s + it.b.h, 0);
    const gap = totalGap / (items.length - 1);
    let cursor = first.y + first.h;
    for (let i = 1; i < items.length - 1; i++) {
      cursor += gap;
      items[i].e.y += cursor - items[i].b.y;
      cursor += items[i].b.h;
    }
  }
}

// ---------------------------------------------------------------------------
// Grid arrangement — reflow a multi-selection into `cols` columns (rows auto =
// ceil(items / cols)). Used by the keyboard "Arrange mode" (Alt+G) and the
// Inspector's Arrange buttons. Like align/distribute it mutates `x`/`y` in
// place and never resizes; cells size to content (per-column width / per-row
// height) and each item is centred in its cell. A whole group counts as ONE
// cell and translates rigidly. The grid is anchored at the selection's current
// top-left, and items fill in reading order (top→bottom, left→right).
// ---------------------------------------------------------------------------
export interface ArrangeGridOptions {
  gap?: number;
  rowGap?: number;
  colGap?: number;
}

interface GridItem {
  members: Element[];
  bbox: Rect;
}

// Cluster the selection into layout cells: one per group (union bbox), one per
// ungrouped element. (The selection is already group-expanded upstream.)
function buildGridItems(els: Element[]): GridItem[] {
  const groups = new Map<string, Element[]>();
  const items: GridItem[] = [];
  for (const e of els) {
    if (e.groupId) {
      const a = groups.get(e.groupId) ?? [];
      a.push(e);
      groups.set(e.groupId, a);
    } else {
      items.push({ members: [e], bbox: elementBBox(e) });
    }
  }
  for (const [, members] of groups)
    items.push({ members, bbox: unionRect(members.map(elementBBox))! });
  return items;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Stable reading order: group items into row-bands within a y-tolerance, then
// sort each band left-to-right. Avoids the non-transitive single comparator.
function readingOrder(items: GridItem[], tol: number): GridItem[] {
  const byY = [...items].sort((a, b) => a.bbox.y - b.bbox.y);
  const bands: GridItem[][] = [];
  for (const it of byY) {
    const band = bands[bands.length - 1];
    if (band && it.bbox.y - band[0].bbox.y <= tol) band.push(it);
    else bands.push([it]);
  }
  for (const band of bands) band.sort((a, z) => a.bbox.x - z.bbox.x);
  return bands.flat();
}

// Auto gap: scales with content (median item dimension), clamped to a sane range.
function defaultGap(w: number[], h: number[]): number {
  const m = median([...w, ...h]);
  return m > 0 ? Math.round(Math.min(48, Math.max(8, m * 0.06))) : 16;
}

// Number of layout cells for a selection (a group counts as one).
export function gridItemCount(els: Element[]): number {
  return buildGridItems(els).length;
}

export function arrangeGrid(
  els: Element[],
  cols: number,
  opts: ArrangeGridOptions = {},
): void {
  if (cols < 1) return;
  const items = buildGridItems(els);
  const n = items.length;
  if (n < 2) return;

  const anchor = selectionBBox(els)!; // == union of item bboxes
  const ws = items.map((i) => i.bbox.w);
  const hs = items.map((i) => i.bbox.h);
  const gap = opts.gap ?? defaultGap(ws, hs);
  const colGap = opts.colGap ?? gap;
  const rowGap = opts.rowGap ?? gap;

  const ordered = readingOrder(items, median(hs) * 0.5);
  const C = Math.min(cols, n);
  const R = Math.ceil(n / C);

  const colW = new Array(C).fill(0);
  const rowH = new Array(R).fill(0);
  ordered.forEach((it, i) => {
    const r = (i / C) | 0;
    const c = i % C;
    colW[c] = Math.max(colW[c], it.bbox.w);
    rowH[r] = Math.max(rowH[r], it.bbox.h);
  });

  const colX = new Array(C);
  let ax = anchor.x;
  for (let c = 0; c < C; c++) {
    colX[c] = ax;
    ax += colW[c] + colGap;
  }
  const rowY = new Array(R);
  let ay = anchor.y;
  for (let r = 0; r < R; r++) {
    rowY[r] = ay;
    ay += rowH[r] + rowGap;
  }

  ordered.forEach((it, i) => {
    const r = (i / C) | 0;
    const c = i % C;
    const dx = colX[c] + (colW[c] - it.bbox.w) / 2 - it.bbox.x;
    const dy = rowY[r] + (rowH[r] - it.bbox.h) / 2 - it.bbox.y;
    for (const m of it.members) {
      m.x += dx; // x/y translation moves every element type (lines included)
      m.y += dy;
    }
  });
}

// Distinct row counts that fill n items with no empty trailing row, ascending.
// e.g. n=6 → [1,2,3,6]; n=5 (prime) → [1,2,3,5].
export function validRowCounts(n: number): number[] {
  const s = new Set<number>();
  for (let c = 1; c <= n; c++) s.add(Math.ceil(n / c));
  return [...s].sort((a, b) => a - b);
}

// Balanced (near-square) row count: the valid count closest to √n
// (ties resolve toward fewer rows, i.e. a wider/landscape grid).
export function balancedRows(n: number): number {
  const t = Math.sqrt(n);
  return validRowCounts(n).reduce((best, r) =>
    Math.abs(r - t) < Math.abs(best - t) ? r : best,
  );
}
