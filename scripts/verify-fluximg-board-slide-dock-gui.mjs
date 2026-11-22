// fluximg live view on a slide with the animator dock open (review B6, related; F4): the NORMAL authoring layout in
// Slide mode leaves the canvas short (about 380 px at 1440 x 900). The board makes room instead of covering: the view is
// fitted so the image and the instruments are on the canvas that is actually there, and where they cannot all stand at
// full size the instruments rearrange (the step card beside the console, a compact console whose keys stay at its foot)
// before anything covers the picture. At 1440 x 900 and 1280 x 720 windows, at "Edit after step 1": no instrument covers
// the image or another, every instrument is inside the canvas, the step card whole, the console's key row in sight.
// Ends with "no console errors". Screenshots: test-results/scratch/shots/slide-dock-<w>x<h>-<FX_TAG|after>.png
//
// UI tier, runtime tsx. Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-board-slide-dock-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame, sleep, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-board-slide-dock-gui");
const SHOTS = "test-results/scratch/shots", TAG = process.env.FX_TAG ?? "after";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "fx-dock-gui-"));
{
  const T = 12, C = 2, Hh = 40, Ww = 40, d = new Uint16Array(T * C * Hh * Ww);
  let k = 0;
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) {
    const cx = 12 + c * 14 + t, cy = 14 + c * 8, r2 = (x - cx) ** 2 + (y - cy) ** 2;
    d[k++] = 80 + Math.round(1000 * Math.exp(-r2 / 40)) + ((x * 5 + y * 3) % 60);
  }
  await writeFixture(scratch, { name: "tc_u16", about: "a two-channel movie", dims: ["t", "c", "y", "x"], shape: [T, C, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { t: { unit: "s", scale: 0.25 }, y: { unit: "µm", scale: 0.3 }, x: { unit: "µm", scale: 0.3 } }, channels: [{ name: "a", color: "#ff00ff" }, { name: "b", color: "#00ff00" }] } });
}
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}
const overlaps = (a, b) => !(a.right <= b.x + 0.5 || a.x >= b.right - 0.5 || a.bottom <= b.y + 0.5 || a.y >= b.bottom - 0.5);
const within = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;

/** A fresh app in Slide mode with the image on a slide with one step; returns the page, its helpers and the image's id. */
async function stage(W, H) {
  const { browser, page } = await launch({ width: W, height: H });
  const F = (fn, arg) => page.evaluate(fn, arg);
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const IMG = await F(async (files) => {
    const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
    window.__fluxSeedFluximg("plots/tc.fluximg", files);
    const assetId = f.fluximg.place.fluximgAssetId("tc", "dock");
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/tc.fluximg", assetId });
    const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/tc.fluximg");
    let id;
    f.fig.commit((p) => { const s = p.figures.find((x) => x.id === sid); s.elements = []; id = f.ops.addFluximg(p, { figureId: sid, asset, x: 180, y: 60, width: 280 }); });
    f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats = [s.beats[0], { id: "fx1", label: "Step 1", tracks: [] }]; });
    f.fig.resetHistory();
    // Every view change from here on, counted (a loop between the board's fit and Slide mode's Fit would show here).
    window.__views = 0; f.fig.viewport.subscribe(() => { window.__views++; });
    return id;
  }, bundleFiles("tc_u16"));
  await waitFor(page, (id) => !!document.querySelector(`[data-editor-element-id="${id}"] image`)?.getAttribute("href"), IMG, { label: "the image's still", timeout: 15000 });
  const dock = async (open) => {
    await F((open) => { if (!!document.querySelector(".animator") !== open) [...document.querySelectorAll("button")].find((b) => /^Animate/.test(b.textContent.trim()))?.click(); }, open);
    await waitFor(page, (open) => !!document.querySelector(".animator") === open, open, { label: `the animator dock ${open ? "open" : "closed"}`, timeout: 5000 });
  };
  const atStep = (step) => F((step) => window.__flux.slide.setEditDestination(step ? { kind: "after", beatId: "fx1" } : { kind: "design" }), step);
  const board = async () => {
    if (!(await F(() => !!document.querySelector("[data-fxb-console]")))) {
      await F((id) => window.__flux.fig.selectOnly(id), IMG);
      await page.mouse.move(5, H - 5);
      await page.keyboard.press("r");
      await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fxb-step]"), null, { label: "the board with its step card", timeout: 10000 });
    }
  };
  /** Let every cause settle: Slide mode's Fit, the board's measuring, its fit (after the canvas holds still). */
  const settle = async () => {
    await sleep(700);
    await waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgFitDue), null, { label: "the board placed", timeout: 4000 }).catch(() => {});
    await sleep(250);
    await waitForFrame(page);
  };
  return { browser, page, F, IMG, dock, atStep, board, settle, views: () => F(() => window.__views) };
}
/** The board's boxes on screen, and the checks every route ends with. */
async function verdict(page, F, label, { short = true, minImage = 90, shotName = "" } = {}) {
  const s = await F(() => {
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
    const step = document.querySelector("[data-fxb-step]");
    return {
      host: r(document.querySelector(".canvas-host")), image: r(document.querySelector("[data-fluximg-live]")),
      console: r(document.querySelector("[data-fxb-console]")), keypad: r(document.querySelector("[data-fxb-keypad]")), stepInner: r(step),
      parts: [...document.querySelectorAll("[data-fxb] > .part")].map(r).filter((b) => b.w > 0 && b.h > 0),
    };
  });
  if (shotName) await page.screenshot({ path: `${SHOTS}/${shotName}-${TAG}.png` });
  if (short) h.ok(s.host.h < 520, `${label}: the canvas is short with the dock open (${Math.round(s.host.h)} px tall)`);
  const all = [s.console, ...s.parts];
  const onImage = all.filter((b) => overlaps(b, s.image));
  const area = onImage.reduce((t, b) => t + Math.max(0, Math.min(b.right, s.image.right) - Math.max(b.x, s.image.x)) * Math.max(0, Math.min(b.bottom, s.image.bottom) - Math.max(b.y, s.image.y)), 0);
  h.ok(!onImage.length, `${label}: no instrument covers the image${onImage.length ? ` (${Math.round(area)} px² covered by ${onImage.length}: ${JSON.stringify(onImage.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]))}, image ${JSON.stringify([s.image.x, s.image.y, s.image.w, s.image.h].map(Math.round))})` : ""}`);
  h.ok(all.every((a, i) => all.every((b, k) => k <= i || !overlaps(a, b))), `${label}: no instrument covers another`);
  h.ok(all.every((b) => within(b, s.host)) && within(s.image, s.host), `${label}: the image and every instrument are inside the canvas`);
  h.ok(!!s.stepInner && s.stepInner.h >= 40 && within(s.stepInner, s.host), `${label}: the step card stands whole in the canvas (${s.stepInner ? Math.round(s.stepInner.h) : 0} px tall)`);
  h.ok(!!s.keypad && within(s.keypad, s.console) && within(s.keypad, s.host), `${label}: the console's key row is in sight (not clipped at its foot)`);
  h.ok(s.image.w >= minImage, `${label}: the image is still a size you can work at (${Math.round(s.image.w)} px wide)`);
}

