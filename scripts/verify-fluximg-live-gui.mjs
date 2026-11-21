// fluximg live view on the real canvas (Figure): select an image, press R. Pins how it opens and closes; the control
// board that stands round the live image (no menu: a console of channel strips and paper keys at its side, depth
// standing at its other side, time lying under it, never on the image or each other, changing sides at the canvas's
// edges; nothing animating at rest); what the pointer reads out on the board; the rails (scrub, wheel, runs, the
// projection chooser, playback, speed); the wheel's scope (the view's own hold answers over the image and the board
// only, something taken in hand answers anywhere); the channel strips (handles, wheel, Auto from the pixels in
// view, the histogram of the pixels on screen, take in hand, pull contrast on the image, colour, curve), Split with
// its preview into LINKED panels; layers and objects with their two-way hover and the pointer's card; the frame as
// a viewport with its map (and pulling an inset out of it); annotations as paper keys, dragged between corners,
// drawn alike in the live overlay and at rest; undo / redo through live gestures; leaks; and that the still at
// rest shows the last live state. Records real frame timings (`flux-fluximg-frame`); asserts generous ceilings only.
//
// UI tier, runtime tsx (it writes the synthetic bundles with scripts/lib/fluximgFixtures.ts). Real keys and the
// real wheel throughout (page.keyboard / page.mouse), condition-based waits.
// Run (dev server on :1420, or FLUX_URL): node --import tsx scripts/verify-fluximg-live-gui.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForFrame, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeAllFixtures, writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-live-gui");
const scratch = mkdtempSync(path.join(tmpdir(), "fx-livegui-"));
await writeAllFixtures(scratch);
// Time AND depth (the shared fixtures have one or the other): both rails at once.
{
  const T = 6, C = 2, Z = 5, Hh = 32, Ww = 40, d = new Uint16Array(T * C * Z * Hh * Ww);
  let k = 0;
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let z = 0; z < Z; z++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) d[k++] = 100 + ((x * (c + 1) + y * 3 + t * 40 + z * 90) % 1000);
  await writeFixture(scratch, { name: "tz_u16", about: "time and depth", dims: ["t", "c", "z", "y", "x"], shape: [T, C, Z, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { t: { unit: "s", scale: 0.5 }, z: { unit: "µm", scale: 1.5 }, y: { unit: "µm", scale: 0.3 }, x: { unit: "µm", scale: 0.3 } }, channels: [{ name: "a", color: "#ff00ff" }, { name: "b", color: "#00ff00" }] } });
}
// A wide, low movie (a line scan): six times wider than it is tall.
{
  const T = 12, C = 2, Hh = 16, Ww = 96, d = new Uint16Array(T * C * Hh * Ww);
  let k = 0;
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) d[k++] = 50 + ((x * 7 * (c + 1) + y * 11 + t * 60) % 900);
  await writeFixture(scratch, { name: "line_u16", about: "a wide, low movie", dims: ["t", "c", "y", "x"], shape: [T, C, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { t: { unit: "s", scale: 0.25 }, y: { unit: "µm", scale: 0.5 }, x: { unit: "µm", scale: 0.5 } }, channels: [{ name: "a", color: "#ff00ff" }, { name: "b", color: "#00ff00" }] } });
}
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}

const W = 1500, H = 950;
const { browser, page } = await launch({ width: W, height: H });
const base = new URL(APP_URL);
base.search = "?fixture=demo";
await gotoApp(page, { url: base.href, settle: 1500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!window.__flux?.fluximg && !!document.querySelector(".canvas-host"), null, { label: "Figure mode with the dev handle" });

// ---- the stage ------------------------------------------------------------------------------------
// One big figure at the origin, the demo's elements gone except one plot (R on a plot must still be the X-ray).
const PLOT_SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const PLOT_MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PLOT = await page.evaluate((svg, manifest) => {
  const F = window.__flux;
  F.io.reimportPlot("fxl-plot-asset", svg, manifest);
  F.fig.commit((p) => {
    const f = p.figures[0];
    f.x = 0; f.y = 0; f.width = 1400; f.height = 1100;
    f.elements = [{ type: "plot", id: "fxl-plot", x: 880, y: 700, width: 252, height: 180, rotation: 0, assetId: "fxl-plot-asset", overrides: {} }];
    F.fig.activeFigureId.set(f.id);
  });
  F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 });
  // Every frame the live overlay presents, with its timing.
  window.__fxFrames = [];
  document.addEventListener("flux-fluximg-frame", (e) => window.__fxFrames.push({ ...e.detail }));
  window.addEventListener("wheel", () => { window.__fxWheelAt = performance.now(); }, { capture: true });
  window.addEventListener("keydown", (e) => { if (e.key === "r") window.__fxKeyAt = performance.now(); }, { capture: true });
  return "fxl-plot";
}, PLOT_SVG, PLOT_MANIFEST);

/** Place a fixture through the real import and ops; returns the element id. */
async function placeFixture(name, at, extra = {}) {
  const files = bundleFiles(name);
  return page.evaluate(async ({ name, files, at, extra }) => {
    const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir);
    window.__fluxSeedFluximg(`plots/${name}.fluximg`, files);
    const place = F.fluximg.place;
    const assetId = place.fluximgAssetId(name, Math.random().toString(36).slice(2));
    const result = await window.fig.importFluximg({ root, sourcePath: `plots/${name}.fluximg`, assetId });
    const asset = place.fluximgAsset(assetId, result, `plots/${name}.fluximg`);
    const figureId = F.get(F.fig.activeFigureId);
    let id;
    F.fig.commit((p) => { id = F.ops.addFluximg(p, { figureId, asset, x: at.x, y: at.y, ...extra }); const el = p.figures[0].elements.find((e) => e.id === id); Object.assign(el, extra.patch ?? {}); });
    return id;
  }, { name, files, at, extra });
}
const waitStill = (id) => waitFor(page, (id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); const n = el && document.querySelector(`svg[data-fluximg="${el.assetId}"]`); return !!n?.querySelector("image") && !!n.getAttribute("data-fluximg-key"); }, id, { label: `the still of ${id}`, timeout: 15000 });


const model = (id) => page.evaluate((id) => {
  const F = window.__flux;
  const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id) ?? null;
  return { el: el ? structuredClone(el) : null, live: structuredClone(F.get(F.fluximg.live.fluximgLive)), explicit: F.fluximg.live.liveArm.explicit, past: F.fig.historyStats().past, future: F.fig.historyStats().future };
}, id);
const resolved = (id) => page.evaluate((id) => {
  const F = window.__flux;
  const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id);
  if (!el) return null;
  const m = F.get(F.fluximg.store.fluximgManifests)[el.assetId];
  return m ? { manifest: { dims: m.pixels.dims, shape: m.pixels.shape }, view: F.fluximg.actions.liveContext()?.element.id === id ? structuredClone(F.fluximg.actions.liveContext().view) : null } : null;
}, id);
const rect = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const rects = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }), sel);
const overlaps = (a, b) => !(a.right <= b.x + 0.5 || a.x >= b.right - 0.5 || a.bottom <= b.y + 0.5 || a.y >= b.bottom - 0.5);
const within = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
const isOpen = () => page.evaluate(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const sharpFrame = () => waitFor(page, () => document.querySelector("[data-fluximg-live]")?.getAttribute("data-sharp") === "1", null, { label: "a sharp live frame", timeout: 10000 });
async function openLive(id) {
  if (await isOpen()) await closeLive();
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), id);
  const r = await page.evaluate((id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); const n = document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getBoundingClientRect(); return n ? { x: n.left + n.width / 2, y: n.top + n.height / 2 } : null; }, id);
  if (r) await page.mouse.move(r.x, r.y);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "live view open with its board" });
  await sharpFrame();
}
async function closeLive() {
  if (await isOpen()) await page.evaluate(() => window.__flux.fluximg.live.closeFluximgLive());
  await waitFor(page, () => !document.querySelector("[data-fluximg-live]") && !document.querySelector("[data-fxb]"), null, { label: "live view closed" });
}
/** The WebGL canvas as presented, read through a 2D canvas (the renderer preserves its drawing buffer). */
const glStats = () => page.evaluate(() => {
  const c = document.querySelector("[data-fluximg-live] canvas.gl");
  if (!c || !c.width) return null;
  const k = document.createElement("canvas"); k.width = c.width; k.height = c.height;
  const x = k.getContext("2d"); x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; }
  return { r: r / n, g: g / n, b: b / n, a: a / n, w: c.width, h: c.height, lost: !!c.getContext("webgl2")?.isContextLost() };
});
const differs = (a, b, by = 2) => !!a && !!b && (Math.abs(a.r - b.r) > by || Math.abs(a.g - b.g) > by || Math.abs(a.b - b.b) > by);
const wheel = async (x, y, deltaY, n = 1, mods = []) => {
  await page.mouse.move(x - 2, y - 1); await page.mouse.move(x, y);
  for (const m of mods) await page.keyboard.down(m);
  for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY }); await sleep(45); } // debounce: 45 ms keeps notches apart (wheel law: rest > 30 ms = a notch)
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
};
const drag = async (from, to, { steps = 4, hold = false } = {}) => {
  await page.mouse.move(from.x - 2, from.y - 1); await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps }); await page.mouse.move(to.x, to.y, { steps });
  await waitForFrame(page);
  if (!hold) { await page.mouse.up(); await waitForFrame(page); }
};
/** Wait until the open wheel gesture settled into one undo step (the live view settles after 420 ms of quiet). */
const settled = () => waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgLiveBusy), null, { label: "the gesture settled", timeout: 3000 });
const ctx = (fn, arg) => page.evaluate(new Function("arg", `const c = window.__flux.fluximg.actions.liveContext(); return c ? (${fn})(c, arg) : null;`), arg);
const key = (id) => `[data-fxb-key='${id}']`;
const strip = (i) => `[data-fxb-channel='${i}']`;
const rail = (dim) => `[data-fxb-rail='${dim}']`;
/** Everything the board has on screen, as boxes. */
const board = () => page.evaluate(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
  const one = (s) => r(document.querySelector(s));
  return {
    host: one(".canvas-host"), image: one("[data-fluximg-live]"), console: one("[data-fxb-console]"), layers: one("[data-fxb-layers]"),
    consoleSide: document.querySelector("[data-fxb-console]")?.getAttribute("data-side") ?? null,
    rails: Object.fromEntries([...document.querySelectorAll("[data-fxb-rail]")].map((e) => [e.getAttribute("data-fxb-rail"), { ...r(e), vertical: e.classList.contains("vertical"), left: e.classList.contains("left") }])),
  };
});
const parts = (b) => [b.console, ...(b.layers ? [b.layers] : []), ...Object.values(b.rails)];

