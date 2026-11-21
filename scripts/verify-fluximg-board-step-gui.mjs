// verify-fluximg-board-step-gui (ui tier; dev server up, FLUX_URL for a worktree): an image's objects and layers at a
// slide step, on the live board and in the X-ray (fluximg stage 2; the board fix package F3, items 4 and 5).
//   * The board draws the step's truth: at "Edit after step 1" an object that appears at step 2 (unborn) and one that
//     disappeared at step 1 (gone) are drawn on the board exactly as the element at rest draws them there (the same
//     factors: ghosted at 0.25 while Show hidden is on, left out when it is off); an object with no track is drawn
//     whole. After step 2 the born objects are whole on the board too.
//   * The X-ray's eye on the image's LAYER row at "Edit after step 1": Design is unchanged, step 1's Change holds the
//     layer's visibility, the canvas at step 1 shows the layer gone, and undo is one step.
//   * A clean console (a Svelte runtime error fails it).
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-board-step-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame, sleep, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-board-step-gui");
const SHOTS = "test-results/scratch/shots";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "fx-board-step-gui-"));
await writeFixture(scratch, fixtures().find((f) => f.name === "mean_f64_layers"));
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
const F = (fn, arg) => page.evaluate(fn, arg);
const past = () => F(() => window.__flux.fig.historyStats().past);
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const box = (sel) => F((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const isOpen = () => F(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
/** The footprints as a surface draws them: key → opacity (absent = not drawn). */
const drawn = (sel) => F((sel) => { const root = document.querySelector(sel); if (!root) return null; const out = {}; for (const n of root.querySelectorAll('[data-layer="footprints"] [data-key]')) out[n.getAttribute("data-key")] = Number(n.getAttribute("opacity") ?? 1); return out; }, sel);
async function openBoard(id) {
  if (await isOpen()) return;
  await F((id) => window.__flux.fig.selectOnly(id), id);
  const r = await box(`[data-editor-element-id="${id}"]`);
  if (r) await page.mouse.move(r.cx, r.cy);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "the board open on the slide", timeout: 10000 });
}
const showHidden = (on) => F((on) => { const i = document.querySelector(".ghost-toggle input"); if (i && i.checked !== on) i.click(); return i?.checked ?? null; }, on);

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const IMG = await F(async (files) => {
    const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
    window.__fluxSeedFluximg("plots/cells.fluximg", files);
    const assetId = f.fluximg.place.fluximgAssetId("cells", "step");
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/cells.fluximg", assetId });
    const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/cells.fluximg");
    let id;
    f.fig.commit((p) => {
      const s = p.figures.find((x) => x.id === sid);
      s.elements = [];
      id = f.ops.addFluximg(p, { figureId: sid, asset, x: 60, y: 40, width: 300 });
      const el = s.elements.find((e) => e.id === id);
      el.view = { ...(el.view ?? {}), layers: { ...(el.view?.layers ?? {}), footprints: { visible: true } } };
    });
    // s2 disappears at step 1 (gone after it); s1 and s3 appear at step 2 (unborn before it); s7 has no track.
    f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats = [s.beats[0],
      { id: "q1", label: "Step 1", tracks: [{ id: "gone", target: id, part: "footprints/s2", preset: "fadeOut", start: 0, duration: 400 }] },
      { id: "q2", label: "Step 2", tracks: [{ id: "born", target: id, parts: ["footprints/s1", "footprints/s3"], preset: "fade", start: 0, duration: 400 }] }]; });
    f.slide.setEditDestination({ kind: "design" });
    f.fig.resetHistory();
    return id;
  }, bundleFiles("mean_f64_layers"));
  const EL = `[data-editor-element-id="${IMG}"]`, LIVE = "[data-fluximg-live]";
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [data-layer="footprints"] [data-key="s1"]`), EL, { label: "the footprints drawn", timeout: 15000 });

  // ------------------------------------------------------------------------------------------------------------
  h.section("the board draws a step's objects as the element at rest does");
  await openBoard(IMG);
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [data-layer="footprints"] [data-key]`), LIVE, { label: "the board's footprints", timeout: 8000 });
  h.eq(await drawn(LIVE), { s1: 1, s2: 1, s3: 1, s7: 1 }, "in Design every object is drawn whole on the board");
  await press("Escape");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(1); f.slide.editAfterBeat(1); });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.editDestination).kind === "after", null, { label: "Edit after step 1" });
  h.eq(await showHidden(true), true, "Show hidden on");
  await waitFor(page, (sel) => { const n = document.querySelector(`${sel} [data-layer="footprints"] [data-key="s1"]`); return !!n && Number(n.getAttribute("opacity") ?? 1) <= 0.25; }, EL, { label: "the element at rest ghosts s1", timeout: 6000 });
  const rest = await drawn(EL);
  h.eq(rest, { s1: 0.25, s2: 0.25, s3: 0.25, s7: 1 }, "the element at rest at step 1: s1 and s3 (unborn) and s2 (gone) ghosted, s7 whole");
  await openBoard(IMG);
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [data-layer="footprints"] [data-key]`), LIVE, { label: "the board's footprints", timeout: 8000 });
  await sleep(150);
  h.eq(await drawn(LIVE), rest, "the board at step 1 draws them the same (ghosted while Show hidden is on)");
  await page.screenshot({ path: `${SHOTS}/board-step-objects.png` });
  await showHidden(false);
  await waitFor(page, (sel) => !document.querySelector(`${sel} [data-layer="footprints"] [data-key="s1"]`), LIVE, { label: "the board leaves s1 out", timeout: 6000 }).catch(() => {});
  h.eq(await drawn(LIVE), { s7: 1 }, "Show hidden off: the board leaves the unborn and gone objects out, as the element does");
  h.eq(await drawn(EL), await drawn(LIVE), "…the element and the board agree");
  await showHidden(true);
  await press("Escape");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(2); f.slide.editAfterBeat(2); });
  await openBoard(IMG);
  await waitFor(page, (sel) => { const n = document.querySelector(`${sel} [data-layer="footprints"] [data-key="s1"]`); return !!n && Number(n.getAttribute("opacity") ?? 1) > 0.9; }, LIVE, { label: "s1 born on the board", timeout: 6000 }).catch(() => {});
  h.eq(await drawn(LIVE), { s1: 1, s2: 0.25, s3: 1, s7: 1 }, "after step 2 the born objects are whole on the board; the gone one stays ghosted");
  await press("Escape");

  // ------------------------------------------------------------------------------------------------------------
  h.section("the X-ray's layer eye at a step");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(1); f.slide.editAfterBeat(1); });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.editDestination).kind === "after", null, { label: "Edit after step 1" });
  const deckSlide = () => F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); const s = f.slide.currentDeck().slides.find((x) => x.id === sid); return structuredClone({ design: s.elements.find((e) => e.id === id), change: s.beats[1].tracks.find((t) => t.target === id && t.preset === "transform") ?? null }); }, IMG);
  const before = await deckSlide();
  await F((id) => window.__flux.fig.selectOnly(id), IMG);
  await page.mouse.move(1300, 150);
  await press("KeyR", ["Shift", "Alt"]);
  await waitFor(page, () => !!document.querySelector(".xray .row[data-rid$='layer:footprints'] button.eye"), null, { label: "the layer row's eye", timeout: 8000 });
  const p0 = await past();
  const eye = await box(".xray .row[data-rid$='layer:footprints'] button.eye");
  await page.mouse.click(eye.cx, eye.cy);
  await waitForFrame(page);
  const after = await deckSlide();
  h.eq(JSON.stringify(after.design), JSON.stringify(before.design), "the eye at step 1 leaves Design unchanged");
  h.eq(after.change?.to?.state?.view?.layers?.footprints?.visible, false, "step 1's Change holds the layer's visibility (hidden)");
  h.eq(await past(), p0 + 1, "…one undo step");
  await press("Escape"); await sleep(150);
  await waitFor(page, (sel) => !document.querySelector(`${sel} [data-layer="footprints"] [data-key]`), EL, { label: "the layer gone at step 1", timeout: 5000 }).catch(() => {});
  h.ok(await F((sel) => !document.querySelector(`${sel} [data-layer="footprints"] [data-key]`) && !!document.querySelector(`${sel} image`), EL), "the canvas at step 1 shows the layer gone (the picture still drawn)");
  h.eq(await F((id) => window.__flux.figures().flatMap((x) => x.elements).find((e) => e.id === id)?.view?.layers?.footprints?.visible, IMG), false, "…the image at step 1 resolves the layer hidden");
  await press("z", ["Control"]);
  const undone = await deckSlide();
  h.ok(!undone.change?.to?.state?.view?.layers?.footprints && JSON.stringify(undone.design) === JSON.stringify(before.design), "undo takes the step's layer change back in one step");
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [data-layer="footprints"] [data-key]`), EL, { label: "the layer back at step 1", timeout: 5000 }).catch(() => {});
  h.ok(await F((sel) => !!document.querySelector(`${sel} [data-layer="footprints"] [data-key]`), EL), "…and the canvas draws the layer again");
} catch (e) {
  h.fail(`threw: ${e?.stack ?? e}`);
  await page.screenshot({ path: `${SHOTS}/board-step-gui-failure.png` }).catch(() => {});
} finally {
  h.eq(errs.filter((e) => !/favicon/.test(e)), [], "no console errors (a Svelte runtime error included)");
  await browser.close();
}
await h.done();
