/**
 * Where the panels an image gives rise to are put: its channel panels (Split channels) and its blow-outs (an
 * inset). Pure (no DOM, no Svelte, no project).
 *
 * A figure clips what lies outside it, so a panel put past the figure's edge is a panel nobody can see; and a panel
 * put on another is a panel nobody can see either (an inset pulled out after a split once landed exactly on the first
 * channel panel). The law: a new panel goes where NOTHING else is (every other element of the figure is occupied,
 * the image's own panels among them): beside its image, else below it, else beside or below the image's panels, else
 * wherever the figure has room (nearest the image); only when the figure has no free place of its size does it stay
 * inside the image's own footprint. Nothing else on the figure moves and the figure never changes size.
 */

export interface PanelBox { x: number; y: number; width: number; height: number }
export interface FigureSize { width: number; height: number }

const EPS = 0.5;
const inside = (f: FigureSize, b: PanelBox): boolean => b.x >= -EPS && b.y >= -EPS && b.x + b.width <= f.width + EPS && b.y + b.height <= f.height + EPS;

/**
 * `count` equal cells of aspect `aspect` (width / height) laid in reading order inside `box`, as large as they
 * can be: the column count is the one that gives the largest cell.
 */
export function gridCells(box: PanelBox, count: number, aspect: number, gap: number): PanelBox[] {
  if (!(count > 0) || !(aspect > 0) || !(box.width > 0) || !(box.height > 0)) return [];
  let best = { cols: 1, width: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const width = Math.min((box.width - (cols - 1) * gap) / cols, aspect * ((box.height - (rows - 1) * gap) / rows));
    if (width > best.width + 1e-9) best = { cols, width };
  }
  if (!(best.width > 0)) return [];
  const w = best.width, h = w / aspect;
  return Array.from({ length: count }, (_, i) => ({ x: box.x + (i % best.cols) * (w + gap), y: box.y + Math.floor(i / best.cols) * (h + gap), width: w, height: h }));
}

/**
 * Where a new box of size `w` x `h` can stand on the figure without covering anything (`occupied`: every other element
 * of the figure, the image and its panels included), nearest first: beside the image (right, then below), then beside
 * the image's family (right of its outermost panel at the image's height, then below the family at the image's left),
 * then the free place nearest the image anywhere on the figure. Null when the figure has no free place that size.
 * `past`: it stands beyond the image's own panels.
 */
function freePlace(figure: FigureSize, src: PanelBox, family: readonly PanelBox[], occupied: readonly PanelBox[], w: number, h: number, gap: number, sweep = true):
  { at: "right" | "below" | "free"; past: boolean; x: number; y: number } | null {
  // The image itself is always occupied (a caller that names nothing else still never covers it).
  const occ = [src, ...occupied];
  const free = (x: number, y: number): boolean => {
    const b = { x, y, width: w, height: h };
    return inside(figure, b) && !occ.some((o) => overlaps(b, o, 1e-6));
  };
  const right = Math.max(src.x + src.width, ...family.map((f) => f.x + f.width)), bottom = Math.max(src.y + src.height, ...family.map((f) => f.y + f.height));
  const tries: Array<{ at: "right" | "below"; past: boolean; x: number; y: number }> = [
    { at: "right", past: false, x: src.x + src.width + gap, y: src.y },
    { at: "below", past: false, x: src.x, y: src.y + src.height + gap },
    { at: "right", past: true, x: right + gap, y: src.y },
    { at: "below", past: true, x: src.x, y: bottom + gap },
  ];
  for (const t of tries) if (free(t.x, t.y)) return t;
  if (!sweep) return null;
  // Anywhere the figure has room, the place nearest the image (a coarse sweep, then the edges of what is there).
  const xs = new Set<number>(), ys = new Set<number>();
  const step = Math.max(4, Math.min(w, h) / 4);
  for (let x = 0; x + w <= figure.width + EPS; x += step) xs.add(x);
  for (let y = 0; y + h <= figure.height + EPS; y += step) ys.add(y);
  xs.add(Math.max(0, figure.width - w)); ys.add(Math.max(0, figure.height - h));
  // Beside each thing that is there, a gap away first and, where only that fits, touching it.
  for (const o of occ) for (const g of [gap, 0]) { xs.add(o.x + o.width + g); xs.add(o.x - g - w); ys.add(o.y + o.height + g); ys.add(o.y - g - h); }
  const cx = src.x + src.width / 2, cy = src.y + src.height / 2;
  let best: { x: number; y: number; d: number } | null = null;
  for (const x of xs) for (const y of ys) {
    const d = Math.hypot(x + w / 2 - cx, y + h / 2 - cy);
    if (best && d >= best.d) continue;
    if (free(x, y)) best = { x, y, d };
  }
  return best ? { at: "free", past: true, x: best.x, y: best.y } : null;
}
const overlaps = (a: PanelBox, b: PanelBox, eps: number): boolean => a.x < b.x + b.width - eps && b.x < a.x + a.width - eps && a.y < b.y + b.height - eps && b.y < a.y + a.height - eps;

