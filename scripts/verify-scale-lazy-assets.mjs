// Lazy figure-asset residency — SCALE GATE
// (notes/lazy_figure_asset_loading_plan.md §8; landed 2026-07-21).
//
// Contract: opening a project parses NO plot DOM up front — the parsed cache
// (`plotDom`) tracks the MOUNTED working set (viewport culling is the
// residency policy) under a structural node cap with LRU eviction, so
// resident cost is O(active figure), not O(project). Eager baseline at this
// fixture's density (14 panels × ~2.2k elements × ~380KB per figure — the
// real rasterized-FluxProjection shape): 168 parsed docs / 366k resident
// elements / 2.25M renderer nodes / 2.55s open at 12 figures, all linear.
//
// STRUCTURAL budgets (primary, machine-independent):
//   · anti-eager sentinel: ≤20 parsed plot DOMs immediately after open
//     (an eager regression parses all 84 in this 6-figure fixture)
//   · residency: totalNodes ≤ nodeCap after every figure focus; LRU
//     evictions occur once the visited set exceeds the cap
//   · mounted plots are NEVER evicted (tiny-cap probe)
//   · LRU warmth: re-focusing a warm figure re-parses nothing
//   · parse slicing: no single long task ≥150ms during a cold-figure settle
//     (a regression to parse-everything-in-one-task reads ~300ms+)
// TIMING (recorded to test-results/scale-lazy-assets.json, never asserted):
//   open / settle / cold-focus / warm-focus wall times.
//
//   node scripts/verify-scale-lazy-assets.mjs      (dev server on :1420)