// Values the sections share (each section places what it needs and reads these fresh).
let m, b, image, before, after, c0, c1, g, g2, ph, p0, p1, proj, st, hd, rows, mk;
/** A clean figure with one fixture on it: every image gone, the view and the history reset. Returns the element id. */
async function fresh(name, at, extra = {}) {
  await page.evaluate(() => { const F = window.__flux; F.fluximg.live.closeFluximgLive(); F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); });
  await waitFor(page, () => !document.querySelector("[data-fluximg-live]") && !document.querySelector("[data-fxb]"), null, { label: "live view closed" });
  const id = await placeFixture(name, at, extra);
  await waitStill(id);
  await page.evaluate(() => window.__flux.fig.resetHistory());
  return id;
}
/** FX_ONLY="rails,frame" runs only the sections whose title contains one of those words (for working on the gate). */
const ONLY = (process.env.FX_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
async function section(title, run) {
  if (ONLY.length && !ONLY.some((w) => title.includes(w))) return;
  h.section(title);
  await run();
}
const idx = async (id, dim) => page.evaluate(({ id, dim }) => { const a = window.__flux.fluximg.actions.liveContext(); return a && a.element.id === id ? a.view.index[dim] : null; }, { id, dim });
const chanOf = async (id, i) => page.evaluate(({ id, i }) => { const c = window.__flux.fluximg.actions.liveContext(); return c && c.element.id === id ? structuredClone(c.view.channels[i]) : null; }, { id, i });
const compOf = () => page.evaluate(() => { const v = window.__flux.fluximg.actions.liveContext().view; return { composite: v.composite, solo: v.solo }; });
const windows = async () => page.evaluate(() => window.__flux.fluximg.actions.liveContext().view.channels.map((c) => c.range.join("..")).join(" | "));
const vpNow = () => page.evaluate(() => structuredClone(window.__flux.get(window.__flux.fig.viewport)));
const countImages = () => page.evaluate(() => window.__flux.figures()[0].elements.filter((e) => e.type === "fluximg").map((e) => ({ id: e.id, composite: e.view?.composite ?? null, solo: e.view?.solo ?? null, link: e.view?.link ?? null })));
const inFigure = (ids) => page.evaluate((ids) => { const f = window.__flux.figures()[0]; return f.elements.filter((e) => ids.includes(e.id)).every((e) => e.x >= -0.5 && e.y >= -0.5 && e.x + e.width <= f.width + 0.5 && e.y + e.height <= f.height + 0.5); }, ids);
const head = () => page.evaluate(() => ({ name: document.querySelector("[data-fxb-console] .ttl")?.textContent.trim(), line: document.querySelector("[data-fxb-readout]")?.textContent.trim().replace(/\s+/g, " "), facts: [...document.querySelectorAll("[data-fxb-readout] .fact")].map((e) => e.textContent.trim()), where: [...document.querySelectorAll("[data-fxb-readout] .where b")].map((e) => e.textContent.trim()) }));
const strips = () => page.evaluate(() => [...document.querySelectorAll("[data-fxb-channel]")].map((s) => ({
  i: Number(s.getAttribute("data-fxb-channel")), lamp: s.querySelector(".lamp")?.textContent.trim(), name: s.querySelector(".name")?.textContent.trim(), off: s.classList.contains("off"), hand: s.classList.contains("hand"),
  plot: [s.querySelectorAll("svg.well path.in").length, s.querySelectorAll("svg.well path.edge").length, s.querySelectorAll("svg.well line.pt").length, s.querySelectorAll(".knob").length],
  range: [...s.querySelectorAll(".range .num")].map((n) => n.textContent.trim()), front: s.querySelector("svg.well path.in")?.getAttribute("d") ?? "", stack: s.querySelector("svg.well path.stack")?.getAttribute("d") ?? "",
})));
/** Where the playhead is drawn along its well vs where the model's plane says it should be. */
const playhead = (dim) => page.evaluate((dim) => {
  const r = document.querySelector(`[data-fxb-rail='${dim}']`), track = r.querySelector("svg[data-fxb-track]"), tb = track.getBoundingClientRect(), line = track.querySelector("line.head");
  const v = r.classList.contains("vertical"), c = window.__flux.fluximg.actions.liveContext();
  const n = c.manifest.pixels.shape[c.manifest.pixels.dims.indexOf(dim)], i = c.view.index[dim];
  const want = ((i + 0.5) / n) * (v ? tb.height : tb.width), got = line ? Number(line.getAttribute(v ? "y1" : "x1")) : NaN;
  const flag = r.querySelector("[data-fxb-flag]");
  return { i, n, want, got, flag: flag ? [...flag.children].map((e) => e.textContent.trim()) : null, dots: track.querySelectorAll("circle.dot").length, track: { x: tb.left, y: tb.top, w: tb.width, h: tb.height, v } };
}, dim);
/** A plane's place on a rail's well, in client px. */
const at = (t, i, n) => (t.v ? { x: t.x + t.w / 2, y: t.y + ((i + 0.5) / n) * t.h } : { x: t.x + ((i + 0.5) / n) * t.w, y: t.y + t.h / 2 });
const ctrlZ = () => press("z", ["Control"]);
const ctrlShiftZ = () => press("z", ["Control", "Shift"]);
const hostBox = await rect(".canvas-host");

// =====================================================================================================
await section("opening and closing", async () => {
const S = await fresh("stack_u16", { x: 120, y: 60 }, { width: 320 });
await openLive(S);
m = await model(S);
h.ok(m.live?.elementId === S, "R on one selected image opens its live view");
h.ok(await page.evaluate(() => !!document.querySelector("[data-fluximg-live] canvas.gl")), "the image goes live in place (a WebGL canvas over the element)");
await shot(page, "fluximg-live-open");
await press("r");
h.ok(!(await isOpen()), "R again closes it");
await openLive(S);
await press("Escape");
h.ok(!(await isOpen()), "Esc with nothing in hand closes it");
// Double-click opens (the same door).
const box0 = await page.evaluate((id) => { const F = window.__flux; const el = F.figures()[0].elements.find((e) => e.id === id); const r = document.querySelector(`svg[data-fluximg="${el.assetId}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, S);
await page.mouse.click(box0.x, box0.y, { count: 2 });
await waitFor(page, () => !!document.querySelector("[data-fxb-console]"), null, { label: "double-click opens" }).catch(() => {});
h.ok(await isOpen(), "double-clicking the image opens its live view");
await page.mouse.click(box0.x, box0.y, { count: 2 });
await waitForFrame(page);
h.ok((await isOpen()) && (await model(S)).live?.elementId === S, "…and a double-click on the live image leaves it open");
if (PLOT) {
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), PLOT);
  await waitForFrame(page);
  h.ok(!(await isOpen()), "selecting something else closes it");
  await press("r");
  h.ok(await page.evaluate(() => window.__flux.get(window.__flux.fig.xrayOpen)), "R on a plot still opens the X-ray");
  await press("Escape");
  await waitFor(page, () => !window.__flux.get(window.__flux.fig.xrayOpen), null, { label: "X-ray closed" });
} else h.fail("the demo project has a plot to test R on");
// The keyboard is never left locked: after closing, a canvas shortcut works.
await openLive(S);
await press("r");
await press("h");
h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.activeTool)), "hand", "after closing, a canvas shortcut works again (h = Pan)");
await press("v");
h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.activeTool)), "select", "…and v returns to Select");
// The close key on the board.
await openLive(S);
await page.click(key("close"));
await waitForFrame(page);
h.ok(!(await isOpen()), "the board's close key closes it");
// Locked (or hidden) from elsewhere while open: the view closes rather than keep editing a locked element.
await openLive(S);
await page.evaluate((id) => window.__flux.fig.commit((p) => { p.figures[0].elements.find((e) => e.id === id).locked = true; }), S);
await waitForFrame(page);
h.ok(!(await isOpen()), "locking the image while its live view is open closes the view");
const lockedZ = (await model(S)).el.view?.index?.z ?? null;
await wheel(box0.x, box0.y, 100, 1);
h.eq((await model(S)).el.view?.index?.z ?? null, lockedZ, "…and the wheel no longer edits the locked image");
await page.evaluate((id) => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements.find((e) => e.id === id).locked = false; }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); F.fig.resetHistory(); }, S);
});

// =====================================================================================================
await section("the control board: instruments round the image, no menu", async () => {
const S = await fresh("stack_u16", { x: 120, y: 60 }, { width: 320 });
await page.evaluate((id) => window.__flux.fig.selectOnly(id), S);
await waitForFrame(page);
h.ok(!!(await page.$(".canvas-host .sel-box")), "at rest the selected image wears the selection box");
await openLive(S);
await sleep(320); // debounce: the board fades in over 150 ms; "nothing animating at rest" is measured after it
b = await board();
h.ok(!(await page.$(".fluximgPanel")) && !(await page.$("[role='dialog'][aria-label='Image view']")), "there is no menu panel: the live view is the board");
h.ok(!!b.console && !!b.rails.z && b.rails.z.vertical, "a z-stack gets a console and a standing depth rail");
h.ok(b.rails.z.right <= b.image.x + 0.5 && b.rails.z.left, `the depth rail stands at the image's LEFT, like a y axis (rail right ${b.rails.z.right.toFixed(0)}, image left ${b.image.x.toFixed(0)})`);
h.ok(Math.abs(b.rails.z.y - b.image.y) <= 1 && Math.abs(b.rails.z.h - b.image.h) <= 1, "…exactly as tall as the image");
h.ok(b.console.x >= b.image.right - 0.5 && b.consoleSide === "right" && Math.abs(b.console.y - b.image.y) <= 1, "the console stands at its RIGHT, level with its top");
h.ok(parts(b).every((p) => !overlaps(p, b.image)), "no instrument covers the image");
h.ok(parts(b).every((p, i, all) => all.every((q, k) => k <= i || !overlaps(p, q))), "…and none covers another");
h.ok(parts(b).every((p) => within(p, b.host)), "every instrument is inside the canvas");
h.ok(!(await page.$(".canvas-host .sel-chrome")), "the selection box and its handles step aside while the image is live");
h.eq(await page.evaluate(() => document.getAnimations().length), 0, "nothing animates at rest");
{
  const f = await rect("[data-fxb-frame]");
  h.ok(!!f && Math.abs(f.x - b.image.x) <= 1 && Math.abs(f.y - b.image.y) <= 1 && Math.abs(f.w - b.image.w) <= 1 && Math.abs(f.h - b.image.h) <= 1 && (await page.$$("[data-fxb-frame] .c")).length === 4, "a pink viewfinder frame with four corner marks says the image is live");
  h.ok(await page.evaluate(() => { const c = getComputedStyle(document.querySelector("[data-fxb-frame] .c")).borderTopColor, g = getComputedStyle(document.documentElement).getPropertyValue("--c-guide").trim(); const d = document.createElement("i"); d.style.color = g; document.body.append(d); const want = getComputedStyle(d).color; d.remove(); return c === want; }), "…in the pink of Flux's guides");
}
// The head: the image's name and what it is; no channel count (the strips are the channels).
hd = await head();
h.ok(/7 z/.test(hd.facts.join("|")) && hd.facts.some((f) => /^\d+ × \d+$/.test(f)) && hd.facts.some((f) => /µm\/px$/.test(f)) && !/channel/.test(hd.line), `the console's head says what the image is (${hd.facts.join(" · ")})`);
// Strips: one per channel, each a lamp with its digit, its name, and its histogram with two pink handles.
st = await strips();
h.eq(st.map((x) => [x.lamp, x.name]), [["1", "structure"], ["2", "signal"]], "one strip per channel: a lamp with its digit, and its name");
h.ok(st.every((x) => JSON.stringify(x.plot) === "[1,1,2,2]" && x.range.length === 2), "each strip's histogram is its contrast control: the plot, its outline, two points and two knobs, with the window in numbers");
h.eq(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-keypad] [data-fxb-key]")].map((e) => e.getAttribute("data-fxb-key"))), ["auto", "split", "frame", "inset", "scalebar", "stamp", "channelLabels", "colorbar"], "a row of paper keys: Auto, Split, Frame, Inset, and the four annotations");
h.ok(await page.evaluate(() => { const f = getComputedStyle(document.querySelector("[data-fxb-key='auto'] .face")); const d = document.createElement("i"); d.style.color = getComputedStyle(document.documentElement).getPropertyValue("--flx-paper").trim(); document.body.append(d); const paper = getComputedStyle(d).color; d.remove(); return f.backgroundColor === paper; }), "…with Flux's paper for a face, like the Crystallize offer");
h.ok(!(await page.$("[data-fxb-map]")), "no map while the frame shows the whole image");
// The pointer reads out ON the board: where it is, each channel's value marked on its own histogram, ticks on the frame.
await page.mouse.move(b.image.x + b.image.w * 0.4, b.image.y + b.image.h * 0.5);
await page.mouse.move(b.image.x + b.image.w * 0.4 + 1, b.image.y + b.image.h * 0.5);
await waitFor(page, () => !!document.querySelector("[data-fxb-readout] .where"), null, { label: "readout filled" });
hd = await head();
h.ok(/^x .*µm$/.test(hd.where[0]) && /^y .*µm$/.test(hd.where[1]), `hovering the image says where the pointer is (${hd.where.join("  ")})`);
{
  const probes = await page.evaluate(() => [...document.querySelectorAll("[data-fxb-channel]")].map((s) => ({ line: !!s.querySelector("svg.well path.probe"), text: s.querySelector(".probeval")?.textContent.trim() ?? null })));
  const values = await page.evaluate(() => window.__flux.get(window.__flux.fluximg.live.fluximgReadout).values.map((v) => v.text));
  h.eq(probes.map((p) => p.text), values, `…and marks each channel's value on that channel's own histogram (${values.join(", ")})`);
  h.ok(probes.every((p) => p.line), "…with a tick at the value");
  h.eq((await page.$$("[data-fxb-frame] .t")).length, 4, "four ticks on the frame's edges ride with the pointer");
  const t = await rect("[data-fxb-frame] .t.x"), want = b.image.x + b.image.w * 0.4 + 1;
  h.ok(Math.abs(t.cx - want) <= 1.5, `…at the pointer's place (${t.cx.toFixed(1)} vs ${want.toFixed(1)})`);
}
const consoleBox0 = b.console;
await page.mouse.move(5, 940);
await waitFor(page, () => !document.querySelector("[data-fxb-readout] .where"), null, { label: "readout idle again" });
h.ok((await head()).facts.length >= 3 && !(await page.$("[data-fxb-frame] .t")) && !(await page.$("[data-fxb-channel] .probeval")), "off the image the head says what the image is again, and the ticks are gone");
h.ok(JSON.stringify((await board()).console) === JSON.stringify(consoleBox0), "…and nothing on the board moved or changed size");
// The board's one label: on paper, with the key.
{
  const k = await rect(key("auto"));
  await page.mouse.move(k.cx - 2, k.cy); await page.mouse.move(k.cx, k.cy);
  await waitFor(page, () => !!document.querySelector("[data-fxb] .tip"), null, { label: "the label" });
  const tip = await page.evaluate(() => { const t = document.querySelector("[data-fxb] .tip"); return { text: t.childNodes[0].textContent.trim(), key: t.querySelector("kbd")?.textContent.trim() ?? null, n: document.querySelectorAll("[data-fxb] .tip").length }; });
  h.eq([tip.text, tip.key, tip.n], ["Auto contrast", "A", 1], "resting on a key names it and its hotkey in the board's one label");
  h.ok(await page.evaluate(() => !document.querySelector("[data-fxb] [title]")), "…and nothing on the board uses a browser tooltip");
  await page.mouse.move(5, 940);
  await waitFor(page, () => !document.querySelector("[data-fxb] .tip"), null, { label: "label gone" });
  h.ok(true, "the label leaves with the pointer");
}
h.ok(await page.evaluate(() => [...document.querySelectorAll("[data-fxb], [data-fxb] *, [data-fxb-frame], [data-fxb-frame] *")].every((e) => { const s = getComputedStyle(e); return (s.backdropFilter === "none" || !s.backdropFilter) && (s.filter === "none" || !s.filter); })), "no backdrop-filter or filter anywhere on the board");
{
  const LEFT = new Set([..."123456qwertasdfgzxcvb`", "n"]);
  const keys = await page.evaluate(() => { const A = window.__flux.fluximg.actions, c = A.liveContext(); return { own: Object.values(A.LIVE_KEYS), rails: Object.values(A.dimKeys(c.manifest)) }; });
  h.ok([...keys.own, ...keys.rails].every((k) => LEFT.has(k)), `the board's keys are under the left hand (${[...keys.own, ...keys.rails].join(" ")})`);
  h.eq(new Set([...keys.own, ...keys.rails, "r", "f"]).size, keys.own.length + keys.rails.length + 2, "…each used once, and none takes r (close) or f (properties)");
}
// A key struck from the keyboard goes down on the board too.
{
  await page.keyboard.down("b");
  const struck = await page.evaluate(() => document.querySelector("[data-fxb-key='scalebar']").classList.contains("struck"));
  await page.keyboard.up("b");
  await waitForFrame(page);
  h.ok(struck && (await ctx("(c) => !!c.view.furniture.scalebar")), "a hotkey presses its paper key on the board (b: the scale bar)");
  h.ok(await page.evaluate(() => document.querySelector("[data-fxb-key='scalebar']").classList.contains("on")), "…which stays lit while its annotation is shown");
  await press("b");
}
// A press on the frame's corner marks, or in the narrow gap between the image and an instrument, is the board's:
// it must not fall through to the canvas, which would take it for a click elsewhere and close the view.
{
  const bb = await board(), mark = await rect("[data-fxb-frame] .c.tl");
  await page.mouse.click(mark.x + 2, mark.y + 2);
  h.ok(await isOpen(), "a press on a corner mark of the frame does not close the view");
  await page.mouse.click((bb.image.right + bb.console.x) / 2, bb.image.y + 40);
  h.ok(await isOpen(), "…nor does one in the narrow gap between the image and the console");
  await page.mouse.click((bb.rails.z.right + bb.image.x) / 2, bb.image.y + 40);
  h.ok(await isOpen(), "…or between the rail and the image");
  const z0 = await idx(S, "z");
  await wheel((bb.image.right + bb.console.x) / 2, bb.image.y + 40, 100, 1);
  await settled();
  h.eq(await idx(S, "z"), z0 + 1, "the wheel in that gap still steps planes");
  await press("z", ["Control"]);
  await page.mouse.click(bb.image.cx ?? (bb.image.x + bb.image.w / 2), bb.image.bottom + 200);
  await waitForFrame(page);
  h.ok(!(await isOpen()), "a click well away from the board, on the canvas, still closes the view");
  await openLive(S);
  await page.mouse.move(5, 940);
}
await shot(page, "fluximg-live-board");
await closeLive();
await page.evaluate((id) => window.__flux.fig.selectOnly(id), S);
await waitForFrame(page);
h.ok(!!(await page.$(".canvas-host .sel-box")), "after closing, the selection box is back");
await page.evaluate(() => window.__flux.fig.resetHistory());
});

// =====================================================================================================
await section("rails", async () => {
const S = await fresh("stack_u16", { x: 120, y: 60 }, { width: 320 });
await openLive(S);
image = await rect("[data-fluximg-live]");
h.ok(!(await page.$("[data-fxb-rail]:not(.vertical)")), "a z-stack has no lying rail (no time, no extra dimension)");
ph = await playhead("z");
h.ok(Math.abs(ph.want - ph.got) <= 0.6, `the pink playhead sits at the model's plane (z ${ph.i}: ${ph.got.toFixed(1)} vs ${ph.want.toFixed(1)})`);
h.eq(ph.flag?.[0], String(ph.i + 1), "its paper flag says the plane's number");
h.ok(/µm$/.test(ph.flag?.[1] ?? ""), `…and where that is (${ph.flag?.[1]})`);
h.eq(ph.dots, 2, "a dot rides each shown channel's trace on the playhead");
h.ok(await page.evaluate(() => document.querySelector("[data-fxb-rail='z'] .unit")?.textContent.trim() === "µm"), "the scale's unit is said once");
// Wheel down over the image: the NEXT plane; a run of notches is one undo step.
before = await model(S);
await wheel(image.cx, image.cy, 100, 1);
await settled();
h.eq(await idx(S, "z"), ph.i + 1, "wheel down over the image moves to the next plane");
after = await model(S);
h.eq(after.past - before.past, 1, "…as one undo step");
before = after;
await wheel(image.cx, image.cy, -100, 3);
await settled();
h.eq(await idx(S, "z"), Math.max(0, ph.i + 1 - 3), "three notches up move three planes back");
after = await model(S);
h.eq(after.past - before.past, 1, "…and the run of notches is ONE undo step");
h.ok(JSON.stringify(await rect("[data-fluximg-live]")) === JSON.stringify(image), "the image does not move or change size while stepping planes");
ph = await playhead("z");
h.ok(Math.abs(ph.want - ph.got) <= 0.6 && ph.flag[0] === String(ph.i + 1), "the playhead and its flag follow the wheel");
// The wheel over the rail itself steps it too.
{
  const z0 = await idx(S, "z");
  await wheel(ph.track.x + ph.track.w / 2, ph.track.y + ph.track.h * 0.8, 100, 2);
  await settled();
  h.eq(await idx(S, "z"), z0 + 2, "the wheel over the rail steps its planes");
  await press("z", ["Control"]);
}
// Wheel scope: what the view holds by itself answers over the image and the board only; elsewhere the canvas pans.
const zBefore = await idx(S, "z"), vp0 = await vpNow();
const empty = { x: image.cx, y: image.bottom + 240 };
await wheel(empty.x, empty.y, 100, 1);
await waitForFrame(page);
const vp1 = await vpNow();
h.ok(vp1.panY !== vp0.panY && (await idx(S, "z")) === zBefore, `with the rail held by the view, the wheel over empty canvas pans the canvas (panY ${vp0.panY} -> ${vp1.panY}) and leaves the plane`);
await page.evaluate((v) => window.__flux.fig.viewport.set(v), vp0);
await waitForFrame(page);
h.eq((await model(S)).explicit, false, "…the view's own hold is not something taken in hand");
await press("z");
h.ok((await model(S)).explicit && (await model(S)).live.armed === "pos:z", "the rail's key takes it in hand");
await wheel(empty.x, empty.y, 100, 1);
await settled();
h.ok((await idx(S, "z")) === Math.min(6, zBefore + 1) && JSON.stringify(await vpNow()) === JSON.stringify(vp0), "…and then the wheel anywhere steps the plane (and the canvas stays)");
await press("z", ["Control"]);
// Dragging on the rail scrubs: one undo step, and the view's hold stays the view's own.
ph = await playhead("z");
before = await model(S);
p0 = at(ph.track, 1, ph.n); p1 = at(ph.track, 5, ph.n);
await page.mouse.move(p0.x, p0.y); await page.mouse.down();
await page.mouse.move(p0.x, (p0.y + p1.y) / 2, { steps: 4 });
const mid = await idx(S, "z");
await page.mouse.move(p1.x, p1.y, { steps: 4 }); await page.mouse.up();
await waitForFrame(page);
h.ok(mid === 3 && (await idx(S, "z")) === 5, `dragging on the rail scrubs through the planes (mid-drag z ${mid}, released on 5)`);
after = await model(S);
h.eq(after.past - before.past, 1, "…and the whole scrub is ONE undo step");
h.eq(after.explicit, false, "…and scrubbing with the mouse takes nothing in hand (the wheel off the image is still the canvas's)");
// The flag is a handle too: take it and scrub.
{
  ph = await playhead("z");
  const f = await rect("[data-fxb-rail='z'] [data-fxb-flag]"), to = at(ph.track, 2, ph.n), m0 = await model(S);
  await drag({ x: f.cx, y: f.cy }, { x: f.cx, y: to.y });
  h.eq(await idx(S, "z"), 2, "dragging the playhead's flag scrubs too");
  h.eq((await model(S)).past - m0.past, 1, "…as one undo step");
  await press("z", ["Control"]);
  h.eq(await idx(S, "z"), 5, "(undone)");
}
// The rail names the plane under the pointer before you go there.
{
  const p = at(ph.track, 1, ph.n);
  await page.mouse.move(p.x - 1, p.y); await page.mouse.move(p.x, p.y);
  await waitFor(page, () => !!document.querySelector("[data-fxb-railcursor]"), null, { label: "the rail's cursor flag" });
  h.eq(await page.evaluate(() => document.querySelector("[data-fxb-railcursor] b")?.textContent.trim()), "2", "resting on the rail names the plane under the pointer");
  await page.mouse.move(5, 940);
}
// Arrows: down / up through depth.
await press("ArrowDown");
h.eq(await idx(S, "z"), 6, "ArrowDown goes one plane deeper");
await press("ArrowUp"); await press("ArrowUp");
h.eq(await idx(S, "z"), 4, "ArrowUp goes back up");
await settled();
// Shift+drag on the rail draws a projection run, and the picture changes.
const g0 = await glStats();
ph = await playhead("z");
p0 = at(ph.track, 1, ph.n); p1 = at(ph.track, 4, ph.n);
await page.keyboard.down("Shift");
await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move(p1.x, p1.y, { steps: 5 }); await page.mouse.up();
await page.keyboard.up("Shift");
await sharpFrame(); await waitForFrame(page);
proj = (await resolved(S)).view.projection;
h.eq(proj && [proj.dim, proj.from, proj.to], ["z", 1, 5], "Shift+drag on the rail draws a projection run over the planes it covers");
const g1 = await glStats();
h.ok(differs(g0, g1, 0.5), `…and the image changes (mean RGB ${g0 && [g0.r, g0.g, g0.b].map((v) => v.toFixed(1))} -> ${g1 && [g1.r, g1.g, g1.b].map((v) => v.toFixed(1))})`);
h.ok(await page.evaluate(() => !!document.querySelector("[data-fxb-rail='z'] rect.band") && document.querySelectorAll("[data-fxb-rail='z'] rect.grip").length === 2), "the run shows as a pink band with a grip at each end");
h.eq(await page.evaluate(() => [...document.querySelector("[data-fxb-rail='z'] [data-fxb-flag]").children].map((e) => e.textContent.trim()).slice(0, 2)), ["max", "2–5"], "…and the flag says the statistic and the planes");
h.ok(await page.evaluate(() => document.querySelector("[data-fxb-key='project:z']").classList.contains("on") && !document.querySelector("[data-fxb-key='play:z']")), "the projection key is lit, and a projected dimension offers no play key");
// The run's edge resizes it; its middle slides it.
p0 = at(ph.track, 1, ph.n); p0.y = ph.track.y + (1 / ph.n) * ph.track.h + 1; // just inside the run's start edge
p1 = at(ph.track, 0, ph.n);
await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move(p1.x, p1.y, { steps: 4 }); await page.mouse.up();
await waitForFrame(page);
proj = (await resolved(S)).view.projection;
h.eq(proj && [proj.from, proj.to], [0, 5], "dragging the run's start edge resizes it");
p0 = at(ph.track, 2, ph.n); p1 = at(ph.track, 4, ph.n);
await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move(p1.x, p1.y, { steps: 4 }); await page.mouse.up();
await waitForFrame(page);
proj = (await resolved(S)).view.projection;
h.eq(proj && [proj.from, proj.to], [2, 7], "dragging the run's middle slides it (and it stops at the end)");
// The chooser: what the planes of a run become.
await press("e");
h.eq(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-rail='z'] [data-fxb-chooser] .chip")].map((c) => `${c.querySelector("kbd").textContent.trim()}:${c.childNodes[1].textContent.trim()}${c.classList.contains("on") ? "*" : ""}`)), ["1:off", "2:max*", "3:mean", "4:min", "5:sum", "6:std"], "e opens the projection chooser on the rail, the current statistic lit");
await press("3");
h.ok((await resolved(S)).view.projection?.mode === "mean" && !(await page.$("[data-fxb-chooser]")), "a chip's number picks it (3 = mean) and the chooser closes");
h.eq((await model(S)).live.armed, "run:z", "…with the run in hand: the wheel grows and shrinks it");
await page.click(key("project:z"));
await waitFor(page, () => !!document.querySelector("[data-fxb-chooser]"), null, { label: "chooser from the key" });
await press("Escape");
h.ok((await isOpen()) && !(await page.$("[data-fxb-chooser]")), "the projection key opens the chooser too; Esc closes the chooser, not the view");
await press("e"); await press("1");
h.eq((await resolved(S)).view.projection, null, "e then 1 returns from the projection to one plane");
// Picked with the mouse, nothing is taken in hand; the wheel over the run's band sizes it, off the band it slides it.
{
  await page.click(key("project:z"));
  await waitFor(page, () => !!document.querySelector("[data-fxb-rail='z'] [data-fxb-chooser] .chip"), null, { label: "chooser" });
  await page.click("[data-fxb-rail='z'] [data-fxb-chooser] .chip:nth-child(2)");
  await sharpFrame();
  m = await model(S);
  proj = (await resolved(S)).view.projection;
  h.ok(proj?.mode === "max" && proj.from === 0 && proj.to === 7 && !m.explicit && m.live.armed === "pos:z", "a chip clicked with the mouse projects the whole dimension and takes nothing in hand");
  const tr = await rect("[data-fxb-rail='z'] svg[data-fxb-track]");
  await wheel(tr.cx, tr.cy, 100, 1);
  await settled();
  proj = (await resolved(S)).view.projection;
  h.eq([proj.from, proj.to], [1, 6], "the wheel over the run's band sizes the run about its middle");
  await wheel(tr.cx, tr.y + (0.5 / 7) * tr.h, 100, 1);
  await settled();
  proj = (await resolved(S)).view.projection;
  h.eq([proj.from, proj.to], [2, 7], "…and off the band, on the same rail, it slides the run");
  await press("e"); await press("1");
  h.eq((await resolved(S)).view.projection, null, "(back to one plane)");
}
h.ok(!!(await page.$(key("play:z"))), "…and the play key is back");
await closeLive();

const MOV = await fresh("movie_f32", { x: 120, y: 60 }, { width: 320 });
await openLive(MOV);
image = await rect("[data-fluximg-live]");
b = await board();
h.ok(!!b.rails.t && !b.rails.t.vertical && b.rails.t.y >= b.image.bottom - 0.5 && Math.abs(b.rails.t.x - b.image.x) <= 1, "a t dimension gives a lying rail UNDER the image, like an x axis");
h.ok(!(await page.$("[data-fxb-rail].vertical")), "…and no standing rail without z");
h.ok(parts(b).every((p) => !overlaps(p, b.image) && within(p, b.host)) && !overlaps(b.console, b.rails.t), "the console, the rail and the image keep clear of each other, inside the canvas");
await press("ArrowRight");
h.eq(await idx(MOV, "t"), 1, "ArrowRight steps time forward");
await press("ArrowLeft");
h.eq(await idx(MOV, "t"), 0, "ArrowLeft steps time back");
await settled();
await wheel(image.cx, image.cy, 100, 1, ["Shift"]);
await settled();
h.eq(await idx(MOV, "t"), 10, "Shift+wheel moves 10 planes");
ph = await playhead("t");
h.ok(Math.abs(ph.want - ph.got) <= 0.6, `the lying rail's playhead sits at the model's frame (t ${ph.i})`);
{
  const ticks = await page.evaluate(() => [...document.querySelectorAll("[data-fxb-rail='t'] .tick")].map((t) => t.textContent.trim()));
  const period = await ctx("(c) => c.manifest.axes.t.scale");
  h.ok(ticks.length >= 2 && ticks.every((t) => /^-?−?[\d.]+$/.test(t)), `the scale is in the axis' own unit, at round values (${ticks.join(", ")}; one frame is ${period} s)`);
}
// The speed dial.
{
  const speed = () => page.evaluate(() => window.__flux.get(window.__flux.fluximg.live.fluximgLive).speed);
  h.eq([await speed(), await page.evaluate(() => document.querySelector("[data-fxb-rail='t'] .dial")?.textContent.trim())], [1, "1×"], "the dial under the play key starts at the movie's own speed");
  await page.click("[data-fxb-rail='t'] .dial");
  h.eq([await speed(), await page.evaluate(() => document.querySelector("[data-fxb-rail='t'] .dial")?.textContent.trim())], [2, "2×"], "a click on the dial is the next speed");
  const d = await rect("[data-fxb-rail='t'] .dial");
  await wheel(d.cx, d.cy, 100, 2);
  h.eq(await speed(), 0.5, "…and the wheel over it turns it both ways");
  await wheel(d.cx, d.cy, -100, 1);
  h.eq(await speed(), 1, "…back to 1×");
}
await closeLive();

const TRI = await fresh("trials_f32", { x: 120, y: 60 }, { width: 320 });
await openLive(TRI);
b = await board();
h.eq(Object.keys(b.rails).sort(), ["t", "trial"], "t and an extra dimension each get a lying rail");
h.ok(b.rails.t.y >= b.image.bottom - 0.5 && b.rails.t.bottom <= b.rails.trial.y + 0.5, "…under the image, one under the other");
await press("ArrowRight");
h.eq([await idx(TRI, "t"), await idx(TRI, "trial")], [1, 0], "arrows are spatial: left / right step the first lying rail (time)");
h.ok(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-rail='trial'] .tick")].some((t) => /[a-z]/i.test(t.textContent))), "a dimension of named positions is ticked by name");
await closeLive();
});

// =====================================================================================================
await section("channels: the strips", async () => {
const S = await fresh("stack_u16", { x: 120, y: 60 }, { width: 320 });
await openLive(S);
image = await rect("[data-fluximg-live]");
// The strip's plot is the pixels ON SCREEN: it changes with the plane; the whole image's stays behind it.
{
  await press("ArrowUp", ["Shift"]); await settled(); await sharpFrame(); await waitForFrame(page); await waitForFrame(page);
  await sleep(260); // debounce: the strip counts the pixels on screen in the browser's next idle moment (at most 200 ms on)
  const top = await strips();
  await press("ArrowDown"); await press("ArrowDown"); await press("ArrowDown"); await settled(); await sharpFrame(); await waitForFrame(page); await waitForFrame(page);
  await waitFor(page, (was) => (document.querySelector("[data-fxb-channel='0'] svg.well path.in")?.getAttribute("d") ?? "") !== was, top[0].front, { label: "the strip's plot following the plane", timeout: 3000 }).catch(() => {});
  const midp = await strips();
  h.ok(top[0].front && midp[0].front && top[0].front !== midp[0].front, "a strip's histogram is of the pixels on screen: it changes as you move through the stack");
  h.ok(top[0].stack && top[0].stack === midp[0].stack && top[0].stack !== top[0].front, "…over the whole image's own outline, which stays");
}
// Auto reads the pixels in view: two planes of different brightness give two different windows.
await press("ArrowUp", ["Shift"]); await settled(); await sharpFrame();
await press("a");
const autoTop = await windows();
await press("ArrowDown"); await press("ArrowDown"); await press("ArrowDown"); await settled(); await sharpFrame(); await waitForFrame(page);
await press("a");
const autoMid = await windows();
h.ok(autoTop !== autoMid, `Auto takes its window from the pixels in view (plane 1: ${autoTop}; plane 4: ${autoMid})`);
// Resting on the Auto key shows where it would put every channel's points, before anything changes.
{
  const k = await rect(key("auto")), w0 = await windows();
  await page.mouse.move(k.cx - 2, k.cy); await page.mouse.move(k.cx, k.cy);
  await waitFor(page, () => document.querySelectorAll("[data-fxb-channel] line.ghost").length >= 2, null, { label: "Auto's preview" });
  h.eq(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-channel]")].map((s) => s.querySelectorAll("line.ghost").length)), [2, 2], "resting on Auto draws, on every strip, the two points it would set");
  h.eq(await windows(), w0, "…and changes nothing until it is pressed");
  await page.mouse.move(5, 940);
  await waitFor(page, () => !document.querySelector("[data-fxb-channel] line.ghost"), null, { label: "preview gone" });
}
// The handles: drag the white knob left; drag between the points to slide the window. Each drag is one undo step,
// and working a strip with the mouse takes nothing in hand.
c0 = await chanOf(S, 0);
before = await model(S);
{
  const wk = await rect(`${strip(0)} .knob[data-fxb-knob='white']`), well = await rect(`${strip(0)} svg.well`);
  await drag({ x: wk.cx, y: well.cy }, { x: wk.cx - 50, y: well.cy });
}
c1 = await chanOf(S, 0);
after = await model(S);
h.ok(c1.range[1] < c0.range[1] && c1.range[0] === c0.range[0], `dragging the white handle lowers the white point (${c0.range[1]} -> ${c1.range[1]}), the black point stays`);
h.eq(after.past - before.past, 1, "…as one undo step");
h.ok(!after.explicit && after.live.armed === "pos:z" && !(await strips())[0].hand, "…and the channel is not taken in hand: the wheel over the image still steps planes");
h.eq((await strips())[0].range, c1.range.map((v) => String(v)), "the strip's numbers are the window");
{
  // A knob hangs half below the plot: it is grabbed anywhere on it, not only on the half inside the plot.
  const wk = await rect(`${strip(0)} .knob[data-fxb-knob='white']`), well = await rect(`${strip(0)} svg.well`);
  const r0 = (await chanOf(S, 0)).range;
  await drag({ x: wk.cx, y: wk.bottom - 1.5 }, { x: wk.cx - 20, y: wk.bottom - 1.5 });
  h.ok(wk.bottom - 1.5 > well.bottom && (await chanOf(S, 0)).range[1] < r0[1], `a knob is grabbed anywhere on it, also on the half that hangs below the plot (${r0[1]} -> ${(await chanOf(S, 0)).range[1]})`);
  await press("z", ["Control"]);
  h.eq((await chanOf(S, 0)).range, r0, "(undone)");
}
c0 = c1; before = after;
{
  const well = await rect(`${strip(0)} svg.well`), bk = await rect(`${strip(0)} .knob[data-fxb-knob='black']`), wk = await rect(`${strip(0)} .knob[data-fxb-knob='white']`);
  const from = { x: (bk.cx + wk.cx) / 2, y: well.y + well.h * 0.25 };
  await drag(from, { x: from.x + 24, y: from.y });
}
c1 = await chanOf(S, 0); after = await model(S);
h.ok(c1.range[0] > c0.range[0] && Math.abs((c1.range[1] - c1.range[0]) - (c0.range[1] - c0.range[0])) <= 1, `dragging between the points slides the window (${c0.range.join("..")} -> ${c1.range.join("..")})`);
h.eq(after.past - before.past, 1, "…as one undo step");
// The wheel over a strip's plot moves the NEARER point.
{
  const well = await rect(`${strip(0)} svg.well`), bk = await rect(`${strip(0)} .knob[data-fxb-knob='black']`), wk = await rect(`${strip(0)} .knob[data-fxb-knob='white']`);
  const r0 = (await chanOf(S, 0)).range, m0 = await model(S);
  await wheel(wk.cx - 6, well.cy, -100, 3);
  await settled();
  const r1 = (await chanOf(S, 0)).range;
  h.ok(r1[1] > r0[1] && r1[0] === r0[0], `the wheel over the plot near the white point raises the white point (${r0[1]} -> ${r1[1]})`);
  h.eq((await model(S)).past - m0.past, 1, "…as one undo step");
  await wheel(bk.cx + 6, well.cy, -100, 2);
  await settled();
  const r2 = (await chanOf(S, 0)).range;
  h.ok(r2[0] > r1[0] && r2[1] === r1[1], `…and near the black point, the black point (${r1[0]} -> ${r2[0]})`);
  h.eq((await model(S)).live.armed, "pos:z", "…with nothing taken in hand");
}
// Double-click on the plot: Auto for that channel alone.
{
  const well = await rect(`${strip(1)} svg.well`), w0 = await windows();
  await page.mouse.click(well.cx, well.cy, { count: 2 });
  await waitForFrame(page);
  const w1 = await windows();
  h.ok(w0.split(" | ")[0] === w1.split(" | ")[0] && w0.split(" | ")[1] !== w1.split(" | ")[1] && (await isOpen()), `a double-click on a strip's plot sets that channel's contrast alone (${w0.split(" | ")[1]} -> ${w1.split(" | ")[1]})`);
}
// A typed value.
{
  const m0 = await model(S);
  await page.click(`${strip(0)} .num.b`);
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.type("123");
  await press("Enter");
  h.eq((await chanOf(S, 0)).range[0], 123, "a click on the black point's number lets you type it; Enter sets it");
  h.eq((await model(S)).past - m0.past, 1, "…as one undo step");
  h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)), "…and the keyboard is the board's again");
  await page.click(`${strip(0)} .num.w`);
  await page.keyboard.type("77777");
  await press("Escape");
  h.ok((await chanOf(S, 0)).range[1] !== 77777 && (await isOpen()), "Esc in the field drops what was typed and leaves the view open");
}
// The lamp is the switch.
g = await glStats();
await page.click(`${strip(0)} .lamp`);
h.eq((await chanOf(S, 0)).visible, false, "a click on a channel's lamp hides it in the model");
await waitForFrame(page); await waitForFrame(page);
g2 = await glStats();
h.ok(differs(g, g2), "…and in the picture");
h.ok((await strips())[0].off, "…and its strip goes dim, its lamp a ring");
await press("1", ["Shift"]);
h.eq((await chanOf(S, 0)).visible, true, "Shift + its digit shows it again");
await waitForFrame(page); await waitForFrame(page);
g = await glStats();
await press("1", ["Alt"]);
h.eq(await compOf(), { composite: "single", solo: 0 }, "Alt + its digit shows that channel alone");
await sharpFrame(); await waitForFrame(page); await waitForFrame(page);
g2 = await glStats();
h.ok(differs(g, g2), "…and the picture shows that channel alone");
await press("1", ["Alt"]);
h.eq((await compOf()).composite, "blend", "Alt + its digit again returns to the composite");
await waitForFrame(page); await waitForFrame(page);
// Take a channel in hand: its digit. The strip is lit; the wheel anywhere moves its white point; asked again, the next point.
await press("1");
m = await model(S);
h.ok(m.live.channel === 0 && m.live.armed === "white" && m.explicit && (await strips())[0].hand, "a channel's digit takes it in hand: its strip is lit and its white point is what the wheel drives");
h.eq(await page.evaluate(() => document.querySelector("[data-fluximg-live]").getAttribute("data-mode")), "pull", "…and the image says a drag on it will pull that channel's contrast");
c0 = await chanOf(S, 0); before = await model(S);
await wheel(image.cx, image.cy, -100, 3);
await settled();
c1 = await chanOf(S, 0);
h.ok(c1.range[1] > c0.range[1] && c1.range[0] === c0.range[0], `the wheel over the image raises its white point (${c0.range[1]} -> ${c1.range[1]})`);
h.eq((await model(S)).past - before.past, 1, "…as one undo step");
await press("1");
h.eq((await model(S)).live.armed, "black", "its digit again: the black point");
await press("1");
h.eq((await model(S)).live.armed, "gamma", "…and again: gamma");
await press("1");
h.eq((await model(S)).live.armed, "white", "…and round to the white point");
{
  // Dragging on the image pulls contrast: right narrows the window about its centre; the window never leaves what
  // the channel holds. One undo step per drag.
  const r0 = (await chanOf(S, 0)).range, m0 = await model(S);
  await page.mouse.move(image.cx, image.cy); await page.mouse.down();
  await page.mouse.move(image.cx + 40, image.cy, { steps: 4 }); await page.mouse.move(image.cx + 80, image.cy, { steps: 4 });
  await waitForFrame(page);
  const midr = (await chanOf(S, 0)).range;
  await page.mouse.up();
  await waitForFrame(page);
  const r1 = (await chanOf(S, 0)).range, m1 = await model(S);
  h.ok(r1[1] - r1[0] < r0[1] - r0[0] && Math.abs((r1[0] + r1[1]) / 2 - (r0[0] + r0[1]) / 2) <= 1, `with a channel in hand, dragging right on the image narrows its window about its centre (${r0.join("..")} -> ${r1.join("..")})`);
  h.ok(midr[1] - midr[0] < r0[1] - r0[0], "…while the pointer is still down (the picture follows the hand)");
  h.ok(Number.isInteger(r1[0]) && Number.isInteger(r1[1]), "…in whole numbers for integer data");
  h.ok(m1.past - m0.past === 1 && (await isOpen()), "…as one undo step");
  const stats = await page.evaluate(() => { const s = window.__flux.fluximg.actions.liveContext().manifest.channels[0].stats; return [s.min, s.max]; });
  await page.mouse.move(image.cx, image.cy); await page.mouse.down();
  await page.mouse.move(image.cx, image.cy + 300, { steps: 6 }); await page.mouse.move(image.cx - 600, image.cy + 600, { steps: 6 });
  await page.mouse.up();
  await waitForFrame(page);
  const r2 = (await chanOf(S, 0)).range;
  h.ok(r2[0] >= Math.min(stats[0], r1[0]) && r2[1] <= Math.max(stats[1], r1[1]) && r2[1] > r2[0], `a long pull never takes the window outside the channel's values (${r2.join("..")} within ${stats.join("..")})`);
  await press("z", ["Control"]); await press("z", ["Control"]);
  await waitForFrame(page);
  h.eq((await chanOf(S, 0)).range, r0, "two undos put the window back");
}
// Auto with a channel in hand is that channel's; its ladder comes round.
{
  const other0 = (await chanOf(S, 1)).range.join("..");
  const ladder = [];
  for (let i = 0; i < 5; i++) { await press("a"); ladder.push((await chanOf(S, 0)).range.join("..")); }
  h.ok(new Set(ladder.slice(0, 4)).size === 4 && ladder[4] === ladder[0], `with a channel in hand, a cycles the Auto ladder for it (${ladder.join(" | ")})`);
  h.eq((await chanOf(S, 1)).range.join(".."), other0, "…and leaves the other channel alone");
}
await press("Escape");
m = await model(S);
h.ok((await isOpen()) && m.live.armed === "pos:z" && !m.explicit && !(await strips())[0].hand, "Esc lets the channel go (the view stays open, the rail is the view's own hold again)");
// A click on a channel's name takes it in hand; a click on the name of the one in hand lets it go.
{
  await page.click(`${strip(1)} .name`);
  m = await model(S);
  h.ok(m.live.channel === 1 && m.live.armed === "white" && m.explicit && (await strips())[1].hand, "a click on a channel's name takes it in hand");
  await page.click(`${strip(1)} .name`);
  m = await model(S);
  h.ok(m.live.armed === "pos:z" && !m.explicit && !(await strips())[1].hand, "…and a click on it again lets it go");
  await page.mouse.move(5, 940);
}
// The strip's own keys appear when it is wanted: the curve, the colour drawer, only-this.
{
  const name = await rect(`${strip(0)} .name`);
  await page.mouse.move(name.cx - 2, name.cy); await page.mouse.move(name.cx, name.cy);
  await waitFor(page, () => !!document.querySelector("[data-fxb-channel='0'].busy .keys button"), null, { label: "the strip's keys" });
  h.eq(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-channel='0'] .keys button")].map((x) => x.getAttribute("aria-label").split(" · ")[0])), ["Auto contrast", "Linear", "Colour", "Only this channel"], "resting on a strip brings out its own keys: Auto, the curve, Colour, Only this");
  h.ok(await page.evaluate(() => getComputedStyle(document.querySelector("[data-fxb-channel='1'] .keys")).display === "none"), "…and a strip that is not wanted keeps them away (its name has the room)");
  await page.click(`${strip(0)} .keys button:nth-child(3)`);
  await waitFor(page, () => document.querySelectorAll("[data-fxb-channel='0'] .drawer .sw").length >= 9, null, { label: "the colour drawer" });
  g = await glStats();
  await page.click(`${strip(0)} .drawer .sw[aria-label='cyan']`);
  h.eq((await chanOf(S, 0)).color, "#00ffff", "Colour opens a drawer of swatches in the strip; a swatch sets the colour");
  await waitForFrame(page); await waitForFrame(page);
  g2 = await glStats();
  h.ok(differs(g, g2), "…and the picture takes it");
  h.ok(await page.evaluate(() => document.querySelector("[data-fxb-channel='0'] .drawer .sw[aria-label='cyan']").classList.contains("cur")), "…and the swatch it wears is ringed");
  g = g2;
  await page.click(`${strip(0)} .drawer button[aria-label='Invert']`);
  h.eq((await chanOf(S, 0)).invert, true, "the drawer's Invert key inverts the channel");
  await waitForFrame(page); await waitForFrame(page);
  h.ok(differs(g, await glStats()), "…and the picture changes");
  await page.click(`${strip(0)} .drawer button[aria-label='Back to how the image came']`);
  const back = await chanOf(S, 0);
  h.ok(back.color === "#ff00ff" && !back.invert && !(await page.$(`${strip(0)} .drawer`)), "…and its last key puts the channel back to how the image came (and shuts the drawer)");
  // The curve: click through linear, log, gamma; pull the dot to bend it.
  await page.mouse.move(name.cx, name.cy);
  await page.click(`${strip(0)} .keys button:nth-child(2)`);
  h.eq((await chanOf(S, 0)).norm, "log", "the curve key steps linear → log");
  await page.click(`${strip(0)} .keys button:nth-child(2)`);
  h.eq((await chanOf(S, 0)).norm, "gamma", "…→ gamma");
  await page.click(`${strip(0)} .keys button:nth-child(2)`);
  h.eq((await chanOf(S, 0)).norm, "linear", "…→ linear");
  const dot = await rect(`${strip(0)} svg.well circle.bend`), m0 = await model(S);
  h.ok(!!dot, "the transfer curve shows on the plot with a dot at its middle");
  await drag({ x: dot.cx, y: dot.cy }, { x: dot.cx, y: dot.cy - 12 });
  const bent = await chanOf(S, 0);
  h.ok(bent.norm === "gamma" && bent.gamma < 1, `pulling the dot up bends the curve: gamma ${bent.gamma}`);
  h.eq((await model(S)).past - m0.past, 1, "…as one undo step");
  await press("z", ["Control"]);
  h.eq((await chanOf(S, 0)).norm, "linear", "…which undo straightens again");
  await page.mouse.move(5, 940);
}
// Split: the key previews where its panels would go; pressing it makes them, LINKED to the image, in one undo step.
await page.mouse.move(5, 940);
const imgs0 = await countImages(); before = await model(S);
{
  const k = await rect(key("split"));
  await page.mouse.move(k.cx - 2, k.cy); await page.mouse.move(k.cx, k.cy);
  await waitFor(page, () => document.querySelectorAll(".fx-preview").length >= 2, null, { label: "Split's preview" });
  const pv = await page.evaluate(() => [...document.querySelectorAll(".fx-preview")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, label: e.textContent.trim() }; }));
  h.eq(pv.map((p) => p.label), ["structure", "signal"], "resting on Split draws, on the figure, the panel each channel would get");
  h.eq((await countImages()).length, imgs0.length, "…and makes nothing until it is pressed");
  const imgPv = await rect("[data-fluximg-live]");
  await page.mouse.down(); await page.mouse.up();
  await waitForFrame(page);
  await sleep(120); // the board measures, then may ask the view for room (F4: boardFit after a split)
  const imgs1 = await countImages(); after = await model(S);
  const made = imgs1.filter((e) => !imgs0.some((o) => o.id === e.id));
  h.ok(made.length === 2 && made.every((e, i) => e.composite === "single" && e.solo === i), `the Split key makes one solo panel per channel (${made.length})`);
  const where = await page.evaluate((ids) => ids.map((id) => { const r = document.querySelector(`[data-editor-element-id="${id}"]`)?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; }), made.map((e) => e.id));
  // Measured against the image (F4: the view may have made room for them after the press, so screen positions move
  // with the figure; where the panels stand ON the figure is what the preview promised).
  const imgAfter = await rect("[data-fluximg-live]"), sc = imgAfter.w / imgPv.w;
  h.ok(where.every((w, i) => w && Math.abs((w.x - imgAfter.x) - (pv[i].x - imgPv.x) * sc) <= 1.5 && Math.abs((w.y - imgAfter.y) - (pv[i].y - imgPv.y) * sc) <= 1.5 && Math.abs(w.w - pv[i].w * sc) <= 1.5), "…exactly where the preview showed them");
  h.ok(await inFigure(made.map((e) => e.id)), "…each inside the figure (a figure clips what lies outside it)");
  h.ok(after.past - before.past === 1 && (await isOpen()) && after.live.elementId === S && !(await page.$(".fx-preview")), "…in one undo step, with the view still on the image and the preview gone");
  const link = after.el.view?.link ?? null;
  h.ok(!!link && made.every((e) => e.link === link), `…and the panels are linked to the composite (${link})`);
  // Stepping a plane on the composite moves every linked panel.
  const zOf = (id) => page.evaluate((id) => window.__flux.figures()[0].elements.find((e) => e.id === id)?.view?.index?.z ?? null, id);
  await page.mouse.move(5, 940);
  await press("ArrowDown"); await settled();
  const zs = [await zOf(S), ...(await Promise.all(made.map((e) => zOf(e.id))))];
  h.ok(zs[0] !== null && zs.every((z) => z === zs[0]), `stepping a plane on one linked panel moves all of them (z ${zs.join(", ")})`);
  // Dragging channel 1's white point on the composite sets the single-channel panel's window too.
  const wk = await rect(`${strip(0)} .knob[data-fxb-knob='white']`), well = await rect(`${strip(0)} svg.well`);
  await drag({ x: wk.cx, y: well.cy }, { x: wk.cx - 40, y: well.cy });
  const rangeOf = (id) => page.evaluate((id) => JSON.stringify(window.__flux.figures()[0].elements.find((e) => e.id === id)?.view?.channels?.[0]?.range ?? null), id);
  const r0 = await rangeOf(S), r1 = await rangeOf(made[0].id);
  h.ok(r0 !== "null" && r0 === r1, `dragging channel 1's white point on the composite sets the linked channel-1 panel's window (${r0} / ${r1})`);
  await closeLive();
  await page.evaluate((ids) => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => !ids.includes(e.id)); }); F.fig.resetHistory(); }, made.map((e) => e.id));
}
});

