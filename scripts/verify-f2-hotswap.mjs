// F2 in-app hot-swap primitive: reimportPlot replaces a plot's cached DOM in
// place and bumps plotGen (so mountPlot re-clones) WITHOUT touching the element —
// proving regenerate keeps the element's id-keyed overrides.
import { launch, gotoApp, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await sleep(400);

const r = await page.evaluate(() => {
  const { plot, io, get } = window.__flux;
  const assetId = "test-plot-asset";
  const manifest = { schemaVersion: "0.1.0", axes: [], series: [], guides: [], overlays: [] };

  // Initial cache (v1).
  io.reimportPlot(assetId, '<svg xmlns="http://www.w3.org/2000/svg" data-v="1"><rect/></svg>', manifest, { params: { test: "t" } });
  const gen1 = get(plot.plotGen)[assetId];
  const v1 = plot.plotDom.get(assetId)?.getAttribute("data-v");

  // Hot-swap (v2) — same assetId, new content + recipe.
  io.reimportPlot(assetId, '<svg xmlns="http://www.w3.org/2000/svg" data-v="2"><circle/></svg>', manifest, { params: { test: "mw" } });
  const gen2 = get(plot.plotGen)[assetId];
  const dom2 = plot.plotDom.get(assetId);

  return {
    gen1,
    gen2,
    genBumped: gen2 === gen1 + 1, // → mountPlot re-clones
    v1,
    v2: dom2?.getAttribute("data-v"),
    swappedToCircle: !!dom2?.querySelector("circle") && !dom2?.querySelector("rect"),
    recipeUpdated: get(plot.plotRecipes)[assetId]?.params?.test === "mw",
  };
});

console.log(JSON.stringify({ hotswap: r, errs: errors(page) }, null, 2));
await browser.close();
