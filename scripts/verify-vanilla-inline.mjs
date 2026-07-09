// figure-v1 Phase 4 gate (browser) — VANILLA SVGs are first-class semantic plots:
//  - a real `plt.savefig()` file cached with NO manifest renders as INLINE live
//    DOM (real <text>, no <image> raster for svg assets anywhere in the scene);
//  - cachePlot synthesizes a DERIVED manifest (spec "fluxplot-derived/1") whose
//    parts tree covers the matplotlib ids (tick groups addressable by prefixed id);
//  - a REAL canvas click over a tick label drills partSelection (click-through);
//  - LEGACY DOCS: a fig/ canvas file containing a raw `type:"svg"` element (the
//    deleted v1 kind), loaded through the REAL loader path (memBridge write →
//    bridge.loadFigInto → normalizeProject → migrateProject), arrives as a
//    `type:"plot"` element with `overrides:{}` + `source.svgPath` from the asset
//    entry — and renders inline (loadFigInto now caches EVERY svg asset).
//  - side-by-side with a fluxplot: both inline; only the fluxplot keeps a real
//    (non-derived) manifest. Screenshot saved for the evidence trail.
//   Run (dev server on :1420 must be up): node scripts/verify-vanilla-inline.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const ROOT = "/demo/myc-growth-paper";
// A REAL vanilla matplotlib export (360×216pt → 480×288 CSS px), no sidecar.
const VANILLA = readFileSync("fixtures/plots/vanilla-sine.svg", "utf8");
// A REAL fluxplot (generator output + manifest) for the side-by-side.
const FLUXPLOT_SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const FLUXPLOT_MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // ---- 1. LEGACY-DOC CONVERSION through the real loader path ------------------
  // Write a v1-shaped fig/ subsystem (asset entry + a raw type:"svg" element)
  // into the memBridge, then load it EXACTLY the way the app does.
  const legacy = await page.evaluate(
    async (root, svg) => {
      const F = window.__flux;
      const idx = JSON.parse(await window.fig.readText(`${root}/fig/index.json`));
      idx.assets = idx.assets ?? [];
      idx.assets.push({ id: "legacy-asset", name: "legacy.svg", kind: "svg", path: "assets/legacy-asset.svg", naturalWidth: 480, naturalHeight: 288 });
      await window.fig.writeText(`${root}/fig/index.json`, JSON.stringify(idx, null, 2) + "\n");
      await window.fig.writeText(`${root}/fig/assets/legacy-asset.svg`, svg);
      const cf = JSON.parse(await window.fig.readText(`${root}/fig/canvases/canvas-1.json`));
      cf.figures[0].width = 1200;
      cf.figures[0].height = 800;
      cf.figures[0].elements = [
        { type: "svg", id: "legacy-el", assetId: "legacy-asset", x: 40, y: 420, width: 480, height: 288, rotation: 0 },
      ];
      await window.fig.writeText(`${root}/fig/canvases/canvas-1.json`, JSON.stringify(cf, null, 2) + "\n");

      await F.bridge.loadFigInto(root, "Demo");
      const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === "legacy-el");
      const man = F.get(F.plot.plotManifests)["legacy-asset"];
      return {
        type: el?.type ?? null,
        overrides: el ? JSON.stringify(el.overrides) : null,
        svgPath: el?.source?.svgPath ?? null,
        manifestPath: el?.source?.manifestPath ?? null,
        manifestSpec: man?.spec ?? null,
        domCached: F.plot.plotDom.has("legacy-asset"),
      };
    },
    ROOT,
    VANILLA,
  );
  assert(legacy.type === "plot", `legacy type:"svg" element loads as type:"plot" (got ${legacy.type})`);
  assert(legacy.overrides === "{}", `…with overrides seeded {} (got ${legacy.overrides})`);
  assert(legacy.svgPath === "assets/legacy-asset.svg", `…source.svgPath from the asset entry (got ${legacy.svgPath})`);
  assert(legacy.manifestPath == null, "…and NO manifestPath (vanilla discriminator preserved)");
  assert(legacy.domCached, "loadFigInto cached the sidecar-less svg asset (P4 loader parity)");
  assert(legacy.manifestSpec === "fluxplot-derived/1", `…with a DERIVED manifest (spec ${legacy.manifestSpec})`);
  await sleep(400);
  assert(
    await page.evaluate(() => !!document.getElementById("legacy-el__figure_1")),
    "the converted legacy element renders INLINE (prefixed matplotlib root id live in the DOM)",
  );

  // ---- 2. direct-seed a vanilla plot + a fluxplot side by side ----------------
  await page.evaluate(
    (vanillaSvg, fpSvg, fpManifest) => {
      const F = window.__flux;
      // reimportPlot = the headless-callable cache seam: assetData (fallback) +
      // cachePlot. NO manifest for the vanilla file → cachePlot DERIVES one.
      F.io.reimportPlot("vanilla-asset", vanillaSvg, undefined);
      F.io.reimportPlot("fluxplot-asset", fpSvg, fpManifest);
      F.fig.commit((p) => {
        const g = p.figures[0]; // holds only legacy-el (loadFigInto seeded it above)
        g.elements.push({
          type: "plot", id: "vanilla1", assetId: "vanilla-asset",
          x: 40, y: 40, width: 480, height: 288, rotation: 0, overrides: {},
          source: { svgPath: "plots/vanilla-sine.svg" },
        });
        g.elements.push({
          type: "plot", id: "fluxplot1", assetId: "fluxplot-asset",
          x: 580, y: 40, width: 504, height: 360, rotation: 0, overrides: {},
          source: { svgPath: "plots/06_scatter_regression.svg", manifestPath: "plots/06_scatter_regression.fluxplot.json" },
        });
      });
      F.fig.selectOnly("vanilla1");
      F.fig.viewport.set({ panX: 40, panY: 120, zoom: 1 });
    },
    VANILLA,
    FLUXPLOT_SVG,
    FLUXPLOT_MANIFEST,
  );
  await sleep(500);

  const dom = await page.evaluate(() => {
    const F = window.__flux;
    const root = document.getElementById("vanilla1__figure_1");
    const texts = root ? root.querySelectorAll("text") : [];
    const man = F.get(F.plot.plotManifests)["vanilla-asset"];
    const fpMan = F.get(F.plot.plotManifests)["fluxplot-asset"];
    return {
      inlineTexts: texts.length,
      firstText: texts[0]?.textContent?.trim() ?? null,
      spec: man?.spec ?? null,
      manifestHasXtick: JSON.stringify(man?.parts ?? {}).includes('"xtick_1"'),
      fpSpec: fpMan?.spec ?? null,
      tickGroup: !!document.getElementById("vanilla1__xtick_1"),
      tickLabelGroup: !!document.getElementById("vanilla1__text_1"),
      fluxplotInline: !!document.getElementById("fluxplot1__figure"),
      sceneImages: document.querySelectorAll(".scene-svg image").length,
    };
  });
  assert(dom.inlineTexts > 0, `vanilla plot renders REAL inline <text> (${dom.inlineTexts} nodes, first "${dom.firstText}")`);
  assert(dom.spec === "fluxplot-derived/1", `derived manifest registered in plotManifests (spec ${dom.spec})`);
  assert(dom.manifestHasXtick, "derived parts tree covers the matplotlib tick groups");
  assert(dom.tickGroup, "tick group addressable by prefixed id (vanilla1__xtick_1)");
  assert(dom.tickLabelGroup, "tick label addressable by prefixed id (vanilla1__text_1)");
  assert(dom.fluxplotInline, "the fluxplot beside it is inline too (fluxplot1__figure)");
  assert(dom.fpSpec === "fluxplot/manifest", `the fluxplot keeps its REAL manifest, not a derived one (spec ${dom.fpSpec})`);
  assert(dom.sceneImages === 0, `NO <image> elements for svg assets in the scene (${dom.sceneImages})`);
  await shot(page, "vanilla-inline-side-by-side");

  // ---- 3. part click-through: a REAL click over a tick label drills ----------
  const rect = await page.evaluate(() => {
    const n = document.getElementById("vanilla1__text_1");
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  assert(rect, "tick label has a live on-screen rect");
  if (rect) {
    await page.mouse.click(rect.x, rect.y);
    await sleep(350);
    const ps = await page.evaluate(() => {
      const F = window.__flux;
      const sel = F.get(F.fig.partSelection);
      if (!sel) return { drilled: false };
      const node = document.getElementById(`${sel.elementId}__${sel.partId}`);
      const label = document.getElementById("vanilla1__text_1");
      return {
        drilled: true,
        elementId: sel.elementId,
        partId: sel.partId,
        insideLabel: !!node && !!label && (node === label || label.contains(node)),
      };
    });
    assert(ps.drilled, "real click over the tick label sets partSelection");
    assert(ps.drilled && ps.elementId === "vanilla1", `…on the vanilla plot (${ps.elementId})`);
    assert(ps.drilled && ps.insideLabel, `…resolved to the label subtree (partId ${ps.partId})`);
  }
  await shot(page, "vanilla-inline-drilled");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-VANILLA-INLINE ALL PASS" : `\nVERIFY-VANILLA-INLINE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
