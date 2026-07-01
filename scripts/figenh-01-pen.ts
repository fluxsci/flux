#!/usr/bin/env -S npx tsx
// Feature 1 — pen/vector overhaul (GUI). Draws a bezier path with the pen
// (corner + click-drag smooth node), records a GIF, then node-edits it:
// drag a node, toggle corner↔smooth, insert on a segment, delete a node — each a
// single undo. Finally proves the RESIZE FIX (a path handle-resize rescales the
// geometry and persists, instead of snapping back).
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

const { browser, page } = await launch({ width: 1440, height: 900 });
// A genuine DOM dblclick (puppeteer's clickCount:2 single press does NOT emit one).
const dbl = async (x: number, y: number) => {
  await page.mouse.move(x, y);
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
};
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Blank the figure + a known viewport so coordinate math is exact.
  await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = [];
    });
    F.viewport.set({ panX: 80, panY: 120, zoom: 1 });
  });
  await sleep(150);

  // figure-local (lx,ly) → absolute client coords
  const pt = (lx: number, ly: number) =>
    page.evaluate(([lx, ly]: [number, number]) => {
      const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
      const g = (window as any).__flux.get((window as any).__flux.fig.project);
      const fig = g.figures.find((f: any) => f.id === "growth");
      const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
      return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
    }, [lx, ly] as [number, number]);

  const paths = () => page.evaluate(() => (window as any).__flux.figures().flatMap((f: any) => f.elements).filter((e: any) => e.type === "path"));
  const firstPath = async () => (await paths())[0];

  // ---- pen: draw an open bezier (corner, smooth via click-drag, 2 corners) ----
  await page.evaluate(() => (window as any).__flux.fig.activeTool.set("pen"));
  await sleep(120);
  const P1 = await pt(120, 120);
  const P2 = await pt(280, 120);
  const P2h = await pt(340, 70); // handle drag for the smooth node
  const P3 = await pt(430, 240);
  const P4 = await pt(180, 300);
  await shot(page, "f1-00-pen-before");

  await recordGif(page, "f1-pen-draw", async (frame: () => Promise<void>) => {
    await page.mouse.move(P1.x, P1.y); await page.mouse.down(); await page.mouse.up(); // corner
    await frame();
    await page.mouse.move(P2.x, P2.y); await page.mouse.down();
    await page.mouse.move(P2h.x, P2h.y, { steps: 8 }); await page.mouse.up(); // smooth (drag handles)
    await frame();
    await page.mouse.move(P3.x, P3.y); await page.mouse.down(); await page.mouse.up(); await frame();
    await page.mouse.move(P4.x, P4.y); await page.mouse.down(); await page.mouse.up(); await frame();
    await page.keyboard.press("Enter"); // finish (open)
    await frame();
  });
  await sleep(200);

  let path = await firstPath();
  assert(!!path, "pen created a path element");
  assert(path && path.nodes && path.nodes.length === 4, `path has 4 nodes (got ${path?.nodes?.length})`);
  assert(path && path.nodes[1].type === "smooth" && path.nodes[1].hOut, "node[1] is smooth with a handle (click-drag)");
  assert(path && /C /.test(path.d), "path d contains a cubic segment (curve)");
  assert(path && path.closed === false && path.fill === "none", "open path → not closed, fill none");
  await shot(page, "f1-01-pen-drawn");

  // ---- node edit: select + Enter (deterministic); then verify double-click on
  // the stroke also enters (a straight segment's midpoint sits on the path) ----
  const pathId = path.id;
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), pathId);
  await sleep(100);
  await page.keyboard.press("Enter");
  await sleep(200);
  let inEdit = await page.evaluate(() => (window as any).__flux.get((window as any).__flux.fig.nodeEditId));
  assert(inEdit === pathId, `Enter entered node-edit (nodeEditId=${inEdit})`);
  // exit, then re-enter via double-click on the stroke. Target an exact on-path
  // point via the rendered <path> geometry (a 2px stroke is too thin to hit by
  // arithmetic in headless).
  await page.keyboard.press("Escape");
  await sleep(120);
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), pathId);
  await sleep(80);
  const c = await page.evaluate(() => {
    const path = [...document.querySelectorAll(".el path")].pop() as SVGPathElement;
    const L = path.getTotalLength();
    const p = path.getPointAtLength(L * 0.5);
    const sp = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: sp.x, y: sp.y };
  });
  await dbl(c.x, c.y);
  await sleep(200);
  inEdit = await page.evaluate(() => (window as any).__flux.get((window as any).__flux.fig.nodeEditId));
  assert(inEdit === pathId, `double-click on stroke entered node-edit (nodeEditId=${inEdit})`);
  const nodeCount = await page.evaluate(() => document.querySelectorAll(".node-pt").length);
  assert(nodeCount === 4, `4 node markers rendered (got ${nodeCount})`);
  await shot(page, "f1-02-node-edit");

  // helper: center of the i-th overlay element of a class
  const centerOf = (sel: string, i = 0) =>
    page.evaluate(([sel, i]: [string, number]) => {
      const el = document.querySelectorAll(sel)[i] as SVGGraphicsElement | undefined;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, [sel, i] as [string, number]);

  // ---- drag node[0] → shape changes; one undo restores ----
  const dBefore = (await firstPath()).d;
  const n0 = await centerOf(".node-pt", 0);
  assert(!!n0, "found node[0] marker");
  await recordGif(page, "f1-node-drag", async (frame: () => Promise<void>) => {
    await page.mouse.move(n0!.x, n0!.y); await page.mouse.down(); await frame();
    await page.mouse.move(n0!.x - 50, n0!.y + 40, { steps: 10 }); await frame();
    await page.mouse.up(); await frame();
  });
  await sleep(150);
  const dAfter = (await firstPath()).d;
  assert(dAfter !== dBefore, "dragging a node changed the path geometry");
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert((await firstPath()).d === dBefore, "single undo restored the node drag");
  await shot(page, "f1-03-node-dragged");

  // ---- toggle corner → smooth (double-click node[0]) ----
  const beforeType = (await firstPath()).nodes[0].type;
  const n0b = await centerOf(".node-pt", 0);
  await dbl(n0b!.x, n0b!.y);
  await sleep(150);
  const afterType = (await firstPath()).nodes[0].type;
  assert(beforeType === "corner" && afterType === "smooth", `dbl-click toggled node type ${beforeType}→${afterType}`);
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert((await firstPath()).nodes[0].type === "corner", "undo restored node type");

  // ---- insert a node on a segment (midpoint marker) ----
  const cntBefore = (await firstPath()).nodes.length;
  const ins = await centerOf(".node-insert", 0);
  assert(!!ins, "found a segment-insert marker");
  await page.mouse.click(ins!.x, ins!.y);
  await sleep(150);
  assert((await firstPath()).nodes.length === cntBefore + 1, `insert added a node (${cntBefore}→${(await firstPath()).nodes.length})`);
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert((await firstPath()).nodes.length === cntBefore, "undo restored inserted node");

  // ---- delete a node (select then Delete) ----
  const cnt2 = (await firstPath()).nodes.length;
  const nSel = await centerOf(".node-pt", 1);
  await page.mouse.click(nSel!.x, nSel!.y);
  await sleep(80);
  await page.keyboard.press("Delete");
  await sleep(150);
  assert((await firstPath()).nodes.length === cnt2 - 1, `Delete removed the selected node (${cnt2}→${(await firstPath()).nodes.length})`);
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert((await firstPath()).nodes.length === cnt2, "undo restored deleted node");

  // exit node-edit
  await page.keyboard.press("Escape");
  await sleep(120);
  assert((await page.evaluate(() => (window as any).__flux.get((window as any).__flux.fig.nodeEditId))) === null, "Escape exits node-edit");

  // ---- RESIZE FIX: handle-resize rescales geometry + persists ----
  path = await firstPath();
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), path.id);
  await sleep(150);
  await shot(page, "f1-04-resize-before");
  const wBefore = path.width;
  const dPreResize = path.d;
  const se = await pt(path.x + path.width, path.y + path.height); // SE handle sits here
  await page.mouse.move(se.x, se.y);
  await page.mouse.down();
  await page.mouse.move(se.x + 80, se.y + 60, { steps: 12 });
  await page.mouse.up();
  await sleep(200);
  const after = await firstPath();
  assert(after.width > wBefore + 40, `path widened on resize (${wBefore.toFixed(0)}→${after.width.toFixed(0)})`);
  assert(after.d !== dPreResize, "resize rescaled the path d (did NOT snap back)");
  await shot(page, "f1-05-resize-after");
  // persistence: the widened width survives (no snap-back on next tick)
  await sleep(200);
  assert((await firstPath()).width > wBefore + 40, "resized width persists");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF1 PEN/NODE GUI ALL PASS" : `\nF1 PEN/NODE GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
