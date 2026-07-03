// Pure highlight geometry for the PDF reader. Range.getClientRects() returns a messy
// pile of boxes — per-span fragments, boxes nested inside other boxes, duplicates —
// and painting one translucent div per raw rect stacks alpha wherever they overlap
// (the patchy, ragged highlights this replaces). This module collapses that pile into
// ONE box per visual text line, expressed as PERCENTAGES of the page box so painted
// divs survive page resize without recompute. No DOM here; unit-tested by
// scripts/verify-r1-hlgeom.ts.

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One merged per-line highlight box, in % of the page box (0–100). */
export interface LineBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A page's clickable highlights: annotation id → its line boxes (draw order). */
export interface HitEntry {
  id: string;
  boxes: LineBox[];
}

const EPS = 0.5; // px tolerance for containment/dedupe

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const contains = (outer: Box, inner: Box): boolean =>
  inner.left >= outer.left - EPS &&
  inner.right <= outer.right + EPS &&
  inner.top >= outer.top - EPS &&
  inner.bottom <= outer.bottom + EPS;

/** Vertical overlap of two boxes as a fraction of the shorter box's height. */
function vOverlap(a: Box, b: Box): number {
  const o = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const minH = Math.max(1e-6, Math.min(a.bottom - a.top, b.bottom - b.top));
  return o / minH;
}

/**
 * Collapse a Range's client rects into one box per text line, as % of the page.
 * `bleedY` (px) expands each line slightly above/below for the hand-marker look.
 * Rules: drop degenerate rects; drop rects contained in another (Chrome emits the
 * parent inline box AND its fragments); group the rest into lines by ≥50% vertical
 * overlap (tolerates sub/superscript fragments); union each line's extent.
 */
export function mergeRectsIntoLines(rects: RectLike[], page: PageBox, opts: { bleedY?: number } = {}): LineBox[] {
  const bleedY = opts.bleedY ?? 0;
  if (page.width <= 0 || page.height <= 0) return [];

  let boxes: Box[] = [];
  for (const r of rects) {
    if (r.width < EPS || r.height < EPS) continue;
    boxes.push({
      left: r.left - page.left,
      top: r.top - page.top,
      right: r.left - page.left + r.width,
      bottom: r.top - page.top + r.height,
    });
  }

  // Drop boxes contained in another (keep the first of exact duplicates).
  boxes = boxes.filter((b, i) =>
    !boxes.some((o, j) => {
      if (i === j || !contains(o, b)) return false;
      return !contains(b, o) || j < i; // mutual containment = duplicate → keep lowest index
    }),
  );

  // Group into lines (sorted by top, then greedily attach by vertical overlap).
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Box[] = [];
  for (const b of boxes) {
    const line = lines.find((l) => vOverlap(l, b) >= 0.5);
    if (line) {
      line.left = Math.min(line.left, b.left);
      line.right = Math.max(line.right, b.right);
      line.top = Math.min(line.top, b.top);
      line.bottom = Math.max(line.bottom, b.bottom);
    } else {
      lines.push({ ...b });
    }
  }

  return lines.map((l) => {
    const top = l.top - bleedY;
    const bottom = l.bottom + bleedY;
    return {
      x: (l.left / page.width) * 100,
      y: (top / page.height) * 100,
      w: ((l.right - l.left) / page.width) * 100,
      h: ((bottom - top) / page.height) * 100,
    };
  });
}

/**
 * Which annotation (if any) is under a point, given page-relative % coordinates.
 * Later entries win (they're drawn later, i.e. on top) — iterate in reverse.
 */
export function hitTest(xPct: number, yPct: number, entries: HitEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const b of entries[i].boxes) {
      if (xPct >= b.x && xPct <= b.x + b.w && yPct >= b.y && yPct <= b.y + b.h) return entries[i].id;
    }
  }
  return null;
}
