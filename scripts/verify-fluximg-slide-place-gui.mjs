// verify-fluximg-slide-place-gui (ui tier; dev server up, FLUX_URL for a worktree): an N-dimensional image (fluximg)
// on a slide in the headless app (fluximg stage 2, W1b).
//   * Slide mode's Plots rail lists a seeded bundle; a double-click places it on the active slide, inside the stage;
//     its still renders; a bundle folder DROPPED on the slide places too;
//   * "Edit after step 1": a view edit (ops.setFluximgView through mutate) and a crop write become ONE Change on that
//     step, with to.state.view / to.state.crop, and leave Design untouched; each edit is one undo step (undo / redo);
//   * the canvas shows the step's end state at step 1 and the Design state at Design (data + its still);
//   * save → reload: the deck is 0.8.0, owns no bundle, reopens with the same document and the same picture;
//   * copy / paste on the slide; a clean console.
//   Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-slide-place-gui.mjs
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-slide-place-gui");
const dir = mkdtempSync(path.join(tmpdir(), "fx-slide-gui-"));
for (const f of fixtures()) if (f.name === "stack_u16" || f.name === "gray2d_u8") await writeFixture(dir, f);
function bundleFiles(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}
const stack = bundleFiles(path.join(dir, "stack_u16.fluximg"));
const gray = bundleFiles(path.join(dir, "gray2d_u8.fluximg"));

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
/** The slide's images as the canvas holds them (the displayed state). */
const shown = () => page.evaluate(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.figures().find((x) => x.id === sid).elements.filter((e) => e.type === "fluximg"); });
/** The active slide as deck.json would hold it (Design + tracks). */
const authored = () => page.evaluate(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.slide.currentDeck().slides.find((s) => s.id === sid); });
const stillOf = (id) => page.evaluate((i) => document.querySelector(`[data-editor-element-id="${i}"] image`)?.getAttribute("href") ?? null, id);
const waitStill = (id, not = null) => waitFor(page, ({ i, n }) => { const h = document.querySelector(`[data-editor-element-id="${i}"] image`)?.getAttribute("href"); return h && h !== n ? h : null; }, { i: id, n: not }, { label: `the still of ${id}`, timeout: 15000 });
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const root = await page.evaluate(() => window.__flux.get(window.__flux.shell.projectModel).root);
  const deckId = await page.evaluate(() => window.__flux.slide.currentDeck().id);
  const stage = await page.evaluate(() => window.__flux.slide.currentDeck().stage);
  await page.evaluate(({ stack, gray }) => { window.__fluxSeedFluximg("plots/cells.fluximg", stack); window.__fluxSeedFluximg("plots/plane.fluximg", gray); }, { stack, gray });

  h.section("placing from the Plots rail and by drop");
  await page.mouse.click(900, 500);
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
  const tile = '[data-plots-gallery] [data-tile$="/cells.fluximg"]';
  await waitFor(page, (s) => !!document.querySelector(s), tile, { label: "the bundle's tile in Slide mode", timeout: 15000 });
  const at = await waitFor(page, (s) => { const r = document.querySelector(`${s} .page`)?.getBoundingClientRect(); return r && r.width > 4 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, tile, { label: "tile box" });
  await page.mouse.click(at.x, at.y, { count: 2 });
  const [placed] = await waitFor(page, async () => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); const els = f.figures().find((x) => x.id === sid).elements.filter((e) => e.type === "fluximg"); return els.length === 1 ? els : null; }, null, { label: "an image on the slide", timeout: 15000 });
  h.ok(placed.source?.bundlePath === "plots/cells.fluximg" && placed.width <= stage.width && placed.height <= stage.height, `the rail places the bundle on the active slide, inside the stage (${placed.width}×${placed.height})`);
  const asset = await page.evaluate((id) => window.__flux.get(window.__flux.fig.project).assets.find((a) => a.id === id), placed.assetId);
  h.ok(asset?.kind === "fluximg" && asset.path === `assets/${placed.assetId}.fluximg`, "its asset is a project bundle (fig/assets), by id");
  const designStill = await waitStill(placed.id);
  h.ok(/^data:image\/png/.test(designStill), "it renders its still on the slide");
  // A bundle folder dropped from the file manager (the memory bridge names its path by the File's name).
  await page.evaluate(() => {
    const wrap = document.querySelector(".canvas-wrap").getBoundingClientRect(), x = wrap.left + wrap.width / 2, y = wrap.top + wrap.height / 2;
    const target = document.elementFromPoint(x, y), dt = new DataTransfer();
    dt.items.add(new File([], "plots/plane.fluximg"));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  });
  const dropped = await waitFor(page, async () => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.figures().find((x) => x.id === sid).elements.find((e) => e.type === "fluximg" && e.source?.bundlePath === "plots/plane.fluximg") ?? null; }, null, { label: "the dropped bundle", timeout: 15000 }).catch(() => null);
  h.ok(!!dropped, "a bundle folder dropped on the slide places too");
  if (dropped) await waitStill(dropped.id);

  h.section("Edit after step 1: a view edit and a crop edit are ONE Change");
  await page.evaluate(() => {
    const f = window.__flux, sid = f.get(f.fig.activeFigureId);
    f.slide.commitDeckLive((d) => { d.slides.find((x) => x.id === sid).beats.push({ id: "fxstep", tracks: [] }); });
    f.slide.activeBeat.set(1);
    f.slide.editAfterBeat(1);
  });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.editDestination).kind === "after", null, { label: "Edit after step 1" });
  h.ok(await page.evaluate((id) => window.__flux.get(window.__flux.fig.project).assets.some((a) => a.id === id), placed.assetId), "a structural deck edit (adding a step) keeps the image's project asset (external by kind)");
  await page.evaluate((id) => window.__flux.fig.mutate((p) => window.__flux.ops.setFluximgView(p, id, { index: { z: 0 } })), placed.id);
  let slide = await authored();
  const tracksOf = (s) => s.beats[1].tracks.filter((t) => t.target === placed.id && t.preset === "transform");
  h.ok(tracksOf(slide).length === 1 && tracksOf(slide)[0].to?.state?.view?.index?.z === 0, `a view edit at step 1 writes that step's Change (to.state.view ${JSON.stringify(tracksOf(slide)[0]?.to?.state?.view)})`);
  h.ok(!slide.elements.find((e) => e.id === placed.id).view, "…and Design is untouched");
  const stepStill = await waitStill(placed.id, designStill);
  h.ok(stepStill !== designStill, "the canvas shows the step's end state (a new still)");
  const crop = { x: 16, y: 12, width: 32, height: 24 };
  await page.evaluate(({ id, crop }) => window.__flux.fig.mutate((p) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.crop = crop; }), { id: placed.id, crop });
  slide = await authored();
  const change = tracksOf(slide);
  h.ok(change.length === 1 && change[0].to?.state?.view?.index?.z === 0 && JSON.stringify(change[0].to?.state?.crop) === JSON.stringify(crop), "a crop edit at the same step extends the SAME Change (view + crop)");
  h.ok(!("crop" in slide.elements.find((e) => e.id === placed.id)), "…Design still has no crop");
  const shownStep = (await shown()).find((e) => e.id === placed.id);
  h.ok(shownStep.view?.index?.z === 0 && JSON.stringify(shownStep.crop) === JSON.stringify(crop), "the canvas holds the step's end state");
  const cropStill = await waitStill(placed.id, stepStill);
  // undo / redo: one step per edit
  await page.evaluate(() => window.__flux.fig.undo());
  slide = await authored();
  h.ok(tracksOf(slide)[0]?.to?.state?.view?.index?.z === 0 && !("crop" in (tracksOf(slide)[0]?.to?.state ?? {})), "one undo takes back the crop edit only");
  await page.evaluate(() => window.__flux.fig.undo());
  slide = await authored();
  h.ok(!tracksOf(slide).some((t) => t.to?.state?.view), "a second undo takes back the view edit");
  await page.evaluate(() => { window.__flux.fig.redo(); window.__flux.fig.redo(); });
  slide = await authored();
  h.ok(tracksOf(slide).length === 1 && tracksOf(slide)[0].to?.state?.view?.index?.z === 0 && !!tracksOf(slide)[0].to?.state?.crop, "redo twice brings both back");
  h.eq(await waitStill(placed.id, null), cropStill, "…and the canvas shows the step's end again");

  h.section("Design shows Design");
  await page.evaluate(() => { const f = window.__flux; f.slide.activeBeat.set(0); f.slide.setEditDestination({ kind: "design" }); });
  await waitFor(page, (id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); const e = f.figures().find((x) => x.id === sid).elements.find((x) => x.id === id); return !e.view && !e.crop; }, placed.id, { label: "Design state", timeout: 5000 });
  h.ok(true, "at Design the canvas holds the Design element (no view, no crop)");
  h.eq(await waitFor(page, ({ i, d }) => document.querySelector(`[data-editor-element-id="${i}"] image`)?.getAttribute("href") === d ? d : null, { i: placed.id, d: designStill }, { label: "the Design still", timeout: 15000 }).catch(() => "other"), designStill, "…and draws the Design still again");

  h.section("save and reload");
  await page.evaluate(async () => { await window.__flux.lifecycle.flushById("slide"); });
  const file = `${root}/slides/${deckId}/deck.json`;
  const text = await page.evaluate((p) => window.fig._files.get(p) instanceof Uint8Array ? new TextDecoder().decode(window.fig._files.get(p)) : String(window.fig._files.get(p) ?? ""), file);
  const saved = JSON.parse(text);
  h.ok(saved.schemaVersion === "0.8.0" && !saved.assets.some((a) => a.kind === "fluximg"), `the deck is saved as 0.8.0 and owns no bundle (${saved.schemaVersion})`);
  const savedSlide = saved.slides.find((s) => s.elements.some((e) => e.id === placed.id));
  h.ok(!!savedSlide && savedSlide.beats[1].tracks.some((t) => t.target === placed.id && t.to?.state?.view?.index?.z === 0), "…with the step's Change");
  await page.evaluate(async ({ root, deckId }) => { await window.__flux.slideBridge.loadDeckInto(root, deckId); }, { root, deckId });
  const reopened = await page.evaluate(() => window.__flux.slide.currentDeck());
  const strip = (d) => { const c = structuredClone(d); delete c.modified; return JSON.stringify(c); };
  h.eq(strip(reopened), strip(saved), "the reopened deck is the saved document");
  await page.evaluate(async () => { await window.__flux.lifecycle.flushById("slide"); });
  const again = await page.evaluate((p) => window.fig._files.get(p) instanceof Uint8Array ? new TextDecoder().decode(window.fig._files.get(p)) : String(window.fig._files.get(p) ?? ""), file);
  h.ok(again === text, "saving the reopened deck writes the same bytes");
  h.eq(await waitStill(placed.id), designStill, "…and draws the same picture");

  h.section("paste");
  await page.mouse.click(1200, 880);
  await page.evaluate((id) => window.__flux.fig.selection.set(new Set([id])), placed.id);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyC"); await page.keyboard.press("KeyV"); await page.keyboard.up("Control");
  const pasted = await waitFor(page, async (id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); const els = f.figures().find((x) => x.id === sid).elements.filter((e) => e.type === "fluximg"); const p = els.find((e) => e.id !== id && e.assetId === els.find((x) => x.id === id)?.assetId); return p ?? null; }, placed.id, { label: "a pasted copy", timeout: 5000 }).catch(() => null);
  h.ok(!!pasted, "copy / paste on a slide makes a second image of the same asset");
  h.eq(errs.length, 0, `clean console${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
} catch (error) {
  h.fail(`unexpected: ${error?.stack ?? error}`);
}
await h.done(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
