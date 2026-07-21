// Lazy figure-asset residency — SAVE SAFETY (the critical correctness gate,
// notes/lazy_figure_asset_loading_plan.md §7/§8).
//
// The one way lazy loading could corrupt a project: if save regenerated the
// asset index from a PRUNED asset list, unparsed/evicted assets would drop out
// of fig/index.json and orphan their bytes. The invariant: `model.assets`
// stays 100% resident — only the parsed-DOM cache defers — and saveFigFrom
// skips byte-writes for clean assets, so a save while most plots were never
// parsed (or were LRU-evicted) must leave every asset byte file, every
// sidecar, and every index asset entry intact.
//
// Flow: dense 6-figure project → loadFigInto (nothing parsed beyond the
// active figure) → force eviction pressure (nodeCap=1) → saveFigFrom →
// assert bytes/sidecars byte-identical + index entries complete → reload →
// assert everything still renders (cold figure upgrades inline).
//
//   node scripts/verify-lazy-save-safety.mjs      (dev server on :1420)

import { launch, gotoApp, clickMode, APP_URL, realErrors } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const h = harness("verify-lazy-save-safety");
const FIGURES = 6;

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

  // Small density — this gate is about correctness, not scale.
  const fx = await installDenseProject(page, {
    root: "/demo/lazy-save",
    figures: FIGURES,
    elemsPerPanel: 220,
    panelBytes: 18_000,
    vanillaPerFigure: 1,
  });

  // FNV-1a over every fig/ file we wrote — the before/after byte fingerprint.
  const hashTree = (paths) =>
    page.evaluate(async (ps) => {
      const out = {};
      for (const p of ps) {
        const bytes = new Uint8Array(await window.fig.readFile(p));
        let hv = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
          hv ^= bytes[i];
          hv = Math.imul(hv, 0x01000193) >>> 0;
        }
        out[p] = `${hv.toString(16)}:${bytes.length}`;
      }
      return out;
    }, paths);

  const assetPaths = [];
  for (const figId of fx.figIds)
    for (const aid of fx.assetsByFig[figId]) {
      assetPaths.push(`${fx.root}/fig/assets/${aid}.svg`);
      if (!aid.endsWith("-v")) assetPaths.push(`${fx.root}/fig/assets/${aid}.fluxplot.json`);
    }

  await page.evaluate(async (root) => {
    await window.__flux.bridge.loadFigInto(root, "lazy-save");
  }, fx.root);
  await waitFor(
    page,
    (ids) => {
      const P = window.__flux.plot;
      return P.plotResidency.pending() === 0 && ids.every((id) => P.plotDom.has(id));
    },
    fx.assetsByFig[fx.figIds[0]],
    { label: "active figure resident", timeout: 30000 },
  );

  const before = await hashTree(assetPaths);
  const stateBefore = await page.evaluate(() => ({
    plotDom: window.__flux.plot.plotDom.size,
    assets: window.__flux.get(window.__flux.fig.project).assets.length,
  }));
  h.ok(stateBefore.plotDom < FIGURES * 14, `plotDom is a strict subset before save (${stateBefore.plotDom} parsed of ${stateBefore.assets} assets)`);
  h.eq(stateBefore.assets, FIGURES * 15, "model.assets stays 100% resident (the save-safety invariant)");

  // Maximum eviction pressure: everything unmounted must go, save must not care.
  const evicted = await page.evaluate((ids) => {
    const P = window.__flux.plot;
    P.plotResidency.nodeCap = 1;
    for (const id of ids) P.ensurePlotDom(id); // parse a couple of cold ones → triggers evictions
    return { plotDom: P.plotDom.size, evictions: P.plotResidency.evictions };
  }, fx.assetsByFig[fx.figIds[2]].slice(0, 3));
  h.ok(evicted.evictions > 0, `eviction pressure applied (evictions=${evicted.evictions}, plotDom=${evicted.plotDom})`);

  await page.evaluate(async (root) => {
    await window.__flux.bridge.saveFigFrom(root);
  }, fx.root);

  const after = await hashTree(assetPaths);
  let identical = 0;
  let broken = [];
  for (const p of assetPaths) {
    if (before[p] === after[p]) identical++;
    else broken.push(p);
  }
  h.eq(identical, assetPaths.length, `every asset byte file + sidecar byte-identical across save (${identical}/${assetPaths.length}${broken.length ? ` — broke: ${broken.slice(0, 3).join(", ")}` : ""})`);

  const index = await page.evaluate(
    async (root) => JSON.parse(await window.fig.readText(`${root}/fig/index.json`)),
    fx.root,
  );
  const expectIds = fx.figIds.flatMap((f) => fx.assetsByFig[f]);
  const gotIds = new Set((index.assets ?? []).map((a) => a.id));
  const missing = expectIds.filter((id) => !gotIds.has(id));
  h.eq(missing.length, 0, `index.json preserves every asset entry (${gotIds.size}/${expectIds.length}${missing.length ? ` — missing: ${missing.slice(0, 3).join(", ")}` : ""})`);
  const entryOk = (index.assets ?? []).every((a) => a.path && a.kind === "svg" && a.naturalWidth > 0);
  h.ok(entryOk, "index asset entries keep path/kind/naturalWidth");

  // Reload from the saved tree: everything must still resolve + render.
  await page.evaluate(async (root) => {
    window.__flux.plot.plotResidency.nodeCap = 150_000;
    await window.__flux.bridge.loadFigInto(root, "lazy-save");
  }, fx.root);
  const focusFig = (id) => {
    const F = window.__flux.fig;
    const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
    F.activeCanvasId.set(fig.canvasId);
    F.activeFigureId.set(id);
    const zoom = 0.55;
    F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
  };
  await page.evaluate(focusFig, fx.figIds[4]);
  await waitFor(
    page,
    (ids) => {
      const P = window.__flux.plot;
      return P.plotResidency.pending() === 0 && ids.every((id) => P.plotDom.has(id));
    },
    fx.assetsByFig[fx.figIds[4]],
    { label: "cold figure resident after reload", timeout: 30000 },
  );
  const reloadAssets = await page.evaluate(() => window.__flux.get(window.__flux.fig.project).assets.length);
  h.eq(reloadAssets, FIGURES * 15, "reload restores the full asset list");
  // assetData completeness is proven structurally by the cold-figure upgrade
  // above — a figure that was never parsed pre-save can only go inline after
  // reload if its bytes survived the save intact.

  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean: ${errs.slice(0, 3).join(" | ") || "no errors"}`);
} finally {
  await browser.close();
}
await h.done();
