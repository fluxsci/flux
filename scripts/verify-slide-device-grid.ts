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
//   4. the device grid (deviceGrid.ts, pure): hosts fit the stage with its origin on a whole device pixel; a marked node's rest shift
//   5. compositing is a constant of the slide (headless Chrome, the exported player): a node that ever glides carries its flight mark from the
//      slide's first frame through every cue; a node that never glides never does
//   6. (2026-10-25) a marked node that resizes is laid out per frame (no frozen-box scale on a layer); a morphing text's static renders are
//      painted at HANDOVER_FLOOR instead of hidden and carry one bounds halo each (textMorph.ts)
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
h.section("4. the device grid");
{
  const { gridFit, gridOf, cameraPose, snapDelta } = await import("../src/lib/slide/player/deviceGrid");
  const stage = { width: 640, height: 360 };
  for (const [W, H, L, T, dpr] of [[900, 504, 0, 0, 1.25], [1004, 612, 0, 0, 1.25], [978, 404, 302.89, 136, 1.25], [1366, 768, 0, 0, 1], [1440, 900, 0, 47.3, 1.5], [3072, 1728, 0, 0, 1.25]] as const) {
    const f = gridFit({ left: L, top: T, width: W, height: H }, stage, dpr);
    const ox = (L + f.left) * dpr, oy = (T + f.top) * dpr;
    const centredX = Math.abs((L + f.left) - (L + (W - 640 * f.scale) / 2)) <= 0.5 / dpr + 1e-9, centredY = Math.abs((T + f.top) - (T + (H - 360 * f.scale) / 2)) <= 0.5 / dpr + 1e-9;
    h.ok(Math.abs(ox - Math.round(ox)) < 1e-6 && Math.abs(oy - Math.round(oy)) < 1e-6 && centredX && centredY && f.scale === Math.min(W / 640, H / 360),
      `a ${W}x${H} box at (${L}, ${T}) @${dpr}: the stage origin lands on a whole device pixel (${ox.toFixed(3)}, ${oy.toFixed(3)}) within half a device pixel of centred, scale ${f.scale.toFixed(5)}`);
  }
  h.eq(cameraPose(""), { x: 0, y: 0, z: 1 }, "an identity camera pose");
  h.eq(cameraPose("translate(-120.5px, 33px) scale(1.8)"), { x: -120.5, y: 33, z: 1.8 }, "the pose the player writes (baseCameraTransform)");
  h.eq(cameraPose("translate(10px, 10px) rotate(3deg)"), null, "a pose the grid cannot follow (a rotation) is refused, never half-read");
  const g = gridOf(302.89, 136.2, 1.1222, 1.25, "")!;
  h.ok(Math.abs(g.s - 1.25 * 1.1222) < 1e-12 && g.fx >= 0 && g.fx < 1 && g.fy >= 0 && g.fy < 1, "the grid of a stage: device px per local px = dpr x fit x zoom, and the fractional device offset of its origin");
  const zoomed = gridOf(0, 0, 1.4, 1.25, "translate(-100.3px, -40.1px) scale(2)")!;
  h.ok(Math.abs(zoomed.s - 3.5) < 1e-12, "a camera zoom multiplies the grid (1.25 x 1.4 x 2 = 3.5 device px per local px)");
  let worst = 0, onGrid = true;
  for (const v of [0, 0.3, 33.37, 60, 90, 90.4, 419.6, -11.21]) {
    const d = snapDelta(g, v, v), ax = g.fx + g.s * (v + d.dx), ay = g.fy + g.s * (v + d.dy);
    worst = Math.max(worst, Math.abs(d.dx * g.s), Math.abs(d.dy * g.s)); onGrid &&= Math.abs(ax - Math.round(ax)) < 1e-6 && Math.abs(ay - Math.round(ay)) < 1e-6;
  }
  h.ok(onGrid && worst <= 0.5 + 1e-9, `a rest shift lands the box origin on a whole device pixel and moves it at most half a device pixel (worst ${worst.toFixed(3)})`);
}

