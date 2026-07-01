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

export function selectionBBox(els: Element[]): Rect | null {
  return unionRect(els.map(elementBBox));
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
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

// Arrowhead polygons (in element-local coords) for a line's enabled ends.
// Returned as arrays of [x,y] triangles so they render identically on the
// canvas and in exported SVG/PDF (no reliance on SVG markers).
export function arrowHeads(e: LineElement): number[][][] {
  const size = Math.max(6, e.strokeWidth * 3.2);
  const heads: number[][][] = [];
  const make = (tipX: number, tipY: number, fromX: number, fromY: number) => {
    const dx = tipX - fromX;
    const dy = tipY - fromY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const baseX = tipX - ux * size;
    const baseY = tipY - uy * size;
    const half = size * 0.42;
    heads.push([
      [tipX, tipY],
      [baseX + px * half, baseY + py * half],
      [baseX - px * half, baseY - py * half],
    ]);
  };
  if (e.arrowEnd) make(e.x2, e.y2, e.x1, e.y1);
  if (e.arrowStart) make(e.x1, e.y1, e.x2, e.y2);
  return heads;
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
