import type { Rect } from "./geometry";

export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sized {
  w: number;
  h: number;
}

// Arrange items at EXACTLY their given size into `region`, packing along one
// axis and wrapping. Items are never rescaled — size is the physical-size
// contract (an item larger than the region simply overflows it, Figma-style;
// the user resizes deliberately or regenerates the plot at the right size).
//   "rows" — flow left→right (a horizontal row), wrap downward.
//   "cols" — flow top→bottom (a vertical stack), wrap rightward.
export function gridLayout(
  items: Sized[],
  region: Rect,
  gap: number,
  orientation: "rows" | "cols",
): Placed[] {
  const n = items.length;
  if (n === 0) return [];

  if (orientation === "rows") {
    const sized = items.map((it) => ({ w: it.w, h: it.h }));
    const out: Placed[] = new Array(n);
    let x = region.x;
    let y = region.y;
    let rowH = 0;
    let inRow = 0;
    for (let i = 0; i < n; i++) {
      const s = sized[i];
      if (inRow > 0 && x - region.x + s.w > region.w + 0.5) {
        x = region.x;
        y += rowH + gap;
        rowH = 0;
        inRow = 0;
      }
      out[i] = { x, y, w: s.w, h: s.h };
      x += s.w + gap;
      rowH = Math.max(rowH, s.h);
      inRow++;
    }
    return out;
  }

  // cols
  const sized = items.map((it) => ({ w: it.w, h: it.h }));
  const out: Placed[] = new Array(n);
  let x = region.x;
  let y = region.y;
  let colW = 0;
  let inCol = 0;
  for (let i = 0; i < n; i++) {
    const s = sized[i];
    if (inCol > 0 && y - region.y + s.h > region.h + 0.5) {
      y = region.y;
      x += colW + gap;
      colW = 0;
      inCol = 0;
    }
    out[i] = { x, y, w: s.w, h: s.h };
    y += s.h + gap;
    colW = Math.max(colW, s.w);
    inCol++;
  }
  return out;
}

// Pick the largest empty band of `inner` that doesn't overlap `occupied`
// (below / right / above / left of it). Falls back to `inner` if nothing fits.
export function emptyRegion(inner: Rect, occupied: Rect | null, gap: number): Rect {
  if (!occupied) return inner;
  const cands: Rect[] = [
    { x: inner.x, y: occupied.y + occupied.h + gap, w: inner.w, h: inner.y + inner.h - (occupied.y + occupied.h + gap) }, // below
    { x: occupied.x + occupied.w + gap, y: inner.y, w: inner.x + inner.w - (occupied.x + occupied.w + gap), h: inner.h }, // right
    { x: inner.x, y: inner.y, w: inner.w, h: occupied.y - gap - inner.y }, // above
    { x: inner.x, y: inner.y, w: occupied.x - gap - inner.x, h: inner.h }, // left
  ].filter((r) => r.w > 30 && r.h > 30);
  if (!cands.length) return inner;
  return cands.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
}
