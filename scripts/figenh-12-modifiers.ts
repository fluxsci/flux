#!/usr/bin/env -S npx tsx
// Feature 12 — shape/line creation modifiers. Unit-checks applyDrawModifiers, then
// GUI: Shift draws a perfect square + snaps a line to 45°, Alt draws from the centre.
import { applyDrawModifiers } from "../src/lib/editing";
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 1) => Math.abs(a - b) <= t;

// --- unit ---
{
  let r = applyDrawModifiers("rect", { x: 0, y: 0 }, { x: 100, y: 60 }, true, false);
  assert(near(r.p1.x, 100) && near(r.p1.y, 100), `rect+Shift → square 100×100 (${r.p1.x},${r.p1.y})`);
  r = applyDrawModifiers("ellipse", { x: 0, y: 0 }, { x: 40, y: 90 }, true, false);
  assert(near(r.p1.x, 90) && near(r.p1.y, 90), `ellipse+Shift → circle (${r.p1.x},${r.p1.y})`);
  r = applyDrawModifiers("line", { x: 0, y: 0 }, { x: 150, y: 100 }, true, false);
  assert(near(Math.abs(r.p1.x), Math.abs(r.p1.y), 0.001), `line+Shift snaps to 45° (dx=dy: ${r.p1.x.toFixed(1)},${r.p1.y.toFixed(1)})`);
  r = applyDrawModifiers("line", { x: 0, y: 0 }, { x: 150, y: 8 }, true, false);
  assert(near(r.p1.y, 0, 0.001), `line+Shift near-horizontal → snaps to 0° (dy≈0: ${r.p1.y.toFixed(2)})`);
  r = applyDrawModifiers("rect", { x: 50, y: 50 }, { x: 80, y: 70 }, false, true);
  assert(near(r.p0.x, 20) && near(r.p0.y, 30) && near(r.p1.x, 80) && near(r.p1.y, 70), `rect+Alt → centred on start (${r.p0.x},${r.p0.y})-(${r.p1.x},${r.p1.y})`);
  r = applyDrawModifiers("rect", { x: 50, y: 50 }, { x: 80, y: 70 }, true, true);
  assert(near(r.p0.x, 20) && near(r.p0.y, 20) && near(r.p1.x, 80) && near(r.p1.y, 80), `rect+Shift+Alt → centred square (${r.p0.x},${r.p0.y})-(${r.p1.x},${r.p1.y})`);
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const reset = (tool: string) => page.evaluate((tool: string) => {
    const F = (window as any).__flux.fig;
    F.commit((p: any) => { const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0]; g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = []; });
    F.viewport.set({ panX: 80, panY: 120, zoom: 1 });
    F.activeTool.set(tool);
  }, tool);
  const first = () => page.evaluate(() => (window as any).__flux.figures().find((f: any) => f.id === "growth").elements[0]);
  const pt = (lx: number, ly: number) => page.evaluate(([lx, ly]: [number, number]) => {
    const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
    const g = (window as any).__flux.get((window as any).__flux.fig.project);
    const fig = g.figures.find((f: any) => f.id === "growth");
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
  }, [lx, ly] as [number, number]);

  // --- Shift → perfect square ---
  await reset("rect");
  await sleep(80);
  let a = await pt(150, 150), b = await pt(350, 230); // 200×80 drag
  await recordGif(page, "f12-square", async (frame: () => Promise<void>) => {
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await frame();
    await page.keyboard.down("Shift");
    await page.mouse.move(b.x, b.y, { steps: 10 }); await frame();
    await page.mouse.up(); await page.keyboard.up("Shift"); await frame();
  });
  await sleep(150);
  let e = await first();
  assert(e && e.type === "rect" && near(e.width, e.height) && near(e.width, 200), `Shift drew a square (${e.width}×${e.height})`);
  await shot(page, "f12-01-square");

  // --- Shift → line snaps to 45° ---
  await reset("line");
  await sleep(80);
  a = await pt(150, 150); b = await pt(300, 250); // dx150 dy100 → 45°
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up(); await page.keyboard.up("Shift");
  await sleep(150);
  e = await first();
  assert(e && e.type === "line" && near(Math.abs(e.x2), Math.abs(e.y2), 2), `Shift snapped the line to 45° (x2=${e.x2?.toFixed(0)} y2=${e.y2?.toFixed(0)})`);

  // --- Alt → draw from centre ---
  await reset("ellipse");
  await sleep(80);
  a = await pt(400, 250); b = await pt(460, 300); // start=centre, drag out 60×50
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up(); await page.keyboard.up("Alt");
  await sleep(150);
  e = await first();
  const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
  assert(e && e.type === "ellipse" && near(cx, 400, 2) && near(cy, 250, 2), `Alt drew from centre (centre=${cx.toFixed(0)},${cy.toFixed(0)}, expect 400,250)`);
  await shot(page, "f12-02-center");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF12 MODIFIERS ALL PASS" : `\nF12 MODIFIERS ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
