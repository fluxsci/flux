// fluximg live view on the real canvas (Figure): select an image, press R. Pins how it opens and closes; the short
// entry panel in the F-menu's manner (exactly its rows, beside the image, never on it, zones only on request,
// left-hand keys, nothing animating at rest) with the hover readout inside it; the navigator rails (depth at the
// side, time and extra dimensions below; changing side at the canvas's edges, never on the image or each other);
// the wheel's scope (the view's own rail arm answers over the image only, a row armed by hand anywhere); the
// channel zone's histogram control, Auto from the pixels in view, Split into LINKED panels; layers and objects with
// their two-way hover; the frame as a viewport (and pulling an inset out of it); the Annotations zone, drawn alike in
// the live overlay and at rest; undo / redo through live gestures; playback; leaks; and that the still at rest shows
// the last live state. Records real frame timings (`flux-fluximg-frame`); asserts generous ceilings only.
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
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; }
  return { r: r / n, g: g / n, b: b / n, a: a / n, w: c.width, h: c.height, lost: !!c.getContext("webgl2")?.isContextLost() };
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
// Locked (or hidden) from elsewhere while open: the view closes rather than keep editing a locked element.
await openLive(S);
await page.evaluate((id) => window.__flux.fig.commit((p) => { p.figures[0].elements.find((e) => e.id === id).locked = true; }), S);
await waitForFrame(page);
h.ok(!(await isOpen()), "locking the image while its live view is open closes the view");
const lockedZ = (await model(S)).el.view?.index?.z ?? null;
await wheel(box0.x, box0.y, 100, 1);
h.eq((await model(S)).el.view?.index?.z ?? null, lockedZ, "…and the wheel no longer edits the locked image");
await page.evaluate((id) => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements.find((e) => e.id === id).locked = false; }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); F.fig.resetHistory(); }, S);

// =====================================================================================================
h.section("the panel, in the F-menu's manner");
await openLive(S);
await sleep(200); // debounce: the surface contract measures "nothing animating" about 200 ms after open
let panel = await rect(".fluximgPanel"), image = await rect("[data-fluximg-live]"), rails = await rects(".fx-railpos .rail");
h.ok(!overlaps(panel, image), "the panel does not overlap the image");
h.ok(rails.length > 0 && rails.every((r) => !overlaps(panel, r)), "…nor its rails");
h.ok(panel.x >= 0 && panel.y >= 0 && panel.right <= W && panel.bottom <= H, "the panel is inside the viewport");
// The entry panel is short: one row per channel, one per rail, Projection, (Layers), Frame, Annotations. Nothing else.
const entryRows = () => page.evaluate(() => [...document.querySelectorAll(".fluximgPanel .body > *")].filter((e) => !e.classList.contains("sep")).map((e) => `${e.getAttribute("data-key") ?? "?"}:${(e.querySelector(".label")?.textContent ?? e.textContent).trim()}`));
h.eq(await entryRows(), ["1:structure", "2:signal", "z:Depth", "e:Projection", "v:Frame", "b:Annotations"], "the entry panel lists exactly: channels, the rail, Projection, Frame, Annotations (in that order)");
h.ok(panel.h < 320, `…and is short (${Math.round(panel.h)} px for a two-channel z-stack)`);
h.ok(await page.evaluate(() => !document.querySelector(".fluximgPanel .gtitle, .fluximgPanel .about, .fluximgPanel .value.dim, .fluximgPanel .lead")), "…with no group titles, about row or helper text");
h.ok(await page.evaluate(() => /a\s*auto/.test(document.querySelector(".fluximgPanel .foot")?.textContent ?? "")), "Auto is a key named in the footer");
h.eq(await page.evaluate(() => [...document.querySelectorAll(".fluximgPanel .row.chan")].map((r) => { const m = r.querySelector("svg.mini"); return m ? [m.querySelectorAll("path").length, m.querySelectorAll("line.pt").length] : null; })), [[2, 2], [2, 2]], "each channel row carries its histogram: the area, the part inside the window in the channel's ink, and the two points");
// The readout lives inside the panel: a fixed strip that says what the image IS until the pointer is over it.
const readout = () => page.evaluate(() => { const r = document.querySelector(".fluximgPanel .readout[data-fluximg-readout]"); return r ? { text: r.textContent.trim(), h: r.getBoundingClientRect().height } : null; });
let ro = await readout();
const idle = (t) => /2 channels/.test(t) && /7 z/.test(t) && /uint16/.test(t) && /µm per pixel/.test(t) && !/\bx\s/.test(t);
h.ok(!!ro && idle(ro.text) && Math.abs(ro.h - 36) < 1.5, `the readout strip is in the panel, 36 px tall, and says what the image is before hovering (${ro?.text.replace(/\s+/g, " ").slice(0, 70)})`);
h.eq(await page.evaluate(() => document.querySelector(".fluximgPanel .menu-head .ctx")?.textContent.trim()), "", "…so the header carries the name alone");
h.ok(!(await page.$(".fx-strip")), "…and nothing floats over the figure");
const panelH0 = panel.h;
await page.mouse.move(image.x + image.w * 0.4, image.y + image.h * 0.5);
await waitFor(page, () => !!document.querySelector(".fluximgPanel .readout[data-fluximg-readout] .where"), null, { label: "readout filled" });
ro = await readout();
h.ok(/x .*µm.*y .*µm/.test(ro.text) && /structure/.test(ro.text) && /signal/.test(ro.text), `hovering the image fills it (${ro.text.replace(/\s+/g, " ").slice(0, 70)})`);
h.ok(Math.abs((await rect(".fluximgPanel")).h - panelH0) < 0.5, "…and the panel's height does not change");
await page.mouse.move(5, 940);
await waitFor(page, () => !document.querySelector(".fluximgPanel .readout[data-fluximg-readout] .where"), null, { label: "readout idle again" });
h.ok(idle((await readout()).text), "…and says what the image is again when the pointer leaves it");
h.ok(await page.evaluate(() => !document.querySelector(".fluximgPanel .hist") && !document.querySelector(".fluximgPanel svg.plot")), "zones are not shown until asked: no histogram in the DOM at open");
// The mouse alone: the wheel over a channel's row arms that channel's white point (the notch is spent on arming),
// further notches move it, and Esc gives the wheel back to the view's own rail without closing the view.
{
  const row = await rect(".fluximgPanel .row.chan[data-channel='1']");
  const white = () => page.evaluate(() => window.__flux.fluximg.actions.liveContext().view.channels[1].range[1]);
  const w0 = await white(), m0 = await model(S);
  await wheel(row.cx, row.cy, -100, 1);
  let m = await model(S);
  h.ok(m.live.zone === "home" && m.live.armed === "white" && m.live.channel === 1 && (await white()) === w0 && m.past === m0.past, "the first wheel notch over a channel's row arms that channel's white point and changes nothing");
  h.ok(await page.evaluate(() => document.querySelector(".fluximgPanel .row.chan[data-channel='1']").classList.contains("armed")), "…the row shows it is armed");
  await wheel(row.cx, row.cy, -100, 2);
  await settled();
  h.ok((await white()) > w0, `…and the next notches raise it (${w0} -> ${await white()})`);
  h.eq((await model(S)).past - m0.past, 1, "…as one undo step");
  await press("Escape");
  m = await model(S);
  h.ok((await isOpen()) && m.live.zone === "home" && m.live.armed === "pos:z", "Esc disarms it (the view stays open, the rail has the wheel again)");
  await press("z", ["Control"]);
  await waitForFrame(page);
}
h.eq(await page.evaluate(() => document.getAnimations().length), 0, "nothing animates ~200 ms after open");
h.ok(await page.evaluate(() => [document.querySelector(".fluximgPanel"), ...document.querySelectorAll(".fluximgPanel *, .fx-railpos, .fx-railpos *")].every((e) => { const s = getComputedStyle(e); return (s.backdropFilter === "none" || !s.backdropFilter) && (s.filter === "none" || !s.filter); })), "no backdrop-filter or filter anywhere in the panel, rails or readout");
const LEFT = new Set([..."123456qwertasdfgzxcvb`", "h", "n"]);
const keyCaps = () => page.evaluate(() => [...document.querySelectorAll(".fluximgPanel [data-key]")].map((e) => e.getAttribute("data-key")));
let caps = await keyCaps();
h.ok(caps.length >= 6 && caps.every((k) => LEFT.has(k)), `home hotkeys are left-hand keys (${caps.join(" ")})`);
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
// Wheel scope: the rail the view armed by itself answers over the image and rails only; elsewhere the canvas pans.
const vpNow0 = () => page.evaluate(() => structuredClone(window.__flux.get(window.__flux.fig.viewport)));
const zBefore = await idx(S, "z"), vp0 = await vpNow0();
await wheel(image.cx, image.bottom + 260, 100, 1);
await waitForFrame(page);
const vp1 = await vpNow0();
h.ok(vp1.panY !== vp0.panY && (await idx(S, "z")) === zBefore, `with the rail armed by the view, the wheel over empty canvas pans the canvas (panY ${vp0.panY} -> ${vp1.panY}) and leaves the plane`);
await page.evaluate((v) => window.__flux.fig.viewport.set(v), vp0);
await waitForFrame(page);
const panelBox = await rect(".fluximgPanel");
await wheel(panelBox.cx, panelBox.y + 60, 100, 1);
h.eq(await idx(S, "z"), zBefore, "…and over the panel too");
await press("z");
await settled().catch(() => {});
await wheel(image.cx, image.bottom + 260, 100, 1);
await settled();
h.ok((await idx(S, "z")) === Math.min(6, zBefore + 1) && JSON.stringify(await vpNow0()) === JSON.stringify(vp0), "after pressing the rail's key, the wheel anywhere steps the plane (and the canvas stays)");
await press("z", ["Control"]);
// A zone's row is the user's arm; backing out of the zone gives the wheel back to the view's own arm.
await press("1"); await press("Escape");
const zHome = await idx(S, "z"), vpHome = await vpNow0();
await wheel(image.cx, image.bottom + 260, 100, 1);
await waitForFrame(page);
h.ok((await idx(S, "z")) === zHome && (await vpNow0()).panY !== vpHome.panY, "after backing out of a zone, the wheel over empty canvas pans the canvas again");
await page.evaluate((v) => window.__flux.fig.viewport.set(v), vpHome);
await waitForFrame(page);
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