// =====================================================================================================
await section("the board keeps clear of the image and of itself, wherever the image is", async () => {
for (const [label, fixture, width, zoom, patch, at, expect] of [
  ["t and z", "tz_u16", 320, 1, {}, { x: 200, y: 60 }, "depth-left time-below console-right"],
  ["t and z, small", "tz_u16", 150, 1, {}, { x: 200, y: 60 }, "depth-left time-below"],
  ["z at zoom 0.3", "stack_u16", 320, 0.3, {}, { x: 600, y: 300 }, "depth-left console-right"],
  ["z rotated 90 degrees", "stack_u16", 320, 1, { rotation: 90 }, { x: 200, y: 60 }, "depth-left"],
  ["z at the canvas's left edge", "stack_u16", 300, 1, {}, { x: -210, y: 60 }, "depth-right console-right"],
  ["z at the canvas's right edge", "stack_u16", 300, 1, {}, { x: Math.round(hostBox.w - 240 - 300 - 40), y: 60 }, "depth-left console-left"],
  ["t at the canvas's bottom edge", "movie_f32", 320, 1, {}, { x: 200, y: Math.round(hostBox.h - 110 - 213 - 30) }, "time-above"],
  ["a wide, low movie", "line_u16", 520, 1, {}, { x: 120, y: 60 }, "time-below console-below"],
]) {
  await page.evaluate(() => { const F = window.__flux; F.fluximg.live.closeFluximgLive(); F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); });
  const id = await placeFixture(fixture, at, { width, patch });
  await page.evaluate((zoom) => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom }), zoom);
  await waitStill(id);
  await openLive(id);
  await page.mouse.move(5, 940); // the pointer off the board
  await sleep(120); // debounce: the console is measured, then placed, over two frames
  await waitForFrame(page);
  const c = await board(), all = parts(c);
  h.ok(all.every((p, i) => all.every((q, k) => k <= i || !overlaps(p, q))), `${label}: no instrument covers another`);
  h.ok(all.every((p) => !overlaps(p, c.image)), `${label}: no instrument covers the image`);
  h.ok(all.every((p) => within(p, c.host)), `${label}: every instrument is inside the canvas`);
  h.ok(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-rail] [data-fxb-flag]")].every((f) => { const r = f.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (f.contains(hit) || hit.closest("[data-fxb-rail]") === f.closest("[data-fxb-rail]")); })), `${label}: every rail's flag is in view (nothing lies on top of it)`);
  const z = c.rails.z, t = c.rails.t;
  if (expect.includes("depth-left")) h.ok(!!z && z.right <= c.image.x + 0.5, `${label}: depth stands at the image's left`);
  if (expect.includes("depth-right")) h.ok(!!z && z.x >= c.image.right - 0.5 && !z.left, `${label}: with no room at the left, depth stands at the image's right`);
  if (expect.includes("time-below")) h.ok(!!t && t.y >= c.image.bottom - 0.5, `${label}: time lies under the image`);
  if (expect.includes("time-above")) h.ok(!!t && t.bottom <= c.image.y + 0.5, `${label}: with no room below, time lies above the image`);
  if (expect.includes("console-right")) h.ok(c.console.x >= c.image.right - 0.5 && (!z || z.left || c.console.x >= z.right - 0.5), `${label}: the console stands at the right (outside the depth rail when that is there too)`);
  if (expect.includes("console-left")) h.ok(c.console.right <= c.image.x + 0.5 && c.consoleSide === "left", `${label}: with no room at the right, the console stands at the left`);
  if (expect.includes("console-below")) h.ok(c.consoleSide === "below" && c.console.y >= t.bottom - 0.5 && Math.abs(c.console.x - c.image.x) <= 1, `${label}: the console stands under the image and its rail, from the image's left edge`);
  if (label === "t and z") await shot(page, "fluximg-live-t-and-z");
  if (label === "a wide, low movie") await shot(page, "fluximg-live-wide");
}
// An image that fills the canvas: the instruments stand over its edges, inside the canvas, clear of each other.
{
  await page.evaluate(() => { const F = window.__flux; F.fluximg.live.closeFluximgLive(); F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); });
  const id = await placeFixture("tz_u16", { x: 100, y: 60 }, { width: 320 });
  await waitStill(id);
  await page.evaluate(() => window.__flux.fig.viewport.set({ panX: -900, panY: -500, zoom: 9 }));
  await openLive(id);
  await page.mouse.move(5, 940);
  await sleep(120); // debounce: the console is measured, then placed, over two frames
  const c = await board(), all = parts(c);
  h.ok(all.every((p) => within(p, c.host)) && all.every((p, i) => all.every((q, k) => k <= i || !overlaps(p, q))), "an image that fills the canvas: every instrument is inside the canvas and none covers another (they stand over the image's edges)");
  await shot(page, "fluximg-live-fill");
  await closeLive();
  await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
}
});

