// fluximg live view (F4): the board never covers what its image has just given rise to, and channel split-outs keep
// their colour. On the real canvas (Figure): split a two-channel and a four-channel image, pull an inset out to the
// right and below, open the board later on an image that has panels (and on one of its panels): after each, every
// panel's rectangle is clear of every instrument's and everything is inside the canvas (the view makes room when it
// must, and keeps the image where it is when it need not). The previews are honest: the ghost panels are washed in
// the look they will have, and where an instrument will move once they exist a dashed outline says where (the press
// moves it there, once). The Split key: S splits in the look last used (colour for a first-time user), Shift+S the
// other, remembered across a close and open; a lamp shows the look; with panels present the key is lit and flips them
// (one undo step), sparing a panel recoloured by hand. Ends with "no console errors".
//
// UI tier, runtime tsx (it writes synthetic bundles with scripts/lib/fluximgFixtures.ts). Real keys and pointer.
// Run (dev server, FLUX_URL): node --import tsx scripts/verify-fluximg-board-room-gui.mjs
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForFrame, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-board-room-gui");
const SHOTS = process.env.FX_SHOTS ?? "";
const scratch = mkdtempSync(path.join(tmpdir(), "fx-room-"));
async function fixture(name, C, colors) {
  const Z = 5, Hh = 48, Ww = 64, d = new Uint16Array(C * Z * Hh * Ww);
  let k = 0;
  for (let c = 0; c < C; c++) for (let z = 0; z < Z; z++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) {
    const cx = 14 + c * 12, cy = 12 + c * 7, r2 = (x - cx) ** 2 + (y - cy) ** 2;
    d[k++] = 60 + Math.round(1400 * Math.exp(-r2 / 90)) + ((x * 3 + y * 5 + z * 40) % 90);
  }
  await writeFixture(scratch, { name, about: `${C} channels`, dims: ["c", "z", "y", "x"], shape: [C, Z, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { z: { unit: "µm", scale: 1 }, y: { unit: "µm", scale: 0.3 }, x: { unit: "µm", scale: 0.3 } }, channels: colors.map((color, i) => ({ name: `ch${i + 1}`, color })) } });
}
await fixture("two_u16", 2, ["#ff00ff", "#00ff00"]);
await fixture("four_u16", 4, ["#ff00ff", "#00ff00", "#00ffff", "#ffff00"]);
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}