import { mkdirSync, writeFileSync } from "node:fs";
import { launch, gotoApp, clickMode, APP_URL, realErrors } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const h = harness("verify-scale-lazy-assets");
const FIGURES = 6;
const timings = {};

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

  const fx = await installDenseProject(page, { root: "/demo/lazy-scale", figures: FIGURES });

  // ---- open: no eager parse ------------------------------------------------
  timings.loadMs = await page.evaluate(async (root) => {
    const t0 = performance.now();
    await window.__flux.bridge.loadFigInto(root, "lazy-scale");
    return Math.round(performance.now() - t0);
  }, fx.root);
  const justAfter = await page.evaluate(() => window.__flux.plot.plotDom.size);
  h.ok(justAfter <= 20, `open parses nothing up front (anti-eager sentinel): plotDom=${justAfter} right after load (eager would be ${FIGURES * 14})`);

  const focusFig = (id) => {
    const F = window.__flux.fig;
    const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
    F.activeCanvasId.set(fig.canvasId);
    F.activeFigureId.set(id);
    const zoom = 0.55;
    F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
  };
  const settleFig = async (figId, label, timeout = 30000) => {
    const t0 = Date.now();
    await waitFor(
      page,
      (ids) => {
        const P = window.__flux.plot;
        return P.plotResidency.pending() === 0 && ids.every((id) => P.plotDom.has(id));
      },
      fx.assetsByFig[figId],
      { label, timeout, interval: 30 },
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return Date.now() - t0;
  };

  // ---- active figure upgrades within the navigation budget -----------------
  timings.settleMs = await settleFig(fx.figIds[0], "active figure plots resident");
  const snapResidency = () => {
    const P = window.__flux.plot;
    return { totalNodes: P.plotResidency.totalNodes, nodeCap: P.plotResidency.nodeCap, plotDom: P.plotDom.size, evictions: P.plotResidency.evictions };
  };
  let res = await page.evaluate(snapResidency);
  h.ok(res.totalNodes <= res.nodeCap && res.plotDom <= 2 * 14, `post-open residency bounded: totalNodes=${res.totalNodes} cap=${res.nodeCap} plotDom=${res.plotDom}`);

  // ---- LRU warmth: re-focus parses nothing ---------------------------------
  await page.evaluate(focusFig, fx.figIds[1]);
  // long-task capture during a COLD settle — parse slicing keeps tasks short
  await page.evaluate(() => {
    window.__lazyLT = { n: 0, max: 0 };
    window.__lazyPO?.disconnect?.();
    window.__lazyPO = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__lazyLT.n++;
        window.__lazyLT.max = Math.max(window.__lazyLT.max, e.duration);
      }
    });
    window.__lazyPO.observe({ entryTypes: ["longtask"] });
  });
  timings.coldFocusMs = await settleFig(fx.figIds[1], "cold figure settle");
  const lt = await page.evaluate(() => {
    window.__lazyPO.disconnect();
    return window.__lazyLT;
  });
  h.ok(lt.max < 150, `cold settle stays time-sliced (no parse-all long task): longtask max=${Math.round(lt.max)}ms n=${lt.n}`);

  const parsesBefore = await page.evaluate(() => window.__flux.plot.plotResidency.parses);
  await page.evaluate(focusFig, fx.figIds[0]);
  timings.warmFocusMs = await settleFig(fx.figIds[0], "warm figure settle");
  const parsesAfter = await page.evaluate(() => window.__flux.plot.plotResidency.parses);
  h.ok(parsesAfter === parsesBefore, `warm re-focus re-parses nothing (LRU hit): parses ${parsesBefore} → ${parsesAfter}`);

  // ---- tour every figure: cap holds, evictions kick in ---------------------
  for (let i = 1; i < FIGURES; i++) {
    await page.evaluate(focusFig, fx.figIds[i]);
    await settleFig(fx.figIds[i], `tour figure ${i + 1}`);
    res = await page.evaluate(snapResidency);
    h.ok(res.totalNodes <= res.nodeCap, `residency ≤ cap after figure ${i + 1}: totalNodes=${res.totalNodes} cap=${res.nodeCap} plotDom=${res.plotDom}`);
  }
  h.ok(res.evictions >= 1, `LRU evicted once the visited set exceeded the cap: evictions=${res.evictions} (visited ${FIGURES}×~30.5k elements vs cap ${res.nodeCap})`);
  const lastResident = await page.evaluate(
    (ids) => ids.every((id) => window.__flux.plot.plotDom.has(id)),
    fx.assetsByFig[fx.figIds[FIGURES - 1]],
  );
  h.ok(lastResident, "current figure survives eviction pressure: active figure's panels resident after tour");

  // ---- mounted plots are never evicted (tiny-cap probe) --------------------
  await page.evaluate(() => {
    window.__flux.plot.plotResidency.nodeCap = 1000;
  });
  await page.evaluate(focusFig, fx.figIds[0]);
  await settleFig(fx.figIds[0], "tiny-cap settle");
  const tiny = await page.evaluate((ids) => {
    const P = window.__flux.plot;
    return {
      activeResident: ids.every((id) => P.plotDom.has(id)),
      plotDom: P.plotDom.size,
      totalNodes: P.plotResidency.totalNodes,
      evictions: P.plotResidency.evictions,
    };
  }, fx.assetsByFig[fx.figIds[0]]);
  h.ok(tiny.activeResident, `mounted plots never evicted (soft cap): active figure resident under nodeCap=1000 (totalNodes=${tiny.totalNodes})`);
  h.ok(tiny.plotDom === 14, `tiny cap evicts every unmounted plot: plotDom=${tiny.plotDom} (expected exactly the mounted figure)`);
  await page.evaluate(() => {
    window.__flux.plot.plotResidency.nodeCap = 150_000;
  });

  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean: ${errs.slice(0, 3).join(" | ") || "no errors"}`);

  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/scale-lazy-assets.json",
    JSON.stringify({ at: new Date().toISOString(), figures: FIGURES, timings, finalResidency: res, longTask: lt }, null, 2),
  );
  console.log(`timings ${JSON.stringify(timings)}`);
} finally {
  await browser.close();
}
await h.done();