// =====================================================================================================
h.section("channels");
const chanOf = async (id, i) => page.evaluate(({ id, i }) => { const c = window.__flux.fluximg.actions.liveContext(); return c && c.element.id === id ? structuredClone(c.view.channels[i]) : null; }, { id, i });
const compOf = () => page.evaluate(() => { const v = window.__flux.fluximg.actions.liveContext().view; return { composite: v.composite, solo: v.solo }; });
await openLive(S);
image = await rect("[data-fluximg-live]");
// Auto reads the pixels in view: two planes of different brightness give two different windows.
const windows = async () => page.evaluate(() => window.__flux.fluximg.actions.liveContext().view.channels.map((c) => c.range.join("..")).join(" | "));
await press("ArrowUp", ["Shift"]); await settled(); await sharpFrame();
await press("a");
const autoTop = await windows();
await press("ArrowDown"); await press("ArrowDown"); await press("ArrowDown"); await settled(); await sharpFrame(); await waitForFrame(page);
await press("a");
const autoMid = await windows();
h.ok(autoTop !== autoMid, `Auto takes its window from the pixels in view (plane 1: ${autoTop}; plane 4: ${autoMid})`);
await press("1");
await waitFor(page, () => !!document.querySelector(".fluximgPanel .hist svg.plot"), null, { label: "channel 1's zone" });
h.ok(true, "key 1 opens channel 1's zone with its histogram");
h.eq((await model(S)).live.armed, "white", "…with the white point armed for the wheel");
let c0 = await chanOf(S, 0);
before = await model(S);
await wheel(image.cx, image.cy, -100, 3);
await settled();
let c1 = await chanOf(S, 0);
h.ok(c1.range[1] > c0.range[1] && c1.range[0] === c0.range[0], `wheel up raises the white point (${c0.range[1]} -> ${c1.range[1]}), the black point stays`);
after = await model(S);
h.eq(after.past - before.past, 1, "…and the run of notches commits ONE undo step");
h.eq(await page.evaluate(() => [...document.querySelectorAll(".fluximgPanel .field")].map((f) => [f.querySelector(".flabel")?.textContent.trim(), /^clips (<|>)?[\d.]+ %$/.test(f.querySelector(".clip")?.textContent.trim() ?? "")])), [["Black", true], ["White", true], ["Gamma", false]], "the black and white fields say what share of the channel they clip");
{
  // Dragging on the image pulls contrast: right narrows the window about its centre, up raises nothing but the
  // centre; the window never leaves what the channel holds. One undo step per drag.
  const r0 = (await chanOf(S, 0)).range, m0 = await model(S);
  await page.mouse.move(image.cx, image.cy); await page.mouse.down();
  await page.mouse.move(image.cx + 40, image.cy, { steps: 4 }); await page.mouse.move(image.cx + 80, image.cy, { steps: 4 });
  await waitForFrame(page);
  const mid = (await chanOf(S, 0)).range;
  await page.mouse.up();
  await waitForFrame(page);
  const r1 = (await chanOf(S, 0)).range, m1 = await model(S);
  h.ok(r1[1] - r1[0] < r0[1] - r0[0] && Math.abs((r1[0] + r1[1]) / 2 - (r0[0] + r0[1]) / 2) <= 1, `dragging right on the image narrows the window about its centre (${r0.join("..")} -> ${r1.join("..")})`);
  h.ok(mid[1] - mid[0] < r0[1] - r0[0], "…while the pointer is still down (the picture follows the hand)");
  h.ok(Number.isInteger(r1[0]) && Number.isInteger(r1[1]), "…in whole numbers for integer data");
  h.ok(m1.past - m0.past === 1 && m1.live.zone === "channel" && (await isOpen()), "…as one undo step, and the view stays where it was");
  const stats = await page.evaluate(() => { const st = window.__flux.fluximg.actions.liveContext().manifest.channels[0].stats; return [st.min, st.max]; });
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
// Drag the black handle to the right.
const histBox = await rect(".fluximgPanel .hist svg.plot");
const marks = await rects(".fluximgPanel .hist .mark");
c0 = await chanOf(S, 0); before = await model(S);
await page.mouse.move(marks[0].x + marks[0].w / 2, histBox.cy); await page.mouse.down();
await page.mouse.move(marks[0].x + marks[0].w / 2 + 30, histBox.cy, { steps: 4 });
await page.mouse.move(marks[0].x + marks[0].w / 2 + 60, histBox.cy, { steps: 4 }); await page.mouse.up();
await waitForFrame(page);
c1 = await chanOf(S, 0); after = await model(S);
h.ok(c1.range[0] > c0.range[0] && c1.range[1] === c0.range[1], `dragging the black handle raises the black point (${c0.range[0]} -> ${c1.range[0]})`);
h.eq(after.past - before.past, 1, "…as one undo step");
// Auto walks its ladder: every press changes the window, and it comes round again.
const ladder = [];
for (let i = 0; i < 5; i++) { await press("a"); ladder.push((await chanOf(S, 0)).range.join("..")); }
h.ok(new Set(ladder.slice(0, 4)).size === 4 && ladder[4] === ladder[0], `a cycles the Auto ladder (${ladder.join(" | ")})`);
// Hide / solo / invert / colour change the model and the picture.
let g = await glStats();
await press("x");
h.eq((await chanOf(S, 0)).visible, false, "x hides the channel in the model");
await waitForFrame(page); await waitForFrame(page);
let g2 = await glStats();
h.ok(differs(g, g2), "…and in the picture");
await press("x");
h.eq((await chanOf(S, 0)).visible, true, "x again shows it");
await waitForFrame(page); await waitForFrame(page);
g = await glStats();
await press("v");
h.eq(await compOf(), { composite: "single", solo: 0 }, "v solos the channel");
await sharpFrame(); await waitForFrame(page); await waitForFrame(page);
g2 = await glStats();
h.ok(differs(g, g2), "…and the picture shows that channel alone");
await press("v");
h.eq((await compOf()).composite, "blend", "v again returns to the composite");
await waitForFrame(page); await waitForFrame(page);
g = await glStats();
await press("z");
h.eq((await chanOf(S, 0)).invert, true, "z inverts the channel");
await waitForFrame(page); await waitForFrame(page);
g2 = await glStats();
h.ok(differs(g, g2), "…and the picture changes");
await press("z");
g = await glStats();
await press("c");
h.ok(await page.evaluate(() => !!document.querySelector(".fluximgPanel .acts .opts [role=option]")), "c lays out the colours");
await press("4"); // cyan
h.eq((await chanOf(S, 0)).color, "#00ffff", "a colour's number picks it");
await waitForFrame(page); await waitForFrame(page);
g2 = await glStats();
h.ok(differs(g, g2), "…and the picture takes the new colour");
// Typed values: Enter commits, Esc reverts, and the keys work again afterwards.
c0 = await chanOf(S, 0); before = await model(S);
await page.click(".fluximgPanel .field[data-key='q'] input", { count: 3 });
await page.keyboard.type("500");
h.eq((await chanOf(S, 0)).range[0], 500, "typing a black point previews it live");
await press("Enter");
after = await model(S);
h.ok((await chanOf(S, 0)).range[0] === 500 && after.past - before.past === 1, "Enter commits the typed value as one undo step");
h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)), "…and hands the keyboard back (no field keeps focus)");
c0 = await chanOf(S, 0); before = await model(S);
await page.click(".fluximgPanel .field[data-key='w'] input", { count: 3 });
await page.keyboard.type("999");
h.eq((await chanOf(S, 0)).range[1], 999, "typing a white point previews it");
await press("Escape");
after = await model(S);
h.ok((await chanOf(S, 0)).range[1] === c0.range[1] && after.past === before.past, "Esc reverts the typed value (no undo step)");
h.ok(await isOpen() && (await model(S)).live.zone === "channel", "Esc in a field leaves the zone open");
h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)), "…and no field keeps focus");
await waitForFrame(page); await waitForFrame(page);
g = await glStats();
h.ok(!!g && !g.lost && g.a > 200, "…and the live image is still drawn after the revert");
await press("q");
h.eq((await model(S)).live.armed, "black", "keys work again after a field (q arms the black point)");
await press("Escape");
h.eq((await model(S)).live.zone, "home", "Esc returns to the home zone, not out of the view");
// Split channels (from the channel zone): one panel per channel beside the image, LINKED to it, one undo step.
const countImages = () => page.evaluate(() => window.__flux.figures()[0].elements.filter((e) => e.type === "fluximg").map((e) => ({ id: e.id, composite: e.view?.composite ?? null, solo: e.view?.solo ?? null, link: e.view?.link ?? null })));
const imgs0 = await countImages(); before = await model(S);
await press("1");
await press("b");
const imgs1 = await countImages(); after = await model(S);
const made = imgs1.filter((e) => !imgs0.some((o) => o.id === e.id));
h.ok(made.length === 2 && made.every((e, i) => e.composite === "single" && e.solo === i), `b in a channel zone splits the channels into one solo panel each (${made.length})`);
const inFigure = (ids) => page.evaluate((ids) => { const f = window.__flux.figures()[0]; return f.elements.filter((e) => ids.includes(e.id)).every((e) => e.x >= -0.5 && e.y >= -0.5 && e.x + e.width <= f.width + 0.5 && e.y + e.height <= f.height + 0.5); }, ids);
h.ok(await inFigure(made.map((e) => e.id)), "…each inside the figure (a figure clips what lies outside it)");
h.ok(after.past - before.past === 1 && (await isOpen()) && after.live.elementId === S, "…in one undo step, with the view still on the image");
const link = after.el.view?.link ?? null;
h.ok(!!link && made.every((e) => e.link === link), `…and the panels are linked to the composite (${link})`);
await press("Escape");
// Stepping a plane on the composite moves every linked panel.
const zOf = (id) => page.evaluate((id) => window.__flux.figures()[0].elements.find((e) => e.id === id)?.view?.index?.z ?? null, id);
await press("ArrowDown"); await settled();
const zs = [await zOf(S), ...(await Promise.all(made.map((e) => zOf(e.id))))];
h.ok(zs[0] !== null && zs.every((z) => z === zs[0]), `stepping a plane on one linked panel moves all of them (z ${zs.join(", ")})`);
// Dragging channel 1's white point on the composite sets the single-channel panel's window too.
await press("1");
await waitFor(page, () => !!document.querySelector(".fluximgPanel .hist svg.plot"), null, { label: "channel 1 zone" });
const hb = await rect(".fluximgPanel .hist svg.plot"), wmk = await rects(".fluximgPanel .hist .mark");
await page.mouse.move(wmk[1].x + wmk[1].w / 2, hb.cy); await page.mouse.down();
await page.mouse.move(wmk[1].x + wmk[1].w / 2 - 40, hb.cy, { steps: 4 }); await page.mouse.up();
await waitForFrame(page);
const rangeOf = (id) => page.evaluate((id) => JSON.stringify(window.__flux.figures()[0].elements.find((e) => e.id === id)?.view?.channels?.[0]?.range ?? null), id);
const r0 = await rangeOf(S), r1 = await rangeOf(made[0].id);
h.ok(r0 !== "null" && r0 === r1, `dragging channel 1's white point on the composite sets the linked channel-1 panel's window (${r0} / ${r1})`);
await press("Escape");
await closeLive();
await page.evaluate((ids) => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => !ids.includes(e.id)); }); F.fig.resetHistory(); }, made.map((e) => e.id));