// =====================================================================================================
await section("layers and objects (mean_f64_layers)", async () => {
const L = await fresh("mean_f64_layers", { x: 300, y: 60 }, { width: 330 });
await openLive(L);
image = await rect("[data-fluximg-live]");
// Float data: the black point wheeled up into the white point stops below it; the window never collapses (an empty
// window is invalid, and the view fell back to the default window: the picture jumped and the next notch started from there).
{
  const white0 = (await chanOf(L, 0)).range[1];
  await page.click(`${strip(0)} .num.b`);
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.type(String(Math.floor((white0 - 0.08) * 100) / 100));
  await press("Enter");
  await press("1"); await press("1");
  h.eq((await model(L)).live.armed, "black", "(the black point in hand)");
  await wheel(image.cx, image.cy, -100, 3);
  await settled();
  c1 = await chanOf(L, 0);
  h.ok(c1.range[0] < c1.range[1] && c1.range[0] > white0 - 0.1 && c1.range[1] === white0, `float data: wheeling the black point into the white point stops just below it (${c1.range.join(" .. ")}; white ${white0})`);
  await press("Escape");
}
b = await board();
h.ok(!!b.layers && !overlaps(b.layers, b.image) && !overlaps(b.layers, b.console) && within(b.layers, b.host), "an image with layers gets a layers card, clear of the image and the console");
const layerIds = await page.evaluate(() => window.__flux.fluximg.actions.liveContext().manifest.layers.map((l) => l.id));
const rowIds = () => page.evaluate(() => [...document.querySelectorAll("[data-fxb-layers] .row[data-rid]")].map((e) => e.getAttribute("data-rid")));
rows = await rowIds();
h.ok(layerIds.every((id) => rows.includes(`layer:${id}`)), `a row for every layer (${layerIds.join(", ")})`);
h.ok(!rows.some((r) => r.startsWith("obj:")), "object layers start closed");
const visOf = (id) => page.evaluate((id) => window.__flux.fluximg.actions.liveContext().view.layers.find((l) => l.id === id).visible, id);
{
  const v0 = await visOf("footprints");
  await page.click("[data-fxb-layers] .row[data-rid='layer:footprints'] .lamp");
  h.eq(await visOf("footprints"), !v0, "a layer's lamp shows and hides it in the model");
  h.ok(await page.evaluate((on) => !!document.querySelector("[data-fluximg-live] [data-layer='footprints']") === on, !v0), "…and on the live image");
  h.ok(await page.evaluate((off) => document.querySelector("[data-fxb-layers] .row[data-rid='layer:footprints']").classList.contains("off") === off, v0), "…and the row dims with it");
  await page.click("[data-fxb-layers] .row[data-rid='layer:footprints'] .lamp");
  h.eq(await visOf("footprints"), v0, "…and again puts it back");
}
await page.click("[data-fxb-layers] .row[data-rid='layer:footprints'] .name");
await waitFor(page, () => document.querySelectorAll("[data-fxb-layers] .row[data-rid^='obj:footprints/']").length > 0, null, { label: "footprints open" });
rows = await rowIds();
const objRows = rows.filter((r) => r.startsWith("obj:footprints/"));
h.ok(objRows.length >= 3, `a click on an object layer opens it: its objects by name (${objRows.length})`);
await waitFor(page, () => [...document.querySelectorAll("[data-fxb-layers] .row.colhead .cell")].length > 0, null, { label: "table columns", timeout: 5000 }).catch(() => {});
const cols = await page.evaluate(() => [...document.querySelectorAll("[data-fxb-layers] .row.colhead .cell")].map((e) => e.textContent.trim()));
h.ok(cols.length >= 1 && cols.length <= 2, `…with the first columns of their table, named once above them (${cols.join(", ")})`);
h.ok(await page.evaluate((n) => [...document.querySelectorAll("[data-fxb-layers] .row.obj")].every((r) => r.querySelectorAll(".cell").length === n && [...r.querySelectorAll(".cell")].every((c) => c.textContent.trim().length > 0)), cols.length), "…and each object's row carries just its values");
b = await board();
h.ok(!overlaps(b.layers, b.image) && within(b.layers, b.host) && parts(b).every((p, i, all) => all.every((q, k) => k <= i || !overlaps(p, q))), "the opened card still covers nothing and stays inside the canvas");
// Row -> image: hovering a row lights the object on the image.
const firstObj = objRows[0], firstKey = firstObj.split("/").slice(1).join("/");
const rowBox = await rect(`[data-fxb-layers] .row[data-rid='${firstObj}']`);
await page.mouse.move(rowBox.cx - 2, rowBox.cy); await page.mouse.move(rowBox.cx, rowBox.cy);
await waitFor(page, () => !!document.querySelector("[data-fluximg-live] .fx-hot"), null, { label: "the object lit on the image", timeout: 3000 }).catch(() => {});
h.eq(await page.evaluate(() => document.querySelector("[data-fluximg-live] .fx-hot")?.getAttribute("data-key") ?? null), firstKey, "resting on an object's row lights that object on the image");
// Image -> row and the pointer's card.
const other = objRows[objRows.length - 1], otherKey = other.split("/").slice(1).join("/");
await page.mouse.move(5, 5);
const shapeAt = await page.evaluate((k) => { const s = [...document.querySelectorAll("[data-fluximg-live] [data-key]")].find((e) => e.getAttribute("data-key") === k && e.closest("[data-layer]")?.getAttribute("data-layer") === "footprints"); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.getAttribute("data-key") ?? null }; }, otherKey);
if (shapeAt) {
  await page.mouse.move(shapeAt.x - 2, shapeAt.y - 1); await page.mouse.move(shapeAt.x, shapeAt.y, { steps: 3 });
  await waitFor(page, (rid) => !!document.querySelector(`[data-fxb-layers] .row.hot[data-rid='${rid}']`), other, { label: "row lit", timeout: 3000 }).catch(() => {});
  h.ok(await page.evaluate((rid) => !!document.querySelector(`[data-fxb-layers] .row.hot[data-rid='${rid}']`), other), `resting on an object on the image lights its row (${otherKey}; hit-test found ${shapeAt.hit})`);
  await waitFor(page, () => !!document.querySelector("[data-fxb-card]"), null, { label: "the pointer's card", timeout: 3000 }).catch(() => {});
  const card = await page.evaluate(() => { const c = document.querySelector("[data-fxb-card]"); if (!c) return null; const r = c.getBoundingClientRect(); return { name: c.querySelector("b")?.textContent.trim(), layer: c.querySelector(".of")?.textContent.trim(), cells: c.querySelectorAll(".cell:not(.vals)").length, vals: c.querySelectorAll(".vals span").length, x: r.left, y: r.top, events: getComputedStyle(c).pointerEvents }; });
  h.ok(!!card && card.name === otherKey && !!card.layer, `…and a card beside the pointer names it and its layer (${card?.name} · ${card?.layer})`);
  h.ok(!!card && card.cells >= 1 && card.vals >= 1, `…with its table's values and the pixel's (${card?.cells} columns, ${card?.vals} channels)`);
  h.ok(!!card && card.events === "none" && Math.hypot(card.x - shapeAt.x, card.y - shapeAt.y) < 60, "…near the pointer, never in its way");
  h.eq(await page.evaluate(() => document.querySelector("[data-fxb-readout] .obj")?.textContent.trim()), otherKey, "…and the console's head names it too");
  await shot(page, "fluximg-live-object");
  await page.mouse.move(5, 5);
  await waitFor(page, () => !document.querySelector("[data-fxb-card]"), null, { label: "card gone", timeout: 3000 }).catch(() => {});
  h.ok(!(await page.$("[data-fxb-card]")), "the card leaves with the pointer");
} else h.fail(`the object ${otherKey} is drawn on the live image`);
// A layer's opacity is the small dial on its row: roll the wheel over it, or drag it sideways.
{
  const row = await rect("[data-fxb-layers] .row[data-rid='layer:footprints']");
  await page.mouse.move(row.x + 60, row.cy - 1); await page.mouse.move(row.x + 62, row.cy);
  await waitFor(page, () => getComputedStyle(document.querySelector("[data-fxb-layers] .row[data-rid='layer:footprints'] .pct")).display !== "none", null, { label: "the opacity dial" });
  const dial = await rect("[data-fxb-layers] .row[data-rid='layer:footprints'] .pct");
  const op = () => page.evaluate(() => window.__flux.fluximg.actions.liveContext().view.layers.find((l) => l.id === "footprints").opacity);
  const o0 = await op(), m0 = await model(L);
  await wheel(dial.cx, dial.cy, 100, 3);
  await settled();
  const o1 = await op();
  h.ok(o1 < o0, `the wheel over a layer's opacity dial turns it down (${o0} -> ${o1})`);
  h.eq((await model(L)).past - m0.past, 1, "…as one undo step");
  h.eq(await page.evaluate(() => document.querySelector("[data-fxb-layers] .row[data-rid='layer:footprints'] .pct")?.textContent.trim()), `${Math.round(o1 * 100)}%`, "…and the dial reads it");
  const m1 = await model(L);
  await drag({ x: dial.cx, y: dial.cy }, { x: dial.cx - 30, y: dial.cy });
  const o2 = await op();
  h.ok(Math.abs(o2 - (o1 - 0.3)) < 0.011, `dragging the dial sideways turns it too (${o1} -> ${o2} over 30 px)`);
  h.eq((await model(L)).past - m1.past, 1, "…as one undo step");
  await press("z", ["Control"]); await press("z", ["Control"]);
  h.eq(await op(), o0, "…and two undos put it back");
  // The wheel over the list itself still scrolls it (or does nothing): it never changes a layer.
  await wheel(row.x + 60, row.cy, 100, 2);
  await sleep(480); // debounce: past the wheel's 420 ms settle, so a stray change would show
  h.eq(await op(), o0, "the wheel over the rest of a row changes nothing (the list is the list's to scroll)");
}
// The keyboard: d hands the card the keys; it walks, toggles, names; Esc takes them back.
await page.mouse.move(5, 940);
h.ok(!(await page.$("[data-fxb-layers].keys")), "working the card with the mouse never takes the keyboard from the board");
{
  const on0 = await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar);
  await press("b");
  h.ok((await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar)) !== on0, "…so after a click on a lamp the board's keys still work (b: the scale bar)");
  await press("b");
}
await press("d");
h.ok(!!(await page.$("[data-fxb-layers].keys")), "d hands the layers card the keyboard (it is outlined pink)");
{
  const sel0 = await page.evaluate(() => document.querySelector("[data-fxb-layers] .row.sel")?.getAttribute("data-rid"));
  await press("ArrowDown");
  const sel1 = await page.evaluate(() => document.querySelector("[data-fxb-layers] .row.sel")?.getAttribute("data-rid"));
  h.ok(!!sel0 && !!sel1 && sel0 !== sel1, `the arrows walk its rows (${sel0} -> ${sel1})`);
  await page.click("[data-fxb-layers] .row[data-rid='layer:footprints'] .name");
  await page.click("[data-fxb-layers] .row[data-rid='layer:footprints'] .name"); // (click toggles open; twice = back as it was, cursor on it)
  const v0 = await visOf("footprints");
  await press("x");
  h.eq(await visOf("footprints"), !v0, "x shows or hides the row's layer");
  await press("x");
  await press("q");
  h.ok(await page.evaluate(() => (window.__flux.fluximg.actions.liveContext().view.furniture.names?.layers ?? []).includes("footprints")), "q turns the layer's names on in the model");
  await waitFor(page, () => !!document.querySelector("[data-fluximg-live] [data-part='names'] text"), null, { label: "names drawn", timeout: 3000 }).catch(() => {});
  h.ok(await page.evaluate(() => document.querySelectorAll("[data-fluximg-live] [data-part='names'] text").length > 0), "…and draws the names on the image");
  await press("q");
  h.ok(await page.evaluate(() => !document.querySelector("[data-fluximg-live] [data-part='names']")), "q again removes them");
  await press("c");
  h.ok(await page.evaluate(() => document.querySelectorAll("[data-fxb-layers] .drawer .sw").length >= 6), "c opens the layer's colour drawer");
  await press("Escape");
  h.ok(!!(await page.$("[data-fxb-layers].keys")) && !(await page.$("[data-fxb-layers] .drawer")), "Esc shuts the drawer and the card keeps the keys");
  // The filter.
  await press("a");
  h.ok(await page.evaluate(() => document.activeElement === document.querySelector("[data-fxb-layers] .find input")), "a puts the caret in the filter");
  await page.keyboard.type(firstKey);
  await waitForFrame(page);
  rows = await rowIds();
  const objAfter = rows.filter((r) => r.startsWith("obj:"));
  h.ok(objAfter.length >= 1 && objAfter.length < objRows.length && objAfter.includes(firstObj), `the filter narrows the list (${objAfter.length} objects match '${firstKey}')`);
  await press("Enter");
  h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)), "Enter hands the keyboard back from the filter");
  await press("a");
  await press("Escape");
  h.ok(await page.evaluate(() => document.querySelector("[data-fxb-layers] .find input")?.value === "" && document.activeElement === document.querySelector("[data-fxb-layers] .find input")), "Esc in the filter clears it first");
  await press("Escape");
  h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)) && (await isOpen()), "Esc in the empty filter hands the keyboard back");
  await press("Escape");
  h.ok((await isOpen()) && !(await page.$("[data-fxb-layers].keys")), "Esc gives the keys back to the board");
  const zBeforeKeys = await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar);
  await press("b");
  h.ok((await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar)) !== zBeforeKeys, "…whose keys work again (b: the scale bar)");
  await press("b");
}
await closeLive();
});

