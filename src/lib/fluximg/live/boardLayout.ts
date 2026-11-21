/**
 * Where the live view's control board stands: the instruments that surround a live image on the canvas.
 *
 * The image is the middle of a small figure of its own. Depth stands at its side like a y axis, time lies under it
 * like an x axis, the channel console stands at its other side like a colour bar, and layers (when the image has
 * any) stand outermost. A wide, low image (a line-scan movie) takes its console and layers UNDER it instead, where
 * the room is. Everything is in the canvas host's pixels, never in the figure's: the board keeps its size at any zoom.
 *
 * The law, in order: (1) no instrument covers the image while there is room beside or under it; (2) every
 * instrument is wholly inside the canvas; (3) instruments on the same side keep their order and never overlap.
 * When the canvas has no room round the image (it fills the window), instruments stand over the image's own edges:
 * that is the only time rule 1 gives way.
 *
 * Pure (no DOM, no Svelte).
 */

export interface Box { x: number; y: number; w: number; h: number }
export type Side = "left" | "right";

export interface BoardNeeds {
  /** The canvas host, in its own px. */
  host: { w: number; h: number };
  /** The image's screen bounds in host px (rotation already applied: the axis-aligned box of what is drawn). */
  image: Box;
  /** A vertical rail (depth). */
  depth: boolean;
  /** How many horizontal rails (time, then any other dimension). */
  rows: number;
  /** The console (identity, channels, keys, map): its width and its height as measured. */
  console: { w: number; h: number };
  /** The layers card, when the image has layers: its width, and the height it would like. */
  layers: { w: number; h: number } | null;
  /** The "this step" card (only on a slide): its width and measured height. It stands in the console's column, under it. */
  step?: { w: number; h: number } | null;
}

export interface BoardLayout {
  /** What the instruments stand around: the visible part of the image, never smaller than a rail needs. */
  stage: Box;
  depth: (Box & { side: Side }) | null;
  rows: Box[];
  rowsAt: "below" | "above" | "over";
  /** `h` is the room it has (it scrolls inside when its content is taller). */
  console: Box & { side: Side | "below" };
  /** `under`: it stands under the console, in the console's column. `h` is the room it has. */
  layers: (Box & { side: Side | "below"; under: boolean }) | null;
  /** The "this step" card: directly under the console (beside it when the console stands under the image). Null off a slide. */
  step: (Box & { side: Side | "below" }) | null;
  /** True when the canvas had no room and something stands over the image. */
  over: boolean;
}

/** Sizes the board is built from (px). */
export const BOARD = {
  /** Canvas edge to the nearest instrument. */
  pad: 8,
  /** Image to instrument, and instrument to instrument. */
  gap: 10,
  /** A depth rail's width, and the least height it is useful at. */
  depthW: 94, depthMinH: 168,
  /** A horizontal rail's height, the gap between two, and the least width it is useful at. */
  rowH: 72, rowGap: 6, rowMinW: 300,
  /** The least height a layers card is useful at (a few rows). */
  layersMinH: 132,
  /** An image this many times wider than it is tall takes its console under it when there is room. */
  wide: 2.2,
} as const;

const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : v < lo ? lo : v > hi ? hi : v);

type Item = "depth" | "console" | "layers";
/** One way of standing the instruments. `left` / `right`: nearest the image first. */
interface Arrangement { left: Item[]; right: Item[]; stack?: boolean; below?: boolean }

