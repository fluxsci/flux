// W10 acceptance: the watch → live-reload matrix (renderer half, via the memBridge
// fixture + simulated fs:changed events). Proves an external (agent/CLI) edit that
// lands while a mode is OPEN pops into that mode:
//   • Figure: clean editor reloads in place (AGT-3); dirty editor keeps its work +
//     shows the reload/overwrite banner (no clobber).
//   • Slide: clean deck reloads in place (SLD-1).
//   • FluxLib: a fluxlib event is handled (LR-3 wiring) without error.
// The Electron watcher's target list (main.cjs) is verified by inspection; here we
// exercise the renderer wiring (projectWatch → revisions → mode subscriptions).
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const R = "/demo/myc-growth-paper";
const LIB = "/home/demo/FluxConfig/FluxLib/library.bib";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3200 });

// ---- Figure: clean external reload -----------------------------------------
await clickMode(page, "Figure");
await sleep(1400);
const figClean = await page.evaluate(async (R) => {
  const rename = (json, name) => {
    const o = JSON.parse(json);
    if (o.figures?.[0]) o.figures[0].name = name;
    return JSON.stringify(o, null, 2) + "\n";
  };
  const cid = "canvas-1";
  const canvasP = R + "/fig/canvases/" + cid + ".json";
  const idxP = R + "/fig/index.json";
  await window.fig.writeText(canvasP, rename(await window.fig.readText(canvasP), "AGENT RENAMED"));
  await window.fig.writeText(idxP, rename(await window.fig.readText(idxP), "AGENT RENAMED"));
  window.__fluxEmitFsChange({ subsystem: "fig", path: idxP });
  return true;
}, R);
await sleep(700);
const figCleanName = await page.evaluate(() => window.__flux.figures()[0]?.name);

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
  figCleanReloaded: figClean && figCleanName === "AGENT RENAMED",
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
  out.figDirtyKeptEdit &&
  out.figDirtyBanner &&
  out.slideReloaded &&
  out.fluxlibHandled &&
  out.errs.length === 0;
console.log(pass ? "W10 VERIFY: PASS" : "W10 VERIFY: FAIL");
process.exit(pass ? 0 : 1);