// =====================================================================================================
h.section("the rails never cover each other, the image or the panel");
const chrome = () => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
  const host = r(document.querySelector(".canvas-host"));
  return { image: r(document.querySelector("[data-fluximg-live]")), host, rails: [...document.querySelectorAll(".fx-railpos .rail")].map(r), panel: r(document.querySelector(".fluximgPanel")),
    readouts: [...document.querySelectorAll("[data-fluximg-rail] .readout")].map((e) => { const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + 4, b.top + 5); return !!hit && e.contains(hit); }) };
});
const hostBox = await rect(".canvas-host");
// Near the right edge: room for the image, not for a depth rail beside it (its right edge 60 px from the canvas's).
const nearRight = Math.round(hostBox.w - 60 - 240 - 300), nearBottom = Math.round(hostBox.h - 30 - 110 - 213);
for (const [label, fixture, width, zoom, patch, at, expect] of [["t and z", "tz_u16", 320, 1, {}], ["t and z, narrow", "tz_u16", 150, 1, {}], ["z, narrow", "stack_u16", 200, 1, {}], ["z at zoom 0.3", "stack_u16", 320, 0.3, {}], ["z rotated 90 degrees", "stack_u16", 320, 1, { rotation: 90 }], ["t and an extra dimension", "trials_f32", 220, 1, {}],
  ["z at the canvas's right edge", "stack_u16", 300, 1, {}, { x: nearRight, y: 60 }, "depth-left"], ["t at the canvas's bottom edge", "movie_f32", 320, 1, {}, { x: 80, y: nearBottom }, "time-above"], ["t and z in the bottom-right corner", "tz_u16", 300, 1, {}, { x: nearRight, y: Math.round(hostBox.h - 30 - 110 - 240) }, "depth-left time-above"], ["t and z at the bottom edge", "tz_u16", 300, 1, {}, { x: 80, y: Math.round(hostBox.h - 30 - 110 - 240) }, "time-above"]]) {
  await page.evaluate(() => { const F = window.__flux; F.fluximg.live.closeFluximgLive(); F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); });
  const id = await placeFixture(fixture, at ?? { x: 80, y: 60 }, { width, patch });
  await page.evaluate((zoom) => window.__flux.fig.viewport.set({ panX: 240 + (zoom < 1 ? 200 : 0), panY: 110 + (zoom < 1 ? 100 : 0), zoom }), zoom);
  await waitStill(id);
  await openLive(id);
  await page.mouse.move(image?.x ?? 300, 940); // the pointer off the chrome
  await waitForFrame(page);
  const c = await chrome();
  const boxes = [...c.rails];
  let pair = true;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) pair = false;
  h.ok(pair, `${label}: rails never overlap each other`);
  h.ok(c.readouts.every(Boolean), `${label}: every rail's readout is visible (nothing lies on top of it)`);
  h.ok(boxes.every((b) => !overlaps(b, c.image)), `${label}: no rail covers the image`);
  h.ok(![...boxes, c.image].some((b) => overlaps(b, c.panel)), `${label}: the panel covers neither the image nor its rails`);
  if (expect) {
    const vr = await rect(".fx-railpos.v .rail"), hr = await rect(".fx-railpos:not(.v) .rail");
    if (expect.includes("depth-left")) h.ok(!!vr && vr.right <= c.image.x + 0.5 && c.image.right <= c.host.right, `${label}: the depth rail moves to the image's left`);
    if (expect.includes("time-above")) h.ok(!!hr && hr.bottom <= c.image.y + 0.5 && c.image.bottom <= c.host.bottom, `${label}: the time rail moves above the image`);
    await shot(page, `fluximg-live-edge-${expect.replace(/ /g, "-")}`);
  }
  if (label === "t and z") await shot(page, "fluximg-live-t-and-z");
}
await closeLive();

