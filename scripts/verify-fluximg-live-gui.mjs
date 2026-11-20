// fluximg live view on the real canvas (Figure): select an image, press R. Pins how it opens and closes, the
// panel in the F-menu's manner (beside the image, never on it, zones only on request, left-hand keys, nothing
// animating at rest), the navigator rails (depth vertical at the side, time and extra dimensions horizontal
// below), the channel zone's histogram control, layers and objects with their two-way hover, the frame as a
// viewport onto the image (and pulling an inset out of it), the annotations in both the live overlay and the
// element at rest, undo / redo through live gestures, and that the still at rest shows the last live state.
// Records real frame timings (`flux-fluximg-frame` events) on the tiled fixtures; asserts generous ceilings only.
//
// UI tier, runtime tsx (it writes the synthetic bundles with scripts/lib/fluximgFixtures.ts). Real keys and the
// real wheel throughout (page.keyboard / page.mouse), condition-based waits.
// Run (dev server on :1420, or FLUX_URL): node --import tsx scripts/verify-fluximg-live-gui.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForFrame, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeAllFixtures } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-live-gui");
const scratch = mkdtempSync(path.join(tmpdir(), "fx-livegui-"));
await writeAllFixtures(scratch);
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
  return { el: el ? structuredClone(el) : null, live: structuredClone(F.get(F.fluximg.live.fluximgLive)), past: F.fig.historyStats().past, future: F.fig.historyStats().future };
}, id);
const resolved = (id) => page.evaluate((id) => {
  const F = window.__flux, live = F.fluximg.live;
  const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id);
  if (!el) return null;
  const m = F.get(F.fluximg.store.fluximgManifests)[el.assetId];
  return m ? { manifest: { dims: m.pixels.dims, shape: m.pixels.shape }, view: F.fluximg.actions.liveContext()?.element.id === id ? structuredClone(F.fluximg.actions.liveContext().view) : null } : null;
}, id);
const rect = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const rects = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; }), sel);
const overlaps = (a, b) => !(a.right <= b.x + 0.5 || a.x >= b.right - 0.5 || a.bottom <= b.y + 0.5 || a.y >= b.bottom - 0.5);
const isOpen = () => page.evaluate(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const sharpFrame = () => waitFor(page, () => document.querySelector("[data-fluximg-live]")?.getAttribute("data-sharp") === "1", null, { label: "a sharp live frame", timeout: 10000 });
async function openLive(id) {
  if (await isOpen()) await closeLive();
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), id);
  const r = await page.evaluate((id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); const n = document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getBoundingClientRect(); return n ? { x: n.left + n.width / 2, y: n.top + n.height / 2 } : null; }, id);
  if (r) await page.mouse.move(r.x, r.y);
  await press("r");
  await waitFor(page, () => getComputedStyle(document.querySelector(".fluximgPanel") ?? document.body).visibility === "visible" && !!document.querySelector(".fluximgPanel.placed") && !!document.querySelector("[data-fluximg-live]"), null, { label: "live view open and placed" });
  await sharpFrame();
}
async function closeLive() {
  if (await isOpen()) await page.evaluate(() => window.__flux.fluximg.live.closeFluximgLive());
  await waitFor(page, () => !document.querySelector("[data-fluximg-live]") && !document.querySelector(".fluximgPanel"), null, { label: "live view closed" });
}
/** The WebGL canvas as presented, read through a 2D canvas (the renderer preserves its drawing buffer). */
const glStats = () => page.evaluate(() => {
  const c = document.querySelector("[data-fluximg-live] canvas.gl");
  if (!c || !c.width) return null;
  const k = document.createElement("canvas"); k.width = c.width; k.height = c.height;
  const x = k.getContext("2d"); x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n, w: c.width, h: c.height };
});
const differs = (a, b, by = 2) => !!a && !!b && (Math.abs(a.r - b.r) > by || Math.abs(a.g - b.g) > by || Math.abs(a.b - b.b) > by);
const wheel = async (x, y, deltaY, n = 1, mods = []) => {
  await page.mouse.move(x, y);
  for (const m of mods) await page.keyboard.down(m);
  for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY }); await sleep(45); } // debounce: 45 ms keeps notches apart (wheel law: rest > 30 ms = a notch)
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
};
/** Wait until the open wheel gesture settled into one undo step (the live view settles after 420 ms of quiet). */
const settled = () => waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgLiveBusy), null, { label: "the gesture settled", timeout: 3000 });

