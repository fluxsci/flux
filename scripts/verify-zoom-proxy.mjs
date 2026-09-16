// 2026-09-16 — the zoom proxy (Canvas.svelte + interact/zoomProxy.ts): a
// ctrl-wheel zoom burst rides a raster of the scene on the compositor while the
// live scene is frozen and hidden; the settle fold brings the live scene back in
// one commit. Gated on the dense lazy-assets fixture against the dev server:
//   · at rest a warm snapshot exists (an <img> with a blob src, opacity 0.01);
//   · during the burst the proxy is live, its scale follows zoom, the scene's
//     <g> and inline transform do NOT change (frozen), main-thread task time per
//     tick stays small (the live zoom read ~20 ms/tick), no long task;
//   · after the settle the proxy retreats, the scene is back with the fold applied
//     (g scale == zoom, residual 1);
//   · a model edit re-keys the snapshot: a new blob URL lands at idle;
//   · a pan does NOT re-key it (world-space snapshot).
//   node scripts/verify-zoom-proxy.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor, sleep, APP_URL } from "./lib/driver.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!window.__flux?.fig && !!window.__flux?.bridge && !!document.querySelector(".canvas-host"), null, { timeout: 15000, label: "figure + dev handle" });
const checks = [];
const ok = (cond, msg) => { checks.push([!!cond, msg]); console.log(`${cond ? "✓" : "✗"} ${msg}`); };

// 8 panels ≈ 17.6k plot nodes: under the proxy's density cap (20k — above it a scene zooms live), and the
// owner's real figure is 14.8k, so this is the shape that must get the proxy.
const fx = await installDenseProject(page, { root: "/demo/zoom-proxy", figures: 1, panels: 8 });
await page.evaluate(async (root) => { await window.__flux.bridge.loadFigInto(root, "zoom-proxy"); }, fx.root);
await page.evaluate((id) => {
  const F = window.__flux.fig;
  const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
  F.activeCanvasId.set(fig.canvasId);
  F.activeFigureId.set(id);
  const zoom = 0.55;
  F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
}, fx.figIds[0]);
await waitFor(page, () => document.querySelectorAll("[data-editor-element-id] svg *").length > 8000, null, { timeout: 90000, label: "dense plot DOM mounted" });

// --- 1. a warm snapshot at rest -------------------------------------------------------
await waitFor(page, () => { const i = document.querySelector(".zoom-proxy"); return !!i && i.src.startsWith("blob:") && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000, label: "snapshot" });
const rest = await page.evaluate(() => { const i = document.querySelector(".zoom-proxy"); return { src: i.src, opacity: getComputedStyle(i).opacity, live: i.classList.contains("live"), w: i.naturalWidth, h: i.naturalHeight }; });
ok(rest.src.startsWith("blob:") && !rest.live && Number(rest.opacity) < 0.05, `at rest a warm snapshot exists (${rest.w}×${rest.h} image, opacity ${rest.opacity}, not live)`);