// =====================================================================================================
h.section("float windows and the layers zone (mean_f64_layers)");
await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
const L = await placeFixture("mean_f64_layers", { x: 80, y: 60 }, { width: 360 });
await waitStill(L);
await openLive(L);
image = await rect("[data-fluximg-live]");
// The black point wheeled up into the white point stops below it; the window never collapses (an empty window is
// invalid, and the view fell back to the default window: the picture jumped and the next notch started from there).
await press("1");
await waitFor(page, () => !!document.querySelector(".fluximgPanel .hist"), null, { label: "channel zone" });
await page.click(".fluximgPanel .field[data-key='q'] input", { count: 3 });
const white0 = (await chanOf(L, 0)).range[1];
await page.keyboard.type(String(Math.floor((white0 - 0.08) * 100) / 100));
await press("Enter");
await press("q");
await wheel(image.cx, image.cy, -100, 3);
await settled();
c1 = await chanOf(L, 0);
h.ok(c1.range[0] < c1.range[1] && c1.range[0] > white0 - 0.1 && c1.range[1] === white0, `float data: wheeling the black point into the white point stops just below it (${c1.range.join(" .. ")}; white ${white0})`);
await press("Escape");
// Layers.
await press("d");
await waitFor(page, () => !!document.querySelector(".fluximgPanel .list"), null, { label: "layers zone" });
const layerIds = await page.evaluate(() => window.__flux.fluximg.actions.liveContext().manifest.layers.map((l) => l.id));
const rowIds = () => page.evaluate(() => [...document.querySelectorAll(".fluximgPanel .lrow[data-rid]")].map((e) => e.getAttribute("data-rid")));
let rows = await rowIds();
h.ok(layerIds.every((id) => rows.includes(`layer:${id}`)), `a row for every layer (${layerIds.join(", ")})`);
h.ok(!rows.some((r) => r.startsWith("obj:")), "object layers start closed (several of them)");
await page.click(".fluximgPanel .lrow[data-rid='layer:footprints']");
await waitFor(page, () => document.querySelectorAll(".fluximgPanel .lrow[data-rid^='obj:footprints/']").length > 0, null, { label: "footprints open" });
rows = await rowIds();
const objRows = rows.filter((r) => r.startsWith("obj:footprints/"));
h.ok(objRows.length >= 3, `opening an object layer lists its objects (${objRows.length})`);
await waitFor(page, () => [...document.querySelectorAll(".fluximgPanel .lrow.obj .cellk")].length > 0, null, { label: "table columns", timeout: 5000 }).catch(() => {});
const cols = await page.evaluate(() => [...new Set([...document.querySelectorAll(".fluximgPanel .lrow.obj .cellk")].map((e) => e.textContent.trim()))]);
h.ok(cols.length >= 1, `…with the columns of their table (${cols.join(", ")})`);
// Row -> image: hovering a row outlines the object on the image.
const firstObj = objRows[0], firstKey = firstObj.split("/").slice(1).join("/");
const rowBox = await rect(`.fluximgPanel .lrow[data-rid='${firstObj}']`);
await page.mouse.move(rowBox.cx, rowBox.cy);
await waitFor(page, () => !!document.querySelector("[data-fluximg-live] .fx-hot"), null, { label: "outline on the image", timeout: 3000 }).catch(() => {});
const hot = await page.evaluate(() => document.querySelector("[data-fluximg-live] .fx-hot")?.getAttribute("data-key") ?? null);
h.eq(hot, firstKey, "hovering an object's row outlines that object on the image");
// Image -> row: hovering the object on the image marks its row.
const other = objRows[objRows.length - 1], otherKey = other.split("/").slice(1).join("/");
await page.mouse.move(5, 5);
const shapeAt = await page.evaluate((k) => { const s = [...document.querySelectorAll("[data-fluximg-live] [data-layer='footprints'] [data-key], [data-fluximg-live] [data-key]")].find((e) => e.getAttribute("data-key") === k && e.closest("[data-layer]")?.getAttribute("data-layer") === "footprints"); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.getAttribute("data-key") ?? null }; }, otherKey);
if (shapeAt) {
  await page.mouse.move(shapeAt.x, shapeAt.y, { steps: 3 });
  await waitFor(page, (rid) => !!document.querySelector(`.fluximgPanel .lrow.hot[data-rid='${rid}']`), other, { label: "row marked", timeout: 3000 }).catch(() => {});
  h.ok(await page.evaluate((rid) => !!document.querySelector(`.fluximgPanel .lrow.hot[data-rid='${rid}']`), other), `hovering an object on the image marks its row (${otherKey}; hit-test found ${shapeAt.hit})`);
} else h.fail(`the object ${otherKey} is drawn on the live image`);
await page.mouse.move(rowBox.cx, rowBox.cy);
// The filter narrows.
await press("a");
h.ok(await page.evaluate(() => document.activeElement?.classList.contains("search-in")), "a focuses the filter");
await page.keyboard.type(firstKey);
await waitForFrame(page);
rows = await rowIds();
const objAfter = rows.filter((r) => r.startsWith("obj:"));
h.ok(objAfter.length >= 1 && objAfter.length < objRows.length && objAfter.includes(firstObj), `the filter narrows the list (${objAfter.length} objects match '${firstKey}')`);
await press("Enter");
h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)), "Enter hands the keyboard back from the filter");
await press("a");
await press("Escape");
h.ok(await page.evaluate(() => document.querySelector(".fluximgPanel .search-in")?.value === "" && document.activeElement?.classList.contains("search-in")), "Esc in the filter clears it first");
await press("Escape");
h.ok(await page.evaluate(() => !(document.activeElement instanceof HTMLInputElement)) && (await model(L)).live?.zone === "layers", "Esc in the empty filter hands the keyboard back (and stays in the zone)");
// x toggles the current row's layer; q toggles its names.
await page.click(".fluximgPanel .lrow[data-rid='layer:footprints']");
await page.click(".fluximgPanel .lrow[data-rid='layer:footprints']"); // (click toggles open; twice = back as it was, cursor on it)
const visOf = (id) => page.evaluate((id) => window.__flux.fluximg.actions.liveContext().view.layers.find((l) => l.id === id).visible, id);
const v0 = await visOf("footprints");
await press("x");
h.eq(await visOf("footprints"), !v0, "x toggles the layer's visibility in the model");
h.ok(await page.evaluate((on) => !!document.querySelector("[data-fluximg-live] [data-layer='footprints']") === on, !v0), "…and on the live image");
await press("x");
await press("q");
h.ok(await page.evaluate(() => (window.__flux.fluximg.actions.liveContext().view.furniture.names?.layers ?? []).includes("footprints")), "q turns the layer's names on in the model");
await waitFor(page, () => !!document.querySelector("[data-fluximg-live] [data-part='names'] text"), null, { label: "names drawn", timeout: 3000 }).catch(() => {});
h.ok(await page.evaluate(() => document.querySelectorAll("[data-fluximg-live] [data-part='names'] text").length > 0), "…and draws the names on the image");
await press("q");
h.ok(await page.evaluate(() => !document.querySelector("[data-fluximg-live] [data-part='names']")), "q again removes them");
await press("c");
h.ok(await page.evaluate(() => !!document.querySelector(".fluximgPanel .detail .opts")), "c lays out the layer's colours");
await press("Escape");
h.ok((await model(L)).live?.zone === "layers" && (await page.evaluate(() => !document.querySelector(".fluximgPanel .detail .opts"))), "Esc closes the colour choice and stays in the layers zone");
await press("Escape");
h.eq((await model(L)).live?.zone, "home", "Esc leaves the layers zone for home");
await closeLive();

