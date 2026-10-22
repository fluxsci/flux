// Justified-row layout for the Plots rail (pure; gate: scripts/verify-plots-rail-layout.ts).
//
// A narrow rail wastes most of a square cell on a 4:1 panel strip or a 1:2 portrait, and
// masonry breaks reading order (fig1_a, fig1_b, …) and 2-D keyboard movement. Justified rows
// keep order and true aspect: each row holds the run of items whose scaled height lands nearest
// the target row height, then scales to fill the width exactly. Rows may shrink as well as grow
// — v1's greedy "fill, then stretch" put ONE 4:3 tile per row at 320 px, because two never fit
// under the target height.
//
// Sections (folders, dissection groups) always start a new row and carry a header. The last row
// of a section is never stretched past LAST_ROW_STRETCH × the target height (it stays ragged,
// left-aligned, instead of blowing up two leftovers to full width).

export interface JustifySectionIn {
  key: string;
  /** Header height in px (0 = no header). */
  headerH: number;
  /** Width / height per item; non-finite or ≤ 0 → `defaultAspect`. */
  aspects: number[];
  /** Per item: > 0 makes it a full-width BLOCK of that height on its own row, without a
   *  caption strip (a table card, a "Show all" row). */
  blocks?: number[];
}

export interface JustifyOpts {
  width: number;
  /** Target image height (the zoom). */
  rowHeight: number;
  /** Horizontal and vertical gap between tiles. */
  gap: number;
  /** Caption strip below each tile (0 = none). */
  captionH: number;
  /** Space above the first section and between sections. */
  padTop?: number;
  sectionGap?: number;
  /** Aspect clamp for LAYOUT only (the image keeps its true aspect inside its tile). */
  minAspect?: number;
  maxAspect?: number;
  defaultAspect?: number;
  /** A row never gets shorter than this. */
  minRowH?: number;
  /** A row never gets taller than rowHeight × this (1.5: a lone 4:3 plot fills a 220 px rail). */
  maxStretch?: number;
}

export interface PlacedItem {
  /** Flat index across all sections, in order. */
  index: number;
  x: number;
  w: number;
}
export interface LaidRow {
  /** Top of the image box. */
  y: number;
  /** Image box height (the caption strip follows). */
  h: number;
  /** Caption strip height below the box (0 for a block row). */
  cap: number;
  section: number;
  items: PlacedItem[];
  block: boolean;
}
export interface LaidSection {
  key: string;
  /** Top of the header. */
  y: number;
  headerH: number;
  firstRow: number;
  /** Exclusive. */
  endRow: number;
  itemStart: number;
  itemCount: number;
  /** Bottom of the section's last row (incl. caption). */
  bottom: number;
}
export interface JustifyLayout {
  rows: LaidRow[];
  sections: LaidSection[];
  height: number;
  /** Row of each flat item index. */
  itemRow: Int32Array;
}

export const LAST_ROW_STRETCH = 1.15;