// =====================================================================================================
await section("the frame: a viewport onto the image, its map, and pulling out an inset", async () => {
const L = await fresh("mean_f64_layers", { x: 300, y: 60 }, { width: 330 });
await openLive(L);
image = await rect("[data-fluximg-live]");
h.eq(await page.evaluate(() => document.querySelector("[data-fluximg-live]").getAttribute("data-mode")), "read", "with the whole image in its frame, a drag on it does nothing by itself");
await press("v");
h.ok((await model(L)).live.armed === "zoom" && (await model(L)).explicit && !!(await page.$("[data-fxb-frame].hand")) && (await page.evaluate(() => document.querySelector("[data-fxb-key='frame']").classList.contains("on"))), "v takes the frame in hand: its key is lit and the viewfinder's corners thicken into handles");
h.ok(!!(await page.$("[data-fxb-map]")), "…and the map appears in the console");
let e0 = (await model(L)).el;
const full = await page.evaluate(() => { const m = window.__flux.fluximg.actions.liveContext().manifest; const n = m.pixels.shape.length; return { w: m.pixels.shape[n - 1], h: m.pixels.shape[n - 2] }; });
const u = 0.3, v = 0.4, px = image.x + u * image.w, py = image.y + v * image.h;
before = await model(L);
await wheel(px, py, -100, 3);
await settled();
let e1 = (await model(L)).el;
h.ok(!!e1.crop && e1.crop.width < full.w && e1.crop.height < full.h, `wheel up over the image zooms the frame in (crop ${e1.crop && [e1.crop.x, e1.crop.y, e1.crop.width, e1.crop.height].map((n) => n.toFixed(1)).join(", ")})`);
h.eq([e1.x, e1.y, e1.width, e1.height], [e0.x, e0.y, e0.width, e0.height], "…without changing the element's box");
const fixedX = e1.crop.x + u * e1.crop.width, fixedY = e1.crop.y + v * e1.crop.height;
h.ok(Math.abs(fixedX - u * full.w) < 0.75 && Math.abs(fixedY - v * full.h) < 0.75, `…about the pointer (the image point under it stays put: ${fixedX.toFixed(2)}, ${fixedY.toFixed(2)} vs ${(u * full.w).toFixed(2)}, ${(v * full.h).toFixed(2)})`);
h.eq((await model(L)).past - before.past, 1, "…as one undo step");
h.ok(JSON.stringify(await rect("[data-fluximg-live]")) === JSON.stringify(image), "the live image keeps its place and size while zooming");
before = await model(L);
await page.mouse.move(image.cx, image.cy); await page.mouse.down();
await page.mouse.move(image.cx - 20, image.cy - 10, { steps: 3 }); await page.mouse.move(image.cx - 40, image.cy - 20, { steps: 3 }); await page.mouse.up();
await waitForFrame(page);
let e2 = (await model(L)).el;
h.ok(e2.crop.x > e1.crop.x && e2.crop.y > e1.crop.y && Math.abs(e2.crop.width - e1.crop.width) < 1e-9, `dragging moves the image under the frame, following the hand (x ${e1.crop.x.toFixed(1)} -> ${e2.crop.x.toFixed(1)})`);
h.eq([e2.x, e2.y, e2.width, e2.height], [e0.x, e0.y, e0.width, e0.height], "…and the box stays put");
h.eq((await model(L)).past - before.past, 1, "…as one undo step");
{
  // The map: the whole image, small, with the frame on it; dragging the frame's rectangle moves the frame.
  await waitFor(page, () => !!document.querySelector("[data-fluximg-navigator] img"), null, { label: "the map's picture", timeout: 5000 }).catch(() => {});
  const nav = await rect("[data-fluximg-navigator]"), fr = await rect("[data-fluximg-navigator] .frame");
  h.ok(!!nav && nav.w <= 233 && nav.h <= 133 && Math.abs(nav.w / nav.h - full.w / full.h) < 0.03 && !!(await page.$("[data-fluximg-navigator] img")), `the map shows the whole image, small (${nav && [nav.w, nav.h].map((n) => n.toFixed(0)).join(" x ")} px)`);
  h.ok(!!fr && Math.abs(fr.w / nav.w - e2.crop.width / full.w) < 0.02 && Math.abs((fr.x - nav.x) / nav.w - e2.crop.x / full.w) < 0.02, "…with the frame's rectangle where the frame is");
  h.ok(/×$/.test(await page.evaluate(() => document.querySelector("[data-fxb-map] .zoomwords")?.textContent.trim() ?? "")) && /px$/.test(await page.evaluate(() => document.querySelector("[data-fxb-map] .showing")?.textContent.trim() ?? "")), "…how far in it is, and how many pixels it shows");
  const m0 = await model(L);
  const dxMap = Math.min(8, Math.floor(nav.right - fr.right) - 1), dyMap = Math.min(5, Math.floor(nav.bottom - fr.bottom) - 1);
  await page.mouse.move(fr.cx, fr.cy); await page.mouse.down();
  await page.mouse.move(fr.cx + dxMap / 2, fr.cy + dyMap / 2, { steps: 2 }); await page.mouse.move(fr.cx + dxMap, fr.cy + dyMap, { steps: 2 });
  await page.mouse.up();
  await waitForFrame(page);
  const m1 = await model(L);
  const wantX = e2.crop.x + (dxMap / nav.w) * full.w, wantY = e2.crop.y + (dyMap / nav.h) * full.h;
  h.ok(dxMap > 0 && Math.abs(m1.el.crop.x - wantX) < 1 && Math.abs(m1.el.crop.y - wantY) < 1 && Math.abs(m1.el.crop.width - e2.crop.width) < 1e-9, `dragging the rectangle on the map moves the frame with it (x ${e2.crop.x.toFixed(1)} -> ${m1.el.crop.x.toFixed(1)}, wanted ${wantX.toFixed(1)})`);
  h.eq([m1.el.x, m1.el.y, m1.el.width, m1.el.height], [e0.x, e0.y, e0.width, e0.height], "…the element's box stays put");
  h.eq(m1.past - m0.past, 1, "…as one undo step");
  // The wheel over the map zooms about the frame's middle.
  const w0 = m1.el.crop.width;
  await wheel(nav.cx, nav.cy, -100, 2);
  await settled();
  h.ok((await model(L)).el.crop.width < w0, "the wheel over the map zooms the frame");
  await press("z", ["Control"]);
  // True pixels.
  const smooth0 = await ctx("(c) => c.view.smooth");
  await press("n");
  h.eq(await ctx("(c) => c.view.smooth"), !smooth0, "n switches between true pixels and smoothed ones");
  h.ok(await page.evaluate((on) => document.querySelector("[data-fxb-key='pixels']").classList.contains("on") === on, smooth0), "…and the map's pixel key is lit for true pixels");
  await press("n");
}
await press("Escape");
h.ok((await isOpen()) && (await model(L)).live.armed === null && !(await page.$("[data-fxb-frame].hand")) && !!(await model(L)).el.crop && !!(await page.$("[data-fxb-map]")), "Esc lets the frame go: it stays where it is, and the map stays while the frame is zoomed in");
h.eq(await page.evaluate(() => document.querySelector("[data-fluximg-live]").getAttribute("data-mode")), "pan", "…and a drag on the image still moves it under the frame");
await press("v", ["Shift"]);
h.ok(!(await model(L)).el.crop, "Shift+V (Whole image) restores the whole frame");
{ const bx = (await model(L)).el; h.ok([bx.x - e0.x, bx.y - e0.y, bx.width - e0.width, bx.height - e0.height].every((d) => Math.abs(d) < 1e-6), `…in the box the image has: it neither moves nor grows on the figure (${[bx.x, bx.y, bx.width, bx.height].map((n) => n.toFixed(1)).join(", ")})`); }
h.ok(!(await page.$("[data-fxb-map]")), "…and the map leaves with it");
// An inset: x, then drag a box on the image.
{
  image = await rect("[data-fluximg-live]");
  const m0 = await model(L), n0 = await page.evaluate((id) => window.__flux.figures()[0].elements.filter((e) => e.view?.insetOf === id).length, L);
  await press("x");
  h.ok((await model(L)).live.armed === "inset" && (await model(L)).past === m0.past && (await page.evaluate(() => document.querySelector("[data-fxb-key='inset']").classList.contains("on"))), "x takes the inset tool in hand: its key is lit, nothing is made yet");
  h.eq(await page.evaluate(() => document.querySelector("[data-fluximg-live]").getAttribute("data-mode")), "inset", "…and the image says a drag on it will draw one");
  await page.mouse.move(image.x + 0.2 * image.w, image.y + 0.25 * image.h); await page.mouse.down();
  await page.mouse.move(image.x + 0.3 * image.w, image.y + 0.4 * image.h, { steps: 3 }); await page.mouse.move(image.x + 0.4 * image.w, image.y + 0.5 * image.h, { steps: 3 });
  await waitForFrame(page);
  const guide = await rect("[data-fluximg-live] .vec .draw");
  h.ok(!!guide && Math.abs(guide.w - 0.2 * image.w) < 2 && Math.abs(guide.h - 0.25 * image.h) < 2, `while it is drawn the rectangle shows as a pink guide (${guide && [guide.w, guide.h].map((n) => n.toFixed(0)).join(" x ")} px)`);
  await page.mouse.up();
  await waitForFrame(page);
  const m1 = await model(L);
  const drawn = await page.evaluate((id) => window.__flux.figures()[0].elements.filter((e) => e.view?.insetOf === id), L);
  const d = drawn[drawn.length - 1];
  h.eq(drawn.length - n0, 1, "releasing makes one inset: a new element that remembers its parent");
  h.ok(Math.abs(d.crop.x - 0.2 * full.w) < 1.5 && Math.abs(d.crop.y - 0.25 * full.h) < 1.5 && Math.abs(d.crop.width - 0.2 * full.w) < 1.5 && Math.abs(d.crop.height - 0.25 * full.h) < 1.5, `…of the rectangle drawn (${[d.crop.x, d.crop.y, d.crop.width, d.crop.height].map((n) => n.toFixed(1)).join(", ")} of ${full.w} x ${full.h})`);
  h.ok(!m1.el.crop, "…and the image keeps its own frame");
  h.ok(Math.abs(d.width / d.height - d.crop.width / d.crop.height) < 1e-6 && (await inFigure([d.id])), "…at its region's aspect, inside the figure");
  h.eq(m1.past - m0.past, 1, "…in one undo step");
  h.ok((await isOpen()) && m1.live?.armed !== "inset" && !(await page.$("[data-fluximg-live] .vec .draw")), "…and the tool is let go, the guide gone (one inset per ask)");
  await waitFor(page, () => !!document.querySelector("[data-fluximg-live] [data-part='inset']"), null, { label: "inset outline on the live image", timeout: 3000 }).catch(() => {});
  h.ok(await page.evaluate(() => !!document.querySelector("[data-fluximg-live] [data-part='inset']")), "the parent draws the inset's rectangle in the live view");
  h.ok(await page.evaluate((a) => !!document.querySelector(`svg[data-fluximg="${a}"] [data-part='inset']`), m1.el.assetId), "…and at rest");
  // The inset's region on the picture: drag its rectangle's edge and the inset shows what is under it; roll to size it.
  {
    await waitFor(page, (id) => !!document.querySelector(`[data-fxb-region="${id}"]`), d.id, { label: "the region's handle" });
    await sleep(120);
    image = await rect("[data-fluximg-live]"); // F4: the view may have made room for the new inset (boardFit)
    const insetCrop = () => page.evaluate((id) => structuredClone(window.__flux.figures()[0].elements.find((e) => e.id === id).crop), d.id);
    const insetBox = () => page.evaluate((id) => { const e = window.__flux.figures()[0].elements.find((x) => x.id === id); return [e.x, e.y, e.width, e.height]; }, d.id);
    const c0i = await insetCrop(), box0 = await insetBox(), m0r = await model(L), k = full.w / image.w;
    // The rectangle's top edge, at its middle, in screen px (from the model: the whole image is in the frame).
    const edge = { x: image.x + ((c0i.x + c0i.width / 2) / full.w) * image.w, y: image.y + (c0i.y / full.h) * image.h };
    await drag(edge, { x: edge.x + 20, y: edge.y + 14 }, { hold: true });
    const mid = await insetCrop();
    await page.mouse.up(); await waitForFrame(page);
    const c1i = await insetCrop();
    h.ok(Math.abs(c1i.x - (c0i.x + 20 * k)) < 1 && Math.abs(c1i.y - (c0i.y + 14 * k)) < 1 && Math.abs(c1i.width - c0i.width) < 1e-9 && Math.abs(c1i.height - c0i.height) < 1e-9, `dragging the rectangle's edge moves the inset's region with the hand (${c0i.x.toFixed(1)}, ${c0i.y.toFixed(1)} -> ${c1i.x.toFixed(1)}, ${c1i.y.toFixed(1)})`);
    h.ok(Math.abs(mid.x - c1i.x) < 1, "…while the pointer is still down");
    h.eq(await insetBox(), box0, "…and the inset's own box on the figure does not move");
    h.eq((await model(L)).past - m0r.past, 1, "…as one undo step");
    // Inside the rectangle the image still answers the pointer.
    const inside = { x: image.x + ((c1i.x + c1i.width / 2) / full.w) * image.w, y: image.y + ((c1i.y + c1i.height / 2) / full.h) * image.h };
    await page.mouse.move(inside.x - 2, inside.y); await page.mouse.move(inside.x, inside.y);
    await waitFor(page, () => !!document.querySelector("[data-fxb-readout] .where"), null, { label: "readout inside the region", timeout: 3000 }).catch(() => {});
    h.ok(!!(await page.$("[data-fxb-readout] .where")), "inside the rectangle the image still reads out (only its edge is a handle)");
    const edge2 = { x: image.x + ((c1i.x + c1i.width / 2) / full.w) * image.w, y: image.y + (c1i.y / full.h) * image.h };
    await wheel(edge2.x, edge2.y, -100, 2);
    await settled();
    const c2i = await insetCrop();
    h.ok(c2i.width < c1i.width && Math.abs(c2i.width / c2i.height - c1i.width / c1i.height) < 1e-6 && Math.abs((c2i.x + c2i.width / 2) - (c1i.x + c1i.width / 2)) < 0.01, `the wheel over the edge sizes the region about its middle, keeping its shape (${c1i.width.toFixed(1)} -> ${c2i.width.toFixed(1)} px wide)`);
    await press("z", ["Control"]); await press("z", ["Control"]);
    h.eq(await insetCrop(), c0i, "…and two undos put the region back");
    await page.mouse.move(5, 940);
  }
  // x twice with the frame zoomed in: the frame as it is becomes the inset, and the image shows all of itself again.
  await press("v"); await wheel(px, py, -100, 4); await settled();
  const frame = (await model(L)).el.crop, m2 = await model(L);
  await press("x"); await press("x");
  await waitForFrame(page);
  const m3 = await model(L);
  const insets = await page.evaluate((id) => window.__flux.figures()[0].elements.filter((e) => e.view?.insetOf === id), L);
  const last = insets[insets.length - 1];
  h.ok(insets.length - drawn.length === 1 && Math.abs(last.crop.x - frame.x) < 1e-6 && Math.abs(last.crop.width - frame.width) < 1e-6, "with the frame zoomed in, x twice pulls the frame out as it is");
  h.ok(!m3.el.crop && m3.past - m2.past === 1, "…and the image shows the whole of itself again, in one undo step");
  await press("Escape");
}
await closeLive();
});