const { browser, page } = await launch({ width: 1500, height: 950 });
const base = new URL(APP_URL);
base.search = "?fixture=demo";
await gotoApp(page, { url: base.href, settle: 1500 });
// A first-time user: no remembered split look.
await page.evaluate(() => { const F = window.__flux; F.settings.update((s) => ({ ...s, fluximgSplitLook: "color" })); });
await clickMode(page, "Figure");
await waitFor(page, () => !!window.__flux?.fluximg && !!document.querySelector(".canvas-host"), null, { label: "Figure mode with the dev handle" });

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
    F.fig.commit((p) => { id = F.ops.addFluximg(p, { figureId, asset, x: at.x, y: at.y, ...extra }); });
    return id;
  }, { name, files, at, extra });
}
const waitStill = (id) => waitFor(page, (id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); const n = el && document.querySelector(`svg[data-fluximg="${el.assetId}"]`); return !!n?.querySelector("image") && !!n.getAttribute("data-fluximg-key"); }, id, { label: `the still of ${id}`, timeout: 15000 });
const isOpen = () => page.evaluate(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const rect = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const rects = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; }), sel);
const overlaps = (a, b) => !(a.right <= b.x + 0.5 || a.x >= b.right - 0.5 || a.bottom <= b.y + 0.5 || a.y >= b.bottom - 0.5);
const within = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
const vpNow = () => page.evaluate(() => structuredClone(window.__flux.get(window.__flux.fig.viewport)));
const history = () => page.evaluate(() => window.__flux.fig.historyStats().past);
const els = () => page.evaluate(() => structuredClone(window.__flux.figures()[0].elements.filter((e) => e.type === "fluximg")));
const lookPref = () => page.evaluate(() => window.__flux.get(window.__flux.settings).fluximgSplitLook);
const key = (id) => `[data-fxb-key='${id}']`;
async function openLive(id) {
  if (await isOpen()) await closeLive();
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), id);
  await page.mouse.move(5, 940);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "live view open with its board" });
  await settle();
}
async function closeLive() {
  if (await isOpen()) await page.evaluate(() => window.__flux.fluximg.live.closeFluximgLive());
  await waitFor(page, () => !document.querySelector("[data-fluximg-live]") && !document.querySelector("[data-fxb]"), null, { label: "live view closed" });
}
/** The board measures its console, places itself and, when it must, asks the view for room: wait for all of it. */
async function settle() {
  await waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgFitDue), null, { label: "the board placed (and the view made room, if it had to)", timeout: 4000 });
  await sleep(220); // debounce: the instruments fade in over 150 ms and the moved view repaints
  await waitForFrame(page);
}
async function fresh(name, at, extra = {}, figure = { width: 1400, height: 1100 }, view = { panX: 240, panY: 110, zoom: 1 }) {
  await page.evaluate(({ figure, view }) => { const F = window.__flux; F.fluximg.live.closeFluximgLive(); F.fig.commit((p) => { const f = p.figures[0]; f.x = 0; f.y = 0; f.width = figure.width; f.height = figure.height; f.elements = []; F.fig.activeFigureId.set(f.id); }); F.fig.viewport.set(view); }, { figure, view });
  const id = await placeFixture(name, at, extra);
  await waitStill(id);
  await page.evaluate(() => window.__flux.fig.resetHistory());
  return id;
}
/** Every instrument of the board, every given element's box, the image and the canvas, on screen. */
const scene = (ids) => page.evaluate((ids) => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
  return {
    host: r(document.querySelector(".canvas-host")), image: r(document.querySelector("[data-fluximg-live]")),
    instruments: [...document.querySelectorAll("[data-fxb-console], [data-fxb] > .part")].map(r).filter((b) => b.w > 0 && b.h > 0),
    panels: ids.map((id) => document.querySelector(`[data-editor-element-id="${id}"]`)).filter(Boolean).map(r),
  };
}, ids);
async function clear(label, ids) {
  const s = await scene(ids);
  h.ok(s.panels.length === ids.length, `${label}: every panel is drawn (${s.panels.length} of ${ids.length})`);
  const hit = s.panels.flatMap((p, i) => s.instruments.filter((b) => overlaps(p, b)).map(() => i));
  h.ok(!hit.length, `${label}: no instrument covers a panel${hit.length ? ` (panels ${[...new Set(hit)].join(", ")}; ${JSON.stringify({ vp: await vpNow(), ...s })})` : ""}`);
  h.ok(s.instruments.every((b) => !overlaps(b, s.image)), `${label}: no instrument covers the image`);
  h.ok([s.image, ...s.panels, ...s.instruments].every((b) => within(b, s.host)), `${label}: the image, every panel and every instrument are inside the canvas`);
  return s;
}
const lookOfPanel = (e, comp) => page.evaluate(({ e, comp }) => window.__flux.fluximg.splitLook.lookOf(e.view?.channels?.[e.view.solo], comp.view?.channels?.[e.view.solo]), { e, comp });

