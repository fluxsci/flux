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

for (const [W, H] of [[1440, 900], [1280, 720]]) {
  h.section(`a ${W} x ${H} window, the animator dock open, at "Edit after step 1"`);
  const { browser, page } = await launch({ width: W, height: H });
  const F = (fn, arg) => page.evaluate(fn, arg);
  try {
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
      return id;
    }, bundleFiles("tc_u16"));
    await waitFor(page, (id) => !!document.querySelector(`[data-editor-element-id="${id}"] image`)?.getAttribute("href"), IMG, { label: "the image's still", timeout: 15000 });
    // The dock open (the Animate button), then "Edit after step 1".
    await F(() => { if (!document.querySelector(".animator")) [...document.querySelectorAll("button")].find((b) => /^Animate/.test(b.textContent.trim()))?.click(); });
    await waitFor(page, () => !!document.querySelector(".animator"), null, { label: "the animator dock", timeout: 5000 });
    await F(() => window.__flux.slide.setEditDestination({ kind: "after", beatId: "fx1" }));
    await sleep(600);
    await F((id) => window.__flux.fig.selectOnly(id), IMG);
    await page.mouse.move(5, H - 5);
    await page.keyboard.press("r");
    await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fxb-step]"), null, { label: "the board with its step card", timeout: 10000 });
    await waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgFitDue), null, { label: "the board placed", timeout: 4000 }).catch(() => {});
    await sleep(400);
    await waitForFrame(page);
    const s = await F(() => {
      const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
      const step = document.querySelector("[data-fxb-step]");
      return {
        host: r(document.querySelector(".canvas-host")), image: r(document.querySelector("[data-fluximg-live]")),
        console: r(document.querySelector("[data-fxb-console]")), keypad: r(document.querySelector("[data-fxb-keypad]")), step: r(step?.closest(".part") ?? step), stepInner: r(step),
        parts: [...document.querySelectorAll("[data-fxb] > .part")].map(r).filter((b) => b.w > 0 && b.h > 0),
      };
    });
    await page.screenshot({ path: `${SHOTS}/slide-dock-${W}x${H}-${TAG}.png` });
    h.ok(s.host.h < 520, `the canvas is short with the dock open (${Math.round(s.host.h)} px tall)`);
    const all = [s.console, ...s.parts];
    const onImage = all.filter((b) => overlaps(b, s.image));
    h.ok(!onImage.length, `no instrument covers the image${onImage.length ? ` (${onImage.length} do: ${JSON.stringify(onImage.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]))}, image ${JSON.stringify([s.image.x, s.image.y, s.image.w, s.image.h].map(Math.round))})` : ""}`);
    h.ok(all.every((a, i) => all.every((b, k) => k <= i || !overlaps(a, b))), "no instrument covers another");
    h.ok(all.every((b) => within(b, s.host)) && within(s.image, s.host), "the image and every instrument are inside the canvas");
    h.ok(!!s.step && s.stepInner.h >= 40 && within(s.stepInner, s.host), `the step card stands whole in the canvas (${s.stepInner ? Math.round(s.stepInner.h) : 0} px tall)`);
    h.ok(!!s.keypad && within(s.keypad, s.console) && within(s.keypad, s.host), "the console's key row is in sight (not clipped at its foot)");
    h.ok(s.image.w >= 90, `the image is still a size you can work at (${Math.round(s.image.w)} px wide)`);
    const errs = realErrors(page).filter((e) => !/Couldn't save|save figures/i.test(e));
    h.eq(errs, [], "no console errors");
  } finally {
    await browser.close();
  }
}
await h.done();