// =====================================================================================================
await section("annotations: paper keys, dragged between corners, drawn alike live and at rest", async () => {
const MV = await fresh("movie_f32", { x: 120, y: 60 }, { width: 360 });
await openLive(MV);
image = await rect("[data-fluximg-live]");
const ann = [["b", "scalebar"], ["w", "stamp"], ["c", "channelLabels"], ["g", "colorbar"]];
for (const [k, kind] of ann) {
  await press(k);
  h.ok(await page.evaluate((kd) => !!window.__flux.fluximg.actions.liveContext().view.furniture[kd], kind) && (await page.evaluate((kd) => document.querySelector(`[data-fxb-key='${kd}']`).classList.contains("on"), kind)), `${k} turns the ${kind} on, and its key lights`);
}
{
  const corner = (k) => page.evaluate((k) => window.__flux.fluximg.actions.liveContext().view.furniture[k].corner, k);
  const c0b = await corner("scalebar"), m0 = await model(MV);
  const seen = [c0b];
  for (let i = 0; i < 4; i++) { await press("B", ["Shift"]); seen.push(await corner("scalebar")); }
  h.ok(new Set(seen.slice(0, 4)).size === 4 && seen[4] === c0b, `Shift + its key walks an annotation round the four corners and back (${seen.join(" -> ")})`);
  h.ok(await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar), "…without switching it off");
  h.ok((await model(MV)).past > m0.past, "…as undo steps");
  // Take hold of it on the picture and put it in another corner.
  await waitFor(page, () => !!document.querySelector("[data-fxb-grip='scalebar']"), null, { label: "the scale bar's grip" });
  const grip = await rect("[data-fxb-grip='scalebar']");
  const bar = await rect("[data-fluximg-live] [data-part='scalebar']");
  h.ok(!!grip && !!bar && grip.x <= bar.x && grip.right >= bar.right && grip.y <= bar.y + 1, "an annotation that is shown has a grip over it on the picture");
  const m1 = await model(MV);
  await drag({ x: grip.cx, y: grip.cy }, { x: image.x + image.w * 0.15, y: image.y + image.h * 0.2 }, { hold: true });
  h.eq(await corner("scalebar"), "top-left", "dragging it toward another corner puts it there while the pointer is still down");
  h.eq((await page.$$("[data-fxb-frame] .slot")).length, 4, "…with the four corners marked while it is carried");
  h.ok(await page.evaluate(() => document.querySelectorAll("[data-fxb-frame] .slot.on").length === 1), "…the one it would land in lit");
  await page.mouse.move(image.x + image.w * 0.85, image.y + image.h * 0.2, { steps: 4 });
  await waitForFrame(page);
  h.eq(await corner("scalebar"), "top-right", "…and it follows to the next corner");
  await page.mouse.up();
  await waitForFrame(page);
  const m2 = await model(MV);
  h.ok((await corner("scalebar")) === "top-right" && m2.past - m1.past === 1 && !(await page.$("[data-fxb-frame] .slot")), "released, it stays; the whole carry is ONE undo step and the marks are gone");
  const bar2 = await rect("[data-fluximg-live] [data-part='scalebar']");
  h.ok(bar2.cx > image.cx && bar2.cy < image.cy, "…and the scale bar is drawn in the top-right of the picture");
  await press("z", ["Control"]);
  h.eq(await corner("scalebar"), c0b, "…which one undo puts back");
}
// The wheel over an annotation on the picture: the scale bar steps through round lengths, text by half points.
{
  const stored = () => page.evaluate((id) => window.__flux.figures()[0].elements.find((e) => e.id === id).view?.furniture?.scalebar?.length ?? null, MV);
  const barW = async () => (await rect("[data-fluximg-live] [data-part='scalebar']")).w;
  let grip = await rect("[data-fxb-grip='scalebar']");
  await page.mouse.move(grip.cx - 2, grip.cy); await page.mouse.move(grip.cx, grip.cy);
  await waitFor(page, () => !!document.querySelector("[data-fxb] .tip"), null, { label: "the grip's label" });
  h.ok(/corner/.test(await page.evaluate(() => document.querySelector("[data-fxb] .tip").textContent)) && /length/.test(await page.evaluate(() => document.querySelector("[data-fxb] .tip").textContent)), "resting on the scale bar says it can be dragged to a corner and rolled for its length");
  const w0 = await barW(), m0 = await model(MV);
  h.eq(await stored(), null, "the scale bar starts at the length the picture picks, and stores none");
  await wheel(grip.cx, grip.cy, -100, 1);
  await settled(); await waitForFrame(page); await waitForFrame(page);
  const l1 = await stored(), w1 = await barW();
  h.ok(l1 !== null && w1 > w0 * 1.5, `the wheel up over the scale bar makes it the next round length (${l1}; ${w0.toFixed(0)} -> ${w1.toFixed(0)} px)`);
  h.ok(l1 !== null && [1, 2, 5].includes(Number((l1 / Math.pow(10, Math.floor(Math.log10(l1) + 1e-9))).toPrecision(3))), "…a 1, 2 or 5 × 10ⁿ length");
  h.eq((await model(MV)).past - m0.past, 1, "…as one undo step");
  grip = await rect("[data-fxb-grip='scalebar']");
  await wheel(grip.cx, grip.cy, 100, 1);
  await settled();
  h.eq(await stored(), null, "…and back at the picture's own length nothing is stored");
  const sg = await rect("[data-fxb-grip='stamp']"), fs0 = await ctx("(c) => c.view.furniture.stamp.fontSize");
  await wheel(sg.cx, sg.cy, -100, 2);
  await settled();
  h.eq(await ctx("(c) => c.view.furniture.stamp.fontSize"), fs0 + 1, "the wheel over a text annotation changes its size, half a point a notch");
  await press("z", ["Control"]);
  h.eq(await ctx("(c) => c.view.furniture.stamp.fontSize"), fs0, "…which one undo puts back");
  await page.mouse.move(5, 940);
}
const partNames = ["scalebar", "scalebar.label", "stamp", "colorbar"];
const markup = () => page.evaluate(({ id, parts }) => {
  const el = window.__flux.figures()[0].elements.find((e) => e.id === id);
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const clean = (n) => (n ? n.outerHTML.replace(/<!--.*?-->/g, "").replaceAll(`fxl-${safe}-`, `fx-${safe}-`) : null);
  const live = document.querySelector("[data-fluximg-live] svg.vec"), rest = document.querySelector(`svg[data-fluximg="${el.assetId}"]`);
  return {
    parts: Object.fromEntries(parts.map((p) => [p, [!!live?.querySelector(`[data-part='${p}']`), !!rest?.querySelector(`[data-part='${p}']`)]])),
    live: clean(live?.querySelector("[data-part='furniture']")), rest: clean(rest?.querySelector("[data-part='furniture']")),
  };
}, { id: MV, parts: partNames });
await waitFor(page, ({ id }) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); return !!document.querySelector(`svg[data-fluximg="${el.assetId}"] [data-part='colorbar']`); }, { id: MV }, { label: "furniture at rest", timeout: 4000 }).catch(() => {});
mk = await markup();
for (const p of partNames) h.ok(mk.parts[p][0] && mk.parts[p][1], `${p}: drawn in the live overlay and at rest`);
h.ok(mk.live && mk.live === mk.rest, `the furniture markup is identical apart from the id prefix (${mk.live?.length ?? 0} chars)`);
await shot(page, "fluximg-live-annotations");
// The keys with the mouse: a click toggles, Shift-click is the next corner.
{
  await page.click(key("stamp"));
  h.ok(!(await ctx("(c) => !!c.view.furniture.stamp")), "a click on an annotation's key switches it off");
  await page.click(key("stamp"));
  const c0s = await ctx("(c) => c.view.furniture.stamp.corner");
  await page.keyboard.down("Shift"); await page.click(key("stamp")); await page.keyboard.up("Shift");
  h.ok((await ctx("(c) => c.view.furniture.stamp.corner")) !== c0s, "…and Shift-click sends one that is shown to its next corner");
}
for (const [k, kind] of ann) if (await ctx(`(c) => !!c.view.furniture.${kind}`)) await press(k);
h.ok(await page.evaluate(() => !document.querySelector("[data-fluximg-live] [data-part='furniture']")) && !(await page.$("[data-fxb-grip]")), "switched off again, they are gone, and so are their grips");
// An image that does not say how big a pixel is: the scale bar refuses, and says why.
const RG = await placeFixture("rgb_u8", { x: 560, y: 60 }, { width: 200 });
await waitStill(RG);
await openLive(RG);
await press("b");
await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /scale bar/i.test(t.textContent)), null, { label: "scale bar toast", timeout: 3000 }).catch(() => {});
h.ok(!(await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar)) && (await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => /scale bar/i.test(t.textContent)))), "without a pixel size the scale bar refuses with a message");
h.ok(!(await page.$(key("stamp"))) && !(await page.$("[data-fxb-rail]")), "…and an image without a stack has no rails and offers no position stamp");
h.eq((await strips()).map((x) => x.lamp), ["1", "2", "3"], "…and an RGB image has a strip for each of its three channels");
await closeLive();
});