// =====================================================================================================
h.section("the frame: a viewport onto the image, and pulling out an inset");
await openLive(L);
image = await rect("[data-fluximg-live]");
await press("v");
h.eq((await model(L)).live.zone, "frame", "v opens the frame zone");
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
h.ok(e2.crop.x > e1.crop.x && e2.crop.y > e1.crop.y && Math.abs(e2.crop.width - e1.crop.width) < 1e-9, `dragging pans the image under the frame, following the hand (x ${e1.crop.x.toFixed(1)} -> ${e2.crop.x.toFixed(1)})`);
h.eq([e2.x, e2.y, e2.width, e2.height], [e0.x, e0.y, e0.width, e0.height], "…and the box stays put");
h.eq((await model(L)).past - before.past, 1, "…as one undo step");
{
  // The navigator: the whole image, small, with the frame on it; dragging the frame's rectangle moves the frame.
  await waitFor(page, () => !!document.querySelector("[data-fluximg-navigator] img"), null, { label: "the navigator's picture", timeout: 5000 }).catch(() => {});
  const nav = await rect("[data-fluximg-navigator]"), fr = await rect("[data-fluximg-navigator] .frame");
  h.ok(!!nav && nav.w <= 277 && nav.h <= 151 && Math.abs(nav.w / nav.h - full.w / full.h) < 0.03 && !!(await page.$("[data-fluximg-navigator] img")), `the frame zone shows the whole image as a small map (${nav && [nav.w, nav.h].map((n) => n.toFixed(0)).join(" x ")} px)`);
  h.ok(!!fr && Math.abs(fr.w / nav.w - e2.crop.width / full.w) < 0.02 && Math.abs((fr.x - nav.x) / nav.w - e2.crop.x / full.w) < 0.02, "…with the frame's rectangle where the frame is");
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
}
await press("d");
h.ok(!(await model(L)).el.crop, "d (Whole image) restores the whole frame");
{ const b = (await model(L)).el; h.ok([b.x - e0.x, b.y - e0.y, b.width - e0.width, b.height - e0.height].every((d) => Math.abs(d) < 1e-6), `…in the box the image has: it neither moves nor grows on the figure (${[b.x, b.y, b.width, b.height].map((n) => n.toFixed(1)).join(", ")})`); }
h.ok(!(await page.$("[data-fluximg-navigator] .frame")) && !!(await page.$("[data-fluximg-navigator]")), "on the whole image the map stays and carries no rectangle");
await wheel(px, py, -100, 4);
await settled();
const frame = (await model(L)).el.crop;
before = await model(L);
await press("x");
h.ok((await model(L)).live.armed === "inset" && (await model(L)).past === before.past, "x arms drawing an inset: nothing is made yet");
h.ok(await page.evaluate(() => document.querySelector(".fluximgPanel .row[data-key='x']").classList.contains("armed") && /draw/.test(document.querySelector(".fluximgPanel .row[data-key='x'] .value").textContent)), "…and its row says to draw it on the image");
await press("x");
await waitForFrame(page);
const after2 = await model(L);
const inset = await page.evaluate((id) => window.__flux.figures()[0].elements.find((e) => e.type === "fluximg" && e.view?.insetOf === id) ?? null, L);
h.ok(!!inset, "x again pulls out the frame as it is: one new element that remembers its parent");
h.ok(inset && Math.abs(inset.crop.x - frame.x) < 1e-6 && Math.abs(inset.crop.width - frame.width) < 1e-6 && Math.abs(inset.crop.y - frame.y) < 1e-6, "…whose crop is the frame");
h.ok(!after2.el.crop, "…and the parent returns to the frame it had before (the whole image)");
h.eq(after2.past - before.past, 1, "…in one undo step");
h.eq(after2.live?.zone, "home", "…and the panel goes back home");
await waitFor(page, () => !!document.querySelector("[data-fluximg-live] [data-part='inset']"), null, { label: "inset outline on the live image", timeout: 3000 }).catch(() => {});
h.ok(await page.evaluate(() => !!document.querySelector("[data-fluximg-live] [data-part='inset']")), "the parent draws the inset's rectangle in the live view");
h.ok(await page.evaluate((a) => !!document.querySelector(`svg[data-fluximg="${a}"] [data-part='inset']`), after2.el.assetId), "…and at rest");
h.ok(await inFigure([inset.id]), "the inset lies inside the figure");
{
  // A rectangle drawn on the image becomes an inset, and the image keeps its frame.
  await press("v"); await press("x");
  image = await rect("[data-fluximg-live]");
  const m0 = await model(L), n0 = await page.evaluate((id) => window.__flux.figures()[0].elements.filter((e) => e.view?.insetOf === id).length, L);
  await page.mouse.move(image.x + 0.2 * image.w, image.y + 0.25 * image.h); await page.mouse.down();
  await page.mouse.move(image.x + 0.3 * image.w, image.y + 0.4 * image.h, { steps: 3 }); await page.mouse.move(image.x + 0.4 * image.w, image.y + 0.5 * image.h, { steps: 3 });
  await waitForFrame(page);
  const guide = await rect("[data-fluximg-live] .vec .draw");
  h.ok(!!guide && Math.abs(guide.w - 0.2 * image.w) < 2 && Math.abs(guide.h - 0.25 * image.h) < 2, `while it is drawn the rectangle shows as a guide (${guide && [guide.w, guide.h].map((n) => n.toFixed(0)).join(" x ")} px)`);
  await page.mouse.up();
  await waitForFrame(page);
  const m1 = await model(L);
  const drawn = await page.evaluate((id) => window.__flux.figures()[0].elements.filter((e) => e.view?.insetOf === id), L);
  const d = drawn[drawn.length - 1];
  h.eq(drawn.length - n0, 1, "releasing makes one inset");
  h.ok(Math.abs(d.crop.x - 0.2 * full.w) < 1.5 && Math.abs(d.crop.y - 0.25 * full.h) < 1.5 && Math.abs(d.crop.width - 0.2 * full.w) < 1.5 && Math.abs(d.crop.height - 0.25 * full.h) < 1.5, `…of the rectangle drawn (${[d.crop.x, d.crop.y, d.crop.width, d.crop.height].map((n) => n.toFixed(1)).join(", ")} of ${full.w} x ${full.h})`);
  h.ok(!m1.el.crop, "…and the image keeps its own frame");
  h.ok(Math.abs(d.width / d.height - d.crop.width / d.crop.height) < 1e-6 && (await inFigure([d.id])), "…at its region's aspect, inside the figure");
  h.eq(m1.past - m0.past, 1, "…in one undo step");
  h.ok(m1.live?.armed !== "inset" && !(await page.$("[data-fluximg-live] .vec .draw")), "…and drawing is disarmed, the guide gone");
  await press("Escape");
}
await closeLive();

