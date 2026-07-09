#!/usr/bin/env -S npx tsx
// Feature 5 — proportional scale mode (K). Unit-checks scaleRemap vs resizeRemap,
// then GUI: the Scale tool halves geometry AND stroke/corner/font together, while
// the Select tool's resize leaves stroke fixed; plus the Inspector "Scale %".
import { scaleRemap, resizeRemap } from "../src/lib/editing";
import { elementBBox } from "../src/lib/geometry";
import type { Element, RectElement, TextElement } from "../src/lib/types";
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 0.6) => Math.abs(a - b) <= t;

// --- unit ---
{
  const mkRect = (): RectElement => ({ type: "rect", id: "r", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "#ccc", stroke: "#222", strokeWidth: 4, cornerRadius: 8 });
  const ob = { x: 0, y: 0, w: 100, h: 100 };
  const nb = { x: 0, y: 0, w: 50, h: 50 };
  const a = mkRect(); scaleRemap(a, mkRect(), ob, nb);
  assert(near(a.width, 50) && near(a.strokeWidth, 2) && near(a.cornerRadius, 4), `scaleRemap 0.5 → w50 sw2 r4 (w=${a.width} sw=${a.strokeWidth} r=${a.cornerRadius})`);
  const b = mkRect(); resizeRemap(b, mkRect(), ob, nb);
  assert(near(b.width, 50) && near(b.strokeWidth, 4) && near(b.cornerRadius, 8), `resizeRemap 0.5 → w50 but stroke/corner UNCHANGED (sw=${b.strokeWidth} r=${b.cornerRadius})`);
  const t = { type: "text", id: "t", x: 0, y: 0, width: 100, height: 28, rotation: 0, text: "Hi", fontFamily: "sans", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000", sizing: "fixed" } as TextElement;
  const t0 = { ...t }; scaleRemap(t, t0, ob, { x: 0, y: 0, w: 50, h: 50 });
  assert(near(t.fontSize, 10), `scaleRemap scales fontSize 20→${t.fontSize}`);
  // P3 contract: a plain resize NEVER touches fontSize (K is the font scaler)…
  const t2 = { ...t0 }; resizeRemap(t2, { ...t0 }, ob, { x: 0, y: 0, w: 50, h: 50 });
  assert(near(t2.fontSize, 20), `resizeRemap leaves fontSize alone (20→${t2.fontSize})`);
  // …and K on a plot/svg multiplies contentScale (plain resize stays pt-true).
  const pl = { type: "plot", id: "p", x: 0, y: 0, width: 100, height: 100, rotation: 0, assetId: "a" } as Element & { type: "plot" };
  const pl0 = structuredClone(pl); scaleRemap(pl, pl0, ob, { x: 0, y: 0, w: 50, h: 50 });
  assert(near(pl.contentScale ?? 1, 0.5, 0.01), `scaleRemap halves plot contentScale (→${pl.contentScale})`);
  void elementBBox;
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const seed = () => page.evaluate(() => {
    const F = (window as any).__flux.fig;
    let id = "";
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = [];
      id = F.newId("rect");
      g.elements.push({ type: "rect", id, x: 200, y: 150, width: 200, height: 140, rotation: 0, fill: "#4c78a8", stroke: "#222", strokeWidth: 6, cornerRadius: 20 });
    });
    F.viewport.set({ panX: 80, panY: 120, zoom: 1 });
    F.activeTool.set("select");
    return id;
  });
  const el = (id: string) => page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id), id);
  const pt = (lx: number, ly: number) => page.evaluate(([lx, ly]: [number, number]) => {
    const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
    const g = (window as any).__flux.get((window as any).__flux.fig.project);
    const fig = g.figures.find((f: any) => f.id === "growth");
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
  }, [lx, ly] as [number, number]);

  // --- Scale tool: SE handle halves geometry + stroke + corner ---
  const id = await seed();
  await page.evaluate((id: string) => { (window as any).__flux.fig.activeTool.set("scale"); (window as any).__flux.fig.selectOnly(id); }, id);
  await sleep(120);
  await shot(page, "f5-00-before");
  const se = await pt(400, 290); // SE corner
  const seT = await pt(300, 220); // Δ(-100,-70) → uniform 0.5
  await recordGif(page, "f5-scale", async (frame: () => Promise<void>) => {
    await page.mouse.move(se.x, se.y); await page.mouse.down(); await frame();
    await page.mouse.move(seT.x, seT.y, { steps: 10 }); await frame();
    await page.mouse.up(); await frame();
  });
  await sleep(150);
  let e = await el(id);
  assert(near(e.width, 100, 3) && near(e.strokeWidth, 3, 0.3) && near(e.cornerRadius, 10, 0.6), `Scale tool halved w/stroke/corner (w=${e.width.toFixed(0)} sw=${e.strokeWidth.toFixed(1)} r=${e.cornerRadius.toFixed(1)})`);
  await shot(page, "f5-01-scaled");

  // --- contrast: Select tool resize leaves stroke fixed ---
  const id2 = await seed();
  await page.evaluate((id: string) => { (window as any).__flux.fig.activeTool.set("select"); (window as any).__flux.fig.selectOnly(id); }, id2);
  await sleep(120);
  const se2 = await pt(400, 290);
  const se2T = await pt(300, 290); // shrink width only, no shift → non-uniform
  await page.mouse.move(se2.x, se2.y); await page.mouse.down();
  await page.mouse.move(se2T.x, se2T.y, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  e = await el(id2);
  assert(near(e.width, 100, 3) && near(e.strokeWidth, 6, 0.01), `Select resize: width changed but stroke stays 6 (w=${e.width.toFixed(0)} sw=${e.strokeWidth})`);

  // --- Inspector "Scale %" one-shot ---
  const id3 = await seed();
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), id3);
  await sleep(120);
  await page.evaluate(() => {
    const nf = [...document.querySelectorAll(".inspector .nf")].find((n) => n.querySelector(".lb")?.textContent?.trim() === "Scale %") as HTMLElement;
    const inp = nf.querySelector("input") as HTMLInputElement;
    inp.value = "50";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(80);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".inspector button")].find((x) => x.textContent?.trim() === "Apply") as HTMLButtonElement;
    b.click();
  });
  await sleep(150);
  e = await el(id3);
  assert(near(e.width, 100, 1) && near(e.strokeWidth, 3, 0.2), `Inspector Scale % 50 → half geometry + stroke (w=${e.width.toFixed(0)} sw=${e.strokeWidth.toFixed(1)})`);

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF5 SCALE ALL PASS" : `\nF5 SCALE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
