/**
 * Where the live view's control board stands: the instruments that surround a live image on the canvas.
 *
 * The image is the middle of a small figure of its own. Depth stands at its side like a y axis, time lies under it
 * like an x axis, the channel console stands at its other side like a colour bar, and layers (when the image has
 * any) stand outermost. A wide, low image (a line-scan movie) takes its console and layers UNDER it instead, where
 * the room is. Everything is in the canvas host's pixels, never in the figure's: the board keeps its size at any zoom.
 *
 * The image also has panels of its own that the board keeps in view: the KEPT boxes. They are what the image has
 * given rise to: the linked channel panels of a split (the elements of the same image sharing its `view.link`: so a
 * board opened on one of the panels keeps its siblings and the composite) and the insets pulled out of it
 * (`view.insetOf` = this image). The instruments stand round the image AND them, as they stand round the picture.
 *
 * The law, in order: (1) every instrument is wholly inside the canvas, and every one asked for is given a place
 * (none is squeezed out of sight); (2) no instrument covers the picture or a kept panel, and none covers another,
 * while any arrangement allows it; (3) instruments on the same side keep their order. When no arrangement keeps
 * everything clear, things give way in a pinned order:
 *   a. the instruments rearrange (sides swap, layers go under the console, the step card stands beside the console
 *      instead of under it, a wide image takes the console under it) with every instrument at its full height;
 *   b. then they compact: the console gives up height down to `BOARD.consoleMinH` (it scrolls inside; its keys stay
 *      at its foot) to let the step card or the layers card stand with it;
 *   c. then a kept panel is covered (the least of it), only after every arrangement has been tried;
 *   d. the picture itself is covered last: the canvas has no room round it (it fills the window), so instruments stand
 *      over its edges.
 * The canvas view helps before any of that is needed: `boardFit` is the smallest pan (and, only if a pan is not
 * enough, zoom out) that lets the board stand clear; the board asks for it when it opens and after it made new panels.
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
  /** The "this step" card (only on a slide): its width and measured height. It stands in the console's column, under it, or beside the console. */
  step?: { w: number; h: number } | null;
  /** The image's own panels the board keeps in view (host px): its linked channel panels and its insets. */
  kept?: readonly Box[];
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
  /** The "this step" card: under the console, or beside it (`beside`), or beside it when the console stands under the image. Null off a slide. */
  step: (Box & { side: Side | "below"; beside: boolean }) | null;
  /** True when the canvas had no room: something stands over the image (or, with no room at all, over another instrument). */
  over: boolean;
  /** What, if anything, an instrument covers: nothing, a kept panel (give-way c), or the picture (give-way d). */
  covers: "none" | "kept" | "image";
  /** True when every instrument stands at its full height (give-way b was not needed). */
  whole: boolean;
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
  /** The least height the console compacts to (its head, a channel strip and its keys, scrolling inside). */
  consoleMinH: 176,
  /** An instrument shorter than this (or its own height, if less) is out of sight: never chosen while another way exists. */
  lostH: 40,
  /** An image this many times wider than it is tall takes its console under it when there is room. */
  wide: 2.2,
} as const;

const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : v < lo ? lo : v > hi ? hi : v);
/** Does the box x, y, w, h meet `b` (by more than half a px)? */
const meetsAt = (x: number, y: number, w: number, h: number, b: Box): boolean => x < b.x + b.w - 0.5 && b.x < x + w - 0.5 && y < b.y + b.h - 0.5 && b.y < y + h - 0.5;
const firstMet = (x: number, y: number, w: number, h: number, boxes: readonly Box[]): Box | null => { for (const b of boxes) if (meetsAt(x, y, w, h, b)) return b; return null; };
const meets = (a: Box, b: Box): boolean => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const area = (a: Box, b: Box): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

type Item = "depth" | "console" | "layers" | "step";
/** One way of standing the instruments. `left` / `right`: nearest the image first. */
interface Arrangement { left: Item[]; right: Item[]; stack?: boolean; below?: boolean; beside?: Arrangement }
const besideOf = (items: Item[]): Item[] => items.flatMap((i) => (i === "console" ? ["console", "step"] as Item[] : [i]));