// =====================================================================================================
h.section("annotations: the live overlay and the element at rest draw the same vectors");
await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
const MV = await placeFixture("movie_f32", { x: 80, y: 60 }, { width: 360 });
await waitStill(MV);
await openLive(MV);
const ann = [["b", "scalebar"], ["w", "stamp"], ["c", "channelLabels"], ["g", "colorbar"]];
await press("b");
h.eq((await model(MV)).live?.zone, "annotate", "b at home opens the Annotations zone");
h.eq(await page.evaluate(() => [...document.querySelectorAll(".fluximgPanel [data-key]")].map((e) => `${e.getAttribute("data-key")}:${e.querySelector(".label")?.textContent.trim()}`)), ["b:Scale bar", "w:Position stamp", "c:Channel names", "g:Calibration bar"], "…listing scale bar, position stamp, channel names and calibration bar");
for (const [key, kind] of ann) {
  await press(key);
  h.ok(await page.evaluate((k) => !!window.__flux.fluximg.actions.liveContext().view.furniture[k], kind), `${key} turns the ${kind} on`);
}
{
  const corner = (k) => page.evaluate((k) => window.__flux.fluximg.actions.liveContext().view.furniture[k].corner, k);
  const rowValue = (key) => page.evaluate((key) => document.querySelector(`.fluximgPanel .row[data-key='${key}'] .value`).textContent.trim(), key);
  const c0 = await corner("scalebar"), m0 = await model(MV);
  h.eq(await rowValue("b"), c0.replace("-", " "), "an annotation that is on shows its corner in its row");
  const seen = [c0];
  for (let i = 0; i < 4; i++) { await press("B", ["Shift"]); seen.push(await corner("scalebar")); }
  h.ok(new Set(seen.slice(0, 4)).size === 4 && seen[4] === c0, `Shift + its key walks an annotation round the four corners and back (${seen.join(" -> ")})`);
  h.ok(await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar), "…without switching it off");
  h.ok((await model(MV)).past > m0.past, "…as undo steps");
}
const parts = ["scalebar", "scalebar.label", "stamp", "colorbar"];
const markup = () => page.evaluate(({ id, parts }) => {
  const el = window.__flux.figures()[0].elements.find((e) => e.id === id);
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const clean = (n) => (n ? n.outerHTML.replace(/<!--.*?-->/g, "").replaceAll(`fxl-${safe}-`, `fx-${safe}-`) : null);
  const live = document.querySelector("[data-fluximg-live] svg.vec"), rest = document.querySelector(`svg[data-fluximg="${el.assetId}"]`);
  return {
    parts: Object.fromEntries(parts.map((p) => [p, [!!live?.querySelector(`[data-part='${p}']`), !!rest?.querySelector(`[data-part='${p}']`)]])),
    channelNames: [live?.querySelectorAll("[data-part='furniture'] text").length ?? 0, rest?.querySelectorAll("[data-part='furniture'] text").length ?? 0],
    live: clean(live?.querySelector("[data-part='furniture']")), rest: clean(rest?.querySelector("[data-part='furniture']")),
  };
}, { id: MV, parts });
await waitFor(page, ({ id }) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); return !!document.querySelector(`svg[data-fluximg="${el.assetId}"] [data-part='colorbar']`); }, { id: MV }, { label: "furniture at rest", timeout: 4000 }).catch(() => {});
let mk = await markup();
for (const p of parts) h.ok(mk.parts[p][0] && mk.parts[p][1], `${p}: drawn in the live overlay and at rest`);
h.ok(mk.live && mk.live === mk.rest, `the furniture markup is identical apart from the id prefix (${mk.live?.length ?? 0} chars)`);
await shot(page, "fluximg-live-annotations");
for (const [key] of ann) await press(key);
h.ok(await page.evaluate(() => !document.querySelector("[data-fluximg-live] [data-part='furniture']")), "toggling them all again removes them");
await press("Escape");
h.ok((await isOpen()) && (await model(MV)).live?.zone === "home", "Esc backs out of the Annotations zone to home");
// An image that does not say how big a pixel is: the scale bar refuses, and says why.
const RG = await placeFixture("rgb_u8", { x: 520, y: 60 }, { width: 200 });
await waitStill(RG);
await openLive(RG);
await press("b"); await press("b");
await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /scale bar/i.test(t.textContent)), null, { label: "scale bar toast", timeout: 3000 }).catch(() => {});
h.ok(!(await page.evaluate(() => !!window.__flux.fluximg.actions.liveContext().view.furniture.scalebar)) && (await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => /scale bar/i.test(t.textContent)))), "without a pixel size the scale bar refuses with a message");
h.ok(!(await page.$(".fluximgPanel [data-key='w']")), "…and an image without rails offers no position stamp");
await press("Escape");
await openLive(MV);