h.section("5. compositing is a constant of the slide (exported player, headless Chrome)");
{
  const fs = await import("node:fs/promises"), os = await import("node:os"), path = await import("node:path");
  const { launch } = await import("./lib/driver.mjs");
  const { createDeck, addSlide, addElement, addBeat, setTransform } = await import("../src/lib/slide/ops");
  const { exportDeckHtml } = await import("../src/lib/slide/export/exportDeck");
  const deck = createDeck({ id: "grid", title: "grid", theme: "flux-paper", withTitleSlide: false }); deck.defaults.transition = "none";
  const s = addSlide(deck, { id: "s", name: "s", layout: "blank" })!;
  const mover = addElement(deck, s.id, rect(60, 60, { id: "mover" }))!, still = addElement(deck, s.id, rect(300, 200, { id: "still", fill: "#d14d41" }))!;
  const b1 = addBeat(deck, s.id, { advance: "click" })!; addBeat(deck, s.id, { advance: "click" });
  const b3 = addBeat(deck, s.id, { advance: "click" })!;
  setTransform(deck, s.id, b3.id, mover, { state: { x: 400, y: 90 }, duration: 500 });   // the only glide: beat 3
  setTransform(deck, s.id, b1.id, still, { state: { fill: "#879a39" }, duration: 400 });  // a picture change, never a glide
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-grid-")); const html = path.join(tmp, "d.html");
  await fs.writeFile(html, (await exportDeckHtml({ deck })).html);
  const { browser } = await launch({ width: 1004, height: 612 });
  try {
    const page = await browser.newPage(); await page.goto("file://" + html); await new Promise(r => setTimeout(r, 600));
    const marks = () => page.evaluate(`(() => { const n = id => document.querySelector('[data-el-id="' + id + '"]').getAnimations().length; return [n('mover'), n('still')]; })()`) as Promise<number[]>;
    const seen: number[][] = [await marks()];
    for (const beat of [1, 2, 3]) { await page.evaluate(`window.fluxDeck.goTo(0, ${beat})`); await new Promise(r => setTimeout(r, 900)); seen.push(await marks()); }
    await page.evaluate(`window.fluxDeck.goTo(0, 0)`); await new Promise(r => setTimeout(r, 300)); seen.push(await marks());
    h.ok(seen.every(([m]) => m === 1), `the node that glides only in beat 3 carries its mark at the slide's first frame and at every beat, forward and back (${seen.map(x => x[0]).join(" ")})`);
    h.ok(seen.every(([, st]) => st === 0), `a node that never glides (a recolour) never carries one (${seen.map(x => x[1]).join(" ")})`);
  } finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
}
h.section("6. a marked node that resizes is laid out; a morphing text keeps its layers");
{
  setDpr(1.25);
  const { createTransform } = await import("../src/lib/slide/player/transform");
  const { fillContent, armFlightMark, releaseFlightMark } = await import("../src/lib/slide/player/render");
  const { BUILTIN_THEMES } = await import("../src/lib/slide/theme");
  const ctx = { theme: BUILTIN_THEMES["flux-paper"] } as never;
  const pre = rect(60, 60), end = rect(60, 60, { width: 168.3, height: 112.1 });
  const flight = (marked: boolean) => {
    const wrap = document.createElement("div") as unknown as HTMLElement & { animate?: unknown };
    // linkedom has no Web Animations: a stand-in for the paused no-op mark (render.armFlightMark only needs pause / finished / cancel)
    wrap.animate = () => ({ pause() {}, cancel() {}, finished: new Promise(() => {}) });
    if (marked) armFlightMark(wrap);
    applyWrapperBox(wrap, pre); fillContent(wrap, pre, ctx);
    const driver = createTransform(wrap, pre, end, ctx);
    driver.seek(0.5, 0.5);
    const out = { transform: wrap.style.transform, width: px(wrap.style.width), height: px(wrap.style.height) };
    releaseFlightMark(wrap);
    return out;
  };
  const painted = flight(false), layered = flight(true);
  {
    // a FIXED text resized on its mark: every frame's size is a whole sixteenth of a stage px between two rests on that grid
    const tpre: any = { id: "t", type: "text", x: 60, y: 60, width: 150, height: 30, rotation: 0, text: "Flux 4.2", fontSize: 20, sizing: "fixed", fill: "#100f0f" };
    const tend: any = { ...tpre, width: 210, height: 42 };
    setDpr(1.25);
    const wrap = document.createElement("div") as unknown as HTMLElement & { animate?: unknown };
    wrap.animate = () => ({ pause() {}, cancel() {}, finished: new Promise(() => {}) });
    armFlightMark(wrap); applyWrapperBox(wrap, tpre); fillContent(wrap, tpre, ctx);
    const driver = createTransform(wrap, tpre, tend, ctx);
    const sizes: number[] = [];
    for (const u of [0.013, 0.37, 0.5, 0.91]) { driver.seek(u, u); sizes.push(px(wrap.style.width), px(wrap.style.height)); }
    releaseFlightMark(wrap); setDpr(1);
    h.ok(sizes.every(v => Math.abs(v * 16 - Math.round(v * 16)) < 1e-9) && sizes[0] > 150 && sizes[6] < 210,
      `a fixed text resized on its mark flies through whole sixteenths of a stage px (${sizes.join(", ")}): its svg viewport is the browser's layout grid, so the glyphs map 1:1 as at rest`);
  }
  h.ok(/scale\(/.test(painted.transform) && painted.width === 120, `painted in place, a resize flies the frozen start box scaled (${painted.width} px wide, ${painted.transform})`);
  h.ok(!/scale\(/.test(layered.transform) && Math.abs(layered.width - (120 + 168.3) / 2) < 1e-6 && Math.abs(layered.height - (80 + 112.1) / 2) < 1e-6,
    `on its flight mark, a resize is laid out at the frame's exact box (${layered.width} x ${layered.height} px, no scale: a layer keeps its raster scale while it animates)`);
  setDpr(1);
  const { handoverOpacity, HANDOVER_FLOOR, HANDOVER_CAP, appendBoundsHalo, boundsHaloReach, BOUNDS_HALO_CLASS } = await import("../src/lib/slide/player/textMorph");
  h.eq([handoverOpacity(0), handoverOpacity(-1), handoverOpacity(1e-9), handoverOpacity(1)], ["0", "0", "0.000001", String(Math.round(HANDOVER_CAP * 1e6) / 1e6)],
    "a hand-over weight: 0 stays 0, a weight above 0 never rounds to 0, a full weight is drawn at the cap (one raster path at rest and in the hand-over)");
  h.ok(HANDOVER_FLOOR > 0.0004 && HANDOVER_FLOOR * 255 < 0.5, `a render that does not show is still painted (${HANDOVER_FLOOR}: above the browser's 0.0004 invisible cutoff, under half an 8-bit level)`);
  const layer = document.createElement("div") as unknown as HTMLElement;
  appendBoundsHalo(layer, boundsHaloReach(22, 30)); appendBoundsHalo(layer, boundsHaloReach(22, 30));
  const halos = layer.querySelectorAll(`.${BOUNDS_HALO_CLASS}`);
  h.ok(halos.length === 1 && (halos[0] as HTMLElement).style.inset === "-90px" && (halos[0] as HTMLElement).style.pointerEvents === "none" && boundsHaloReach() === 64,
    "a static render carries ONE bounds halo, three font sizes beyond its box (64 px at least), never a hit target");
}

await h.done();
