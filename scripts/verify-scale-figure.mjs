// WS-7.1 (fortify plan) — figure-editor SCALE GATE.
//
// Two metric classes:
//   · STRUCTURAL budgets (primary, machine-independent): commits-per-drag,
//     rendered layer rows, mounted-plot / SVG-node counts, plot signature()
//     invocations on an unrelated commit. These pin the MECHANISM (what work
//     runs), cannot flake on a slow runner.
//   · TIMING ratios (secondary, relative-delta): heavy-vs-control on the SAME
//     page (pattern from verify-writer-latency-inp.mjs). Absolute ms live only
//     in the JSON artifact (test-results/scale-figure.json) for the reference
//     machine — never asserted in CI.
//
// Profiles: (i) 1,600 mixed elements (fortify-plan §1.1 shape), (ii) 5,000
// elements (the Layers-sidebar shape), (iii) dense semantic plots (≥150 mounted
// — feeds the WS-11 trigger decision; recorded, not gated).
//
// Budgets marked "post WS-1" start loose/recording and tighten in the WS-1 PRs.
//
//   node scripts/verify-scale-figure.mjs      (dev server on :1420)

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor, waitForFrame } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

// ---- budgets --------------------------------------------------------------
// Tightening schedule (fortify plan §7.1/§WS-1): nudgeRatio 8 → 2 in the final
// WS-1 PR; layerRowsMax null → 150 post WS-1 Fix 6; sigCallsUnrelatedMax
// null → 0 post WS-1 Fix 1 (null = record only / skip if uninstrumented).
const BUDGET = {
  nudgeRatio: Number(process.env.FLUX_SCALE_NUDGE_RATIO || 8), // → 2 in the final WS-1 PR
  snapshotRatio: 10,
  panRatio: 2.5,
  // Measured 2026-07-10 pre-WS-1: ~20× (per-pointermove frame cost ~80ms at
  // 1600 elements even though the move gesture is commit-transient — an O(N)
  // per-move recompute WS-1 must remove). → 3 in the final WS-1 PR.
  dragRatio: 25,
  commitsPerDragMax: 1,
  layerRowsMax: null, // → 150 with WS-1 Fix 6
  sigCallsUnrelatedMax: null, // → 0 with WS-1 Fix 1
};

const h = harness("verify-scale-figure");
const quant = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const round1 = (n) => Math.round(n * 10) / 10;
// Ratio with a floor on the denominator: a 0.2ms control makes raw ratios noise.
const ratio = (heavy, control, floorMs = 4) => heavy / Math.max(control, floorMs);

const { browser, page } = await launch({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  window.__name = window.__name || ((f) => f);
});
await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!(window.__flux?.fig && document.querySelector(".canvas-host")), null, {
  label: "figure mode + dev handle",
  timeout: 15000,
});

// ---- in-page probes ---------------------------------------------------------

/** Replace figure 0's elements with N synthetic ones (2:1 rect:text, §1.1 shape). */
async function seed(n) {
  await page.evaluate((N) => {
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures[0];
      g.x = 0;
      g.y = 0;
      g.width = 1220;
      g.height = 860;
      g.elements = [];
      for (let i = 0; i < N; i++) {
        if (i % 3 === 2)
          g.elements.push({
            type: "text", id: "sc-t" + i, x: (i % 40) * 30 + 10, y: Math.floor(i / 40) * 20 + 12,
            width: 26, height: 12, rotation: 0, text: "t" + i, fontFamily: "Inter", fontSize: 9,
            fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
          });
        else
          g.elements.push({
            type: "rect", id: "sc-r" + i, x: (i % 40) * 30 + 12, y: Math.floor(i / 40) * 20 + 12,
            width: 24, height: 14, rotation: 0, fill: "#4385be", stroke: "#222222", strokeWidth: 1, cornerRadius: 0,
          });
      }
    });
    F.viewport.set({ panX: 30, panY: 50, zoom: 0.9 });
    F.clearSelection?.();
  }, n);
  await waitForFrame(page);
  await sleep(120); // let text layout / derived state settle
}

