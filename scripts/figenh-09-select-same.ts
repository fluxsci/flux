#!/usr/bin/env -S npx tsx
// Feature 9 — select-all-with-same. Unit-checks matchElements/matchByValue, GUI
// Cmd/Ctrl+Alt+A selects every same-fill element for a one-shot restyle, and the
// bridge select_matching mirrors it (then a set_style recolors, undoable).
import { matchElements, matchByValue } from "../src/lib/ops";
import { get } from "svelte/store";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { Element, Project } from "../src/lib/types";
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const rr = (id: string, fill: string): Element => ({ type: "rect", id, x: 0, y: 0, width: 40, height: 40, rotation: 0, fill, stroke: "#222", strokeWidth: 2, cornerRadius: 0 }) as Element;

// --- unit ---
{
  const p: Project = {
    version: 1, name: "t", canvases: [{ id: "c", name: "C" }],
    figures: [
      { id: "A", name: "A", canvasId: "c", x: 0, y: 0, width: 200, height: 200, background: "#fff", elements: [rr("a1", "#e00"), rr("a2", "#00e"), rr("a3", "#e00")] },
      { id: "B", name: "B", canvasId: "c", x: 300, y: 0, width: 200, height: 200, background: "#fff", elements: [rr("b1", "#e00")] },
    ],
    assets: [], palette: [],
  };
  const inFig = matchElements(p, "a1", "fill", "figure").sort();
  assert(JSON.stringify(inFig) === JSON.stringify(["a1", "a3"]), `matchElements fill/figure → a1,a3 (${inFig})`);
  const proj = matchElements(p, "a1", "fill", "project").sort();
  assert(JSON.stringify(proj) === JSON.stringify(["a1", "a3", "b1"]), `matchElements fill/project → a1,a3,b1 (${proj})`);
  const byType = matchElements(p, "a1", "type", "figure").sort();
  assert(byType.length === 3, `matchElements type/figure → all 3 rects (${byType.length})`);
  const byVal = matchByValue(p, "fill", "#00e", "project");
  assert(JSON.stringify(byVal) === JSON.stringify(["a2"]), `matchByValue #00e → a2 (${byVal})`);
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const ids = await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    const out: Record<string, string> = {};
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 800; g.height = 300; g.elements = [];
      const mk = (k: string, x: number, fill: string) => { const id = F.newId("rect"); g.elements.push({ type: "rect", id, x, y: 120, width: 90, height: 90, rotation: 0, fill, stroke: "#222", strokeWidth: 2, cornerRadius: 0 }); out[k] = id; };
      mk("r1", 60, "#d62728"); mk("b1", 200, "#1f77b4"); mk("r2", 340, "#d62728"); mk("b2", 480, "#1f77b4"); mk("r3", 620, "#d62728");
    });
    F.viewport.set({ panX: 40, panY: 120, zoom: 1 });
    return out;
  });
  await sleep(150);
  const selCount = () => page.evaluate(() => (window as any).__flux.get((window as any).__flux.fig.selection).size);

  // pick one red, Cmd/Ctrl+Alt+A → all 3 reds
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.r1);
  await sleep(80);
  await shot(page, "f9-00-one");
  await page.keyboard.down("Control"); await page.keyboard.down("Alt");
  await page.keyboard.press("a");
  await page.keyboard.up("Alt"); await page.keyboard.up("Control");
  await sleep(150);
  assert((await selCount()) === 3, `Cmd+Alt+A selected all 3 reds (${await selCount()})`);
  const selReds = await page.evaluate(() => [...(window as any).__flux.get((window as any).__flux.fig.selection)]);
  const allRed = await page.evaluate((sel: string[]) => sel.every((id) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id).fill === "#d62728"), selReds);
  assert(allRed, "every selected element is red");
  await shot(page, "f9-01-same");

  // Inspector "Fill" button also works (reselect one, click)
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.b1);
  await sleep(80);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".inspector button")].find((x) => x.textContent?.trim() === "Fill") as HTMLButtonElement;
    b.click();
  });
  await sleep(150);
  assert((await selCount()) === 2, `Inspector "Fill" selected both blues (${await selCount()})`);

  // --- bridge select_matching by value, then recolor, undoable ---
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 600, height: 200, background: "#fff", elements: [rr("x1", "#d62728"), rr("x2", "#1f77b4"), rr("x3", "#d62728")] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  await dispatchCommand({ type: "select_matching", by: "fill", value: "#d62728", scope: "figure" });
  assert(get(store.selection).size === 2, `bridge select_matching value → 2 (${get(store.selection).size})`);
  await dispatchCommand({ type: "set_style", patch: { fill: "#2ca02c" } });
  const greens = () => get(store.project).figures[0].elements.filter((e) => (e as { fill?: string }).fill === "#2ca02c").length;
  assert(greens() === 2, `following set_style recolored the matched set (${greens()})`);
  store.undo();
  assert(greens() === 0, "recolor undoable");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF9 SELECT-SAME ALL PASS" : `\nF9 SELECT-SAME ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