// --- 2. the burst rides the proxy ---------------------------------------------------------
const host = await page.$eval(".canvas-host", (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const cdp = await page.target().createCDPSession();
await cdp.send("Performance.enable");
const metric = async (name) => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === name)?.value ?? 0;
await page.evaluate(() => {
  const g = document.querySelector(".scene-svg > g"), sc = document.querySelector(".scene");
  window.__zp = { g0: g.getAttribute("transform"), st0: sc.style.transform, mid: [], lt: [], burstEnd: Infinity };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__zp.lt.push({ d: Math.round(e.duration), t: e.startTime }); }).observe({ type: "longtask" });
});
await page.mouse.move(host.x, host.y);
await page.keyboard.down("Control");
const t0 = await metric("TaskDuration");
const TICKS = 24;
for (let i = 0; i < TICKS; i++) {
  await page.mouse.wheel({ deltaY: -60 });
  await sleep(16);
  if (i === 8 || i === 16) await page.evaluate(() => {
    const g = document.querySelector(".scene-svg > g"), sc = document.querySelector(".scene"), p = document.querySelector(".zoom-proxy");
    const pm = p ? /matrix\(([-\d.e]+)/.exec(getComputedStyle(p).transform) : null;
    window.__zp.mid.push({ live: !!p?.classList.contains("live"), g: g.getAttribute("transform"), st: sc.style.transform, sceneOpacity: getComputedStyle(sc).opacity, proxyScale: pm ? Number(pm[1]) : null, zoom: window.__flux.get(window.__flux.fig.viewport).zoom });
  });
}
await page.keyboard.up("Control");
await page.evaluate(() => { window.__zp.burstEnd = performance.now(); });
const t1 = await metric("TaskDuration");
const perTick = ((t1 - t0) * 1000) / TICKS;
const mid = await page.evaluate(() => window.__zp);
ok(mid.mid.length === 2 && mid.mid.every((m) => m.live), "mid-burst the zoom proxy is live");
ok(mid.mid.every((m) => m.g === mid.g0 && m.st === mid.st0), "mid-burst the live scene is frozen (no <g> or wrapper transform change)");
ok(mid.mid.every((m) => m.sceneOpacity === "0"), "mid-burst the live scene is hidden (opacity 0)");
ok(mid.mid.every((m) => m.proxyScale !== null && Math.abs(m.proxyScale - m.zoom / 0.55) < 0.05 * (m.zoom / 0.55)), `mid-burst the proxy's scale follows zoom (${mid.mid.map((m) => m.proxyScale?.toFixed(3) + " vs " + (m.zoom / 0.55).toFixed(3)).join(", ")})`);
ok(perTick < 8, `main-thread task time per zoom tick over the dense figure: ${perTick.toFixed(1)} ms (<8; the live zoom read ~20)`);

// --- 3. settle: the fold, the scene back, the proxy retreats -------------------------------
await sleep(650);
const after = await page.evaluate(() => {
  const g = document.querySelector(".scene-svg > g"), sc = document.querySelector(".scene"), p = document.querySelector(".zoom-proxy");
  const z = window.__flux.get(window.__flux.fig.viewport).zoom;
  const gs = Number(/scale\(([-\d.e]+)/.exec(g.getAttribute("transform"))[1]);
  const m = /matrix\(([-\d.e]+)/.exec(getComputedStyle(sc).transform);
  return { live: !!p?.classList.contains("live"), gs, z, residual: m ? Number(m[1]) : null, opacity: getComputedStyle(sc).opacity, lt: window.__zp.lt, burstEnd: window.__zp.burstEnd };
});
ok(!after.live && after.opacity === "1", "after the settle the proxy retreats and the scene is visible again");
ok(Math.abs(after.gs - after.z) < 1e-9 && Math.abs(after.residual - 1) < 1e-9, `the fold landed: <g> scale ${after.gs} == zoom ${after.z}, residual ${after.residual}`);
// The settle FOLD repaints the whole scene at the new baked zoom once — the
// accepted "resolution catches up" cost; the gesture itself must stay clean.
const duringBurst = after.lt.filter((e) => e.t < after.burstEnd && e.d >= 50).map((e) => e.d);
ok(duringBurst.length === 0, `no long task ≥50 ms while the burst is live (${duringBurst.join(",") || "none"}; after it: ${after.lt.filter((e) => e.t >= after.burstEnd).map((e) => e.d).join(",") || "none"} = the fold)`);

// --- 4. re-keying: an edit refreshes the snapshot at idle; a pan does not ----------------
// Back to the rest zoom where the whole figure is mounted (at 4.8× culling is live and a
// pan legitimately changes the mounted set), then wait for the snapshot to settle.
await page.evaluate((id) => {
  const F = window.__flux.fig;
  const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
  const zoom = 0.55;
  F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
}, fx.figIds[0]);
await sleep(700);
await waitFor(page, () => { const i = document.querySelector(".zoom-proxy"); if (!i || !i.complete || !i.naturalWidth) return false; if (window.__zpSrc !== i.src) { window.__zpSrc = i.src; window.__zpSince = Date.now(); return false; } return Date.now() - window.__zpSince > 3000; }, null, { interval: 150, timeout: 30000, label: "snapshot settled" });
const src1 = await page.$eval(".zoom-proxy", (i) => i.src);
await page.evaluate(() => { const F = window.__flux; const v = F.get(F.fig.viewport); F.fig.viewport.set({ ...v, panX: v.panX - 120 }); });
await sleep(2500);
const srcAfterPan = await page.$eval(".zoom-proxy", (i) => i.src);
await page.evaluate(() => { const F = window.__flux.fig; F.commit((p) => { const fig = p.figures[0]; fig.elements.push({ type: "rect", id: "zp-mark", x: 20, y: 20, width: 80, height: 60, rotation: 0, fill: "#d62728", stroke: "#000", strokeWidth: 1, cornerRadius: 0 }); }); });
await waitFor(page, (s) => { const i = document.querySelector(".zoom-proxy"); return !!i && i.src !== s && i.complete && i.naturalWidth > 0; }, srcAfterPan, { timeout: 15000, label: "resnapshot" });
const src2 = await page.$eval(".zoom-proxy", (i) => i.src);
ok(srcAfterPan === src1 && src2 !== src1, `a pan keeps the world-space snapshot (${srcAfterPan === src1 ? "kept" : "CHANGED"}); an edit re-keys it and a fresh render lands at idle (${src2 !== src1 ? "renewed" : "NOT renewed"})`);

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);
await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-zoom-proxy", ok: failed === 0, checks: checks.length, failed })}`);
console.log(failed ? `verify-zoom-proxy: FAIL (${failed}/${checks.length})` : `verify-zoom-proxy: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