// =====================================================================================================
h.section("undo and redo through live gestures");
const ctrlZ = () => press("z", ["Control"]);
const ctrlShiftZ = () => press("z", ["Control", "Shift"]);
await page.evaluate(() => window.__flux.fig.resetHistory());
const viewNow = () => page.evaluate((id) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); const c = window.__flux.fluximg.actions.liveContext(); return { stored: JSON.stringify(el?.view ?? {}), live: !!window.__flux.get(window.__flux.fluximg.live.fluximgLive), ctx: c ? { t: c.view.index.t, scalebar: !!c.view.furniture.scalebar, white: c.view.channels[0].range[1] } : null, panelT: document.querySelector(".fluximgPanel .row[data-key='t'] .value")?.textContent?.trim() ?? null, railT: document.querySelector("[data-fluximg-rail='t'] .readout")?.textContent?.trim() ?? null }; }, MV);
const states = [await viewNow()];
await press("ArrowRight"); await press("ArrowRight"); await settled();
states.push(await viewNow());
await press("b"); await press("b"); await press("Escape");
states.push(await viewNow());
await press("1"); await wheel(image.cx, image.cy, -100, 2); await settled(); await press("Escape");
states.push(await viewNow());
h.ok(states[1].ctx.t === 2 && states[2].ctx.scalebar && states[3].ctx.white > states[2].ctx.white, "three live gestures: two frames on, a scale bar, a whiter white point");
let okUndo = true, drawn = true;
for (let i = 3; i > 0; i--) {
  await ctrlZ();
  await sharpFrame(); await waitForFrame(page);
  const gs = await glStats();
  if (!gs || gs.lost || gs.a < 200) { drawn = false; console.log("  live image after undo", i, gs); }
  const s = await viewNow();
  if (!(s.live && s.stored === states[i - 1].stored && s.ctx && JSON.stringify(s.ctx) === JSON.stringify(states[i - 1].ctx) && s.panelT === states[i - 1].panelT && s.railT === states[i - 1].railT)) { okUndo = false; console.log("  undo mismatch", i, s, states[i - 1]); }
}
h.ok(okUndo, "Ctrl+Z steps back through each live gesture while the view stays open, panel and rail agreeing with the model");
h.ok(drawn, "…and the live image keeps drawing after every undo (its WebGL context survives the project being replaced)");
let okRedo = true;
for (let i = 1; i <= 3; i++) {
  await ctrlShiftZ();
  const s = await viewNow();
  if (!(s.live && s.stored === states[i].stored && s.panelT === states[i].panelT)) { okRedo = false; console.log("  redo mismatch", i, s, states[i]); }
}
h.ok(okRedo, "Ctrl+Shift+Z steps forward through them again");
// An undo while a wheel run is still open undoes that run (it does not leave half of it behind).
const tBefore = (await viewNow()).ctx.t;
await wheel(image.cx, image.cy, 100, 2);
await ctrlZ();
await sleep(500); // debounce: past the wheel's 420 ms settle, so a stray late commit would show
h.eq((await viewNow()).ctx.t, tBefore, "Ctrl+Z in the middle of a wheel run undoes the run");
// Undo past the element's creation closes the view without errors.
await page.evaluate(() => { const F = window.__flux; F.fig.resetHistory(); });
await closeLive();
await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
const U = await placeFixture("stack_u16", { x: 80, y: 60 }, { width: 320 });
await waitStill(U);
await openLive(U);
await press("ArrowDown"); await settled();
await ctrlZ();
h.ok(await isOpen(), "the first Ctrl+Z undoes the live step and keeps the view open");
await ctrlZ();
await waitFor(page, () => !document.querySelector("[data-fluximg-live]") && !document.querySelector(".fluximgPanel"), null, { label: "view closed after undoing the element away", timeout: 3000 }).catch(() => {});
h.ok(!(await isOpen()) && !(await page.$("[data-fluximg-live]")) && !(await page.$(".fluximgPanel")), "undoing past the element's creation closes the view");
await press("h");
h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.activeTool)), "hand", "…and the keyboard is the canvas's again");
await press("v");

