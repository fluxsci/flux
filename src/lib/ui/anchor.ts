// Surface anchoring (2026-09-15 surface redesign) — ONE pure placement law for
// every popover that opens "at the selection": the property menu (F), the
// X-ray, the inline colour picker. The panel lands beside the thing it edits,
// as close to the pointer as it can, and never covers the box it was opened
// on. Pure and DOM-free so it gates hermetically (verify-surface-anchor.ts).
//
// Preference order when a box to avoid is given: RIGHT of it (the mouse hand
// reads left→right, so the panel sits where the eye goes next), then LEFT,
// then BELOW, then ABOVE; the first side with room wins. Along the free axis
// the panel aligns to the pointer (its first rows land under the cursor), and
// is clamped inside the viewport. Without a box it opens at the pointer's
// right; without a pointer it centres.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export type AnchorSide = "right" | "left" | "below" | "above" | "pointer" | "center";

export interface AnchorInput {
  /** The screen box the panel must not cover (the selection), if any. */
  avoid?: Rect | null;
  /** Where the pointer was when the panel was summoned, if known. */
  point?: Point | null;
  /** The panel's own size. */
  size: { w: number; h: number };
  /** The viewport size. */
  viewport: { w: number; h: number };
  /** Breathing room between the panel and the avoided box (px). */
  gap?: number;
  /** Minimum distance from the viewport edges (px). */
  margin?: number;
  /** How far above the pointer the panel's top edge lands (px), so the first
   *  row sits under the cursor rather than the panel's corner. */
  lead?: number;
}

export interface AnchorResult {
  x: number;
  y: number;
  side: AnchorSide;
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/** Place a panel of `size` inside `viewport`, beside `avoid`, near `point`. */
export function anchorPanel(input: AnchorInput): AnchorResult {
  const gap = input.gap ?? 12;
  const margin = input.margin ?? 8;
  const lead = input.lead ?? 28;
  const { w: pw, h: ph } = input.size;
  const { w: vw, h: vh } = input.viewport;
  const minX = margin;
  const maxX = vw - margin - pw;
  const minY = margin;
  const maxY = vh - margin - ph;
  const point = input.point ?? null;
  const avoid = input.avoid ?? null;

  const yNear = (fallback: number) => clamp(point ? point.y - lead : fallback, minY, maxY);
  const xNear = (fallback: number) => clamp(point ? point.x - lead : fallback, minX, maxX);

  if (avoid) {
    const right = avoid.x + avoid.w + gap;
    if (right + pw <= vw - margin) return { x: right, y: yNear(avoid.y), side: "right" };
    const left = avoid.x - gap - pw;
    if (left >= margin) return { x: left, y: yNear(avoid.y), side: "left" };
    const below = avoid.y + avoid.h + gap;
    if (below + ph <= vh - margin) return { x: xNear(avoid.x), y: below, side: "below" };
    const above = avoid.y - gap - ph;
    if (above >= margin) return { x: xNear(avoid.x), y: above, side: "above" };
    // Nowhere beside it fits (a selection filling the screen): fall through
    // to the pointer, clamped — covering part of the box beats being unreachable.
  }
  if (point) {
    const x = point.x + gap + pw <= vw - margin ? point.x + gap : clamp(point.x - gap - pw, minX, maxX);
    return { x, y: yNear(point.y), side: "pointer" };
  }
  return { x: clamp((vw - pw) / 2, minX, maxX), y: clamp((vh - ph) / 2, minY, maxY), side: "center" };
}

/** Re-clamp an already-placed panel after it changed size (a mode switch
 *  grew it): keep its origin unless the new size would leave the viewport. */
export function reclampPanel(
  at: Point,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 8,
): Point {
  return {
    x: clamp(at.x, margin, viewport.w - margin - size.w),
    y: clamp(at.y, margin, viewport.h - margin - size.h),
  };
}

/** Union of screen rects (the selection's DOM boxes). */
export function unionRects(rects: Rect[]): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) {
    if (!(r.w > 0 || r.h > 0)) continue;
    if (!out) out = { ...r };
    else {
      const x = Math.min(out.x, r.x);
      const y = Math.min(out.y, r.y);
      const x2 = Math.max(out.x + out.w, r.x + r.w);
      const y2 = Math.max(out.y + out.h, r.y + r.h);
      out = { x, y, w: x2 - x, h: y2 - y };
    }
  }
  return out;
}
