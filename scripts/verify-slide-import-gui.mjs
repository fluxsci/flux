// slide-migration §3.7 — the mode-conditional ASSET SINK: imports in slide
// mode flow through the ONE figure import pipeline (drop → placeIncoming →
// project.assets + assetData) but persist into slides/<deckId>/assets/ (the
// deck save's sink) and register in deck.assets — NEVER into fig/assets/.
// Re-homes verify-importer-slide.mjs's slide-side coverage on the new model.
// Run: node scripts/verify-slide-import-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  const figAssetsBefore = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    try {
      return (await window.fig.readdir(`${root}/fig/assets`)).map((e) => e.name).sort().join(",");
    } catch {
      return "(none)";
    }
  });

  // drop a real PNG file onto the active slide through the figure import pipeline
  const dropRes = await page.evaluate(async () => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    // 1×1 red PNG
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "shot.png", { type: "image/png" });
    await f.io.importDroppedFiles([file], sid);
    const p = f.get(f.fig.project);
    const asset = p.assets.find((a) => a.name === "shot.png");
    const fig = p.figures.find((x) => x.id === sid);
    const el = fig.elements.find((e) => e.type === "image");
    return { assetId: asset?.id, path: asset?.path, elOk: !!el && el.assetId === asset?.id };
  });
  ok(!!dropRes.assetId && dropRes.elOk, "a dropped PNG imported through the SHARED figure pipeline (asset + image element)");
  ok(/^assets\//.test(dropRes.path ?? ""), `the asset path is deck-relative (${dropRes.path})`);

  // flush → the sink writes the bytes into slides/<id>/assets/, registers in deck.assets
  await page.evaluate(() => window.__flux.lifecycle.flushById("slide"));
  await sleep(500);
  const persisted = await page.evaluate(async (assetId) => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const deckId = f.get(f.slide.deckOverlay).id;
    const deck = JSON.parse(await window.fig.readText(`${root}/slides/${deckId}/deck.json`));
    const entry = (deck.assets ?? []).find((a) => a.id === assetId);
    let bytesOnDisk = false;
    try {
      const names = (await window.fig.readdir(`${root}/slides/${deckId}/assets`)).map((e) => e.name);
      bytesOnDisk = names.some((n) => n.startsWith(assetId));
    } catch { /* missing dir */ }
    return { entry, bytesOnDisk };
  }, dropRes.assetId);
  ok(!!persisted.entry && persisted.entry.kind === "png" && persisted.entry.naturalWidth === 1,
    "deck.assets registered the import (figure Asset shape, natural size)");
  ok(persisted.bytesOnDisk, "the bytes landed in slides/<deckId>/assets/ (the slide-mode sink)");

  const figAssetsAfter = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    try {
      return (await window.fig.readdir(`${root}/fig/assets`)).map((e) => e.name).sort().join(",");
    } catch {
      return "(none)";
    }
  });
  ok(figAssetsAfter === figAssetsBefore, "fig/assets/ is untouched (never the slide sink)");

  // and it round-trips: reload the deck from disk → the asset resolves again
  const reload = await page.evaluate(async (assetId) => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const deckId = f.get(f.slide.deckOverlay).id;
    const r = await f.slideBridge.loadDeckInto(root, deckId);
    const p = f.get(f.fig.project);
    return { ok: !!r, asset: p.assets.some((a) => a.id === assetId) };
  }, dropRes.assetId);
  ok(reload.ok && reload.asset, "the deck reloads from disk with the imported asset resolved");

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE IMPORT GUI: FAIL (${fails})` : "\nSLIDE IMPORT GUI: PASS");
process.exit(fails ? 1 : 0);
