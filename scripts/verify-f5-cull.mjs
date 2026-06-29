// F5.2 culling + perf: a 1600-element scene renders only a viewport subset; small
// pans keep the set stable (quantization → cheap pan); a drag holds ~60fps.
import { launch, gotoApp, clickMode, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure");
await sleep(800);

const built = await page.evaluate(() => {
  const F = window.__flux.fig;
  F.commit((p) => {
    const fig = p.figures.find((f) => f.id === "growth");
    fig.width = 5000;
    fig.height = 5000;
    let id = 0;
    for (let r = 0; r < 40; r++)
      for (let c = 0; c < 40; c++)
        fig.elements.push({
          type: "rect", id: `gen-${id++}`, x: c * 120 + 10, y: r * 120 + 10,
          width: 90, height: 90, rotation: 0, fill: "#7aa2f7", stroke: "#333", strokeWidth: 1, cornerRadius: 2,
        });
  });
  F.viewport.set({ panX: 60, panY: 80, zoom: 1 });
  return { total: window.__flux.figures().find((f) => f.id === "growth").elements.length };
});
await sleep(400);
const rendered = await page.evaluate(() => document.querySelectorAll(".scene .el").length);

// Cheap pan: a small pan (< CULL_STEP) keeps the same visible set.
await page.evaluate(() => {
  const F = window.__flux; const v = F.get(F.fig.viewport);
  F.fig.viewport.set({ ...v, panX: v.panX - 60, panY: v.panY - 60 });
});
await sleep(150);
const afterSmall = await page.evaluate(() => document.querySelectorAll(".scene .el").length);

// Big pan: a different region renders.
await page.evaluate(() => {
  const F = window.__flux; const v = F.get(F.fig.viewport);
  F.fig.viewport.set({ ...v, panX: v.panX - 2600, panY: v.panY - 2000 });
});
await sleep(250);
const afterBig = await page.evaluate(() => document.querySelectorAll(".scene .el").length);

// Drag perf under load: rAF frame intervals during a real mouse drag.
await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 60, panY: 80, zoom: 1 }));
await sleep(250);
const c = await page.evaluate(() => {
  const vp = window.__flux.get(window.__flux.fig.viewport);
  const fig = window.__flux.figures().find((f) => f.id === "growth");
  const el = fig.elements.find((e) => e.id === "gen-0");
  const host = document.querySelector(".canvas-host").getBoundingClientRect();
  return { cx: host.left + vp.panX + (fig.x + el.x + el.width / 2) * vp.zoom, cy: host.top + vp.panY + (fig.y + el.y + el.height / 2) * vp.zoom };
});
await page.evaluate(() => {
  window.__frames = [];
  window.__s = true;
  const t = (ts) => { if (window.__s) { window.__frames.push(ts); requestAnimationFrame(t); } };
  requestAnimationFrame(t);
});
await page.mouse.move(c.cx, c.cy);
await page.mouse.down();
for (let i = 0; i < 45; i++) { await page.mouse.move(c.cx + i * 6, c.cy + i * 3); await sleep(16); }
await page.mouse.up();
const frames = await page.evaluate(() => { window.__s = false; return window.__frames; });
const ivals = frames.slice(1).map((t, i) => t - frames[i]).filter((d) => d > 0).sort((a, b) => a - b);
const med = ivals[Math.floor(ivals.length / 2)] || 0;
const p95 = ivals[Math.floor(ivals.length * 0.95)] || 0;
const max = ivals[ivals.length - 1] || 0;

console.log(JSON.stringify({
  total: built.total, rendered, culled: built.total - rendered,
  cheapPanStable: afterSmall === rendered, afterSmall, afterBig,
  drag: { frames: frames.length, medianMs: +med.toFixed(1), p95Ms: +p95.toFixed(1), maxMs: +max.toFixed(1) },
  errs: errors(page),
}, null, 2));
await browser.close();