// =====================================================================================================
h.section("playback, the wheel's ownership, and leaks");
await page.evaluate(() => { const F = window.__flux; F.fluximg.live.closeFluximgLive(); F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); F.fig.resetHistory(); });
const PB = await placeFixture("movie_f32", { x: 80, y: 60 }, { width: 320 });
await waitStill(PB);
await openLive(PB);
image = await rect("[data-fluximg-live]");
const playing = () => page.evaluate(() => structuredClone(window.__flux.get(window.__flux.fluximg.live.fluximgLive)?.playing ?? null));
const pastNow = () => page.evaluate(() => window.__flux.fig.historyStats().past);
const past0 = await pastNow();
// Space+drag over the live image pans the canvas (as everywhere in Flux) and plays nothing.
const vpNow = () => page.evaluate(() => structuredClone(window.__flux.get(window.__flux.fig.viewport)));
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
await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
await waitForFrame(page);
image = await rect("[data-fluximg-live]");
await page.keyboard.down(" ");
for (let i = 0; i < 5; i++) { await page.keyboard.down(" "); await sleep(20); } // debounce: 20 ms between repeats
h.ok(!(await playing()), "a held Space (auto-repeat) toggles nothing while held");
await page.keyboard.up(" ");
await waitForFrame(page);
h.ok(!!(await playing()), "a Space tap plays");
const steady = await page.evaluate(async () => {
  const out = [], t0 = performance.now();
  const r = (s) => { const e = document.querySelector(s); if (!e) return "none"; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(","); };
  while (performance.now() - t0 < 900) { await new Promise((res) => requestAnimationFrame(res)); out.push({ t: window.__flux.fluximg.actions.liveContext()?.view.index.t, layout: [r(".fluximgPanel"), r(".fx-railpos .rail"), r(".fluximgPanel .readout"), r("[data-fluximg-rail] .readout"), r("[data-fluximg-rail] .track"), r("[data-fluximg-live]"), r("[data-fluximg-live] canvas.gl")].join("|"), anims: document.getAnimations().filter((a) => !a.effect?.target?.closest?.(".toasts")).length, who: document.getAnimations().map((a) => (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? "?") + ":" + (a.animationName ?? a.transitionProperty ?? "")).join(",") }); }
  return out;
});
h.ok(new Set(steady.map((s) => s.t)).size >= 5, `playback advances (${new Set(steady.map((s) => s.t)).size} planes in 0.9 s)`);
h.eq(new Set(steady.map((s) => s.layout)).size, 1, "nothing moves or changes size while playing (panel, rail, readout, track, image, canvas)");
h.ok(steady.every((s) => s.anims === 0), `nothing is animated by CSS while playing (toasts aside)${steady.find((s) => s.anims) ? `: ${steady.find((s) => s.anims).who}` : ""}`);
await press(" ");
await settled();
h.ok(!(await playing()), "Space again stops");
h.eq((await pastNow()) - past0, 1, "a playback is one undo step");
// Ctrl+wheel always zooms the canvas, even with a rail armed; the plane stays.
const tNow = await idx(PB, "t"), z0 = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
await wheel(image.cx, image.cy, -100, 1, ["Control"]);
const z1 = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
h.ok(z1 > z0 && (await idx(PB, "t")) === tNow, `Ctrl+wheel zooms the canvas while a rail is armed (${z0} -> ${z1.toFixed(3)}), and the plane stays`);
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
for (let i = 0; i < 20; i++) { await openLive(PB); await press("1"); await press("Escape"); await closeLive(); }
const l1 = await listeners();
const grew = Object.keys({ ...l0, ...l1 }).filter((k) => (l1[k] ?? 0) > (l0[k] ?? 0)).map((k) => `${k} ${l0[k] ?? 0}->${l1[k]}`);
h.eq(grew, [], "20 opens and closes leave no window or document listener behind");
const ctx = await page.evaluate(() => ({ made: window.__fxCtx.length, alive: window.__fxCtx.filter((c) => !c.isContextLost()).length }));
h.ok(ctx.made >= 20 && ctx.alive === 0, `…and every WebGL context is released (${ctx.made} made, ${ctx.alive} still alive)`);
await cdp.detach();

// =====================================================================================================
h.section("after closing, the still shows the last live state");
await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
const SM = await placeFixture("movie_f32", { x: 80, y: 60 }, { width: 360 });
await waitStill(SM);
await openLive(SM);
image = await rect("[data-fluximg-live]");
await wheel(image.cx, image.cy, 100, 5); await settled();
await press("2"); await press("z"); await press("Escape");
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
await waitFor(page, ({ id, t }) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); const k = document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getAttribute("data-fluximg-key") ?? ""; return k.includes(`t=${t};`) || k.includes(`t=${t}|`) || new RegExp(`[;|]t=${t}([;|]|$)`).test(k); }, { id: SM, t: liveView.index.t }, { label: "the still at the last plane", timeout: 8000 }).catch(() => {});
const stillKey = await page.evaluate((id) => { const el = window.__flux.figures()[0].elements.find((e) => e.id === id); return document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getAttribute("data-fluximg-key") ?? ""; }, SM);
const c1v = liveView.channels[1], c0v = liveView.channels[0];
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

// =====================================================================================================
h.section("timings (real frames from flux-fluximg-frame; generous ceilings)");
const timings = {};
for (const [name, width] of [["mid_tiled_u16", 420], ["big_tiled_u16", 420]]) {
  await page.evaluate(() => { const F = window.__flux; F.fig.commit((p) => { p.figures[0].elements = p.figures[0].elements.filter((e) => e.type !== "fluximg"); }); F.fig.resetHistory(); });
  const T = await placeFixture(name, { x: 80, y: 40 }, { width });
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
  await closeLive();
}

// =====================================================================================================
h.section("console");
const errs = realErrors(page).filter((e) => !/Couldn't save|save figures/i.test(e));
h.eq(errs, [], "no console errors anywhere");

await h.done(async () => { await browser.close(); rmSync(scratch, { recursive: true, force: true }); });