export function layoutJustified(sections: JustifySectionIn[], o: JustifyOpts): JustifyLayout {
  const W = Math.max(1, o.width);
  const h = Math.max(8, o.rowHeight);
  const g = Math.max(0, o.gap);
  const capH = Math.max(0, o.captionH);
  const minA = o.minAspect ?? 0.33;
  const maxA = o.maxAspect ?? 6;
  const defA = o.defaultAspect ?? 4 / 3;
  const minRowH = o.minRowH ?? 40;
  const maxH = h * (o.maxStretch ?? 1.5);
  const sectionGap = o.sectionGap ?? 0;
  const rows: LaidRow[] = [];
  const out: LaidSection[] = [];
  let total = 0;
  for (const s of sections) total += s.aspects.length;
  const itemRow = new Int32Array(total);
  let y = o.padTop ?? 0;
  let flat = 0;
  const aspectOf = (a: number) => (Number.isFinite(a) && a > 0 ? Math.min(maxA, Math.max(minA, a)) : defA);

  sections.forEach((s, si) => {
    if (si > 0) y += sectionGap;
    const sec: LaidSection = { key: s.key, y, headerH: s.headerH, firstRow: rows.length, endRow: rows.length, itemStart: flat, itemCount: s.aspects.length, bottom: y + s.headerH };
    y += s.headerH;
    const a = s.aspects.map(aspectOf);
    const blocks = s.blocks ?? [];
    const n = a.length;
    // Where each run of ordinary items ends (the next block, or the section's end) — one pass.
    const nextBlock = new Int32Array(n + 1);
    nextBlock[n] = n;
    for (let k = n - 1; k >= 0; k--) nextBlock[k] = (blocks[k] ?? 0) > 0 ? k : nextBlock[k + 1];
    let i = 0;
    while (i < n) {
      if ((blocks[i] ?? 0) > 0) {
        const bh = blocks[i];
        itemRow[flat + i] = rows.length;
        rows.push({ y, h: bh, cap: 0, section: si, items: [{ index: flat + i, x: 0, w: W }], block: true });
        y += bh + g;
        i++;
        continue;
      }
      // A run of ordinary items stops before the next block.
      const runEnd = nextBlock[i];
      let sum = 0;
      let take = 0;
      let rowH = h;
      let filled = false;
      for (let j = i; j < runEnd; j++) {
        sum += a[j];
        const k = j - i + 1;
        const hk = (W - (k - 1) * g) / sum;
        if (hk <= h) {
          // Enough items: this row ends at k or k-1 — whichever lands nearer the target
          // (in ratio terms, so shrinking and growing count alike).
          const hPrev = k > 1 ? (W - (k - 2) * g) / (sum - a[j]) : Infinity;
          if (k > 1 && Math.abs(Math.log(hPrev / h)) <= Math.abs(Math.log(hk / h))) { take = k - 1; rowH = hPrev; }
          else { take = k; rowH = hk; }
          filled = true;
          break;
        }
      }
      if (!filled) {
        // The run's last row: fill the width only if that barely stretches it.
        take = runEnd - i;
        const hk = (W - (take - 1) * g) / sum;
        rowH = hk <= h * LAST_ROW_STRETCH ? hk : h;
        filled = hk <= h * LAST_ROW_STRETCH;
      }
      let exact = filled;
      if (rowH > maxH) { rowH = maxH; exact = false; }
      if (rowH < minRowH) { rowH = minRowH; exact = false; }
      const items: PlacedItem[] = [];
      let x = 0;
      for (let k = 0; k < take; k++) {
        const isLast = k === take - 1;
        let w = a[i + k] * rowH;
        // The filled row's last tile absorbs float rounding so the row ends exactly at W.
        if (exact && isLast) w = W - x;
        if (!exact) w = Math.min(w, W - x);
        items.push({ index: flat + i + k, x, w });
        itemRow[flat + i + k] = rows.length;
        x += w + g;
      }
      rows.push({ y, h: rowH, cap: capH, section: si, items, block: false });
      y += rowH + capH + g;
      i += take;
    }
    if (n) y -= g; // no trailing gap after a section's last row
    sec.endRow = rows.length;
    sec.bottom = y;
    out.push(sec);
    flat += n;
  });
  return { rows, sections: out, height: y, itemRow };
}

/** Index of the first row whose box reaches below `top` (binary search). */
export function firstRowAt(layout: JustifyLayout, top: number): number {
  let lo = 0, hi = layout.rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = layout.rows[mid];
    if (r.y + r.h + r.cap < top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The section whose span contains `top` (for the stuck header). */
export function sectionAt(layout: JustifyLayout, top: number): number {
  let lo = 0, hi = layout.sections.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (layout.sections[mid].y <= top) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Keyboard movement in justified rows: left/right in flat order; up/down to the item in the
 *  neighbouring row whose centre is nearest this one's (crossing section boundaries). */
export function moveIndex(layout: JustifyLayout, index: number, dir: "left" | "right" | "up" | "down"): number {
  const total = layout.itemRow.length;
  if (!total) return -1;
  if (index < 0 || index >= total) return 0;
  if (dir === "left") return Math.max(0, index - 1);
  if (dir === "right") return Math.min(total - 1, index + 1);
  const r = layout.itemRow[index];
  const target = dir === "up" ? r - 1 : r + 1;
  if (target < 0 || target >= layout.rows.length) return index;
  const from = layout.rows[r].items.find((it) => it.index === index)!;
  const cx = from.x + from.w / 2;
  let best = layout.rows[target].items[0];
  for (const it of layout.rows[target].items)
    if (Math.abs(it.x + it.w / 2 - cx) < Math.abs(best.x + best.w / 2 - cx)) best = it;
  return best.index;
}