const arrangementsSeen = new Map<number, Arrangement[]>();
/** The arrangements for this set of instruments (16 sets at most: each list is built once and kept). */
function arrangements(depth: boolean, layers: boolean, wide: boolean, step: boolean): Arrangement[] {
  const key = (depth ? 1 : 0) | (layers ? 2 : 0) | (wide ? 4 : 0) | (step ? 8 : 0);
  let out = arrangementsSeen.get(key);
  if (!out) { out = buildArrangements(depth, layers, wide, step); arrangementsSeen.set(key, out); }
  return out;
}
function buildArrangements(depth: boolean, layers: boolean, wide: boolean, step: boolean): Arrangement[] {
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
  // On a slide the step card rides under the console; where that squeezes the console it stands beside it instead
  // (the same arrangement, the card one column further out: `solve` stands it right after its own).
  if (step) for (const a of sides) a.beside = { ...a, left: besideOf(a.left), right: besideOf(a.right) };
  const under: Arrangement[] = [{ left: [...d], right: [], below: true }, { left: [], right: [...d], below: true }];
  const all = wide ? [...under, ...sides] : [...sides, ...under];
  // The same arrangement may be listed twice when an instrument is absent.
  const seen = new Set<string>();
  return all.filter((a) => { const k = `${a.left.join(",")}|${a.right.join(",")}|${a.stack ? 1 : 0}${a.below ? 1 : 0}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** One arrangement, stood on the canvas, and what it costs. */
interface Placed {
  layout: Omit<BoardLayout, "covers" | "whole">;
  /** An instrument outside the canvas, or squeezed out of sight. */
  lost: boolean;
  /** Instruments over each other, over kept panels, over the picture (px²). */
  pile: number; kept: number; image: number;
  /** Every instrument at its full height (none compacted below what the canvas itself forces). */
  whole: boolean;
  /** Compacted below the least useful height (px short). */
  short: number;
}

/**
 * Everything the board can do with this canvas: the stage, the rails' place, and each arrangement stood on it (twice
 * when there are kept panels: stepping past them, and packed against the image as before them).
 * `room` is the height the console must fit (the canvas's own; the fit asks with a virtual canvas but the real height).
 */
function solve(n: BoardNeeds, room?: { x: number; y: number; w: number; h: number }, stopAtBest = false): { stage: Box; placed: Placed[] } {
  const { pad, gap, depthW, depthMinH, rowH, rowGap, rowMinW, layersMinH, consoleMinH, lostH } = BOARD;
  const A = room ?? { x: pad, y: pad, w: Math.max(0, n.host.w - 2 * pad), h: Math.max(0, n.host.h - 2 * pad) };
  const ax = A.x, ay = A.y, aw = A.w, ah = A.h;
  const ar = ax + aw, ab = ay + ah;
  const fitH = Math.min(ah, Math.max(0, n.host.h - 2 * pad));
  const kept = (n.kept ?? []).filter((k) => k.w > 0 && k.h > 0);

  // The stage: the part of the image on screen, grown (from its top-left corner) to what the rails need.
  const ix0 = clamp(n.image.x, ax, ar), iy0 = clamp(n.image.y, ay, ab);
  const ix1 = clamp(n.image.x + n.image.w, ix0, ar), iy1 = clamp(n.image.y + n.image.h, iy0, ab);
  const minW = n.rows > 0 ? Math.min(rowMinW, aw) : 0, minH = n.depth ? Math.min(depthMinH, ah) : 0;
  let sw = Math.max(ix1 - ix0, minW), sh = Math.max(iy1 - iy0, minH);
  const sx = clamp(ix0, ax, ar - sw), sy = clamp(iy0, ay, ab - sh);
  sw = Math.min(sw, aw); sh = Math.min(sh, ah);
  const stage: Box = { x: sx, y: sy, w: sw, h: sh };

  // Rows: under the stage, else above it (each where they meet no kept panel first), else over its foot.
  const rowsH = n.rows > 0 ? n.rows * rowH + (n.rows - 1) * rowGap : 0;
  const belowY = stage.y + stage.h + gap, aboveY = stage.y - gap - rowsH;
  const fitsBelow = belowY + rowsH <= ab, fitsAbove = aboveY >= ay;
  const clear = (y: number): boolean => !firstMet(stage.x, y, stage.w, rowsH, kept);
  let rowsAt: BoardLayout["rowsAt"] = "below", rowsY = belowY;
  if (n.rows > 0) {
    if (fitsBelow && clear(belowY)) { /* below */ }
    else if (fitsAbove && clear(aboveY)) { rowsAt = "above"; rowsY = aboveY; }
    else if (fitsBelow) { /* below, over a kept panel */ }
    else if (fitsAbove) { rowsAt = "above"; rowsY = aboveY; }
    else { rowsAt = "over"; rowsY = Math.max(ay, ab - rowsH); }
  }
  // Every arrangement shares the rows (they stand by the image, not by the arrangement); only rows lying over the image are
  // narrowed per arrangement, on a copy.
  const baseRows: Box[] = [];
  for (let i = 0; i < n.rows; i++) baseRows.push({ x: stage.x, y: rowsY + i * (rowH + rowGap), w: stage.w, h: rowH });
  /** Where instruments standing under the image begin. */
  const underY = (n.rows > 0 && rowsAt === "below" ? rowsY + rowsH : stage.y + stage.h) + gap;

  const cw = n.console.w, ch = n.console.h, lw = n.layers?.w ?? 0, lh = n.layers?.h ?? 0;
  const sW = n.step?.w ?? 0, sH = n.step?.h ?? 0;
  const widthOf = (item: Item): number => (item === "depth" ? depthW : item === "console" ? cw : item === "step" ? sW : lw);
  const options = arrangements(n.depth, !!n.layers, stage.w >= BOARD.wide * stage.h, !!n.step);
  const placed: Placed[] = [];

  const standOne = (a: Arrangement, avoid: boolean): { p: Placed; stepped: boolean } => {
    let stepped = false;
    const stepBeside = a.left.includes("step") || a.right.includes("step");
    const cardH = n.step && !stepBeside ? sH + gap : 0;
    let consoleBox: BoardLayout["console"], layersBox: BoardLayout["layers"] = null, stepBox: BoardLayout["step"] = null;
    let depth: BoardLayout["depth"] = null;

    if (a.below) {
      // Side by side under the image, from its left edge, past any kept panel there, kept inside the canvas.
      const total = cw + (n.step ? gap + sW : 0) + (n.layers ? gap + lw : 0);
      const tall = Math.min(Math.max(ch, n.step ? sH : 0, n.layers ? Math.min(lh, layersMinH) : 0), ah);
      const x = clamp(stage.x, ax, ar - total);
      let y = underY;
      if (avoid) for (let g = 0; g <= kept.length; g++) { const hit = firstMet(x, y, total, tall, kept); if (!hit) break; y = hit.y + hit.h + gap; stepped = true; }
      y = Math.min(y, Math.max(ay, ab - Math.min(ch, ah)));
      consoleBox = { x, y, w: cw, h: Math.max(0, Math.min(ch, ab - y)), side: "below" };
      if (n.step) stepBox = { x: x + cw + gap, y, w: sW, h: Math.max(0, Math.min(sH, ab - y)), side: "below", beside: true };
      if (n.layers) layersBox = { x: x + cw + (n.step ? gap + sW : 0) + gap, y, w: lw, h: Math.max(0, Math.min(lh, ab - y)), side: "below", under: false };
      const d = a.left.includes("depth") ? "left" : a.right.includes("depth") ? "right" : null;
      if (d) {
        // Beside the image, past any kept panel there (else packed against the image, inside the canvas).
        let dx = d === "left" ? stage.x - gap - depthW : stage.x + stage.w + gap;
        if (avoid) for (let g = 0; g <= kept.length; g++) {
          const hit = firstMet(dx, stage.y, depthW, stage.h, kept);
          if (!hit) break;
          dx = d === "left" ? hit.x - gap - depthW : hit.x + hit.w + gap;
          stepped = true;
        }
        if (dx < ax - 0.5 || dx + depthW > ar + 0.5) dx = d === "left" ? Math.max(ax, stage.x - gap - depthW) : Math.min(ar - depthW, stage.x + stage.w + gap);
        depth = { x: dx, y: stage.y, w: depthW, h: stage.h, side: d };
      }
    } else {
      // The heights first (they do not depend on the side), then each side outward from the stage.
      const consoleH = cardH ? Math.max(0, Math.min(ch, fitH - cardH)) : Math.min(ch, fitH);
      const block = a.stack ? Math.min(ah, consoleH + cardH + gap + lh) : consoleH + cardH;
      const cy = clamp(stage.y, ay, ab - block);
      // Each instrument's height and top (no closures here: this runs for every arrangement).
      const lH = Math.min(lh, ah);
      const V: Record<Item, readonly [number, number]> = {
        depth: [stage.y, stage.h], console: [cy, block], step: [clamp(cy, ay, ab - sH), sH], layers: [clamp(stage.y, ay, ab - lH), lH],
      };
      const xs: Partial<Record<Item, { x: number; side: Side }>> = {};
      const at: Partial<Record<Item, number>> = {};
      for (let sd = 0; sd < 2; sd++) {
        const right = sd === 0, items = right ? a.right : a.left;
        if (!items.length) continue;
        // Pass 0 steps past a kept panel an instrument would stand on (the next free stretch further out); a side that
        // then overflows the canvas is stood again packed (pass 1) and pushed back inside as a block, so its
        // instruments keep their order and never overlap each other.
        for (let pass = avoid ? 0 : 1; pass < 2; pass++) {
          let edge = right ? stage.x + stage.w + gap : stage.x - gap, lo = Infinity, hi = -Infinity, moved = false;
          for (const item of items) {
            const w = widthOf(item), v = V[item];
            let x = right ? edge : edge - w;
            if (pass === 0) for (let g = 0; g <= kept.length; g++) {
              const hit = firstMet(x, v[0], w, v[1], kept);
              if (!hit) break;
              x = right ? hit.x + hit.w + gap : hit.x - gap - w;
              moved = true;
            }
            at[item] = x;
            edge = right ? x + w + gap : x - gap;
            if (x < lo) lo = x;
            if (x + w > hi) hi = x + w;
          }
          if (hi <= ar + 0.5 && lo >= ax - 0.5) { if (moved) stepped = true; break; }
          if (pass === 1) {
            const shift = right ? (hi > ar ? Math.max(ax - lo, ar - hi) : 0) : (lo < ax ? Math.min(ar - hi, ax - lo) : 0);
            for (const i of items) at[i] = at[i]! + shift;
          }
        }
        for (const i of items) xs[i] = { x: at[i]!, side: right ? "right" : "left" };
      }
      const c = xs.console!;
      consoleBox = { x: c.x, y: cy, w: cw, h: consoleH, side: c.side };
      if (n.step) {
        if (stepBeside) { const s = xs.step!; stepBox = { x: s.x, y: V.step[0], w: sW, h: sH, side: s.side, beside: true }; }
        // The edge nearest the image lines up with the console's.
        else stepBox = { x: c.side === "left" ? c.x + cw - sW : c.x, y: cy + consoleH + gap, w: sW, h: sH, side: c.side, beside: false };
      }
      if (n.layers && a.stack) {
        const ly = cy + consoleH + cardH + gap;
        layersBox = { x: c.side === "left" ? c.x + cw - lw : c.x, y: ly, w: lw, h: Math.max(0, Math.min(lh, ab - ly)), side: c.side, under: true };
      } else if (n.layers) {
        const la = xs.layers!;
        layersBox = { x: la.x, y: V.layers[0], w: lw, h: V.layers[1], side: la.side, under: false };
      }
      if (n.depth) { const d = xs.depth!; depth = { x: d.x, y: stage.y, w: depthW, h: stage.h, side: d.side }; }
    }

    const rows = rowsAt === "over" ? baseRows.map((r) => ({ ...r })) : baseRows.slice();
    const instruments: Box[] = [consoleBox, ...(stepBox ? [stepBox] : []), ...(layersBox ? [layersBox] : []), ...(depth ? [depth] : [])];
    // Rows that stand over the image must not run under a side instrument that stands there too.
    if (rowsAt === "over" && rows.length) narrowRows(rows, instruments, stage, gap);
    const all = [...instruments, ...rows];
    let out = false;
    for (const b of all) if (b.x < ax - 0.5 || b.y < ay - 0.5 || b.x + b.w > ar + 0.5 || b.y + b.h > ab + 0.5) { out = true; break; }
    const lost = out
      || consoleBox.h < Math.min(ch, lostH) || (!!stepBox && stepBox.h < Math.min(sH, lostH)) || (!!layersBox && layersBox.h < Math.min(lh, lostH));
    let pile = 0, keptHit = 0, imageHit = 0;
    for (let i = 0; i < all.length; i++) {
      for (let k = i + 1; k < all.length; k++) pile += area(all[i], all[k]);
      for (const kb of kept) keptHit += area(all[i], kb);
      imageHit += area(all[i], stage);
    }
    const consoleWhole = consoleBox.h >= Math.min(ch, fitH) - 0.5;
    const layersWhole = !layersBox || layersBox.h >= Math.min(lh, layersMinH, fitH) - 0.5;
    const short = Math.max(0, Math.min(ch, consoleMinH) - consoleBox.h) + (layersBox ? Math.max(0, Math.min(lh, layersMinH) - layersBox.h) : 0);
    return {
      p: {
        layout: { stage, depth, rows, rowsAt, console: consoleBox, layers: layersBox, step: stepBox, over: rowsAt === "over" || imageHit > 0.5 || pile > 0.5 },
        lost, pile, kept: keptHit, image: imageHit, whole: consoleWhole && layersWhole, short,
      },
      stepped,
    };
  };
  const best = (p: Placed): boolean => !p.lost && p.pile <= 0.5 && p.kept <= 0.5 && p.image <= 0.5 && p.whole;
  for (const base of options) {
    // The step card under the console; where that squeezes the console, beside it (one column further out).
    const forms = [base];
    for (const a of forms) {
      // Stepping past the kept panels first; when that moved anything, also packed against the image as before them
      // (the give-way order may need it: a kept panel covered rather than the picture).
      const first = standOne(a, kept.length > 0);
      placed.push(first.p);
      // The best there can be (clear, whole, the first such in the board's order): nothing later can beat it.
      if (stopAtBest && best(first.p)) return { stage, placed };
      if (first.stepped) placed.push(standOne(a, false).p);
      if (a === base && base.beside && !first.p.whole) forms.push(base.beside);
    }
  }
  return { stage, placed };
}

function narrowRows(rows: Box[], instruments: Box[], stage: Box, gap: number): void {
  let x0 = stage.x, x1 = stage.x + stage.w;
  for (const b of instruments) {
    const side = (b as { side?: string }).side;
    if (side === "below") continue;
    const meetsRows = rows.some((r) => r.y < b.y + b.h && r.y + r.h > b.y);
    if (!meetsRows) continue;
    if (side === "right" && b.x < x1) x1 = Math.min(x1, b.x - gap);
    if (side === "left" && b.x + b.w > x0) x0 = Math.max(x0, b.x + b.w + gap);
  }
  if (x1 - x0 >= 120) for (const r of rows) { r.x = x0; r.w = x1 - x0; }
}

/** The give-way order as a comparison (lower is better); ties keep the arrangements' own order. */
function rank(p: Placed): number[] {
  const clear = p.pile <= 0.5 && p.kept <= 0.5 && p.image <= 0.5;
  return [
    p.lost ? 1 : 0, // (1) inside the canvas, every instrument in sight: never given up while another way exists
    p.pile > 0.5 ? 1 : 0,
    p.image > 0.5 ? 1 : 0, // (d) the picture is covered last
    p.kept > 0.5 ? 1 : 0, // (c) then a kept panel
    clear && p.whole ? 0 : 1, // (a) rearranged at full height before (b) compacted
    p.short, p.image, p.kept, p.pile,
  ];
}
const better = (a: number[], b: number[]): boolean => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-9) return true; if (a[i] > b[i] + 1e-9) return false; } return false; };

function choose(placed: Placed[]): Placed {
  let best = placed[0], bestRank = rank(best);
  for (const p of placed.slice(1)) { const r = rank(p); if (better(r, bestRank)) { best = p; bestRank = r; } }
  return best;
}

function finish(p: Placed): BoardLayout {
  return { ...p.layout, covers: p.image > 0.5 ? "image" : p.kept > 0.5 ? "kept" : "none", whole: p.whole };
}

export function boardLayout(n: BoardNeeds): BoardLayout {
  return finish(choose(solve(n, undefined, true).placed));
}

/** Every arrangement the law considered, stood on this canvas, with what each covers (for gates: the give-way order is checked against them). */
export function boardOptions(n: BoardNeeds): Array<{ layout: BoardLayout; lost: boolean; pile: number; kept: number; image: number }> {
  return solve(n).placed.map((p) => ({ layout: finish(p), lost: p.lost, pile: p.pile, kept: p.kept, image: p.image }));
}

/** True when the board stands clear: inside the canvas, nothing over the picture, a kept panel or another instrument, and the image and its kept panels wholly on screen. */
export function boardClear(n: BoardNeeds, l: BoardLayout = boardLayout(n)): boolean {
  const { pad } = BOARD;
  const inside = (b: Box): boolean => b.x >= pad - 0.5 && b.y >= pad - 0.5 && b.x + b.w <= n.host.w - pad + 0.5 && b.y + b.h <= n.host.h - pad + 0.5;
  if (l.covers !== "none" || l.rowsAt === "over" || !inside(n.image) || !(n.kept ?? []).every(inside)) return false;
  const all: Box[] = [l.console, ...(l.step ? [l.step] : []), ...(l.layers ? [l.layers] : []), ...(l.depth ? [l.depth] : []), ...l.rows];
  if (!all.every(inside)) return false;
  for (let i = 0; i < all.length; i++) for (let k = i + 1; k < all.length; k++) if (meets(all[i], all[k])) return false;
  return true;
}

/** A change of the canvas view: scale every figure point by `scale` about `about` (host px), then move it by `dx`, `dy`. */
export interface BoardFit { scale: number; dx: number; dy: number; about: { x: number; y: number } }

/** The needs as they would be after a view change (the image and its kept panels move with the figure; the instruments keep their size). */
export function fitNeeds(n: BoardNeeds, f: BoardFit): BoardNeeds {
  const t = (b: Box): Box => ({ x: f.about.x + (b.x - f.about.x) * f.scale + f.dx, y: f.about.y + (b.y - f.about.y) * f.scale + f.dy, w: b.w * f.scale, h: b.h * f.scale });
  return { ...n, image: t(n.image), kept: (n.kept ?? []).map(t) };
}

/** Never zoom an image out below this many px on its longer side to make room (past that, the board stands over its edges). */
const FIT_MIN_PX = 160;

/**
 * The smallest change of the canvas view that lets the board stand clear round the image and its kept panels (see
 * `boardClear`): null when it already does, or when the image alone is larger than the canvas (the user has zoomed in
 * on it: the board stands over its edges, as the law allows). A pan alone when a pan is enough (the shortest one);
 * otherwise the least zoom out (about the image's centre, so it stays where the eye is) with the shortest pan.
 * Bounded: a handful of `solve` runs per scale tried, about a dozen scales at most.
 */
export function boardFit(n: BoardNeeds): BoardFit | null {
  const { pad } = BOARD;
  const aw = n.host.w - 2 * pad, ah = n.host.h - 2 * pad;
  if (!(aw > 0) || !(ah > 0)) return null;
  if (boardClear(n)) return null;
  if (n.image.w > aw + 0.5 || n.image.h > ah + 0.5) return null;
  const about = { x: n.image.x + n.image.w / 2, y: n.image.y + n.image.h / 2 };

  /** The shortest pan that stands the board clear at this scale, or null. */
  const at = (scale: number): BoardFit | null => {
    const m = fitNeeds(n, { scale, dx: 0, dy: 0, about });
    if (boardClear(m)) return { scale, dx: 0, dy: 0, about };
    // Stand each arrangement on a canvas without edges (but the real height for the console to fit), and take the
    // footprint of every one that stands clear: if it fits the canvas, the pan that brings it in is a candidate.
    const big = 1e5;
    const { placed } = solve(m, { x: -big, y: -big, w: 2 * big, h: 2 * big });
    let best: BoardFit | null = null, bestLen = Infinity;
    for (const p of placed) {
      if (p.lost || p.pile > 0.5 || p.kept > 0.5 || p.image > 0.5) continue;
      const L = p.layout, boxes: Box[] = [m.image, ...(m.kept ?? []), L.console, ...(L.step ? [L.step] : []), ...(L.layers ? [L.layers] : []), ...(L.depth ? [L.depth] : []), ...L.rows];
      const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
      if (x1 - x0 > aw + 0.5 || y1 - y0 > ah + 0.5) continue;
      const dx = x0 < pad ? pad - x0 : x1 > n.host.w - pad ? n.host.w - pad - x1 : 0;
      const dy = y0 < pad ? pad - y0 : y1 > n.host.h - pad ? n.host.h - pad - y1 : 0;
      const len = Math.hypot(dx, dy);
      if (len >= bestLen) continue;
      const f = { scale, dx, dy, about };
      if (!boardClear(fitNeeds(n, f))) continue;
      best = f; bestLen = len;
    }
    return best;
  };

  const first = at(1);
  if (first) return first;
  const least = Math.min(1, FIT_MIN_PX / Math.max(1, n.image.w, n.image.h));
  if (least >= 1) return null;
  const last = at(least);
  if (!last) return null;
  // The largest scale that still stands the board clear (feasibility grows as the figure shrinks).
  let lo = least, hi = 1, found = last;
  for (let i = 0; i < 10 && hi - lo > 0.005; i++) {
    const mid = (lo + hi) / 2, f = at(mid);
    if (f) { lo = mid; found = f; } else hi = mid;
  }
  return found;
}