function arrangements(depth: boolean, layers: boolean, wide: boolean): Arrangement[] {
  const d: Item[] = depth ? ["depth"] : [], l: Item[] = layers ? ["layers"] : [];
  // Depth at the left and the console at the right is the board's shape; the rest are what it gives up, in order,
  // as the canvas gets tight.
  const every: Arrangement[] = [
    { left: [...d, ...l], right: ["console"] },
    { left: [...d], right: ["console", ...l] },
    { left: [...d], right: ["console"], stack: true },
    { left: [...l], right: [...d, "console"] },
    { left: [], right: [...d, "console", ...l] },
    { left: [], right: [...d, "console"], stack: true },
    { left: [...d, "console", ...l], right: [] },
    { left: [...d, "console"], right: [], stack: true },
    { left: ["console", ...l], right: [...d] },
    { left: ["console"], right: [...d], stack: true },
  ];
  const sides = every.filter((a) => layers || !a.stack);
  const under: Arrangement[] = [{ left: [...d], right: [], below: true }, { left: [], right: [...d], below: true }];
  const all = wide ? [...under, ...sides] : [...sides, ...under];
  // The same arrangement may be listed twice when an instrument is absent.
  const seen = new Set<string>();
  return all.filter((a) => { const k = `${a.left.join(",")}|${a.right.join(",")}|${a.stack ? 1 : 0}${a.below ? 1 : 0}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function boardLayout(n: BoardNeeds): BoardLayout {
  const { pad, gap, depthW, depthMinH, rowH, rowGap, rowMinW, layersMinH } = BOARD;
  const ax = pad, ay = pad, aw = Math.max(0, n.host.w - 2 * pad), ah = Math.max(0, n.host.h - 2 * pad);
  const ar = ax + aw, ab = ay + ah;

  // The stage: the part of the image on screen, grown (from its top-left corner) to what the rails need.
  const ix0 = clamp(n.image.x, ax, ar), iy0 = clamp(n.image.y, ay, ab);
  const ix1 = clamp(n.image.x + n.image.w, ix0, ar), iy1 = clamp(n.image.y + n.image.h, iy0, ab);
  const minW = n.rows > 0 ? Math.min(rowMinW, aw) : 0, minH = n.depth ? Math.min(depthMinH, ah) : 0;
  let sw = Math.max(ix1 - ix0, minW), sh = Math.max(iy1 - iy0, minH);
  const sx = clamp(ix0, ax, ar - sw), sy = clamp(iy0, ay, ab - sh);
  sw = Math.min(sw, aw); sh = Math.min(sh, ah);
  const stage: Box = { x: sx, y: sy, w: sw, h: sh };
  const freeLeft = stage.x - ax, freeRight = ar - (stage.x + stage.w);

  // Rows: under the stage, else above it, else over its foot.
  const rowsH = n.rows > 0 ? n.rows * rowH + (n.rows - 1) * rowGap : 0;
  let rowsAt: BoardLayout["rowsAt"] = "below", rowsY = stage.y + stage.h + gap;
  if (n.rows > 0 && rowsY + rowsH > ab) {
    if (stage.y - gap - rowsH >= ay) { rowsAt = "above"; rowsY = stage.y - gap - rowsH; }
    else { rowsAt = "over"; rowsY = Math.max(ay, ab - rowsH); }
  }
  const rows: Box[] = Array.from({ length: n.rows }, (_, i) => ({ x: stage.x, y: rowsY + i * (rowH + rowGap), w: stage.w, h: rowH }));
  /** Where instruments standing under the image begin. */
  const underY = (n.rows > 0 && rowsAt === "below" ? rowsY + rowsH : stage.y + stage.h) + gap;

  const cw = n.console.w, ch = n.console.h, lw = n.layers?.w ?? 0, lh = n.layers?.h ?? 0;
  // The step card rides with the console (its column, or its row under the image): without one, nothing below changes.
  const cardW = n.step?.w ?? 0, cardH = n.step ? n.step.h + gap : 0, cardX = n.step ? cardW + gap : 0;
  const widthOf = (item: Item): number => (item === "depth" ? depthW : item === "console" ? cw : lw);
  const need = (items: Item[]): number => items.reduce((s, i) => s + widthOf(i) + gap, 0);
  /** How far an arrangement falls short of fitting, in px (0 = it fits). */
  const shortfall = (a: Arrangement): number => {
    let s = Math.max(0, need(a.left) - freeLeft) + Math.max(0, need(a.right) - freeRight);
    if (a.stack) s += Math.max(0, ch + gap + Math.min(lh, layersMinH) - ah);
    if (a.below) s += Math.max(0, underY + Math.max(ch, n.layers ? Math.min(lh, layersMinH) : 0) - ab) + Math.max(0, cw + cardX + (n.layers ? gap + lw : 0) - aw);
    return s;
  };
  const options = arrangements(n.depth, !!n.layers, stage.w >= BOARD.wide * stage.h);
  let chosen = options[0], least = Infinity;
  for (const a of options) {
    const s = shortfall(a);
    if (s <= 0.5) { chosen = a; least = 0; break; }
    if (s < least - 0.5) { least = s; chosen = a; }
  }
  const fits = least <= 0.5;

  // Stand each side's instruments outward from the stage; a side that overflows is pushed back inside the canvas
  // as a block (so its instruments keep their order and never overlap each other).
  const xs = new Map<Item, { x: number; side: Side }>();
  {
    let x = stage.x + stage.w + gap;
    const total = need(chosen.right);
    if (x + total - gap > ar) x = Math.max(ax, ar - (total - gap));
    for (const item of chosen.right) { xs.set(item, { x, side: "right" }); x += widthOf(item) + gap; }
  }
  {
    const total = need(chosen.left);
    let x = stage.x - gap;
    if (x - (total - gap) < ax) x = Math.min(ar, ax + (total - gap));
    for (const item of chosen.left) { x -= widthOf(item); xs.set(item, { x, side: "left" }); x -= gap; }
  }

  let consoleBox: BoardLayout["console"], layersBox: BoardLayout["layers"] = null, stepBox: BoardLayout["step"] = null;
  if (chosen.below) {
    // Side by side under the image, from its left edge, kept inside the canvas.
    const total = cw + cardX + (n.layers ? gap + lw : 0);
    const x = clamp(stage.x, ax, ar - total), y = Math.min(underY, Math.max(ay, ab - Math.min(ch, ah)));
    consoleBox = { x, y, w: cw, h: Math.max(0, Math.min(ch, ab - y)), side: "below" };
    if (n.step) stepBox = { x: x + cw + gap, y, w: cardW, h: Math.max(0, Math.min(n.step.h, ab - y)), side: "below" };
    if (n.layers) layersBox = { x: x + cw + cardX + gap, y, w: lw, h: Math.max(0, Math.min(lh, ab - y)), side: "below", under: false };
  } else {
    const at = xs.get("console")!;
    // A console with layers under it stands as one block: the layers card takes what is left below (it scrolls).
    // The step card stands between them; the console gives it room (the console scrolls inside).
    const block = chosen.stack ? Math.min(ah, ch + cardH + gap + lh) : Math.min(ch + cardH, ah);
    const y = clamp(stage.y, ay, ab - block);
    const consoleH = n.step ? Math.max(0, Math.min(ch, ah - cardH)) : Math.min(ch, ah);
    consoleBox = { x: at.x, y, w: cw, h: consoleH, side: at.side };
    // The edge nearest the image lines up with the console's.
    if (n.step) stepBox = { x: at.side === "left" ? at.x + cw - cardW : at.x, y: y + consoleH + gap, w: cardW, h: n.step.h, side: at.side };
    if (n.layers && chosen.stack) {
      const ly = y + consoleH + cardH + gap;
      // The edge nearest the image lines up with the console's.
      layersBox = { x: at.side === "left" ? at.x + cw - lw : at.x, y: ly, w: lw, h: Math.max(0, Math.min(lh, ab - ly)), side: at.side, under: true };
    } else if (n.layers) {
      const la = xs.get("layers")!, h = Math.min(lh, ah);
      layersBox = { x: la.x, y: clamp(stage.y, ay, ab - h), w: lw, h, side: la.side, under: false };
    }
  }
  const depthAt = n.depth ? xs.get("depth")! : null;
  const depth = depthAt ? { x: depthAt.x, y: stage.y, w: depthW, h: stage.h, side: depthAt.side } : null;

  // Rows that stand over the image must not run under a side instrument that stands there too.
  const over = !fits || rowsAt === "over";
  if (over && rows.length) {
    let x0 = stage.x, x1 = stage.x + stage.w;
    for (const b of [consoleBox, layersBox, stepBox, depth]) {
      if (!b || b.side === "below") continue;
      const meets = rows.some((r) => r.y < b.y + b.h && r.y + r.h > b.y);
      if (!meets) continue;
      if (b.side === "right" && b.x < x1) x1 = Math.min(x1, b.x - gap);
      if (b.side === "left" && b.x + b.w > x0) x0 = Math.max(x0, b.x + b.w + gap);
    }
    if (x1 - x0 >= 120) for (const r of rows) { r.x = x0; r.w = x1 - x0; }
  }

  return { stage, depth, rows, rowsAt, console: consoleBox, layers: layersBox, step: stepBox, over };
}
