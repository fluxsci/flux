// 2026-09-16 — Figure input hygiene: the three mechanisms that made a pan cost
// main-thread time it never needed, pinned on the dense lazy-assets fixture
// (14 plots, ~30k svg nodes) against the dev server on :1420:
//   1. the scene transform rides the compositor drive while a wheel burst is
//      live (a paused transform animation on .scene) and is gone at rest —
//      a style write per tick made Chromium re-layerize the whole scene every
//      frame (6.7 ms/frame; scripts/perf/layerize-lab.mjs);
//   2. a DOM selection left in a hidden pane (type in Paper, switch to Figure)
//      is dropped, never re-canonicalized through the scene twice per frame;
//   3. a wheel burst mounts/unmounts nothing (cull frozen while hot, hysteresis
//      keeps a screen's worth of scrolled-away content mounted).
// Budgets are structural (animation present/absent, no selection, stable node
// count, no long task) plus one ratio-free CDP number: TaskDuration per wheel
// tick under a generous bound. Fails on the pre-fix code (per-frame layerize +
// selection walk read ~40 ms per tick here).
//   node scripts/verify-figure-input-hygiene.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor, sleep, APP_URL } from "./lib/driver.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2500 });
const checks = [];
const ok = (cond, msg) => { checks.push([!!cond, msg]); console.log(`${cond ? "✓" : "✗"} ${msg}`); };

// --- 1. a caret in Paper, then Figure: the hidden pane keeps no DOM selection ----------
await waitFor(page, () => !!document.querySelector(".cm-editor .cm-content"), null, { timeout: 15000, label: "paper editor" });
await page.click(".cm-editor .cm-content");
await page.keyboard.type("x");
await sleep(150);
const before = await page.evaluate(() => { const s = document.getSelection(); return { ranges: s.rangeCount, inCm: !!s.anchorNode && !!(s.anchorNode.parentElement ?? s.anchorNode).closest?.(".cm-content") }; });
ok(before.ranges === 1 && before.inCm, `typing in Paper leaves a caret in the editor (ranges ${before.ranges})`);
await clickMode(page, "Figure");
await waitFor(page, () => !!document.querySelector(".figure-mode .canvas-host") && !!document.querySelector("[data-editor-element-id]"), null, { timeout: 15000, label: "figure canvas" });
await sleep(200);
const after = await page.evaluate(() => { const s = document.getSelection(); const a = s.anchorNode; const el = a ? (a instanceof Element ? a : a.parentElement) : null; return { ranges: s.rangeCount, inHidden: !!el?.closest(".mc.hidden") }; });
ok(!after.inHidden, `switching to Figure drops the selection left in the hidden Paper pane (ranges ${after.ranges}, inHidden ${after.inHidden})`);
await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); // undo the typed character (paper doc untouched)

// --- 2. the dense figure ---------------------------------------------------------------
await waitFor(page, () => !!window.__flux?.fig && !!window.__flux?.bridge, null, { label: "dev handle" });
const fx = await installDenseProject(page, { root: "/demo/input-hygiene", figures: 1 });
await page.evaluate(async (root) => { await window.__flux.bridge.loadFigInto(root, "input-hygiene"); }, fx.root);
await page.evaluate((id) => {
  const F = window.__flux.fig;
  const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
  F.activeCanvasId.set(fig.canvasId);
  F.activeFigureId.set(id);
  const zoom = 0.55;
  F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
}, fx.figIds[0]);
await waitFor(page, () => document.querySelectorAll("[data-editor-element-id] svg *").length > 10000, null, { timeout: 90000, label: "dense plot DOM mounted" });
await sleep(1500); // parse queue drained, scene cooled
const host = await page.$eval(".figure-mode .canvas-host", (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const nodesBefore = await page.evaluate(() => document.querySelectorAll("[data-editor-element-id] svg *").length);
const restAnims = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.classList?.contains("scene")).length);
ok(restAnims === 0, `at rest the scene carries no transform animation (${restAnims})`);

const cdp = await page.target().createCDPSession();
await cdp.send("Performance.enable");
const metric = async (name) => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === name)?.value ?? 0;
await page.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: "longtask" }); });
await page.mouse.move(host.x, host.y);
const t0 = await metric("TaskDuration");
const TICKS = 36;
let hotAnims = 0;
for (let i = 0; i < TICKS; i++) {
  await page.mouse.wheel({ deltaY: i < TICKS / 2 ? 40 : -40 });
  await sleep(16);
  if (i === 6) hotAnims = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.classList?.contains("scene")).length);
}
await sleep(60);
const t1 = await metric("TaskDuration");
const perTickMs = ((t1 - t0) * 1000) / TICKS;
const nodesDuring = await page.evaluate(() => document.querySelectorAll("[data-editor-element-id] svg *").length);
const lt = await page.evaluate(() => window.__lt);
ok(hotAnims === 1, `while the burst is live the scene transform rides ONE paused animation (${hotAnims})`);
ok(nodesDuring === nodesBefore, `a wheel burst mounts and unmounts nothing (${nodesBefore} → ${nodesDuring} plot nodes)`);
ok(lt.filter((d) => d >= 50).length === 0, `no long task ≥50 ms across ${TICKS} wheel ticks (${lt.join(",") || "none"})`);
ok(perTickMs < 12, `main-thread task time per wheel tick over ${nodesBefore} plot nodes: ${perTickMs.toFixed(1)} ms (<12; the pre-fix code read ~56)`);
await sleep(500); // SCENE_COOL_MS + margin
const coolAnims = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.classList?.contains("scene")).length);
ok(coolAnims === 0, `the animation is gone once the scene cools (${coolAnims})`);
const restTransform = await page.evaluate(() => { const v = window.__flux.get(window.__flux.fig.viewport); const m = /matrix\(([-\d.e]+), [-\d.e]+, [-\d.e]+, [-\d.e]+, ([-\d.e]+), ([-\d.e]+)\)/.exec(getComputedStyle(document.querySelector(".scene")).transform); return m ? { ok: Math.abs(+m[2] - v.panX) < 0.01 && Math.abs(+m[3] - v.panY) < 0.01, m: m[0] } : { ok: false, m: null }; });
ok(restTransform.ok, `at rest the plain style holds the viewport pan exactly (${restTransform.m})`);

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);
await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-figure-input-hygiene", ok: failed === 0, checks: checks.length, failed })}`);
console.log(failed ? `verify-figure-input-hygiene: FAIL (${failed}/${checks.length})` : `verify-figure-input-hygiene: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