// =====================================================================================================
await section("undo and redo through live gestures", async () => {
const MV = await fresh("movie_f32", { x: 120, y: 60 }, { width: 360 });
await openLive(MV);
image = await rect("[data-fluximg-live]");
const viewNow = () => page.evaluate((id) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); const c = window.__flux.fluximg.actions.liveContext(); return { stored: JSON.stringify(el?.view ?? {}), live: !!window.__flux.get(window.__flux.fluximg.live.fluximgLive), ctx: c ? { t: c.view.index.t, scalebar: !!c.view.furniture.scalebar, white: c.view.channels[0].range[1] } : null, flag: document.querySelector("[data-fxb-rail='t'] [data-fxb-flag]")?.textContent?.trim() ?? null, strip: document.querySelector("[data-fxb-channel='0'] .num.w")?.textContent?.trim() ?? null, key: document.querySelector("[data-fxb-key='scalebar']")?.classList.contains("on") ?? null }; }, MV);
const states = [await viewNow()];
await press("ArrowRight"); await press("ArrowRight"); await settled();
states.push(await viewNow());
await press("b");
states.push(await viewNow());
await press("1"); await wheel(image.cx, image.cy, -100, 2); await settled(); await press("Escape");
states.push(await viewNow());
h.ok(states[1].ctx.t === 2 && states[2].ctx.scalebar && states[3].ctx.white > states[2].ctx.white, "three live gestures: two frames on, a scale bar, a whiter white point");
let okUndo = true, drawnOk = true;
for (let i = 3; i > 0; i--) {
  await ctrlZ();
  await sharpFrame(); await waitForFrame(page);
  const gs = await glStats();
  if (!gs || gs.lost || gs.a < 200) { drawnOk = false; console.log("  live image after undo", i, gs); }
  const s = await viewNow();
  if (!(s.live && s.stored === states[i - 1].stored && s.ctx && JSON.stringify(s.ctx) === JSON.stringify(states[i - 1].ctx) && s.flag === states[i - 1].flag && s.strip === states[i - 1].strip && s.key === states[i - 1].key)) { okUndo = false; console.log("  undo mismatch", i, s, states[i - 1]); }
}
h.ok(okUndo, "Ctrl+Z steps back through each live gesture while the view stays open: the rail's flag, the strip's numbers and the keys agree with the model");
h.ok(drawnOk, "…and the live image keeps drawing after every undo (its WebGL context survives the project being replaced)");
let okRedo = true;
for (let i = 1; i <= 3; i++) {
  await ctrlShiftZ();
  const s = await viewNow();
  if (!(s.live && s.stored === states[i].stored && s.flag === states[i].flag && s.strip === states[i].strip)) { okRedo = false; console.log("  redo mismatch", i, s, states[i]); }
}
h.ok(okRedo, "Ctrl+Shift+Z steps forward through them again");
// An undo while a wheel run is still open undoes that run (it does not leave half of it behind).
const tBefore = (await viewNow()).ctx.t;
await wheel(image.cx, image.cy, 100, 2);
await ctrlZ();
await sleep(500); // debounce: past the wheel's 420 ms settle, so a stray late commit would show
h.eq((await viewNow()).ctx.t, tBefore, "Ctrl+Z in the middle of a wheel run undoes the run");
// Letting go with Esc keeps what the wheel just did (it settles the gesture, it does not drop it).
{
  await press("1");
  const w0 = (await viewNow()).ctx.white;
  await wheel(image.cx, image.cy, -100, 2);
  await press("Escape");
  await sleep(500); // debounce: past the wheel's 420 ms settle
  h.ok((await viewNow()).ctx.white > w0, "Esc right after the wheel lets the channel go and KEEPS what the wheel did");
  await ctrlZ();
}
// Undo past the element's creation closes the view without errors.
await closeLive();
await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
const U = await placeFixture("stack_u16", { x: 120, y: 60 }, { width: 320 });
await waitStill(U);
await openLive(U);
await press("ArrowDown"); await settled();
await ctrlZ();
h.ok(await isOpen(), "the first Ctrl+Z undoes the live step and keeps the view open");
await ctrlZ();
await waitFor(page, () => !document.querySelector("[data-fluximg-live]") && !document.querySelector("[data-fxb]"), null, { label: "view closed after undoing the element away", timeout: 3000 }).catch(() => {});
h.ok(!(await isOpen()) && !(await page.$("[data-fluximg-live]")) && !(await page.$("[data-fxb]")), "undoing past the element's creation closes the view and takes the board with it");
await press("h");
h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.activeTool)), "hand", "…and the keyboard is the canvas's again");
await press("v");
});