/** commit→paint for a 1-element nudge, N samples; longtasks captured. */
const nudgeProbe = (samples) =>
  page.evaluate(async (S) => {
    const F = window.__flux.fig;
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let longTasks = 0;
    let ltMax = 0;
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        longTasks++;
        ltMax = Math.max(ltMax, e.duration);
      }
    });
    po.observe({ entryTypes: ["longtask"] });
    const times = [];
    const syncTimes = [];
    for (let i = 0; i < S; i++) {
      const t0 = performance.now();
      F.commit((p) => {
        p.figures[0].elements[0].x += i % 2 ? 1 : -1;
      });
      syncTimes.push(performance.now() - t0);
      await raf2();
      times.push(performance.now() - t0);
    }
    await new Promise((r) => setTimeout(r, 60));
    po.disconnect();
    return { times: times.slice(3), syncTimes: syncTimes.slice(3), longTasks, ltMax }; // drop 3 warmup
  }, samples);

/** beginGesture (undo snapshot) cost, median of N. */
const snapshotProbe = (samples = 7) =>
  page.evaluate((S) => {
    const F = window.__flux.fig;
    const times = [];
    for (let i = 0; i < S; i++) {
      const t0 = performance.now();
      F.beginGesture();
      times.push(performance.now() - t0);
      F.rollbackGesture(); // unwind — state unchanged
    }
    return times;
  }, samples);

