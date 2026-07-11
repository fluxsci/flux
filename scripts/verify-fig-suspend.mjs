// WS-1 Fix 7 (fortify plan) — hidden-pane suspension + figure-pane singleton.
//
// (a) With the Figure pane hidden behind Paper (W16 keep-alive), commits driven
//     through the store (the live-bridge path) must perform ZERO culling /
//     effState / sidebar-row recomputes (perf counters); reactivating the pane
//     recomputes ONCE and shows the edits, with viewport/selection/tool intact.
// (b) A second Figure pane request (splitWith / setFocusedMode) deterministically
//     FOCUSES the existing Figure pane instead of duplicating it.
//
//   node scripts/verify-fig-suspend.mjs      (dev server on :1420)

import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";
import { waitFor, waitForFrame } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-fig-suspend");

const { browser, page } = await launch({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  window.__name = window.__name || ((f) => f);
});
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 2500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!(window.__flux?.fig && document.querySelector(".canvas-host")), null, {
  label: "figure mode ready",
  timeout: 15000,
});

// Seed a figure, set a distinctive viewport + selection + tool.
const seeded = await page.evaluate(() => {
  const F = window.__flux.fig;
  let firstId = "";
  F.commit((p) => {
    const g = p.figures[0];
    g.x = 0;
    g.y = 0;
    g.width = 900;
    g.height = 500;
    g.elements = [];
    for (let i = 0; i < 40; i++) {
      const id = F.newId("rect");
      if (!firstId) firstId = id;
      g.elements.push({ type: "rect", id, x: (i % 10) * 85 + 10, y: Math.floor(i / 10) * 60 + 10, width: 70, height: 45, rotation: 0, fill: "#4385be", stroke: "#222222", strokeWidth: 1, cornerRadius: 0 });
    }
  });
  F.viewport.set({ panX: 77, panY: 66, zoom: 1.25 });
  F.selectOnly(firstId);
  F.activeTool.set("select");
  return { firstId, figId: window.__flux.figures()[0].id };
});
await waitForFrame(page);
await sleep(150);

h.section("(a) suspension while hidden");
// Switch the pane to Paper — Figure stays mounted (keep-alive) but inactive.
await clickMode(page, "Paper");
await waitFor(page, () => !!window.__fluxView, null, { label: "paper mode shown", timeout: 10000 });
await sleep(250);

const hidden = await page.evaluate(async ({ figId, firstId }) => {
  const F = window.__flux.fig;
  const P = window.__flux.perf;
  const before = { ...P };
  // 5 bridge-style edits while the Figure pane is hidden.
  for (let i = 0; i < 5; i++)
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === figId);
      const el = g?.elements.find((e) => e.id === firstId);
      if (el) el.x += 3;
    });
  await new Promise((r) => setTimeout(r, 120));
  return { vis: P.visRecomputes - before.visRecomputes, eff: P.effRecomputes - before.effRecomputes, rows: P.rowsRecomputes - before.rowsRecomputes };
}, seeded);
h.ok(
  hidden.vis === 0 && hidden.eff === 0 && hidden.rows === 0,
  `5 hidden-pane commits → 0 recomputes (vis ${hidden.vis}, eff ${hidden.eff}, rows ${hidden.rows})`,
);

// Reactivate: one recompute pass, edits visible, view state intact.
await clickMode(page, "Figure");
await waitForFrame(page);
await sleep(250);
const back = await page.evaluate(({ figId, firstId }) => {
  const F = window.__flux.fig;
  const P = window.__flux.perf;
  const vp = window.__flux.get(F.viewport);
  const sel = [...window.__flux.get(F.selection)];
  const tool = window.__flux.get(F.activeTool);
  const el = window.__flux.figures().find((f) => f.id === figId).elements.find((e) => e.id === firstId);
  // the moved element's rendered x (model x=10+15=25)
  return { vp, sel, tool, elX: el.x, counters: { ...P } };
}, seeded);
h.ok(back.elX === 25, `hidden edits landed in the model (x=${back.elX})`);
h.eq(back.vp, { panX: 77, panY: 66, zoom: 1.25 }, "viewport restored exactly");
h.eq(back.sel, [seeded.firstId], "selection restored exactly");
h.eq(back.tool, "select", "tool restored exactly");
const reactivated = await page.evaluate(async () => {
  const P = window.__flux.perf;
  const before = { ...P };
  await new Promise((r) => setTimeout(r, 200));
  return { vis: P.visRecomputes - before.visRecomputes };
});
h.ok(reactivated.vis === 0, `recompute settled after reactivation (no churn: ${reactivated.vis})`);

h.section("(b) figure-pane singleton");
const singleton = await page.evaluate(() => {
  const PS = window.__flux.panes;
  const get = window.__flux.get;
  // From a single Figure pane, request a second Figure pane.
  const before = get(PS.panes).length;
  PS.splitWith("figure");
  const afterSplit = get(PS.panes);
  // Split with library (allowed), then ask the focused (library) pane to become figure.
  PS.splitWith("library");
  const two = get(PS.panes);
  const figPane = two.find((p) => p.mode === "figure");
  PS.setFocusedMode("figure");
  const focused = get(PS.focusedPaneId);
  const modes = get(PS.panes).map((p) => p.mode);
  return {
    before,
    afterSplitCount: afterSplit.length,
    afterSplitModes: afterSplit.map((p) => p.mode),
    twoCount: two.length,
    focusedIsExistingFigure: focused === figPane?.id,
    modes,
  };
});
h.ok(
  singleton.before === 1 && singleton.afterSplitCount === 1 && singleton.afterSplitModes[0] === "figure",
  `splitWith("figure") from a Figure pane does not duplicate (${singleton.afterSplitCount} pane)`,
);
h.ok(singleton.twoCount === 2, "splitWith(library) still splits normally");
h.ok(
  singleton.focusedIsExistingFigure && singleton.modes.filter((m) => m === "figure").length === 1,
  `setFocusedMode("figure") focused the EXISTING Figure pane (modes: ${singleton.modes.join(",")})`,
);

const errs = realErrors(page);
await browser.close();
h.ok(errs.length === 0, errs.length ? `console errors: ${JSON.stringify(errs.slice(0, 4))}` : "no console errors");
await h.done();
