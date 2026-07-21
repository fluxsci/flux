// Lazy figure-asset loading — before/after measurement probe
// (notes/lazy_figure_asset_loading_plan.md §2/§9).
//
// Measures, per project size N (figures × 14 dense panels, real-world density):
//   loadMs      — await loadFigInto(root) wall time (the open-path cost)
//   settleMs    — until the ACTIVE figure's plots are inline + parse queue idle
//   plotDom     — resident parsed-DOM entries after settle
//   residentElems — element nodes retained across all cached plot DOMs
//   metrics     — Chrome renderer counters (Nodes / Documents / JS heap)
//   coldSwitchMs— activate the LAST figure → all its plots inline
//   warmSwitchMs— switch back to the first figure (LRU-warm)
//
// Works on both the EAGER (pre-change) and LAZY (post-change) app: detects
// `__flux.plot.plotResidency` and adapts the settle condition.
//
//   node scripts/perf/lazy-assets-probe.mjs            # N = 1,3,6,12
//   FLUX_LAZY_N="1,12" node scripts/perf/lazy-assets-probe.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { launch, gotoApp, clickMode, APP_URL, sleep } from "../lib/driver.mjs";
import { waitFor } from "../lib/wait.mjs";
import { installDenseProject } from "../lib/lazyFixture.mjs";

const NS = (process.env.FLUX_LAZY_N || "1,3,6,12").split(",").map((s) => Number(s.trim()));
const rows = [];

async function measure(n) {
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

    const fx = await installDenseProject(page, { root: "/demo/lazy-probe", figures: n });

    const loadMs = await page.evaluate(async (root) => {
      const t0 = performance.now();
      await window.__flux.bridge.loadFigInto(root, "lazy-probe");
      return performance.now() - t0;
    }, fx.root);

    // Settle: active figure's plots resident (+ queue idle when lazy).
    const firstAssets = fx.assetsByFig[fx.figIds[0]];
    const t1 = Date.now();
    await waitFor(
      page,
      (ids) => {
        const P = window.__flux.plot;
        const q = P.plotResidency ? P.plotResidency.pending() === 0 : true;
        return q && ids.every((id) => P.plotDom.has(id));
      },
      firstAssets,
      { label: "active figure plots resident", timeout: 60000, interval: 40 },
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const settleMs = Date.now() - t1;

    const inPage = await page.evaluate(() => {
      const P = window.__flux.plot;
      let residentElems = 0;
      for (const [, root] of P.plotDom) residentElems += root.querySelectorAll("*").length + 1;
      return {
        plotDom: P.plotDom.size,
        residentElems,
        residency: P.plotResidency
          ? { totalNodes: P.plotResidency.totalNodes, parses: P.plotResidency.parses, evictions: P.plotResidency.evictions }
          : null,
      };
    });
    const metrics = await page.metrics();

    // Cold switch: focus the LAST figure the way the app does (focusFigure —
    // active + PAN; the active figure renders, but its ELEMENTS are still
    // viewport-culled, so a bare activeFigureId.set far offscreen mounts no
    // PlotElements and nothing would ever parse).
    const focusFig = (id) => {
      const F = window.__flux.fig;
      const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
      F.activeCanvasId.set(fig.canvasId);
      F.activeFigureId.set(id);
      const zoom = 0.55;
      F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
    };
    const lastFig = fx.figIds[fx.figIds.length - 1];
    const lastAssets = fx.assetsByFig[lastFig];
    const t2 = Date.now();
    await page.evaluate(focusFig, lastFig);
    await waitFor(page, (ids) => ids.every((id) => window.__flux.plot.plotDom.has(id)), lastAssets, {
      label: "cold figure plots resident",
      timeout: 60000,
      interval: 25,
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const coldSwitchMs = Date.now() - t2;

    // Warm switch back.
    const t3 = Date.now();
    await page.evaluate(focusFig, fx.figIds[0]);
    await waitFor(page, (ids) => ids.every((id) => window.__flux.plot.plotDom.has(id)), firstAssets, {
      label: "warm figure plots resident",
      timeout: 60000,
      interval: 25,
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const warmSwitchMs = Date.now() - t3;

    const after = await page.evaluate(() => ({
      plotDom: window.__flux.plot.plotDom.size,
      residency: window.__flux.plot.plotResidency
        ? {
            totalNodes: window.__flux.plot.plotResidency.totalNodes,
            parses: window.__flux.plot.plotResidency.parses,
            evictions: window.__flux.plot.plotResidency.evictions,
          }
        : null,
    }));

    rows.push({
      n,
      loadMs: Math.round(loadMs),
      settleMs,
      plotDom: inPage.plotDom,
      residentElems: inPage.residentElems,
      nodes: metrics.Nodes,
      documents: metrics.Documents,
      jsHeapMB: Math.round(metrics.JSHeapUsedSize / 1e6),
      coldSwitchMs,
      warmSwitchMs,
      residency: after.residency,
      plotDomAfterSwitches: after.plotDom,
    });
  } finally {
    await browser.close();
  }
}

for (const n of NS) {
  await measure(n);
  await sleep(150);
}

mkdirSync("test-results", { recursive: true });
writeFileSync("test-results/lazy-assets-probe.json", JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
console.log("\nN  loadMs  settleMs  plotDom  residentElems  rendererNodes  docs  heapMB  coldSw  warmSw");
for (const r of rows)
  console.log(
    `${String(r.n).padEnd(2)} ${String(r.loadMs).padStart(6)} ${String(r.settleMs).padStart(9)} ${String(r.plotDom).padStart(8)} ` +
      `${String(r.residentElems).padStart(13)} ${String(r.nodes).padStart(13)} ${String(r.documents).padStart(5)} ` +
      `${String(r.jsHeapMB).padStart(6)} ${String(r.coldSwitchMs).padStart(7)} ${String(r.warmSwitchMs).padStart(7)}`,
  );
console.log("\nwritten: test-results/lazy-assets-probe.json");
