#!/usr/bin/env -S npx tsx
// Feature 7 — exact-gap distribute + equal-spacing snap. Unit-checks the exact-gap
// branch, then GUI: the Inspector "Gap H" button sets every consecutive gutter to
// the field value; dragging a panel between two others snaps to equal spacing with
// a live readout.
import { distributeElements } from "../src/lib/geometry";
import type { Element } from "../src/lib/types";
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

// --- unit: exact-gap distribute ---
{
  const mk = (id: string, x: number): Element => ({ type: "rect", id, x, y: 0, width: 100, height: 50, rotation: 0, fill: "#888", stroke: "#222", strokeWidth: 1, cornerRadius: 0 }) as Element;
  const els = [mk("a", 0), mk("c", 500), mk("b", 190)]; // unsorted, uneven
  distributeElements(els, "h", 24);
  const byId = Object.fromEntries(els.map((e) => [e.id, e]));
  // sorted a(0..100) b c → a.right=100 → b.x=124 → c.x=124+100+24=248
  assert(near(byId.b.x, 124) && near(byId.c.x, 248), `exact-gap 24: b=${byId.b.x} c=${byId.c.x} (expect 124, 248)`);
  const g1 = byId.b.x - (byId.a.x + 100);
  const g2 = byId.c.x - (byId.b.x + 100);
  assert(near(g1, 24) && near(g2, 24), `all consecutive gaps = 24 (${g1}, ${g2})`);
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const seed = (xs: number[]) =>
    page.evaluate((xs: number[]) => {
      const F = (window as any).__flux.fig;
      const out: string[] = [];
      F.commit((p: any) => {
        const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
        g.x = 0; g.y = 0; g.width = 900; g.height = 480; g.elements = [];
        xs.forEach((x, i) => {
          const id = F.newId("rect");
          g.elements.push({ type: "rect", id, x, y: 180, width: 140, height: 100, rotation: 0, fill: ["#4c78a8", "#f58518", "#54a24b", "#e45756"][i % 4], stroke: "#222", strokeWidth: 2, cornerRadius: 0 });
          out.push(id);
        });
      });
      F.viewport.set({ panX: 60, panY: 140, zoom: 1 });
      return out;
    }, xs);
  const gaps = () => page.evaluate(() => {
    const els = (window as any).__flux.figures().find((f: any) => f.id === "growth").elements
      .slice().sort((a: any, b: any) => a.x - b.x);
    const g: number[] = [];
    for (let i = 1; i < els.length; i++) g.push(els[i].x - (els[i - 1].x + els[i - 1].width));
    return g;
  });
  const pt = (lx: number, ly: number) => page.evaluate(([lx, ly]: [number, number]) => {
    const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
    const g = (window as any).__flux.get((window as any).__flux.fig.project);
    const fig = g.figures.find((f: any) => f.id === "growth");
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
  }, [lx, ly] as [number, number]);

  // --- Gap H button: uneven → all gutters = 30 ---
  const ids = await seed([100, 300, 520, 560]);
  await page.evaluate((arr: string[]) => (window as any).__flux.fig.selection.set(new Set(arr)), ids);
  await sleep(150);
  // set the Gap field to 30
  await page.evaluate(() => {
    const nf = [...document.querySelectorAll(".inspector .nf")].find((n) => n.querySelector(".lb")?.textContent?.trim() === "Gap") as HTMLElement;
    const inp = nf.querySelector("input") as HTMLInputElement;
    inp.value = "30";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(100);
  await shot(page, "f7-00-before");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".inspector button")].find((x) => x.textContent?.trim() === "Gap H") as HTMLButtonElement;
    b.click();
  });
  await sleep(150);
  const gs = await gaps();
  assert(gs.every((g) => near(g, 30)), `Gap H → all gutters = 30 (${gs.map((g) => g.toFixed(0)).join(",")})`);
  await shot(page, "f7-01-gap30");
  // undoable
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert(!(await gaps()).every((g) => near(g, 30)), "Gap H is undoable");

  // --- equal-spacing snap while dragging a middle panel ---
  const sids = await seed([100, 500, 340]); // A@100, B@500, C@340 (all y=180)
  // A: 100-240, B: 500-640, C w140 → equal position: (500-240-140)/2=60 → C.x=240+60=300
  const cId = sids[2];
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), cId);
  await sleep(120);
  const from = await pt(340 + 70, 180 + 50); // C centre
  const to = await pt(300 + 70 - 4, 180 + 50); // land C.x≈296 → within threshold of 300
  let labelsMid = 0;
  await recordGif(page, "f7-snap", async (frame: () => Promise<void>) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await frame();
    await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 6 }); await frame();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    labelsMid = await page.evaluate(() => document.querySelectorAll(".measure-label").length);
    await frame();
    await page.mouse.up(); await frame();
  });
  await sleep(150);
  const cx = await page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id).x, cId);
  assert(near(cx, 300, 1.5), `drag snapped C to equal spacing (x=${cx}, expect 300)`);
  assert(labelsMid >= 2, `equal-gap readout shown mid-drag (${labelsMid} labels)`);
  await shot(page, "f7-02-snap");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF7 GAP ALL PASS" : `\nF7 GAP ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