/** Pan sweep: viewport.set per frame, rAF deltas. */
const panProbe = (steps = 48) =>
  page.evaluate(async (S) => {
    const F = window.__flux.fig;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    await raf();
    const deltas = [];
    let last = performance.now();
    for (let i = 0; i < S; i++) {
      const vp = window.__flux.get(F.viewport);
      F.viewport.set({
        panX: vp.panX + (i % 2 ? 7 : -7),
        panY: vp.panY + (i % 4 === 3 ? 3 : 0),
        zoom: i % 12 === 11 ? (vp.zoom > 0.75 ? 0.7 : 0.9) : vp.zoom,
      });
      await raf();
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    return deltas.slice(2);
  }, steps);

/** Real mouse drag on the first element: commits during/after + move→paint deltas. */
async function dragProbe(moves = 14) {
  const start = await page.evaluate(() => {
    const F = window.__flux.fig;
    const g = window.__flux.get(F.project).figures[0];
    const el = g.elements[0];
    F.selectOnly(el.id);
    const vp = window.__flux.get(F.viewport);
    const host = document.querySelector(".canvas-host").getBoundingClientRect();
    window.__scaleDrag = { commits: 0, moveToPaint: [] };
    window.__scaleDragUnsub?.();
    window.__scaleDragUnsub = F.project.subscribe(() => window.__scaleDrag.commits++);
    window.__scaleDrag.commits = 0; // subscribe fires once immediately
    if (!window.__scaleMoveHook) {
      window.__scaleMoveHook = true;
      window.addEventListener(
        "pointermove",
        () => {
          if (!window.__scaleDragActive) return;
          const t = performance.now();
          requestAnimationFrame(() => window.__scaleDrag.moveToPaint.push(performance.now() - t));
        },
        { capture: true },
      );
    }
    window.__scaleDragActive = true;
    return {
      x: host.left + vp.panX + (g.x + el.x + el.width / 2) * vp.zoom,
      y: host.top + vp.panY + (g.y + el.y + el.height / 2) * vp.zoom,
    };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= moves; i++) {
    await page.mouse.move(start.x + i * 6, start.y + i * 3);
    await sleep(16);
  }
  const during = await page.evaluate(() => window.__scaleDrag.commits);
  await page.mouse.up();
  await sleep(150);
  return page.evaluate((d) => {
    window.__scaleDragActive = false;
    const r = {
      during: d,
      total: window.__scaleDrag.commits,
      moveToPaint: window.__scaleDrag.moveToPaint.slice(1),
    };
    window.__scaleDragUnsub?.();
    // undo the drag so later probes see unchanged geometry
    window.__flux.fig.undo();
    return r;
  }, during);
}

// ---- run: control → 1600 → 5000 → dense plots -------------------------------

h.section("control profile (5 elements)");
await seed(5);
const ctl = {
  nudge: await nudgeProbe(30),
  snap: await snapshotProbe(),
  pan: await panProbe(),
  drag: await dragProbe(),
};
h.ok(ctl.nudge.times.length >= 20, `control nudge samples captured (${ctl.nudge.times.length})`);

h.section("heavy profile (1,600 mixed elements — §1.1 shape)");
await seed(1600);
const heavy = {
  nudge: await nudgeProbe(30),
  snap: await snapshotProbe(),
  pan: await panProbe(),
  drag: await dragProbe(),
};

const nudgeCtlP95 = quant(ctl.nudge.times, 0.95);
const nudgeHeavyP95 = quant(heavy.nudge.times, 0.95);
const snapCtlMed = quant(ctl.snap, 0.5);
const snapHeavyMed = quant(heavy.snap, 0.5);
const panCtlP95 = quant(ctl.pan, 0.95);
const panHeavyP95 = quant(heavy.pan, 0.95);
const dragCtlP95 = quant(ctl.drag.moveToPaint, 0.95);
const dragHeavyP95 = quant(heavy.drag.moveToPaint, 0.95);

console.log(
  `  · nudge commit→paint p95: ctl ${round1(nudgeCtlP95)}ms vs 1600-el ${round1(nudgeHeavyP95)}ms (sync ctl ${round1(quant(ctl.nudge.syncTimes, 0.5))} / heavy ${round1(quant(heavy.nudge.syncTimes, 0.5))}); longtasks ${heavy.nudge.longTasks} (max ${round1(heavy.nudge.ltMax)}ms)`,
);
console.log(`  · beginGesture median: ctl ${round1(snapCtlMed)}ms vs ${round1(snapHeavyMed)}ms`);
console.log(`  · pan rAF-delta p95: ctl ${round1(panCtlP95)}ms vs ${round1(panHeavyP95)}ms`);
console.log(`  · drag move→paint p95: ctl ${round1(dragCtlP95)}ms vs ${round1(dragHeavyP95)}ms`);

h.ok(
  ratio(nudgeHeavyP95, nudgeCtlP95) < BUDGET.nudgeRatio,
  `1-element nudge p95 heavy/control ${round1(ratio(nudgeHeavyP95, nudgeCtlP95))}× < ${BUDGET.nudgeRatio}×`,
);
h.ok(
  ratio(snapHeavyMed, snapCtlMed, 0.5) < BUDGET.snapshotRatio,
  `beginGesture snapshot heavy/control ${round1(ratio(snapHeavyMed, snapCtlMed, 0.5))}× < ${BUDGET.snapshotRatio}×`,
);
h.ok(
  ratio(panHeavyP95, panCtlP95, 8) < BUDGET.panRatio,
  `pan sweep rAF-delta p95 heavy/control ${round1(ratio(panHeavyP95, panCtlP95, 8))}× < ${BUDGET.panRatio}×`,
);
h.ok(
  ratio(dragHeavyP95, dragCtlP95) < BUDGET.dragRatio,
  `drag move→paint p95 heavy/control ${round1(ratio(dragHeavyP95, dragCtlP95))}× < ${BUDGET.dragRatio}×`,
);
h.ok(
  ctl.drag.during === 0 && ctl.drag.total === 1 && heavy.drag.during === 0 && heavy.drag.total === 1,
  `move gesture is transient: commits during drag = 0, on release = 1 (ctl ${ctl.drag.during}/${ctl.drag.total}, heavy ${heavy.drag.during}/${heavy.drag.total})`,
);

h.section("sidebar profile (5,000 elements)");
const t5k0 = Date.now();
await seed(5000);
const seedMs5k = Date.now() - t5k0;
const sidebar = await page.evaluate(async () => {
  const F = window.__flux.fig;
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const rows = document.querySelectorAll("li.layer").length;
  const t0 = performance.now();
  F.commit((p) => {
    p.figures[0].elements[0].x += 1;
  });
  await raf2();
  const editMs = performance.now() - t0;
  return { rows, editMs, sceneNodes: document.querySelectorAll(".canvas-host svg *").length };
});
console.log(
  `  · 5k seed→settle ${seedMs5k}ms; li.layer rows ${sidebar.rows}; 1-el edit→paint ${round1(sidebar.editMs)}ms; scene nodes ${sidebar.sceneNodes}`,
);
if (BUDGET.layerRowsMax == null) h.ok(true, `layer rows recorded (${sidebar.rows}) — budget activates with WS-1 Fix 6`);
else h.ok(sidebar.rows <= BUDGET.layerRowsMax, `rendered li.layer rows ${sidebar.rows} ≤ ${BUDGET.layerRowsMax} at 5k elements`);

// Unrelated-commit plot signature() count (WS-1 Fix 1 instrumentation).
const sig = await page.evaluate(async () => {
  const P = window.__flux.plot;
  if (!P.sigCalls) return { present: false };
  const before = P.sigCalls.n;
  window.__flux.fig.commit((p) => {
    p.figures[0].elements[0].x += 1;
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { present: true, calls: P.sigCalls.n - before };
});
if (!sig.present) h.ok(BUDGET.sigCallsUnrelatedMax == null, "plot signature() counter not instrumented yet (arrives with WS-1 Fix 1)");
else h.ok(sig.calls <= BUDGET.sigCallsUnrelatedMax, `plot signature() calls on unrelated commit: ${sig.calls} ≤ ${BUDGET.sigCallsUnrelatedMax}`);

h.section("dense-plot profile (records data for the WS-11 trigger decision)");
const plotSvg = readFileSync("fixtures/plots/growth.svg", "utf8");
const dense = await page.evaluate(
  async ({ svg, COUNT }) => {
    const F = window.__flux.fig;
    const P = window.__flux.plot;
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let longTasks = 0;
    let ltMax = 0;
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        longTasks++;
        ltMax = Math.max(ltMax, e.duration);
      }
    });
    po.observe({ entryTypes: ["longtask"] });
    for (let i = 0; i < COUNT; i++) P.cachePlot("scale-plot-" + i, svg);
    const t0 = performance.now();
    F.commit((p) => {
      const g = p.figures[0];
      g.width = 1790;
      g.height = 920;
      g.elements = [];
      for (let i = 0; i < COUNT; i++)
        g.elements.push({
          type: "plot", id: "sc-p" + i, assetId: "scale-plot-" + i,
          x: (i % 16) * 111 + 4, y: Math.floor(i / 16) * 91 + 4, width: 104, height: 84, rotation: 0,
        });
    });
    F.viewport.set({ panX: 5, panY: 5, zoom: 0.45 });
    await raf2();
    const mountMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
    const mounted = document.querySelectorAll(".canvas-host svg svg").length;
    const svgNodes = document.querySelectorAll(".canvas-host svg *").length;
    // pan-mount burst: jump half a screen and back
    const t1 = performance.now();
    const vp = window.__flux.get(F.viewport);
    F.viewport.set({ ...vp, panX: vp.panX - 700 });
    await raf2();
    F.viewport.set({ ...vp });
    await raf2();
    const panMountMs = performance.now() - t1;
    await new Promise((r) => setTimeout(r, 80));
    po.disconnect();
    return { mounted, svgNodes, mountMs, panMountMs, longTasks, ltMax };
  },
  { svg: plotSvg, COUNT: 160 },
);
console.log(
  `  · ${dense.mounted} mounted semantic plots; ${dense.svgNodes} scene SVG nodes; mount burst ${round1(dense.mountMs)}ms; pan-mount ${round1(dense.panMountMs)}ms; longtasks ${dense.longTasks} (max ${round1(dense.ltMax)}ms)`,
);
h.ok(dense.mounted >= 150, `dense-plot profile mounted ${dense.mounted} ≥ 150 semantic plots (WS-11 evidence recorded, not gated)`);

// ---- artifact + errors -------------------------------------------------------
const errs = realErrors(page);
await browser.close();
h.ok(errs.length === 0, errs.length ? `console errors: ${JSON.stringify(errs.slice(0, 4))}` : "no console errors");

let appRev = "unknown";
try {
  appRev = execSync("git rev-parse --short HEAD").toString().trim();
} catch {}
mkdirSync("test-results", { recursive: true });
writeFileSync(
  path.join("test-results", "scale-figure.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      appRev,
      node: process.versions.node,
      budgets: BUDGET,
      control: {
        nudgeP95: nudgeCtlP95, nudgeMed: quant(ctl.nudge.times, 0.5), snapMed: snapCtlMed,
        panP95: panCtlP95, dragMoveToPaintP95: dragCtlP95,
      },
      heavy1600: {
        nudgeP95: nudgeHeavyP95, nudgeMed: quant(heavy.nudge.times, 0.5), snapMed: snapHeavyMed,
        panP95: panHeavyP95, dragMoveToPaintP95: dragHeavyP95,
        nudgeLongTasks: heavy.nudge.longTasks, nudgeLongTaskMax: heavy.nudge.ltMax,
      },
      sidebar5000: sidebar,
      seedMs5k,
      densePlots: dense,
      sigCounter: sig,
    },
    null,
    2,
  ) + "\n",
);
console.log("  · wrote test-results/scale-figure.json");

await h.done();
