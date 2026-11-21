/**
 * Where the panels an image gives rise to are put: its channel panels (Split channels) and its blow-outs (an
 * inset). Pure (no DOM, no Svelte, no project).
 *
 * A figure clips what lies outside it, so a panel put past the figure's edge is a panel nobody can see. The law:
 * a new panel goes BESIDE its image when the figure has the room, and otherwise stays inside the image's own
 * footprint. Nothing else on the figure moves and the figure never changes size.
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

export interface SplitLayout {
  /** `beside`: the image stays as it is and its channels stand to its right. `inPlace`: image and channels share the image's box. */
  place: "beside" | "inPlace";
  /** The image's own box afterwards (unchanged when `beside`). */
  source: PanelBox;
  /** One box per channel, in channel order. */
  channels: PanelBox[];
}

/**
 * Split channels. With room in the figure the `n` channel panels stand to the image's right, each the image's
 * size. Without it, the image and its channels share the image's own box as a grid (the image first).
 */
export function splitLayout(figure: FigureSize, src: PanelBox, n: number, gap = 6): SplitLayout {
  const beside = Array.from({ length: n }, (_, i) => ({ x: src.x + (i + 1) * (src.width + gap), y: src.y, width: src.width, height: src.height }));
  if (n > 0 && beside.every((b) => inside(figure, b))) return { place: "beside", source: { ...src }, channels: beside };
  const cells = gridCells(src, n + 1, src.width / src.height, gap);
  if (cells.length !== n + 1) return { place: "beside", source: { ...src }, channels: beside };
  return { place: "inPlace", source: cells[0], channels: cells.slice(1) };
}

export interface InsetLayout { place: "right" | "below" | "inside"; box: PanelBox }

/**
 * A blow-out of aspect `aspect` (width / height). Beside its image at the image's height when the figure has the
 * room (to the right, else below); otherwise inside the image's top-right corner at two fifths of its height (and
 * never more than half its width), which is what an inset classically is.
 */
export function insetLayout(figure: FigureSize, src: PanelBox, aspect: number, gap = 8): InsetLayout {
  const a = aspect > 0 ? aspect : 1;
  const right = { x: src.x + src.width + gap, y: src.y, width: src.height * a, height: src.height };
  if (inside(figure, right)) return { place: "right", box: right };
  const bw = Math.min(src.width, src.height * a);
  const below = { x: src.x, y: src.y + src.height + gap, width: bw, height: bw / a };
  if (inside(figure, below)) return { place: "below", box: below };
  let h = src.height * 0.4, w = h * a;
  if (w > src.width * 0.5) { w = src.width * 0.5; h = w / a; }
  const m = Math.min(8, src.width * 0.02);
  return { place: "inside", box: { x: src.x + src.width - w - m, y: src.y + m, width: w, height: h } };
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
