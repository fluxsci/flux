#!/usr/bin/env -S npx tsx
// Feature 11 — rulers + guides + grid/pixel snapping (GUI). Toggles rulers, drags
// guides out of both rulers, snaps an element to a guide, snaps to the grid, rounds
// to pixels on commit, and deletes a guide by dragging it off the figure.
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 1.5) => Math.abs(a - b) <= t;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const setS = (patch: Record<string, unknown>) => page.evaluate((p: Record<string, unknown>) => (window as any).__flux.settings.update((s: any) => ({ ...s, ...p })), patch);
  await setS({ showRulers: false, showGrid: false, snapGrid: false, snapPixel: false, gridSize: 50 });

  const seed = () => page.evaluate(() => {
    const F = (window as any).__flux.fig;
    let id = "";
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = []; g.guides = { x: [], y: [] };
      id = F.newId("rect");
      g.elements.push({ type: "rect", id, x: 350, y: 200, width: 100, height: 80, rotation: 0, fill: "#4c78a8", stroke: "#222", strokeWidth: 2, cornerRadius: 0 });
    });
    F.viewport.set({ panX: 120, panY: 140, zoom: 1 });
    return id;
  });
  const elId = await seed();
  const guides = () => page.evaluate(() => (window as any).__flux.figures().find((f: any) => f.id === "growth").guides ?? {});
  const elx = () => page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id).x, elId);
  const ely = () => page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id).y, elId);
  // figure-local → client
  const pt = (lx: number, ly: number) => page.evaluate(([lx, ly]: [number, number]) => {
    const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
    const g = (window as any).__flux.get((window as any).__flux.fig.project);
    const fig = g.figures.find((f: any) => f.id === "growth");
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
  }, [lx, ly] as [number, number]);
  const hostXY = (sx: number, sy: number) => page.evaluate(([sx, sy]: [number, number]) => {
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    return { x: host.left + sx, y: host.top + sy };
  }, [sx, sy] as [number, number]);

  // --- rulers toggle ---
  await setS({ showRulers: true });
  await sleep(150);
  const rulerCount = await page.evaluate(() => document.querySelectorAll(".ruler").length);
  const tickCount = await page.evaluate(() => document.querySelectorAll(".ruler-tick").length);
  assert(rulerCount === 2, `rulers render (${rulerCount} strips)`);
  assert(tickCount > 0, `ruler ticks render (${tickCount})`);
  await shot(page, "f11-00-rulers");

  // --- drag a horizontal guide out of the TOP ruler → guides.y ~100 ---
  const topRuler = await hostXY(400, 10);
  const yDrop = await pt(0, 100); // figure-local y=100
  await recordGif(page, "f11-guide", async (frame: () => Promise<void>) => {
    await page.mouse.move(topRuler.x, topRuler.y); await page.mouse.down(); await frame();
    await page.mouse.move(topRuler.x, yDrop.y, { steps: 10 }); await frame();
    await page.mouse.up(); await frame();
  });
  await sleep(150);
  let gd = await guides();
  assert(gd.y?.some((v: number) => near(v, 100)), `top ruler drag made a horizontal guide @~100 (${JSON.stringify(gd.y)})`);

  // --- drag a vertical guide out of the LEFT ruler → guides.x ~200 ---
  const leftRuler = await hostXY(10, 300);
  const xDrop = await pt(200, 0);
  await page.mouse.move(leftRuler.x, leftRuler.y); await page.mouse.down();
  await page.mouse.move(xDrop.x, leftRuler.y, { steps: 10 });
  await page.mouse.up();
  await sleep(150);
  gd = await guides();
  assert(gd.x?.some((v: number) => near(v, 200)), `left ruler drag made a vertical guide @~200 (${JSON.stringify(gd.x)})`);
  await shot(page, "f11-01-guides");

  // --- element snaps to the vertical guide (x=200) ---
  // element at x=350; drag its left edge toward 200 → snaps to 200
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), elId);
  await sleep(80);
  const from = await pt(350 + 50, 200 + 40); // element centre
  const to = await pt(203 + 50, 200 + 40); // left ≈203 → snaps to 200
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await sleep(150);
  assert(near(await elx(), 200), `element snapped its left edge to the guide (x=${await elx()}, expect 200)`);
  await shot(page, "f11-02-snap-guide");

  // --- snap to grid (50) ---
  await setS({ showGrid: true, snapGrid: true, gridSize: 50 });
  await page.evaluate(() => { const F = (window as any).__flux.fig; F.commit((p: any) => { const g = p.figures.find((f: any) => f.id === "growth"); g.guides = { x: [], y: [] }; }); });
  await sleep(120);
  const gf = await pt(200 + 50, 200 + 40);
  // target (137,137): element edges 137/187/237 (x) & 137/177/217 (y) avoid the
  // figure edges/centres (0/400/800, 0/250/500), so grid snap owns both axes → (150,150)
  const gt = await pt(137 + 50, 137 + 40);
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), elId);
  await page.mouse.move(gf.x, gf.y); await page.mouse.down();
  await page.mouse.move(gt.x, gt.y, { steps: 10 });
  await page.mouse.up();
  await sleep(150);
  const gx = await elx(); const gy = await ely();
  assert(gx % 50 === 0 && gy % 50 === 0, `snap-to-grid → coords are grid multiples (x=${gx}, y=${gy})`);
  await shot(page, "f11-03-grid");

  // --- snap to pixel: fractional start + move → integer coords ---
  await setS({ showGrid: false, snapGrid: false, snapPixel: true });
  await page.evaluate((id: string) => { const F = (window as any).__flux.fig; F.commit((p: any) => { const e = p.figures.flatMap((f: any) => f.elements).find((x: any) => x.id === id); e.x = 100.4; e.y = 60.7; }); }, elId);
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), elId);
  await sleep(80);
  const pf = await pt(100.4 + 50, 60.7 + 40);
  await page.mouse.move(pf.x, pf.y); await page.mouse.down();
  await page.mouse.move(pf.x + 12, pf.y + 8, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  const px = await elx(); const py = await ely();
  assert(Number.isInteger(px) && Number.isInteger(py), `snap-to-pixel → integer coords (x=${px}, y=${py})`);
  await setS({ snapPixel: false });

  // --- delete a guide by dragging it off the figure ---
  await page.evaluate(() => { const F = (window as any).__flux.fig; F.commit((p: any) => { const g = p.figures.find((f: any) => f.id === "growth"); g.guides = { x: [300], y: [] }; }); });
  await sleep(150);
  const gline = await page.evaluate(() => {
    const el = document.querySelector(".guide-hit") as SVGLineElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert(!!gline, "guide hit-line present to grab");
  const off = await hostXY(8, 300); // drag onto the left ruler (off the figure)
  await page.mouse.move(gline!.x, gline!.y); await page.mouse.down();
  await page.mouse.move(off.x, off.y, { steps: 10 });
  await page.mouse.up();
  await sleep(150);
  gd = await guides();
  assert(!(gd.x ?? []).some((v: number) => near(v, 300)), `dragging a guide off the figure deletes it (${JSON.stringify(gd.x)})`);

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF11 GUIDES ALL PASS" : `\nF11 GUIDES ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