// =====================================================================================================
h.section("split two channels, in colour by default: the panels stand clear, the preview said where everything would be");
const A = await fresh("two_u16", { x: 200, y: 80 }, { width: 320 }, undefined, { panX: 160, panY: 110, zoom: 0.7 });
await openLive(A);
{
  const vp0 = await vpNow(), hist0 = await history();
  h.eq(await lookPref(), "color", "a first-time user splits in colour");
  const lamp = await page.evaluate(() => document.querySelector("[data-fxb-key='split'] [data-fxb-lamp]")?.getAttribute("style") ?? "");
  h.ok(/conic-gradient/.test(lamp) && /255, 0, 255|#ff00ff/i.test(lamp), `the Split key's lamp shows the channels' colours (${lamp.slice(0, 80)}…)`);
  const label = await page.evaluate(() => document.querySelector("[data-fxb-key='split']")?.getAttribute("data-tip"));
  h.ok(/in colour/.test(label) && /⇧ in gray/.test(label), `its label says so, and what Shift does ("${label}")`);
  const k = await rect(key("split"));
  await page.mouse.move(k.cx - 2, k.cy); await page.mouse.move(k.cx, k.cy);
  await waitFor(page, () => document.querySelectorAll("[data-fxb-ghost]").length === 2, null, { label: "Split's ghosts" });
  await waitForFrame(page);
  const ghosts = await rects("[data-fxb-ghost]"), washes = await page.evaluate(() => [...document.querySelectorAll("[data-fxb-ghost]")].map((e) => e.style.background));
  h.ok(washes.every((w) => /color-mix|gradient/.test(w)) && /255, 0, 255|ff00ff/i.test(washes[0]) && /0, 255, 0|00ff00/i.test(washes[1]), `the ghost panels are washed in their channels' colours (${washes.map((w) => w.slice(0, 40)).join(" | ")})`);
  const outlines = await rects("[data-fxb-after]");
  h.ok(outlines.length > 0, `where an instrument will stand once the panels exist is outlined (${outlines.length})`);
  h.ok(outlines.every((o) => ghosts.every((g) => !overlaps(o, g))), "…clear of every ghost panel (the preview is honest about the board)");
  if (SHOTS) await shot(page, "fluximg-split-preview-colour");
  // Shift while resting on the key: the other look.
  await page.keyboard.down("Shift"); await waitForFrame(page);
  const gw = await page.evaluate(() => [...document.querySelectorAll("[data-fxb-ghost]")].map((e) => e.style.background));
  h.ok(gw.length === 2 && gw.every((w) => /242, 240, 229|f2f0e5/i.test(w)), "holding Shift on the key previews the gray look");
  await page.keyboard.up("Shift"); await waitForFrame(page);
  await page.mouse.down(); await page.mouse.up();
  await settle();
  const made = (await els()).filter((e) => e.id !== A);
  const comp = (await els()).find((e) => e.id === A);
  h.eq(made.length, 2, "S (the key) made two channel panels");
  h.eq(await Promise.all(made.map((e) => lookOfPanel(e, comp))), ["color", "color"], "…each in its channel's colour in the merged image");
  h.eq((await history()) - hist0, 1, "…in one undo step");
  const vp1 = await vpNow();
  h.ok(vp1.panX === vp0.panX && vp1.panY === vp0.panY && vp1.zoom === vp0.zoom, "everything already fits: the view does not move (the image stays where the eye is)");
  const after = await rects("[data-fxb-console], [data-fxb] > .part");
  h.ok(outlines.every((o) => after.some((b) => Math.abs(b.x - o.x) <= 1.5 && Math.abs(b.y - o.y) <= 1.5)), "the instruments moved once, to exactly where the outlines were");
  h.eq((await rects("[data-fxb-after]")).length, 0, "…and the outlines are gone");
  await clear("two channels in colour", made.map((e) => e.id));
  if (SHOTS) await shot(page, "fluximg-split-colour-board");
  // The key is lit now and flips the split; the lamp shows the split's look.
  h.ok(await page.evaluate(() => document.querySelector("[data-fxb-key='split']").classList.contains("on")), "with panels present the Split key is lit");
  const h1 = await history();
  await page.mouse.move(5, 940);
  await press("s");
  const flipped = (await els()).filter((e) => e.id !== A);
  h.eq(await Promise.all(flipped.map((e) => lookOfPanel(e, comp))), ["gray", "gray"], "S on a split image flips every panel to gray");
  h.ok(flipped.length === 2 && (await history()) - h1 === 1, "…no new panels, one undo step");
  h.eq(await lookPref(), "gray", "…and gray is remembered as the look last chosen");
  await press("z", ["Control"]);
  h.eq(await Promise.all((await els()).filter((e) => e.id !== A).map((e) => lookOfPanel(e, comp))), ["color", "color"], "one undo brings the colours back");
  // A panel recoloured by hand keeps the hand's choice through a flip.
  await page.evaluate((id) => window.__flux.fig.commit((p) => window.__flux.ops.setFluximgView(p, id, { channels: [null, { color: "#ffff00" }] })), made[1].id);
  await press("s");
  const kept = (await els()).filter((e) => e.id !== A);
  h.eq([await lookOfPanel(kept[0], comp), kept[1].view.channels[1].color], ["gray", "#ffff00"], "a panel recoloured by hand keeps its colour through the flip");
  // The composite's colour reaches a coloured panel; a gray one stays gray.
  await press("s"); // back to colour (the hand-coloured one aside)
  await page.evaluate((id) => window.__flux.fig.commit((p) => window.__flux.ops.setFluximgView(p, id, { channels: [{ color: "#00ffff" }] })), A);
  const fol = (await els()).filter((e) => e.id !== A);
  h.eq(fol[0].view.channels[0].color, "#00ffff", "a coloured panel follows its channel's new colour on the composite");
}

h.section("the look is remembered across a close and an open; Shift+S splits in the other");
{
  await closeLive();
  const B = await fresh("two_u16", { x: 200, y: 80 }, { width: 320 }, undefined, { panX: 160, panY: 110, zoom: 0.7 });
  await page.evaluate(() => window.__flux.settings.update((s) => ({ ...s, fluximgSplitLook: "gray" })));
  await openLive(B);
  const label = await page.evaluate(() => document.querySelector("[data-fxb-key='split']")?.getAttribute("data-tip"));
  h.ok(/in gray/.test(label) && /⇧ in colour/.test(label), `reopened, the key offers the look last chosen ("${label}")`);
  const lamp = await page.evaluate(() => document.querySelector("[data-fxb-key='split'] [data-fxb-lamp]")?.getAttribute("style") ?? "");
  h.ok(/linear-gradient/.test(lamp) && !/conic/.test(lamp), "…its lamp is the gray ramp");
  await press("S", ["Shift"]);
  await settle();
  const comp = (await els()).find((e) => e.id === B), made = (await els()).filter((e) => e.id !== B);
  h.eq(await Promise.all(made.map((e) => lookOfPanel(e, comp))), ["color", "color"], "Shift+S splits in the other look (colour)");
  h.eq(await lookPref(), "color", "…which is then the look last chosen");
  await clear("two channels, Shift+S", made.map((e) => e.id));
}

h.section("four channels at zoom 1: the panels run past the canvas; the view makes room");
{
  await closeLive();
  const Q = await fresh("four_u16", { x: 120, y: 80 }, { width: 300 }, { width: 1700, height: 1100 }, { panX: 240, panY: 110, zoom: 1 });
  await openLive(Q);
  const vp0 = await vpNow();
  await page.mouse.move(5, 940);
  await press("s");
  await settle();
  const made = (await els()).filter((e) => e.id !== Q);
  h.eq(made.length, 4, "four channel panels");
  const vp1 = await vpNow();
  h.ok(vp1.zoom < vp0.zoom || vp1.panX !== vp0.panX, `the view made room for them (zoom ${vp0.zoom} → ${vp1.zoom.toFixed(3)}, pan ${vp0.panX} → ${vp1.panX.toFixed(0)})`);
  await clear("four channels", made.map((e) => e.id));
  if (SHOTS) await shot(page, "fluximg-split-four-board");
  // Opened again later on the composite, and on one of the panels: the same.
  await closeLive();
  await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
  await openLive(Q);
  await clear("opened later on the composite", made.map((e) => e.id));
  await closeLive();
  await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }));
  await openLive(made[1].id);
  await clear("opened on a panel (its siblings and the composite kept)", [Q, made[0].id, made[2].id, made[3].id]);
  await closeLive();
}

