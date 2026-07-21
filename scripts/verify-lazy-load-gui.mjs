// Lazy figure-asset residency — GUI UPGRADE GATE
// (notes/lazy_figure_asset_loading_plan.md §8).
//
// Pins the user-visible half of lazy loading:
//   · the <image> raster fallback IS the loading state (it appears, then the
//     plot upgrades to the inline semantic DOM — the $plotGen reactivity fix;
//     without it the fallback would stick forever)
//   · after settle the active figure has NO svg-data <image> fallbacks and
//     NO gray placeholder rects
//   · a cold figure focus upgrades within the 1s navigation budget
//   · a CROPPED plot upgrades from the nested-svg fallback to the inline
//     mount (crop honored in both states)
//   · a vanilla (sidecar-less) svg has NO manifest until first view, then a
//     DERIVED one (the retroactive-deriver rule, plan §5.3)
//   · re-focusing a warm figure parses nothing (LRU)
//
//   node scripts/verify-lazy-load-gui.mjs      (dev server on :1420)

import { launch, gotoApp, clickMode, APP_URL, realErrors } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const h = harness("verify-lazy-load-gui");
const FIGURES = 3;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2000 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && document.querySelector(".canvas-host")), null, {
    label: "figure mode + dev handle",
    timeout: 20000,
  });

  const fx = await installDenseProject(page, {
    root: "/demo/lazy-gui",
    figures: FIGURES,
    elemsPerPanel: 700, // enough parse weight that the fallback phase is observable
    panelBytes: 120_000,
    vanillaPerFigure: 1,
  });

  // Add a crop to figure 2's first panel BEFORE load (file-level, so no store
  // edits / no autosave interference).
  await page.evaluate(async (root) => {
    const p = `${root}/fig/canvases/canvas-1.json`;
    const cf = JSON.parse(await window.fig.readText(p));
    const el = cf.figures[1].elements[0];
    el.crop = { x: 20, y: 20, width: 220, height: 160 };
    await window.fig.writeText(p, JSON.stringify(cf));
  }, fx.root);

  // Observe the fallback phase: any svg-data <image> insertion under the canvas.
  await page.evaluate(() => {
    window.__lazySawFallback = 0;
    const host = document.querySelector(".canvas-host");
    const count = (n) => {
      if (!n.querySelectorAll) return 0;
      let c = n.matches?.('image[href^="data:image/svg"]') ? 1 : 0;
      c += n.querySelectorAll('image[href^="data:image/svg"]').length;
      return c;
    };
    window.__lazyMO = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) window.__lazySawFallback += count(n);
    });
    window.__lazyMO.observe(host, { subtree: true, childList: true });
  });

  await page.evaluate(async (root) => {
    await window.__flux.bridge.loadFigInto(root, "lazy-gui");
  }, fx.root);

  const settle = async (figId, label) => {
    const t0 = Date.now();
    await waitFor(
      page,
      (ids) => {
        const P = window.__flux.plot;
        return P.plotResidency.pending() === 0 && ids.every((id) => P.plotDom.has(id));
      },
      fx.assetsByFig[figId],
      { label, timeout: 20000, interval: 25 },
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return Date.now() - t0;
  };

  await settle(fx.figIds[0], "active figure resident");
  const sawFallback = await page.evaluate(() => window.__lazySawFallback);
  h.ok(sawFallback > 0, `<image> fallback appeared as the loading state (${sawFallback} insertions observed)`);

  const scene = await page.evaluate(() => ({
    svgFallbacks: document.querySelectorAll('.canvas-host image[href^="data:image/svg"]').length,
    grayRects: document.querySelectorAll('.canvas-host rect[fill="#eee"]').length,
    inlineParts: document.querySelectorAll('.canvas-host [id$="__s0.line"]').length,
  }));
  h.eq(scene.svgFallbacks, 0, "no svg-data <image> fallbacks remain after settle (upgrade completed)");
  h.eq(scene.grayRects, 0, "no gray placeholder rects (assetData fully resident)");
  h.ok(scene.inlineParts >= 14, `inline semantic parts mounted (${scene.inlineParts} s0.line parts — prefixed ids prove the real DOM)`);

  // Vanilla manifest defers until first view.
  const vanillaId = fx.assetsByFig[fx.figIds[1]].find((id) => id.endsWith("-v"));
  const manifestBefore = await page.evaluate(
    (id) => window.__flux.get(window.__flux.plot.plotManifests)[id] ?? null,
    vanillaId,
  );
  h.eq(manifestBefore, null, "vanilla svg has no manifest before first view (derives on parse, never persisted)");

  // Cold focus on figure 2 (has the cropped panel + the vanilla panel).
  const focusFig = (id) => {
    const F = window.__flux.fig;
    const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
    F.activeCanvasId.set(fig.canvasId);
    F.activeFigureId.set(id);
    const zoom = 0.55;
    F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
  };
  await page.evaluate(focusFig, fx.figIds[1]);
  const coldMs = await settle(fx.figIds[1], "cold figure resident");
  h.ok(coldMs < 1000, `cold figure focus upgrades inside the 1s navigation budget (${coldMs}ms)`);

  const after = await page.evaluate((vid) => {
    const derived = window.__flux.get(window.__flux.plot.plotManifests)[vid];
    return {
      vanillaSpec: derived?.spec ?? null,
      svgFallbacks: document.querySelectorAll('.canvas-host image[href^="data:image/svg"]').length,
    };
  }, vanillaId);
  h.eq(after.vanillaSpec, "fluxplot-derived/1", "vanilla svg gained its DERIVED manifest on first view");
  h.eq(after.svgFallbacks, 0, "cropped + vanilla panels upgraded inline too (no fallbacks left)");

  // Warm re-focus parses nothing.
  const p0 = await page.evaluate(() => window.__flux.plot.plotResidency.parses);
  await page.evaluate(focusFig, fx.figIds[0]);
  await settle(fx.figIds[0], "warm re-focus");
  const p1 = await page.evaluate(() => window.__flux.plot.plotResidency.parses);
  h.eq(p1, p0, "warm re-focus re-parses nothing (LRU warm)");

  await page.evaluate(() => window.__lazyMO?.disconnect?.());
  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean: ${errs.slice(0, 3).join(" | ") || "no errors"}`);
} finally {
  await browser.close();
}
await h.done();
