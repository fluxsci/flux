#!/usr/bin/env -S npx tsx
// The slide player's placement law on a FRACTIONALLY scaled display (2026-10-24: the owner's 1.25 desktop). Blink snaps a box's paint
// offset (`left` / `top`) to whole pixels of its local space at the device scale (local px x devicePixelRatio); a whole stage pixel is on
// that grid only at devicePixelRatio 1, so at 1.25 a move's flight frames (the frozen START box plus an unsnapped transform) and its landing
// frame (the END box) carried different snap errors and every move ended with a jump of up to 0.4 stage px (0.7 device px in the editor
// preview). render.layoutBoxOf therefore puts a layout box's ORIGIN on the 1 / devicePixelRatio grid and the residual transform carries the
// exact rest: the browser's snap is a no-op and every frame is exactly where its numbers say.
//   1. the law (pure): Math.round at 1 (byte-identical to the old law), on the grid and within half a cell at 1.25 / 1.5 / 1.75 / 2 / 2.5
//   2. the wrapper (linkedom, devicePixelRatio 1.25): rest and mid-flight frames realise the exact box, the layout origin is on the grid
//   3. the transform driver: a pure move's effective position is continuous from the first frame through the landing at 1.25
// The compositor half (a real fractional display) is measured by verify-slide-settle-electron (its DSF pass): offscreen Electron with
// `offscreen: { deviceScaleFactor: 1.25 }`. Headless Chrome's EMULATED device scale is not a display scale (it snaps differently) and
// cannot stand in for it.
// Run: npx tsx scripts/verify-slide-device-grid.ts
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-device-grid");
const { window: win, document } = parseHTML("<!doctype html><html><body></body></html>");
const g = globalThis as unknown as Record<string, unknown>;
g.window = win; g.document = document; g.HTMLElement = win.HTMLElement; g.Element = win.Element; g.SVGElement = win.SVGElement; g.Node = win.Node;
const setDpr = (v: number) => { (win as unknown as { devicePixelRatio: number }).devicePixelRatio = v; };
setDpr(1);
const { layoutBoxOf, layoutGrid, applyWrapperBox, applyWrapperBoxComposite } = await import("../src/lib/slide/player/render");