h.section("gray split with the board open (four channels, Shift+S)");
{
  const G = await fresh("four_u16", { x: 120, y: 80 }, { width: 220 }, { width: 1500, height: 1100 }, { panX: 200, panY: 110, zoom: 0.8 });
  await openLive(G);
  await page.mouse.move(5, 940);
  await press("S", ["Shift"]);
  await settle();
  const comp = (await els()).find((e) => e.id === G), made = (await els()).filter((e) => e.id !== G);
  h.eq((await Promise.all(made.map((e) => lookOfPanel(e, comp)))).every((l) => l === "gray"), true, "Shift+S with colour remembered: four gray panels");
  await clear("four channels in gray", made.map((e) => e.id));
  if (SHOTS) await shot(page, "fluximg-split-gray-board");
  await closeLive();
}

h.section("an inset pulled out to the right, and one below");
for (const [label, figure, where] of [["to the right", { width: 1400, height: 1100 }, "right"], ["below (no room at the right)", { width: 560, height: 1100 }, "below"]]) {
  const I = await fresh("two_u16", { x: 200, y: 80 }, { width: 320 }, figure, { panX: 240, panY: 110, zoom: 1 });
  await openLive(I);
  const img = await rect("[data-fluximg-live]");
  await press("x");
  // Drag a box on the image: while it is drawn, its inset's ghost (and the instruments' places to come) show.
  await page.mouse.move(img.x + 0.2 * img.w, img.y + 0.25 * img.h); await page.mouse.down();
  await page.mouse.move(img.x + 0.35 * img.w, img.y + 0.4 * img.h, { steps: 3 }); await page.mouse.move(img.x + 0.5 * img.w, img.y + 0.55 * img.h, { steps: 3 });
  await waitForFrame(page);
  const ghost = await rects("[data-fxb-ghost]"), outlines = await rects("[data-fxb-after]");
  h.ok(ghost.length === 1, `${label}: while the box is drawn, the inset's ghost shows where it will go`);
  h.ok(outlines.every((o) => ghost.every((g) => !overlaps(o, g))), `${label}: …and no instrument's place to come lies on it (${outlines.length} outlined)`);
  if (SHOTS && where === "right") await shot(page, "fluximg-inset-preview");
  await page.mouse.up();
  await settle();
  const inset = (await els()).find((e) => e.view?.insetOf === I);
  const parent = (await els()).find((e) => e.id === I);
  h.ok(!!inset && (where === "right" ? inset.x >= parent.x + parent.width : inset.y >= parent.y + parent.height), `${label}: the inset stands ${where} of its image`);
  h.eq(await page.evaluate(() => document.querySelectorAll("[data-fxb-ghost]").length), 0, `${label}: the ghost is gone`);
  await clear(`an inset ${label}`, [inset.id]);
  if (SHOTS) await shot(page, `fluximg-inset-${where}-board`);
  await closeLive();
}

h.section("nothing animates at rest; no console errors");
{
  const Z = await fresh("two_u16", { x: 200, y: 80 }, { width: 320 }, undefined, { panX: 160, panY: 110, zoom: 0.7 });
  await openLive(Z);
  await page.mouse.move(5, 940);
  await sleep(300);
  const frames = await page.evaluate(() => new Promise((res) => {
    let n = 0; const raf = window.requestAnimationFrame.bind(window), orig = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { n++; return raf(cb); };
    setTimeout(() => { window.requestAnimationFrame = orig; const anims = document.getAnimations().filter((a) => !a.effect?.target?.closest?.(".toasts")); // a toast fades on its own clock: not the board
      res({ n, anims: anims.length, who: anims.map((a) => `${a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? "?"}:${a.animationName ?? a.transitionProperty ?? ""}`).join(",") }); }, 1000);
  }));
  h.ok(frames.n === 0 && frames.anims === 0, `the board open and idle for a second: no animation frames asked for, nothing animating (${frames.n} frames, ${frames.anims} animations${frames.who ? `: ${frames.who}` : ""})`);
  await closeLive();
}
h.eq(realErrors(page).filter((e) => !/Couldn't save|save figures/i.test(e)), [], "no console errors");
await browser.close();
await h.done();
