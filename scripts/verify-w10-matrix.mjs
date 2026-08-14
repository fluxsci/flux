// W10 acceptance: the watch → live-reload matrix (renderer half, via the memBridge
// fixture + simulated fs:changed events). Proves an external (agent/CLI) edit that
// lands while a mode is OPEN pops into that mode:
//   • Figure: clean editor reloads in place (AGT-3) — preserving the user's view
//     and landing as ONE undo entry (2026-08-14 reload contract; the pure twin is
//     verify-fig-reload-preserve.ts); dirty editor keeps its work + shows the
//     reload/overwrite banner (no clobber).
//   • Slide: clean deck reloads in place (SLD-1).
//   • FluxLib: a fluxlib event is handled (LR-3 wiring) without error.
// The Electron watcher's target list (main.cjs) is verified by inspection; here we
// exercise the renderer wiring (projectWatch → revisions → mode subscriptions).
// PROBE RULE: assert the reload on a figure's WIDTH, never its NAME — since
// figure families (2026-08-04) `name` is a DERIVED field that load-healing
// rewrites (applyFamilyNumbers), which silently broke the old name-based probe.
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const R = "/demo/myc-growth-paper";
const LIB = "/home/demo/FluxConfig/FluxLib/library.bib";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3200 });

// ---- Figure: clean external reload -----------------------------------------
await clickMode(page, "Figure");
await sleep(1400);
const figClean = await page.evaluate(async (R) => {
  const F = window.__flux;
  const before = {
    width: F.figures()[0]?.width,
    canvas: F.get(F.fig.activeCanvasId),
    past: F.fig.historyStats().past,
  };
  const cid = "canvas-1";
  const canvasP = R + "/fig/canvases/" + cid + ".json";
  const idxP = R + "/fig/index.json";
  const o = JSON.parse(await window.fig.readText(canvasP));
  if (o.figures?.[0]) o.figures[0].width = 1234;
  await window.fig.writeText(canvasP, JSON.stringify(o, null, 2) + "\n");
  // touch the index too so the index-divergence path is exercised alongside
  await window.fig.writeText(idxP, (await window.fig.readText(idxP)) + "\n");
  window.__fluxEmitFsChange({ subsystem: "fig", path: idxP });
  return before;
}, R);
await sleep(700);
const figCleanAfter = await page.evaluate((before) => {
  const F = window.__flux;
  const reloaded = F.figures()[0]?.width === 1234;
  const viewKept = F.get(F.fig.activeCanvasId) === before.canvas;
  const oneEntry = F.fig.historyStats().past === before.past + 1;
  F.fig.undo();
  const undone = F.figures()[0]?.width === before.width;
  F.fig.redo();
  const redone = F.figures()[0]?.width === 1234;
  return { reloaded, viewKept, oneEntry, undone, redone };
}, figClean);
await sleep(1100); // let the undo/redo autosaves settle before the dirty branch

// ---- Figure: dirty → banner, no clobber ------------------------------------
await page.evaluate(async (R) => {
  window.__flux.fig.commit((p) => { if (p.figures[0]) p.figures[0].name = "HUMAN EDIT"; });
  const idxP = R + "/fig/index.json";
  const o = JSON.parse(await window.fig.readText(idxP));
  if (o.figures?.[0]) o.figures[0].name = "AGENT AGAIN";
  await window.fig.writeText(idxP, JSON.stringify(o, null, 2) + "\n");
  window.__fluxEmitFsChange({ subsystem: "fig", path: idxP });
}, R);
await sleep(700);
const figDirty = await page.evaluate(() => ({
  keptHumanEdit: window.__flux.figures()[0]?.name === "HUMAN EDIT",
  bannerShown: !!document.querySelector(".disk-toast"),
}));

// ---- Slide: clean external reload ------------------------------------------
await clickMode(page, "Slide");
await sleep(1600);
const slideReload = await page.evaluate(async (R) => {
  const F = window.__flux;
  // slide-migration: the live deck store is the OVERLAY (deckOverlay) now —
  // the old `slide.deck` handle died with the pre-migration store.
  const id = F.get(F.slide.deckOverlay)?.id;
  if (!id) return { ok: false, why: "no deck" };
  const p = R + "/slides/" + id + "/deck.json";
  const o = JSON.parse(await window.fig.readText(p));
  o.title = "AGENT DECK TITLE";
  await window.fig.writeText(p, JSON.stringify(o, null, 2) + "\n");
  window.__fluxEmitFsChange({ subsystem: "slides", path: p });
  return { ok: true };
}, R);
await sleep(800);
const slideTitle = await page.evaluate(() => window.__flux.get(window.__flux.slide.deckOverlay)?.title);

// ---- FluxLib: event handled (LR-3 wiring) ----------------------------------
await clickMode(page, "Library");
await sleep(1200);
const fluxlibHandled = await page.evaluate(async (LIB) => {
  try {
    if (await window.fig.exists(LIB)) {
      const cur = await window.fig.readText(LIB);
      await window.fig.writeText(LIB, cur + "\n@article{w10lib, title={W10}, author={Z, A}, year={2099}}\n");
    }
    window.__fluxEmitFsChange({ subsystem: "fluxlib", path: LIB });
    return true;
  } catch {
    return false;
  }
}, LIB);
await sleep(500);

const out = {
  figCleanReloaded: figCleanAfter.reloaded,
  figViewPreserved: figCleanAfter.viewKept,
  figReloadOneUndoEntry: figCleanAfter.oneEntry,
  figReloadUndoRestores: figCleanAfter.undone && figCleanAfter.redone,
  figDirtyKeptEdit: figDirty.keptHumanEdit,
  figDirtyBanner: figDirty.bannerShown,
  slideReloaded: slideReload.ok && slideTitle === "AGENT DECK TITLE",
  fluxlibHandled,
  errs: realErrors(page),
};
console.log(JSON.stringify(out, null, 2));
await browser.close();

const pass =
  out.figCleanReloaded &&
  out.figViewPreserved &&
  out.figReloadOneUndoEntry &&
  out.figReloadUndoRestores &&
  out.figDirtyKeptEdit &&
  out.figDirtyBanner &&
  out.slideReloaded &&
  out.fluxlibHandled &&
  out.errs.length === 0;
console.log(pass ? "W10 VERIFY: PASS" : "W10 VERIFY: FAIL");
process.exit(pass ? 0 : 1);