const onGrid = (v: number, grid: number) => Math.abs(v * grid - Math.round(v * grid)) < 1e-6;
const px = (s: string) => Number(s.replace("px", ""));
/** left/top + the translate of the wrapper's transform: where the box origin really is (stage px) */
function effective(w: HTMLElement): { x: number; y: number } {
  const m = /translate\(\s*(-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)/.exec(w.style.transform);
  return { x: px(w.style.left) + (m ? Number(m[1]) : 0), y: px(w.style.top) + (m ? Number(m[2]) : 0) };
}
const rect = (x: number, y: number, extra: Record<string, unknown> = {}): any => ({ id: "r", type: "rect", x, y, width: 120, height: 80, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0, ...extra });

h.section("1. the law");
{
  const values = [0, 0.4, 0.5, 0.6, 1.5, 2.5, 33.37, 60, 61, 62, 89.99, 90, 90.4, 112.5, -0.5, -1.5, -11.21, 419.6, 639.5];
  h.ok(values.every(v => { const b = layoutBoxOf({ x: v, y: v, w: 10.4, h: 10.6 }, 1); return b.x === Math.round(v) && b.y === Math.round(v) && b.w === 10 && b.h === 11; }), "at devicePixelRatio 1 the law is Math.round: byte-identical to every box before the fix");
  for (const grid of [1.25, 1.5, 1.75, 2, 2.5]) {
    const ok = values.every(v => { const b = layoutBoxOf({ x: v, y: v, w: 10, h: 10 }, grid); return onGrid(b.x, grid) && Math.abs(b.x - v) <= 0.5 / grid + 1e-9 && b.x === b.y; });
    h.ok(ok, `at ${grid} every origin is a whole device pixel of the local space (a multiple of 1/${grid}) within half a cell of the exact box`);
  }
  h.eq(layoutBoxOf({ x: 90, y: 90, w: 120, h: 80 }, 1.25), { x: 90.4, y: 90.4, w: 120, h: 80 }, "the measured case: 90 stage px at 1.25 sits on 90.4 (round(112.5) / 1.25, the browser's own snap), with no float dust");
  h.eq(layoutBoxOf({ x: 33.37, y: 0, w: 1, h: 1 }, 1.5).x, 33.333333, "a cell of 1/1.5 is written to the micro-pixel (33.333333, not 33.33333333333333)");
  setDpr(1.25); h.eq(layoutGrid(), 1.25, "the grid is the window's devicePixelRatio");
  setDpr(0); h.eq(layoutGrid(), 1, "an unusable devicePixelRatio (0) falls back to 1");
  setDpr(1);
}

h.section("2. the wrapper at devicePixelRatio 1.25");
{
  setDpr(1.25);
  const w = document.createElement("div") as unknown as HTMLElement;
  for (const [x, y] of [[90, 90], [61, 62.5], [33.37, -11.21], [420, 90]]) {
    applyWrapperBox(w, rect(x, y));
    const e = effective(w);
    h.ok(onGrid(px(w.style.left), 1.25) && onGrid(px(w.style.top), 1.25), `rest at (${x}, ${y}): the layout origin (${w.style.left}, ${w.style.top}) is on the device grid`);
    h.ok(Math.abs(e.x - x) < 1e-6 && Math.abs(e.y - y) < 1e-6, `rest at (${x}, ${y}): layout + residual transform realise the exact box (${e.x.toFixed(6)}, ${e.y.toFixed(6)})`);
  }
  const base = layoutBoxOf({ x: 60, y: 60, w: 120, h: 80 });
  applyWrapperBoxComposite(w, rect(75.25, 70.5), base);
  const mid = effective(w);
  h.ok(onGrid(px(w.style.left), 1.25) && Math.abs(mid.x - 75.25) < 1e-6 && Math.abs(mid.y - 70.5) < 1e-6, "a mid-flight frame rides the frozen grid box and realises the exact box");
  applyWrapperBox(w, rect(60, 60));
  h.eq([w.style.transform, w.style.transformOrigin], ["", "center center"], "a box already on the grid (60 x 1.25 = 75) rests with no residual: the classic transform-free wrapper");
  setDpr(1);
  applyWrapperBox(w, rect(90, 90));
  h.eq([w.style.left, w.style.top, w.style.transform], ["90px", "90px", ""], "at devicePixelRatio 1 a whole-pixel box rests exactly as it always did");
}

h.section("3. a pure move through its landing at devicePixelRatio 1.25");
{
  setDpr(1.25);
  const { createTransform } = await import("../src/lib/slide/player/transform");
  const { fillContent } = await import("../src/lib/slide/player/render");
  const { BUILTIN_THEMES } = await import("../src/lib/slide/theme");
  const pre = rect(60, 60), end = rect(420, 90);
  const ctx = { theme: BUILTIN_THEMES["flux-paper"] } as never;
  const wrap = document.createElement("div") as unknown as HTMLElement;
  applyWrapperBox(wrap, pre); fillContent(wrap, pre, ctx);
  const driver = createTransform(wrap, pre, end, ctx);
  const path: { u: number; x: number; y: number }[] = [];
  for (const u of [0, 0.5, 0.9, 0.99, 0.999, 0.9999, 1]) { driver.seek(u, u); const e = effective(wrap); path.push({ u, ...e }); }
  const last = path[path.length - 1], before = path[path.length - 2];
  h.ok(Math.abs(last.x - 420) < 1e-6 && Math.abs(last.y - 90) < 1e-6, `the landing frame is the exact end box (${last.x}, ${last.y})`);
  const travel = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
  // u 0.9999 -> 1 moves 0.01 % of the 361 stage px path (0.036 px): the landing step must be exactly that, never a snap on top of it
  h.ok(Math.abs(travel(before, last) - 1e-4 * travel(pre, end)) < 1e-6, `the landing step is the motion's own last 0.01 % (${travel(before, last).toFixed(5)} stage px): no snap at the end`);
  h.ok(onGrid(px(wrap.style.left), 1.25) && onGrid(px(wrap.style.top), 1.25), "and the resting layout origin is on the device grid");
  setDpr(1);
}
await h.done();
