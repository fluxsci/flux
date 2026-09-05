// Real renderer stores, Figure deletion/save, project watch dispatch, accepted
// fig bundles and visible Slide output. The memory bridge is project-local.
import assert from "node:assert/strict";
import { launch, gotoApp, clickMode, APP_URL, realErrors } from "./lib/driver.mjs";
const { browser, page } = await launch();
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; console.log("  ok:", label); };
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 200 });
  await clickMode(page, "Figure", { settle: 200 });
  await page.waitForFunction(() => window.__flux?.tenancy.storeTenant() === "figure");
  await page.evaluate(async () => {
    const F = window.__flux, fb = window.fig;
    const fixture = await import("/scripts/lib/orphanSourcesFixture.ts");
    const root = window.__orphanRoot = F.get(F.shell.projectModel).root;
    window.__orphanFixture = fixture;
    await F.lifecycle.flushById("figure");
    window.__orphanData = await fixture.writeOrphanSourcesFixture({ write: (rel, text) => fb.writeText(`${root}/${rel}`, text), read: (rel) => fb.readText(`${root}/${rel}`).catch(() => null) });
    await F.bridge.loadFigInto(root, "Deck source owners");
    const ops = await import("/src/lib/ops.ts");
    F.fig.commit((project) => ops.deleteFigure(project, "orphan-origin"));
    await F.lifecycle.flushById("figure");
    window.__orphanWatch = [];
    const originalWatch = fb.watchSourceFiles;
    fb.watchSourceFiles = async (root, scope, sources) => {
      window.__orphanWatch.push({ root, scope, sources });
      return originalWatch?.(root, scope, sources);
    };
  });
  eq(await page.evaluate(async () => {
    const index = JSON.parse(await window.fig.readText(window.__orphanRoot + "/fig/index.json"));
    return { deleted: !index.figures.some((f) => f.id === "orphan-origin"), retained: window.__orphanData.ids.every((id) => index.assets.some((a) => a.id === id)) };
  }), { deleted: true, retained: true }, "Figure deletion persists while preserving the saved deck's asset dependencies");
  await clickMode(page, "Slide", { settle: 200 });
  await page.waitForFunction(() => window.__flux.slide.currentDeck()?.id === "orphan-talk" && document.querySelector('[data-editor-element-id="orphan-live"] [data-version="1"]'));
  await page.evaluate(async () => {
    const { orphanSvg, orphanManifest } = window.__orphanFixture, root = window.__orphanRoot;
    for (const id of window.__orphanData.ids) {
      await window.fig.writeText(`${root}/plots/${id}.svg`, orphanSvg(2, 400));
      await window.fig.writeText(`${root}/plots/${id}.fluxplot.json`, orphanManifest(2));
    }
    window.__fluxEmitFsChange({ subsystem: "plots", path: `${root}/plots/orphan-live.svg` });
  });
  await page.waitForFunction(() => !!document.querySelector('[data-editor-element-id="orphan-live"] [data-version="2"]'));
  await page.waitForFunction(async () => JSON.parse(await window.fig.readText(`${window.__orphanRoot}/slides/orphan-talk/deck.json`)).slides[0].elements[0].width === 200);
  const snapshot = await page.evaluate(async () => {
    const F = window.__flux, root = window.__orphanRoot;
    const disk = JSON.parse(await window.fig.readText(`${root}/slides/orphan-talk/deck.json`));
    const index = JSON.parse(await window.fig.readText(`${root}/fig/index.json`));
    return { versions: window.__orphanData.ids.map((id) => F.plot.plotDom.get(id)?.getAttribute("data-version")), widths: F.slide.currentDeck().slides[0].elements.map((e) => e.width),
      savedWidths: disk.slides[0].elements.map((e) => e.width), beats: disk.slides[0].beats, expectedBeats: window.__orphanData.deck.slides[0].beats,
      fakeFigures: index.figures.some((f) => f.id.startsWith("deck:")), intrinsic: index.assets.find((a) => a.id === "orphan-live").naturalWidth,
      targetVersion: JSON.parse(await window.fig.readText(`${root}/fig/assets/orphan-target.fluxplot.json`)).version,
      watched: window.__orphanWatch.filter((w) => w.scope === "fig").flatMap((w) => w.sources).map((s) => s.svgPath) };
  });
  eq(snapshot.versions, ["2", "1", "2"], "source watch refreshes visible and animation-only dependencies while retaining frozen bytes");
  eq(snapshot.widths, [200, 100], "live Slide sizing follows accepted intrinsic growth and preserves frozen size");
  eq(snapshot.savedWidths, [200, 100], "orphan source resize persists before any unrelated edit");
  eq(snapshot.beats, snapshot.expectedBeats, "source watch preserves authored animations");
  eq([snapshot.fakeFigures, snapshot.intrinsic, snapshot.targetVersion], [false, 400, 2], "only accepted metadata and bundles persist, with no synthetic Figure");
  eq(snapshot.watched.some((p) => p.endsWith("/plots/orphan-live.svg")) && snapshot.watched.some((p) => p.endsWith("/plots/orphan-target.svg")), true, "native watch registration includes orphan and animation-only links");
  await page.evaluate(async () => {
    const root = window.__orphanRoot;
    await window.fig.remove(`${root}/plots/orphan-live.svg`);
    window.__fluxEmitFsChange({ subsystem: "plots", path: `${root}/plots/orphan-live.svg` });
  });
  await page.waitForFunction(() => window.__flux.get(window.__flux.toast.toasts).some((t) => t.msg === "Slide source missing" && t.detail?.includes("orphan-live")));
  eq(await page.evaluate(() => !!document.querySelector('[data-editor-element-id="orphan-live"] [data-version="2"]')), true, "missing orphan source surfaces a Slide error while keeping accepted pixels");
  await page.evaluate(async () => {
    const root = window.__orphanRoot, F = window.__flux;
    await window.fig.writeText(`${root}/plots/orphan-live.svg`, window.__orphanFixture.orphanSvg(2, 400));
    const other = structuredClone(F.slide.currentDeck()); other.id = "orphan-conflict";
    other.slides[0].elements.find((e) => e.id === "orphan-live").source = { svgPath: "plots/other.svg", frozen: true };
    await window.fig.writeText(`${root}/plots/other.svg`, window.__orphanFixture.orphanSvg(3, 800));
    await window.fig.writeText(`${root}/slides/orphan-conflict/deck.json`, JSON.stringify(other));
    window.__fluxEmitFsChange({ subsystem: "plots", path: `${root}/plots/orphan-live.svg` });
  });
  await page.waitForFunction(() => window.__flux.get(window.__flux.toast.toasts).some((t) => t.msg === "Slide source update failed" && t.detail?.includes("conflicting source links")));
  eq(await page.evaluate(() => !!document.querySelector('[data-editor-element-id="orphan-live"] [data-version="2"]')), true, "conflicting saved-deck links surface a Slide error without replacing accepted pixels");
  eq(realErrors(page), [], "renderer console remains clean");
  console.log(`ORPHAN SLIDE SOURCES GUI: PASS (${checks} assertions)`);
} finally { await browser.close(); }
