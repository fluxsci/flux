// W17 follow-up (FIG-1) — the rotate gesture is now flicker-free: it accumulates the angle and
// shows a transient transform on the live scene groups, committing the model ONCE on release,
// instead of mutate()-ing (and re-rendering the whole figure) every pointermove. This proves it
// deterministically by counting `project`-store emissions across a multi-move rotate drag:
//   old path → one emission per pointermove (N); new path → 0 during the drag, exactly 1 on release.
//   Run (dev server on :1420 must be up): node scripts/verify-w17-rotate-perf.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const D2R = Math.PI / 180;

const { browser, page } = await launch({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  window.__name = window.__name || ((f) => f);
});
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure");
await sleep(700);

// Seed a figure with a few hundred rects so the gesture is a genuine hot path, then select one.
const id = await page.evaluate(() => {
  const F = window.__flux.fig;
  let first = "";
  F.commit((p) => {
    const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
    g.x = 0;
    g.y = 0;
    g.width = 1200;
    g.height = 800;
    g.elements = [];
    for (let i = 0; i < 250; i++) {
      const rid = F.newId("rect");
      if (!first) first = rid;
      g.elements.push({
        type: "rect", id: rid, x: (i % 25) * 46 + 20, y: Math.floor(i / 25) * 74 + 20,
        width: 40, height: 60, rotation: 0, fill: "#4385be", stroke: "#222", strokeWidth: 2, cornerRadius: 0,
      });
    }
  });
  F.viewport.set({ panX: 40, panY: 80, zoom: 1 });
  F.selectOnly(first);
  return first;
});
await sleep(250);

const rotOf = () =>
  page.evaluate((i) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === i).rotation, id);
const handle = () =>
  page.evaluate((i) => {
    const g = window.__flux.get(window.__flux.fig.project);
    const vp = window.__flux.get(window.__flux.fig.viewport);
    let fig, el;
    for (const f of g.figures) { const e = f.elements.find((x) => x.id === i); if (e) { fig = f; el = e; break; } }
    const host = document.querySelector(".canvas-host").getBoundingClientRect();
    const left = host.left + vp.panX + (fig.x + el.x) * vp.zoom;
    const top = host.top + vp.panY + (fig.y + el.y) * vp.zoom;
    const w = el.width * vp.zoom, h = el.height * vp.zoom;
    return { cx: left + w / 2, cy: top + h / 2, hx: left + w / 2, hy: top - 20, r: h / 2 + 20 };
  }, id);

// Count project-store emissions from now on (subscribe fires once immediately → reset to 0).
await page.evaluate(() => {
  window.__pc = 0;
  window.__unsub = window.__flux.fig.project.subscribe(() => window.__pc++);
  window.__pc = 0;
});

const hc = await handle();
const targetDeg = -50; // press straight up (~-90°), drag to about +40°
const tx = hc.cx + hc.r * Math.cos(targetDeg * D2R);
const ty = hc.cy + hc.r * Math.sin(targetDeg * D2R);

await page.mouse.move(hc.hx, hc.hy);
await page.mouse.down();
const MOVES = 12;
for (let i = 1; i <= MOVES; i++) {
  await page.mouse.move(hc.hx + ((tx - hc.hx) * i) / MOVES, hc.hy + ((ty - hc.hy) * i) / MOVES);
}
const during = await page.evaluate(() => window.__pc);
await page.mouse.up();
await sleep(120);
const after = await page.evaluate(() => {
  const c = window.__pc;
  window.__unsub();
  return c;
});
const finalRot = await rotOf();
const errs = realErrors(page);
await browser.close();

console.log("FIG-1 — rotate is transient (no per-frame model mutation):");
assert(during === 0, `zero project commits across ${MOVES} pointermoves of the drag (got ${during})`);
assert(after === 1, `exactly one commit, on release (got ${after})`);
assert(Math.abs(finalRot) > 5, `the rotation actually applied on release (got ${finalRot}°)`);
if (errs.length) {
  console.error("\nW17 ROTATE PERF: FAIL — console errors:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
console.log("\nW17 ROTATE PERF: PASS");
