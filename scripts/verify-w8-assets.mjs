// W8 (FIG-6): the figure autosave writes only CHANGED asset bytes, not every asset
// on each debounce. Wraps the memBridge writeFile to count fig/assets/ byte writes,
// then proves: (A) a dirty asset IS written; (B) once clean, an unrelated edit +
// save writes ZERO asset bytes (no MB-per-keystroke thrash).
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect width="200" height="120" fill="#abc"/></svg>`;
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3200 });
await clickMode(page, "Figure");
await sleep(1400);

// Count writes into fig/assets/ (the memBridge is a plain object → wrappable).
await page.evaluate(() => {
  window.__assetWrites = 0;
  const orig = window.fig.writeFile.bind(window.fig);
  window.fig.writeFile = (p, d) => {
    if (typeof p === "string" && p.includes("/fig/assets/")) window.__assetWrites++;
    return orig(p, d);
  };
});

// A) Add an asset + mark it dirty (reimportPlot), then save → it gets written.
await page.evaluate(async (svg) => {
  const F = window.__flux;
  F.fig.commit((p) => {
    p.assets.push({ id: "w8asset", name: "w8", kind: "svg", path: "assets/w8asset.svg", naturalWidth: 200, naturalHeight: 120 });
  });
  F.io.reimportPlot("w8asset", svg, { specVersion: "0.2.0", series: [] }); // caches + marks dirty
  await F.lifecycle.flushAll();
}, SVG);
await sleep(300);
const afterDirty = await page.evaluate(() => window.__assetWrites);

// B) Now clean — an unrelated edit + save must write ZERO asset bytes.
await page.evaluate(async () => {
  window.__assetWrites = 0;
  window.__flux.fig.commit((p) => { if (p.figures[0]) p.figures[0].name = "W8 unrelated"; });
  await window.__flux.lifecycle.flushAll();
});
await sleep(300);
const afterClean = await page.evaluate(() => window.__assetWrites);

const out = {
  assetWritesForDirtyAsset: afterDirty,
  assetWritesOnUnrelatedEdit: afterClean,
  errs: realErrors(page),
};
console.log(JSON.stringify(out, null, 2));
await browser.close();

const pass =
  out.assetWritesForDirtyAsset >= 1 &&
  out.assetWritesOnUnrelatedEdit === 0 &&
  out.errs.length === 0;
console.log(pass ? "W8 VERIFY: PASS" : "W8 VERIFY: FAIL");
process.exit(pass ? 0 : 1);