for (const [W, H] of [[1440, 900], [1280, 720]]) {
  h.section(`a ${W} x ${H} window: the dock open and the step chosen first, then the board`);
  const S = await stage(W, H);
  try {
    await S.dock(true); await S.atStep(true); await sleep(600);
    await S.board(); await S.settle();
    await verdict(S.page, S.F, `${W}x${H}, dock then board`, { shotName: `slide-dock-${W}x${H}` });
    h.eq(realErrors(S.page).filter((e) => !/Couldn't save|save figures/i.test(e)), [], "no console errors");
  } finally { await S.browser.close(); }
}

// The reviewer's route (review B6, final): the board opened in Design with the dock closed, then the step chosen, then
// the dock opened. The canvas shrinks under an open board: the board asks for room again.
{
  h.section("the reviewer's route: board in Design, then the step, then the dock (1440 x 900)");
  const S = await stage(1440, 900);
  try {
    await S.board(); await S.settle();
    const v0 = await S.views();
    await S.atStep(true); await S.settle();
    const v1 = await S.views();
    await S.dock(true); await S.settle();
    const v2 = await S.views();
    await verdict(S.page, S.F, "board, step, dock", { shotName: "slide-dock-route" });
    // One view change per cause at most from the board, plus Slide mode's own Fit (never a loop).
    await S.dock(false); await S.settle();
    const v3 = await S.views();
    await S.atStep(false); await S.settle();
    const v4 = await S.views();
    await sleep(1500);
    const v5 = await S.views();
    h.ok(v1 - v0 <= 1 && v2 - v1 <= 2 && v3 - v2 <= 2 && v4 - v3 <= 1, `view changes per cause stay bounded (step ${v1 - v0}, dock open ${v2 - v1}, dock closed ${v3 - v2}, Design ${v4 - v3})`);
    h.eq(v5 - v4, 0, "…and the view holds still afterwards (no loop between the board's fit and Slide mode's Fit)");
    h.ok(await S.F(() => !!document.querySelector("[data-fxb-console]")), "the board stayed open through the route");
    h.eq(realErrors(S.page).filter((e) => !/Couldn't save|save figures/i.test(e)), [], "no console errors");
  } finally { await S.browser.close(); }
}
{
  h.section("board first (at the step), then the dock (1440 x 900)");
  const S = await stage(1440, 900);
  try {
    await S.atStep(true); await sleep(400);
    await S.board(); await S.settle();
    await S.dock(true); await S.settle();
    await verdict(S.page, S.F, "board, then dock", { shotName: "slide-dock-board-first" });
    h.eq(realErrors(S.page).filter((e) => !/Couldn't save|save figures/i.test(e)), [], "no console errors");
  } finally { await S.browser.close(); }
}
await h.done();