// =====================================================================================================
await section("playback, the wheel's ownership, and leaks", async () => {
const PB = await fresh("movie_f32", { x: 120, y: 60 }, { width: 320 });
await openLive(PB);
image = await rect("[data-fluximg-live]");
const playing = () => page.evaluate(() => structuredClone(window.__flux.get(window.__flux.fluximg.live.fluximgLive)?.playing ?? null));
const pastNow = () => page.evaluate(() => window.__flux.fig.historyStats().past);
const past0 = await pastNow();
// Space+drag over the live image pans the canvas (as everywhere in Flux) and plays nothing.
let vpa = await vpNow();
await page.mouse.move(image.cx, image.cy);
await page.keyboard.down(" ");
for (let i = 0; i < 5; i++) { await page.keyboard.down(" "); await sleep(20); } // auto-repeat, as a held key sends // debounce: 20 ms between repeats
await page.mouse.down(); await page.mouse.move(image.cx + 30, image.cy + 20, { steps: 4 }); await page.mouse.up();
await page.keyboard.up(" ");
await waitForFrame(page);
let vpb = await vpNow();
h.ok(vpb.panX - vpa.panX === 30 && vpb.panY - vpa.panY === 20, `Space+drag over the live image pans the canvas (${vpb.panX - vpa.panX}, ${vpb.panY - vpa.panY})`);
h.ok(!(await playing()), "…and starts no playback");
{
  // The board goes with the image when the canvas moves.
  const c = await board();
  h.ok(Math.abs(c.rails.t.x - c.image.x) <= 1 && c.rails.t.y >= c.image.bottom - 0.5 && parts(c).every((p) => !overlaps(p, c.image)), "…and the board goes with the image");
}
await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
await waitForFrame(page);
image = await rect("[data-fluximg-live]");
await page.keyboard.down(" ");
for (let i = 0; i < 5; i++) { await page.keyboard.down(" "); await sleep(20); } // debounce: 20 ms between repeats
h.ok(!(await playing()), "a held Space (auto-repeat) toggles nothing while held");
await page.keyboard.up(" ");
await waitForFrame(page);
h.ok(!!(await playing()), "a Space tap plays");
h.ok(await page.evaluate(() => document.querySelector("[data-fxb-rail='t']").classList.contains("playing") && document.querySelector("[data-fxb-key='play:t']").classList.contains("on")), "…and the play key is lit, its ring filling as the movie goes by");
await sleep(200); // debounce: the play key's own 80 ms change of face is over; what follows is the steady state
const steady = await page.evaluate(async () => {
  const out = [], t0 = performance.now();
  const r = (s) => { const e = document.querySelector(s); if (!e) return "none"; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(","); };
  while (performance.now() - t0 < 900) { await new Promise((res) => requestAnimationFrame(res)); out.push({ t: window.__flux.fluximg.actions.liveContext()?.view.index.t, ring: document.querySelector("[data-fxb-rail='t'] .ring .go")?.getAttribute("stroke-dasharray"), layout: [r("[data-fxb-console]"), r("[data-fxb-rail='t']"), r("[data-fxb-rail='t'] svg[data-fxb-track]"), r("[data-fxb-channel='0']"), r("[data-fxb-keypad]"), r("[data-fluximg-live]"), r("[data-fluximg-live] canvas.gl")].join("|"), anims: document.getAnimations().filter((a) => !a.effect?.target?.closest?.(".toasts")).length, who: document.getAnimations().map((a) => (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? "?") + ":" + (a.animationName ?? a.transitionProperty ?? "")).join(",") }); }
  return out;
});
h.ok(new Set(steady.map((s) => s.t)).size >= 5, `playback advances (${new Set(steady.map((s) => s.t)).size} planes in 0.9 s)`);
h.ok(new Set(steady.map((s) => s.ring)).size >= 5, "…and the play key's ring follows it");
h.eq(new Set(steady.map((s) => s.layout)).size, 1, "nothing on the board moves or changes size while playing (console, rail, well, strip, keys, image, canvas)");
h.ok(steady.every((s) => s.anims === 0), `nothing is animated by CSS while playing (toasts aside)${steady.find((s) => s.anims) ? `: ${steady.find((s) => s.anims).who}` : ""}`);
await press("Escape");
h.ok(!(await playing()) && (await isOpen()), "Esc stops a movie that is playing (and the view stays open)");
await settled();
h.eq((await pastNow()) - past0, 1, "a playback is one undo step");
await page.click(key("play:t"));
await waitForFrame(page);
h.ok(!!(await playing()), "the play key plays");
await page.click(key("play:t"));
await settled();
h.ok(!(await playing()), "…and stops");
// Ctrl+wheel always zooms the canvas, even with a rail in hand; the plane stays.
const tNow = await idx(PB, "t"), z0c = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
await wheel(image.cx, image.cy, -100, 1, ["Control"]);
const z1c = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
h.ok(z1c > z0c && (await idx(PB, "t")) === tNow, `Ctrl+wheel zooms the canvas while a rail is held (${z0c} -> ${z1c.toFixed(3)}), and the plane stays`);
await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
await closeLive();
const pan0 = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).panY);
await wheel(700, 700, 100, 1);
h.ok((await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).panY)) !== pan0, "after closing, the wheel pans the canvas again");
await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
// Open and close 20 times: no listener or WebGL context left behind.
const cdp = await page.createCDPSession();
const listeners = async () => {
  const counts = {};
  for (const expr of ["window", "document"]) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: expr });
    const { listeners: ls } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
    for (const l of ls) counts[`${expr}:${l.type}`] = (counts[`${expr}:${l.type}`] ?? 0) + 1;
  }
  return counts;
};
await page.evaluate(() => { window.__fxCtx = []; const orig = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, o) { const c = orig.call(this, t, o); if (t === "webgl2" && c && !window.__fxCtx.includes(c)) window.__fxCtx.push(c); return c; }; });
await openLive(PB); await closeLive();
const l0 = await listeners();
for (let i = 0; i < 20; i++) { await openLive(PB); await press("1"); await press("v"); await press("Escape"); await closeLive(); }
const l1 = await listeners();
const grew = Object.keys({ ...l0, ...l1 }).filter((k) => (l1[k] ?? 0) > (l0[k] ?? 0)).map((k) => `${k} ${l0[k] ?? 0}->${l1[k]}`);
h.eq(grew, [], "20 opens and closes leave no window or document listener behind");
const gl = await page.evaluate(() => ({ made: window.__fxCtx.length, alive: window.__fxCtx.filter((c) => !c.isContextLost()).length }));
h.ok(gl.made >= 20 && gl.alive === 0, `…and every WebGL context is released (${gl.made} made, ${gl.alive} still alive)`);
await cdp.detach();
});

// =====================================================================================================
await section("after closing, the still shows the last live state", async () => {
const SM = await fresh("movie_f32", { x: 120, y: 60 }, { width: 360 });
await openLive(SM);
image = await rect("[data-fluximg-live]");
await wheel(image.cx, image.cy, 100, 5); await settled();
await page.evaluate(() => { const A = window.__flux.fluximg.actions; A.setChannel(1, { invert: true }); window.__flux.fluximg.live.settleLiveEdit(); });
await press("1"); await wheel(image.cx, image.cy, 100, 4); await settled(); await press("Escape");
await sharpFrame(); await waitForFrame(page); await waitForFrame(page);
const grid = await page.evaluate(() => { const m = window.__flux.fluximg.actions.liveContext().manifest; const n = m.pixels.shape.length; const W = m.pixels.shape[n - 1], H = m.pixels.shape[n - 2]; const pts = []; for (let j = 0; j < H; j += 3) for (let i = 0; i < W; i += 3) pts.push([(i + 0.5) / W, (j + 0.5) / H]); return pts; });
const lastGl = await page.evaluate((pts) => {
  const c = document.querySelector("[data-fluximg-live] canvas.gl"), k = document.createElement("canvas"); k.width = c.width; k.height = c.height;
  const x = k.getContext("2d"); x.drawImage(c, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
  return pts.map(([u, v]) => { const i = (Math.floor(v * c.height) * c.width + Math.floor(u * c.width)) * 4; return [d[i], d[i + 1], d[i + 2]]; });
}, grid);
const liveView = await page.evaluate(() => structuredClone(window.__flux.fluximg.actions.liveContext().view));
await press("r");
h.ok(!(await isOpen()), "r closes the view");
await waitFor(page, ({ id, t }) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); const k = document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getAttribute("data-fluximg-key") ?? ""; return new RegExp(`(^|[;|])t=${t}([;|]|$)`).test(k); }, { id: SM, t: liveView.index.t }, { label: "the still at the last plane", timeout: 8000 }).catch(() => {});
const stillKey = await page.evaluate((id) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); return document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getAttribute("data-fluximg-key") ?? ""; }, SM);
const c0v = liveView.channels[0];
h.ok(new RegExp(`(^|[;|])t=${liveView.index.t}([;|]|$)`).test(stillKey), `the still's key is at the last live plane (t=${liveView.index.t})`);
h.ok(stillKey.includes(`|${c0v.range[0]},${c0v.range[1]}|`) && /c1=[^;]*\|inv/.test(stillKey), "…with the last live window and the inverted channel");
const stillPx = await page.evaluate(async ({ id, pts }) => {
  const el = window.__flux.figures()[0].elements.find((e) => e.id === id);
  const href = document.querySelector(`svg[data-fluximg="${el.assetId}"] image`).getAttribute("href");
  const img = new Image(); img.src = href; await img.decode();
  const k = document.createElement("canvas"); k.width = img.naturalWidth; k.height = img.naturalHeight;
  const x = k.getContext("2d"); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, k.width, k.height).data;
  return pts.map(([u, v]) => { const i = (Math.floor(v * k.height) * k.width + Math.floor(u * k.width)) * 4; return [d[i], d[i + 1], d[i + 2]]; });
}, { id: SM, pts: grid });
let worst = 0, off = 0;
for (let i = 0; i < grid.length; i++) { const dlt = Math.max(...[0, 1, 2].map((k) => Math.abs(lastGl[i][k] - stillPx[i][k]))); worst = Math.max(worst, dlt); if (dlt > 2) off++; }
h.ok(worst <= 3, `the still's pixels match the last WebGL frame (${grid.length} samples, worst difference ${worst}/255, ${off} above 2)`);
});

// =====================================================================================================
await section("timings (real frames from flux-fluximg-frame; generous ceilings)", async () => {
const timings = {};
for (const [name, width] of [["mid_tiled_u16", 420], ["big_tiled_u16", 420]]) {
  await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
  const T = await placeFixture(name, { x: 180, y: 40 }, { width });
  await waitStill(T);
  await page.evaluate(() => { window.__fxFrames = []; });
  await openLive(T);
  const cold = await page.evaluate(() => { const at = window.__fxKeyAt, f = window.__fxFrames.filter((x) => x.time >= at), s = f.find((x) => x.sharp); return { first: f[0] ? f[0].time - at : NaN, sharp: s ? s.time - at : NaN, firstLevel: f[0]?.level, sharpLevel: s?.level }; });
  console.log(`  ${name}: R -> first live frame ${cold.first.toFixed(1)} ms (level ${cold.firstLevel}), -> sharp ${cold.sharp.toFixed(1)} ms (level ${cold.sharpLevel})`);
  h.ok(cold.first < 1000 && cold.sharp < 4000, `${name}: R shows the live image within 1 s and sharp within 4 s (${cold.first.toFixed(0)} / ${cold.sharp.toFixed(0)} ms)`);
  image = await rect("[data-fluximg-live]");
  await press("v");
  const first = [], sharp = [], draw = [], levels = [];
  for (let n = 0; n < 6; n++) {
    await page.evaluate(() => { window.__fxFrames = []; window.__fxWheelAt = 0; });
    await page.mouse.move(image.x + image.w * (0.35 + 0.05 * n), image.y + image.h * 0.45);
    await page.mouse.wheel({ deltaY: -100 });
    const r = await waitFor(page, () => { const at = window.__fxWheelAt, f = window.__fxFrames.filter((x) => x.time >= at); const s = f.find((x) => x.sharp && x.pending === 0); return at && s ? { first: f[0].time - at, sharp: s.time - at, draw: Math.max(...f.map((x) => x.drawMs)), level: s.level } : null; }, null, { label: `${name}: sharp frame after a notch`, timeout: 15000 }).catch(() => null);
    if (r) { first.push(r.first); sharp.push(r.sharp); draw.push(r.draw); levels.push(r.level); }
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN, max = (a) => Math.max(...a);
  timings[name] = { notches: first.length, firstMedian: med(first), firstMax: max(first), sharpMedian: med(sharp), sharpMax: max(sharp), drawMax: max(draw), levels };
  console.log(`  ${name}: wheel notch -> first frame median ${med(first).toFixed(1)} ms (max ${max(first).toFixed(1)}), -> sharp frame median ${med(sharp).toFixed(1)} ms (max ${max(sharp).toFixed(1)}), GPU draw max ${max(draw).toFixed(2)} ms, levels ${levels.join(",")}`);
  h.ok(first.length === 6, `${name}: every notch reached a sharp frame`);
  h.ok(max(first) < 250, `${name}: a wheel notch shows a new frame within 250 ms (max ${max(first).toFixed(1)} ms)`);
  h.ok(max(sharp) < 3000, `${name}: and the sharp frame within 3 s (max ${max(sharp).toFixed(1)} ms)`);
  await press("Escape");
  // Stepping planes with the whole board up: the wheel to the frame on screen, and what the board itself costs.
  if (name === "mid_tiled_u16" && (await page.$("[data-fxb-rail]"))) {
    const steps = [];
    for (let n = 0; n < 6; n++) {
      await page.evaluate(() => { window.__fxFrames = []; window.__fxWheelAt = 0; });
      await page.mouse.move(image.cx + n, image.cy);
      await page.mouse.wheel({ deltaY: 100 });
      const r = await waitFor(page, () => { const at = window.__fxWheelAt, f = window.__fxFrames.filter((x) => x.time >= at); return at && f.length ? f[0].time - at : null; }, null, { label: "a frame after a plane step", timeout: 5000 }).catch(() => null);
      if (r !== null) steps.push(r);
      await sleep(60); // debounce: keep the notches apart
    }
    if (steps.length) { console.log(`  ${name}: plane step -> first frame median ${med(steps).toFixed(1)} ms (max ${max(steps).toFixed(1)})`); h.ok(max(steps) < 250, `${name}: a plane step shows its frame within 250 ms with the whole board up (max ${max(steps).toFixed(1)} ms)`); }
  }
  await closeLive();
}
});

// =====================================================================================================
await section("console", async () => {
const errs = realErrors(page).filter((e) => !/Couldn't save|save figures/i.test(e));
h.eq(errs, [], "no console errors anywhere");
});

await h.done(async () => { await browser.close(); rmSync(scratch, { recursive: true, force: true }); });