export interface SplitLayout {
  /** `beside`: the image stays as it is and its channels stand in a row to its right; `below`: the row stands under it
   *  (or under its panels); `free`: where the figure had room; `inPlace`: image and channels share the image's box. */
  place: "beside" | "below" | "free" | "inPlace";
  /** The row stands beyond the image's own panels (its family: an inset, an earlier split). */
  past: boolean;
  /** The image's own box afterwards (unchanged unless `inPlace`). */
  source: PanelBox;
  /** One box per channel, in channel order. */
  channels: PanelBox[];
}

/**
 * Split channels. The `n` channel panels, each the image's size, stand in a row where nothing else is (`occupied`:
 * the figure's other elements, the image's panels among them; `family`: the image's panels): beside the image, else
 * below it, else beside or below its panels, else wherever the figure has room. Without room, the image and its
 * channels share the image's own box as a grid (the image first).
 */
export function splitLayout(figure: FigureSize, src: PanelBox, n: number, gap = 6, occupied: readonly PanelBox[] = [], family: readonly PanelBox[] = []): SplitLayout {
  const rowW = n * src.width + (n - 1) * gap;
  const at = n > 0 ? freePlace(figure, src, family, occupied, rowW, src.height, gap) : null;
  if (at) return { place: at.at === "right" ? "beside" : at.at, past: at.past, source: { ...src }, channels: Array.from({ length: n }, (_, i) => ({ x: at.x + i * (src.width + gap), y: at.y, width: src.width, height: src.height })) };
  const cells = gridCells(src, n + 1, src.width / src.height, gap);
  const beside = Array.from({ length: n }, (_, i) => ({ x: src.x + (i + 1) * (src.width + gap), y: src.y, width: src.width, height: src.height }));
  if (cells.length !== n + 1) return { place: "beside", past: false, source: { ...src }, channels: beside };
  return { place: "inPlace", past: false, source: cells[0], channels: cells.slice(1) };
}

export interface InsetLayout { place: "right" | "below" | "free" | "inside"; past: boolean; box: PanelBox }

/**
 * A blow-out of aspect `aspect` (width / height), at the image's height (no wider than the image when below), where
 * nothing else is (see `splitLayout`): beside the image, below it, beside or below its panels, or wherever the figure
 * has room. Otherwise inside the image's top-right corner at two fifths of its height (and never more than half its
 * width), which is what an inset classically is.
 */
export function insetLayout(figure: FigureSize, src: PanelBox, aspect: number, gap = 8, occupied: readonly PanelBox[] = [], family: readonly PanelBox[] = []): InsetLayout {
  const a = aspect > 0 ? aspect : 1;
  // Its size: the image's height, unless only a narrower one fits below (then no wider than the image).
  // Near the image first at either size, then anywhere the figure has room.
  for (const sweep of [false, true]) for (const [w, hgt] of [[src.height * a, src.height], [Math.min(src.width, src.height * a), Math.min(src.width, src.height * a) / a]] as const) {
    const at = freePlace(figure, src, family, occupied, w, hgt, gap, sweep);
    if (at) return { place: at.at, past: at.past, box: { x: at.x, y: at.y, width: w, height: hgt } };
  }
  let h = src.height * 0.4, w = h * a;
  if (w > src.width * 0.5) { w = src.width * 0.5; h = w / a; }
  const m = Math.min(8, src.width * 0.02);
  return { place: "inside", past: false, box: { x: src.x + src.width - w - m, y: src.y + m, width: w, height: h } };
}

/** What a new panel of this image must not cover: every other shown element of its figure, as boxes (and its family's). */
export function occupiedOf<T extends FamilyElement>(elements: readonly T[], el: T): { occupied: PanelBox[]; family: PanelBox[] } {
  return { occupied: elements.filter((e) => !e.hidden).map(boundsOf), family: familyOf(elements, el).map(boundsOf) };
}

/** What `familyOf` reads of an element (any figure element will do). */
export interface FamilyElement {
  id: string; type: string; assetId?: string; x: number; y: number; width: number; height: number; rotation?: number; hidden?: boolean;
  view?: { link?: string; insetOf?: string } | null;
}

/**
 * The panels an image has given rise to, which its live view keeps in view (`live/boardLayout.ts`, the KEPT boxes):
 * the other elements of the same image that share its `view.link` (the channel panels of a split and their composite;
 * a blow-out and its parent), and its insets (`view.insetOf` = it). Hidden ones are not on screen and are left out.
 * `elements` are one figure's (a slide's) elements: panels never span figures.
 */
export function familyOf<T extends FamilyElement>(elements: readonly T[], el: T): T[] {
  const link = el.view?.link;
  return elements.filter((e) => e.id !== el.id && e.type === el.type && !e.hidden && e.assetId === el.assetId
    && ((!!link && e.view?.link === link) || e.view?.insetOf === el.id));
}

/** The axis-aligned box an element covers on its figure (rotation about its centre included). */
export function boundsOf(e: { x: number; y: number; width: number; height: number; rotation?: number }): PanelBox {
  const r = ((e.rotation ?? 0) * Math.PI) / 180;
  if (!r) return { x: e.x, y: e.y, width: e.width, height: e.height };
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r)), w = e.width * c + e.height * s, h = e.width * s + e.height * c;
  return { x: e.x + e.width / 2 - w / 2, y: e.y + e.height / 2 - h / 2, width: w, height: h };
}
