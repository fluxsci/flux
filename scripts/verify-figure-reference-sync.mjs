// Actual Paper adapter: a figure panel relabel preserves a live unsaved
// manuscript buffer and saves the correctly rewritten references durably.
import assert from "node:assert/strict";
import { launch, gotoApp, clickMode, realErrors } from "./lib/driver.mjs";
const { browser, page } = await launch();
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 1600 });
  await clickMode(page, "Figure");
  await page.evaluate(async () => {
    const F = window.__flux, ops = await import("/src/lib/ops.ts");
    window.__refRoot = F.get(F.shell.projectModel).root;
    F.fig.commit((p) => {
      const f = p.figures[0];
      window.__refFigureId = f.id; window.__refKey = f.referenceKey;
      window.__panelA = f.elements.find((e) => e.type === "text" && e.panelLabel && e.text === "a")?.id
        ?? ops.addPanelLabel(p, f.id, { text: "a", x: 8, y: 8, width: 20, height: 20 });
      window.__panelB = f.elements.find((e) => e.type === "text" && e.panelLabel && e.text === "b")?.id
        ?? ops.addPanelLabel(p, f.id, { text: "b", x: 38, y: 8, width: 20, height: 20 });
    });
    await F.lifecycle.flushAll();
  });
  await clickMode(page, "Paper");
  await page.waitForFunction(() => !!window.__fluxView);
  await page.evaluate(async () => {
    const view = window.__fluxView;
    window.__refOriginal = `# Reference gate\n\nSee @${window.__refKey}-a and @${window.__refKey}-b.\n`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: window.__refOriginal } });
    await window.__flux.lifecycle.flushAll();
  });
  const result = await page.evaluate(async () => {
    const F = window.__flux, view = window.__fluxView;
    const sentinel = "\nUnsaved scientific interpretation stays here.\n";
    view.dispatch({ changes: { from: view.state.doc.length, insert: sentinel } });
    const service = F.referenceSync;
    const live = service.readLiveFigureReferenceDocuments(window.__refRoot);
    const unsavedIsRegistered = live.some((d) => d.text.endsWith(sentinel));
    F.fig.commit((p) => {
      const f = p.figures.find((f) => f.id === window.__refFigureId);
      f.elements.find((e) => e.id === window.__panelA).text = "b";
      f.elements.find((e) => e.id === window.__panelB).text = "a";
    });
    await F.bridge.saveFigFrom(window.__refRoot);
    const doc = service.readLiveFigureReferenceDocuments(window.__refRoot).find((d) => d.text.includes("Reference gate"));
    const expected = `# Reference gate\n\nSee @${window.__refKey}-b and @${window.__refKey}-a.\n${sentinel}`;
    return { unsavedIsRegistered, text: view.state.doc.toString(), expected, liveAfter: service.readLiveFigureReferenceDocuments(window.__refRoot), disk: await window.fig.readText(`${window.__refRoot}/${doc?.path ?? "manuscript/main.qmd"}`), journal: await window.fig.exists(`${window.__refRoot}/.meta/figure-reference-update.json`), number: F.get(F.fig.project).figures.find((f) => f.id === window.__refFigureId).number };
  });
  if (!result.unsavedIsRegistered) console.log(JSON.stringify(result, null, 2));
  eq(result.unsavedIsRegistered, true, "Paper adapter exposes current unsaved text to project usages");
  eq(result.text, result.expected, "actual live Paper refs follow swapped panel IDs while preserving unsaved prose");
  eq(result.disk, result.expected, "actual Paper autosave durably persists the combined result");
  eq(result.journal, false, "completed GUI transaction clears recovery journal");
  eq(result.number, 1, "Paper content and reference order do not renumber the figure");
  eq(realErrors(page), [], "no browser console errors");
  console.log(`FIGURE REFERENCE SYNC GUI: PASS (${checks} assertions)`);
} finally { await browser.close(); }