// =====================================================================================================
h.section("opening and closing");
const S = await placeFixture("stack_u16", { x: 80, y: 60 }, { width: 320 });
await waitStill(S);
await page.evaluate(() => window.__flux.fig.resetHistory());
await openLive(S);
let m = await model(S);
h.ok(m.live?.elementId === S, "R on one selected image opens its live view");
h.ok(await page.evaluate(() => !!document.querySelector("[data-fluximg-live] canvas.gl")), "the image goes live in place (a WebGL canvas over the element)");
await shot(page, "fluximg-live-open");
await press("r");
h.ok(!(await isOpen()), "R again closes it");
await openLive(S);
await press("Escape");
h.ok(!(await isOpen()), "Esc at the panel's home closes it");
// Double-click opens (the same door).
const box0 = await page.evaluate((id) => { const F = window.__flux; const el = F.figures()[0].elements.find((e) => e.id === id); const r = document.querySelector(`svg[data-fluximg="${el.assetId}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, S);
await page.mouse.click(box0.x, box0.y, { count: 2 });
await waitFor(page, () => !!document.querySelector(".fluximgPanel.placed"), null, { label: "double-click opens" }).catch(() => {});
h.ok(await isOpen(), "double-clicking the image opens its live view");
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

// =====================================================================================================
h.section("the panel, in the F-menu's manner");
await openLive(S);
await sleep(200); // debounce: the surface contract measures "nothing animating" about 200 ms after open
let panel = await rect(".fluximgPanel"), image = await rect("[data-fluximg-live]"), rails = await rects(".fx-railpos"), strip = await rect(".fx-strip");
h.ok(!overlaps(panel, image), "the panel does not overlap the image");
h.ok(rails.length > 0 && rails.every((r) => !overlaps(panel, r)), "…nor its rails");
h.ok(!overlaps(panel, strip), "…nor the readout strip");
h.ok(panel.x >= 0 && panel.y >= 0 && panel.right <= W && panel.bottom <= H, "the panel is inside the viewport");
h.ok(await page.evaluate(() => !document.querySelector(".fluximgPanel .hist") && !document.querySelector(".fluximgPanel svg.plot")), "zones are not shown until asked: no histogram in the DOM at open");
h.eq(await page.evaluate(() => document.getAnimations().length), 0, "nothing animates ~200 ms after open");
h.ok(await page.evaluate(() => [document.querySelector(".fluximgPanel"), ...document.querySelectorAll(".fluximgPanel *, .fx-railpos, .fx-railpos *, .fx-strip")].every((e) => { const s = getComputedStyle(e); return (s.backdropFilter === "none" || !s.backdropFilter) && (s.filter === "none" || !s.filter); })), "no backdrop-filter or filter anywhere in the panel, rails or readout");
const LEFT = new Set([..."123456qwertasdfgzxcvb`", "h", "n"]);
const keyCaps = () => page.evaluate(() => [...document.querySelectorAll(".fluximgPanel [data-key]")].map((e) => e.getAttribute("data-key")));
let caps = await keyCaps();
h.ok(caps.length >= 8 && caps.every((k) => LEFT.has(k)), `home hotkeys are left-hand keys (${caps.join(" ")})`);
h.eq(caps.length, new Set(caps).size, "…and unique within the zone");
const railCaps = await page.evaluate(() => [...document.querySelectorAll("[data-fluximg-rail] .cap .hk")].map((e) => e.textContent.trim()));
h.ok(railCaps.every((k) => LEFT.has(k) && !caps.filter((c) => c !== k).includes(k) || caps.includes(k)), `rail key caps are left-hand keys shared with their Position row (${railCaps.join(" ")})`);
const sideOf = (p, img) => (p.right <= img.x ? "left" : p.x >= img.right ? "right" : p.bottom <= img.y ? "above" : "below");
const side0 = sideOf(panel, image);
await press("1");
await waitFor(page, () => !!document.querySelector(".fluximgPanel .hist"), null, { label: "channel zone open" });
await waitFor(page, () => { const p = document.querySelector(".fluximgPanel"); return !!p && Math.abs(p.getBoundingClientRect().width - parseFloat(p.style.width)) < 1; }, null, { label: "panel resized" });
await waitForFrame(page);
panel = await rect(".fluximgPanel");
h.eq(sideOf(panel, image), side0, `opening a zone never moves the panel to the other side of the image (${side0})`);
h.ok(!overlaps(panel, image) && rails.every((r) => !overlaps(panel, r)), "…and the opened zone still does not cover the image or its rails");
h.ok(panel.x >= 0 && panel.right <= W && panel.bottom <= H, "…and stays inside the viewport");
caps = await keyCaps();
h.ok(caps.every((k) => LEFT.has(k)) && caps.length === new Set(caps).size, `channel zone keys are left-hand and unique (${caps.join(" ")})`);
const actCaps = await page.evaluate(() => [...document.querySelectorAll(".fluximgPanel .act .hk")].map((e) => e.textContent.trim()));
h.ok(actCaps.every((k) => LEFT.has(k)) && new Set([...actCaps, ...caps]).size === actCaps.length + caps.length, `channel actions' keys are left-hand and unique with the fields (${actCaps.join(" ")})`);
await press("Escape");
h.ok(await isOpen() && (await model(S)).live.zone === "home", "Esc in a zone returns to the home zone, not out of the view");
await closeLive();

// =====================================================================================================
h.section("rails");
const MOV = await placeFixture("movie_f32", { x: 520, y: 60 }, { width: 300 });
const TRI = await placeFixture("trials_f32", { x: 520, y: 420 }, { width: 300 });
await waitStill(MOV); await waitStill(TRI);
const viewOf = async (id) => (await model(id)).el.view ?? {};
const idx = async (id, dim) => page.evaluate(({ id, dim }) => { const a = window.__flux.fluximg.actions.liveContext(); return a && a.element.id === id ? a.view.index[dim] : null; }, { id, dim });
await openLive(S);
image = await rect("[data-fluximg-live]");
let vr = await rect(".fx-railpos.v [data-fluximg-rail='z']");
h.ok(!!vr && vr.x >= image.right && vr.y < image.bottom && vr.bottom > image.y, "a z dimension gives a vertical rail at the image's side");
h.ok(!(await page.$(".fx-railpos:not(.v)")), "…and no horizontal rail when there is no time or extra dimension");
/** Where the playhead sits along its track vs where the model index says it should. */
const playhead = (dim) => page.evaluate((dim) => {
  const rail = document.querySelector(`[data-fluximg-rail='${dim}']`), track = rail.querySelector("svg.track").getBoundingClientRect(), thumb = rail.querySelector(".thumb")?.getBoundingClientRect();
  const v = rail.classList.contains("vertical"), ctx = window.__flux.fluximg.actions.liveContext();
  const n = ctx.manifest.pixels.shape[ctx.manifest.pixels.dims.indexOf(dim)], i = ctx.view.index[dim];
  const want = v ? track.top + ((i + 0.5) / n) * track.height : track.left + ((i + 0.5) / n) * track.width;
  const got = thumb ? (v ? thumb.top + thumb.height / 2 : thumb.left + thumb.width / 2) : NaN;
  return { i, n, want, got, track: { x: track.left, y: track.top, w: track.width, h: track.height, v } };
}, dim);
let ph = await playhead("z");
h.ok(Math.abs(ph.want - ph.got) <= 1.5, `the playhead sits at the model's plane (z ${ph.i}: ${ph.got.toFixed(1)} vs ${ph.want.toFixed(1)})`);
// Wheel down over the image: the NEXT plane; a run of notches is one undo step.
let before = await model(S);
await wheel(image.cx, image.cy, 100, 1);
await settled();
h.eq(await idx(S, "z"), ph.i + 1, "wheel down over the image moves to the next plane");
let after = await model(S);
h.eq(after.past - before.past, 1, "…as one undo step");
before = after;
await wheel(image.cx, image.cy, -100, 3);
await settled();
h.eq(await idx(S, "z"), Math.max(0, ph.i + 1 - 3), "three notches up move three planes back");
after = await model(S);
h.eq(after.past - before.past, 1, "…and the run of notches is ONE undo step");
h.ok(!!(await rect("[data-fluximg-live]")) && JSON.stringify(await rect("[data-fluximg-live]")) === JSON.stringify(image), "the image does not move or change size while stepping planes");
ph = await playhead("z");
h.ok(Math.abs(ph.want - ph.got) <= 1.5, "the playhead follows the wheel");
// Dragging the playhead scrubs: one undo step.
before = await model(S);
const at = (t, i, n) => (t.v ? { x: t.x + t.w / 2, y: t.y + ((i + 0.5) / n) * t.h } : { x: t.x + ((i + 0.5) / n) * t.w, y: t.y + t.h / 2 });
let p0 = at(ph.track, 1, ph.n), p1 = at(ph.track, 5, ph.n);
await page.mouse.move(p0.x, p0.y); await page.mouse.down();
await page.mouse.move(p0.x, (p0.y + p1.y) / 2, { steps: 4 });
const mid = await idx(S, "z");
await page.mouse.move(p1.x, p1.y, { steps: 4 }); await page.mouse.up();
await waitForFrame(page);
h.ok(mid === 3 && (await idx(S, "z")) === 5, `dragging the playhead scrubs through the planes (mid-drag z ${mid}, released on 5)`);
after = await model(S);
h.eq(after.past - before.past, 1, "…and the whole scrub is ONE undo step");
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
let proj = (await resolved(S)).view.projection;
h.eq(proj && [proj.dim, proj.from, proj.to], ["z", 1, 5], "Shift+drag on the rail draws a projection run over the planes it covers");
const g1 = await glStats();
h.ok(differs(g0, g1, 0.5), `…and the image changes (mean RGB ${g0 && [g0.r, g0.g, g0.b].map((v) => v.toFixed(1))} -> ${g1 && [g1.r, g1.g, g1.b].map((v) => v.toFixed(1))})`);
h.ok(await page.evaluate(() => !!document.querySelector("[data-fluximg-rail='z'] rect.band")), "the run shows as a band on the rail");
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
await press("e");
await press("1"); // "plane"
h.eq((await resolved(S)).view.projection, null, "e then 1 returns from the projection to one plane");
await closeLive();

await openLive(MOV);
image = await rect("[data-fluximg-live]");
let hr = await rect("[data-fluximg-rail='t']");
h.ok(!!hr && hr.y >= image.bottom && hr.x < image.right && hr.right > image.x, "a t dimension gives a horizontal rail below the image");
h.ok(!(await page.$(".fx-railpos.v")), "…and no vertical rail without z");
await press("ArrowRight");
h.eq(await idx(MOV, "t"), 1, "ArrowRight steps time forward");
await press("ArrowLeft");
h.eq(await idx(MOV, "t"), 0, "ArrowLeft steps time back");
await settled();
await wheel(image.cx, image.cy, 100, 1, ["Shift"]);
await settled();
h.eq(await idx(MOV, "t"), 10, "Shift+wheel moves 10 planes");
ph = await playhead("t");
h.ok(Math.abs(ph.want - ph.got) <= 1.5, `the horizontal playhead sits at the model's frame (t ${ph.i})`);
await closeLive();

await openLive(TRI);
image = await rect("[data-fluximg-live]");
const hrs = await page.evaluate(() => [...document.querySelectorAll(".fx-railpos:not(.v) [data-fluximg-rail]")].map((e) => { const r = e.getBoundingClientRect(); return { dim: e.getAttribute("data-fluximg-rail"), y: r.top, bottom: r.bottom }; }));
h.eq(hrs.map((r) => r.dim).sort(), ["t", "trial"], "t and an extra dimension each get a horizontal rail");
h.ok(hrs.every((r) => r.y >= image.bottom) && hrs[0].bottom <= hrs[1].y, "…below the image, one under the other");
await press("ArrowRight");
h.eq([await idx(TRI, "t"), await idx(TRI, "trial")], [1, 0], "arrows are spatial: left / right step the first horizontal rail (time)");
await closeLive();

await h.done(async () => { await browser.close(); rmSync(scratch, { recursive: true, force: true }); });
