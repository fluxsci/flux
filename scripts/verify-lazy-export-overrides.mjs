// Lazy figure-asset residency — EXPORT GATE
// (notes/lazy_figure_asset_loading_plan.md §5.6/§8).
//
// GUI export serializes through plotToSvgMarkup, which reads the parsed-DOM
// cache. Under lazy residency a figure that was never viewed (or was LRU-
// evicted) has no cached DOM — without the ensureFigurePlots gate the export
// would silently fall to the flat <image> fallback and DROP per-part
// overrides. Pins:
//   · exporting a NEVER-VIEWED figure bakes real vector parts + overrides
//   · exporting an EVICTED figure re-parses and bakes identically
//   · the export leaves residency accounting consistent
//
//   node scripts/verify-lazy-export-overrides.mjs      (dev server on :1420)

import { launch, gotoApp, clickMode, APP_URL, realErrors } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const h = harness("verify-lazy-export-overrides");

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
    root: "/demo/lazy-export",
    figures: 2,
    elemsPerPanel: 260,
    panelBytes: 20_000,
  });

  await page.evaluate(async (root) => {
    await window.__flux.bridge.loadFigInto(root, "lazy-export");
  }, fx.root);
  await waitFor(
    page,
    (ids) => {
      const P = window.__flux.plot;
      return P.plotResidency.pending() === 0 && ids.every((id) => P.plotDom.has(id));
    },
    fx.assetsByFig[fx.figIds[0]],
    { label: "active figure resident", timeout: 20000 },
  );

  // Figure 2 was never viewed — must be cold.
  const fig2Cold = await page.evaluate(
    (ids) => ids.every((id) => !window.__flux.plot.plotDom.has(id)),
    fx.assetsByFig[fx.figIds[1]],
  );
  h.ok(fig2Cold, "never-viewed figure has no parsed DOM before export (the hazard case)");

  // Inject a per-part override on the cold figure's first panel (direct store
  // surgery — test seeding; keeps `dirty` untouched so no autosave fires).
  await page.evaluate((figId) => {
    window.__flux.fig.project.update((p) => {
      const fig = p.figures.find((f) => f.id === figId);
      fig.elements[0].overrides = { "s0.line": { stroke: "#ff0000", strokeWidth: 3 } };
      return p;
    });
  }, fx.figIds[1]);

  const exported = await page.evaluate((figId) => {
    const p = window.__flux.get(window.__flux.fig.project);
    const fig = p.figures.find((f) => f.id === figId);
    return window.__flux.io.buildFigureSvg(fig);
  }, fx.figIds[1]);

  const hasOverride = /(#ff0000|rgb\(255,\s*0,\s*0\))/.test(exported);
  h.ok(hasOverride, "per-part override baked into the export of a never-viewed figure");
  h.ok(exported.includes("<circle"), "export contains real vector content (not the <image> fallback)");
  h.ok(exported.includes(`__s0.line`), "export keeps prefixed semantic part ids");
  const fallbackCount = (exported.match(/<image[^>]+data:image\/svg/g) ?? []).length;
  h.eq(fallbackCount, 0, "no svg-data <image> fallbacks in the exported markup");

  const nowResident = await page.evaluate(
    (ids) => ids.every((id) => window.__flux.plot.plotDom.has(id)),
    fx.assetsByFig[fx.figIds[1]],
  );
  h.ok(nowResident, "ensureFigurePlots parsed the figure synchronously for the export");

  // Evict it, export again — identical semantics.
  const evicted = await page.evaluate((ids) => {
    const P = window.__flux.plot;
    P.applyPlotNodeCap(1); // active figure stays (mounted); figure 2 must go
    const gone = ids.filter((id) => !P.plotDom.has(id)).length;
    P.applyPlotNodeCap(150_000);
    return gone;
  }, fx.assetsByFig[fx.figIds[1]]);
  h.ok(evicted > 0, `LRU evicted the unmounted figure under pressure (${evicted} panels dropped)`);

  const exported2 = await page.evaluate((figId) => {
    const p = window.__flux.get(window.__flux.fig.project);
    const fig = p.figures.find((f) => f.id === figId);
    return window.__flux.io.buildFigureSvg(fig);
  }, fx.figIds[1]);
  h.ok(/(#ff0000|rgb\(255,\s*0,\s*0\))/.test(exported2), "override still baked after eviction (export re-ensures)");
  h.eq(exported2 === exported, true, "evicted-then-exported markup is byte-identical to the first export");

  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean: ${errs.slice(0, 3).join(" | ") || "no errors"}`);
} finally {
  await browser.close();
}
await h.done();
