// Exercise actual watch → source update → autosave → Paper readback. The
// in-memory bridge keeps this hermetic; no real project/library is touched.
import assert from "node:assert/strict";
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";
const { browser, page } = await launch();
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 1600 });
  await clickMode(page, "Figure");
  await page.evaluate(async () => {
    const F = window.__flux, fb = window.fig;
    window.__sourceRoot = F.get(F.shell.projectModel).root;
    window.__sourceSvg = (v, w = 200) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="120" data-v="${v}"><rect width="${w}" height="120" fill="${v}"/></svg>`;
    await fb.writeText(`${window.__sourceRoot}/plots/gate.svg`, window.__sourceSvg("red"));
    await fb.writeText(`${window.__sourceRoot}/plots/gate.fluxplot.json`, JSON.stringify({ schemaVersion: "0.1.0", axes: [], series: [], gateVersion: 1 }));
    F.fig.commit((p) => {
      p.assets.push({ id: "source-gate", name: "gate.svg", kind: "svg", path: "assets/source-gate.svg", naturalWidth: 200, naturalHeight: 120 });
      p.figures[0].elements.push({ id: "source-gate-plot", type: "plot", assetId: "source-gate", x: 10, y: 10, width: 100, height: 60, rotation: 0, source: { svgPath: "plots/gate.svg" }, overrides: {} });
    });
    F.io.reimportPlot("source-gate", window.__sourceSvg("red"), { schemaVersion: "0.1.0", axes: [], series: [], gateVersion: 1 });
    await F.lifecycle.flushAll();
  });
  eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.dirty)), false, "baseline is clean");
  await page.evaluate(()=>window.__flux.fig.commit(p=>{
    const e=p.figures[0].elements.find(e=>e.id==='source-gate-plot');e.x=70;e.overrides={figure:{opacity:.5}};
  }));
  await page.evaluate(async () => {
    await window.fig.writeText(`${window.__sourceRoot}/plots/gate.svg`, window.__sourceSvg("blue", 400));
    window.__fluxEmitFsChange({ subsystem: "plots", path: `${window.__sourceRoot}/plots/gate.svg` });
  });
  await page.waitForFunction(async () => (await window.fig.readText(`${window.__sourceRoot}/fig/assets/source-gate.svg`)).includes('data-v="blue"'));
  const accepted = await page.evaluate(async () => {
    const F = window.__flux;
    await F.lifecycle.flushAll();
    const paper = await F.bridge.readFigSource(window.__sourceRoot);
    const p = F.get(F.fig.project);
    return { dirty: F.get(F.fig.dirty), live: F.plot.plotDom.get("source-gate")?.getAttribute("data-v"), paper: atob(paper.assetData["source-gate"].split(",")[1]), width: p.figures[0].elements.find((e) => e.id === "source-gate-plot").width, natural: p.assets.find((a) => a.id === "source-gate").naturalWidth };
  });
  eq(accepted.live, "blue", "canvas accepts regenerated SVG");
  eq(accepted.paper.includes('data-v="blue"'), true, "Paper sees durably accepted source without unrelated edit");
  eq(accepted.dirty, false, "source edit persists through normal lifecycle");
  eq(accepted.width, 200, "deliberate placement scale preserved");
  eq(accepted.natural, 400, "asset metadata matches accepted source");
  await page.evaluate(()=>window.__flux.fig.undo());
  const afterUndo=await page.evaluate(()=>{const p=window.__flux.get(window.__flux.fig.project),e=p.figures[0].elements.find(e=>e.id==='source-gate-plot');return{x:e.x,width:e.width,natural:p.assets.find(a=>a.id==='source-gate').naturalWidth,overrides:e.overrides};});
  eq(afterUndo,{x:10,width:200,natural:400,overrides:{}},"Figure Undo restores the user edit while retaining accepted source scale");
  await page.evaluate(()=>window.__flux.fig.redo());
  const afterRedo=await page.evaluate(()=>{const p=window.__flux.get(window.__flux.fig.project),e=p.figures[0].elements.find(e=>e.id==='source-gate-plot');return{x:e.x,width:e.width,natural:p.assets.find(a=>a.id==='source-gate').naturalWidth,overrides:e.overrides};});
  eq(afterRedo,{x:70,width:200,natural:400,overrides:{figure:{opacity:.5}}},"Figure Redo restores overrides without double-scaling the accepted source");
  await page.evaluate(()=>{window.__flux.fig.undo();window.__flux.fig.undo();});
  eq(await page.evaluate(()=>{const p=window.__flux.get(window.__flux.fig.project);return p.assets.some(a=>a.id==='source-gate')||p.figures.some(f=>f.elements.some(e=>e.id==='source-gate-plot'));}),false,"source acceptance cannot resurrect an undone import");
  await page.evaluate(()=>{window.__flux.fig.redo();window.__flux.fig.redo();});
  await page.evaluate(async () => {
    await window.fig.writeText(`${window.__sourceRoot}/plots/gate.fluxplot.json`, JSON.stringify({ schemaVersion: "0.1.0", axes: [], series: [], gateVersion: 2 }));
    window.__fluxEmitFsChange({ subsystem: "plots", path: `${window.__sourceRoot}/plots/gate.fluxplot.json` });
  });
  await page.waitForFunction(() => window.__flux.get(window.__flux.plot.plotManifests)["source-gate"]?.gateVersion === 2);
  await page.evaluate(() => window.__flux.lifecycle.flushAll());
  eq(await page.evaluate(async () => JSON.parse(await window.fig.readText(`${window.__sourceRoot}/fig/assets/source-gate.fluxplot.json`)).gateVersion), 2, "manifest-only update persisted");
  await page.evaluate(async () => {
    await window.fig.remove(`${window.__sourceRoot}/plots/gate.fluxplot.json`);
    window.__fluxEmitFsChange({ subsystem: "plots", path: `${window.__sourceRoot}/plots/gate.fluxplot.json` });
  });
  await page.waitForFunction(async () => !(await window.fig.exists(`${window.__sourceRoot}/fig/assets/source-gate.fluxplot.json`)));
  eq(await page.evaluate(() => window.__flux.get(window.__flux.plot.plotManifests)["source-gate"]?.gateVersion), undefined, "removed semantic manifest no longer cached");
  await page.evaluate(async () => {
    await window.fig.writeText(`${window.__sourceRoot}/plots/gate.svg`, "<svg><rect");
    const service = await import("/src/lib/project/sourceBridge.ts");
    window.__badSourceResult = await service.syncProjectSources(window.__sourceRoot);
  });
  eq(await page.evaluate(() => window.__badSourceResult.statuses.find((s) => s.assetId === "source-gate").status), "error", "malformed source is visible as an error");
  eq(await page.evaluate(async () => (await window.fig.readText(`${window.__sourceRoot}/fig/assets/source-gate.svg`)).includes('data-v="blue"')), true, "malformed update retains last-good saved version");
  await page.evaluate(async () => {
    await window.fig.writeText(`${window.__sourceRoot}/plots/gate.svg`, window.__sourceSvg("green", 400));
    const F = window.__flux, service = await import("/src/lib/project/sourceBridge.ts");
    await service.setFigureSourceLink(window.__sourceRoot, { figureId: F.get(F.fig.project).figures[0].id, assetId: "source-gate", frozen: true });
    window.__frozenAsset = F.get(F.fig.project).figures[0].elements.find((e) => e.id === "source-gate-plot").assetId;
    await service.syncProjectSources(window.__sourceRoot);
  });
  eq(await page.evaluate(() => window.__frozenAsset !== "source-gate"), true, "freeze creates independent snapshot identity");
  eq(await page.evaluate(async () => (await window.fig.readText(`${window.__sourceRoot}/fig/assets/${window.__frozenAsset}.svg`)).includes('data-v="blue"')), true, "frozen placement retains the accepted version");
  await page.evaluate(async () => {
    const F = window.__flux;
    const old = F.get(F.fig.project).canvases[0].id;
    F.fig.commit((p) => { p.canvases.push({ id: "second-canvas", name: "Second" }); p.figures.push({ id: "second-figure", name: "Figure 2", family: "figure", number: 2, canvasId: "second-canvas", x: 0, y: 0, width: 200, height: 120, background: "#fff", elements: [] }); });
    await F.lifecycle.flushAll(); F.fig.deleteCanvas(old); await F.lifecycle.flushAll();
  });
  const numbers = await page.evaluate(async () => ({ live: window.__flux.get(window.__flux.fig.project).figures[0].number, paper: (await window.__flux.bridge.readFigSource(window.__sourceRoot)).indexFigures[0].number }));
  eq(numbers, { live: 1, paper: 1 }, "canvas deletion agrees live and in Paper immediately");
  eq(realErrors(page), [], "no browser console errors");
  console.log(`FIGURE SOURCE SYNC: PASS (${checks} assertions)`);
} finally { await browser.close(); }
