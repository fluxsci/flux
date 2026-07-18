#!/usr/bin/env -S npx tsx
// Path-edit sub-modes (2026-07-18): v edit / p pen / d delete inside node-edit,
// endpoint pen-merge with grid snapping, shift-drag axis constraint, deferred
// shift-click toggle, the Esc ladder, and the Shift+G grid hotkey. Drives the
// real GUI on :1420 (?fixture=demo).
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep, waitFor } from "./lib/driver.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;

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
  await waitFor(
    page,
    () => !!((window as any).__flux?.fig && (window as any).__flux.figures().length && document.querySelector(".canvas-host")),
    null,
    { timeout: 15000, label: "figure mode ready" },
  );

  // Blank figure + fixed viewport; seed a perfect ±45° zigzag path.
  await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 500; g.elements = [];
      g.elements.push({
        type: "path", id: "zig", x: 40, y: 40, width: 320, height: 80, rotation: 0,
        d: "M 0 80 L 80 0 L 160 80 L 240 0 L 320 80", closed: false, fill: "none",
        stroke: "#222222", strokeWidth: 6,
        nodes: [
          { x: 0, y: 80, type: "corner" }, { x: 80, y: 0, type: "corner" },
          { x: 160, y: 80, type: "corner" }, { x: 240, y: 0, type: "corner" },
          { x: 320, y: 80, type: "corner" },
        ],
      });
    });
    F.viewport.set({ panX: 80, panY: 120, zoom: 1 });
    F.settings?.update?.((s: any) => s); // no-op; settings comes from settings.ts below
  });
  await sleep(400);

  // figure-local (lx,ly) → client coords
  const pt = (lx: number, ly: number) =>
    page.evaluate(([lx, ly]: [number, number]) => {
      const F = (window as any).__flux;
      const vp = F.get(F.fig.viewport);
      const fig = F.get(F.fig.project).figures.find((f: any) => f.id === "growth");
      const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
      return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
    }, [lx, ly] as [number, number]);
  const model = () =>
    page.evaluate(() => {
      const F = (window as any).__flux;
      const els = F.get(F.fig.project).figures.flatMap((f: any) => f.elements);
      const paths = els.filter((e: any) => e.type === "path");
      return { count: paths.length, el: paths.find((e: any) => e.id === "zig") ?? paths[0] };
    });
  const hudMode = () =>
    page.evaluate(() => document.querySelector(".node-hud b.on")?.textContent?.trim() ?? null);
  const grid = () => page.evaluate(() => JSON.parse(localStorage.getItem("flux.settings") || "{}").showGrid === true);

  // ---- Shift+G toggles the grid (outside node-edit) ----
  const g0 = await grid();
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyG");
  await page.keyboard.up("Shift");
  await sleep(200);
  assert((await grid()) === !g0, "Shift+G toggles settings.showGrid");
  // leave it OFF for the edit-mode legs
  if (await grid()) {
    await page.keyboard.down("Shift"); await page.keyboard.press("KeyG"); await page.keyboard.up("Shift");
    await sleep(150);
  }

  // ---- enter node-edit (dblclick the first segment's midpoint) ----
  // element sits at (40,40); segment (0,80)-(80,0) midpoint is el-local (40,40)
  // → FIGURE (80,80).
  const mid01 = await pt(80, 80);
  await dbl(mid01.x, mid01.y);
  await waitFor(page, () => !!document.querySelector(".node-hud"), null, { label: "node-edit HUD appears" });
  assert((await hudMode()) === "V edit", "default sub-mode is edit");
  await shot(page, "pm-01-edit");

  // ---- delete sub-mode: click a node deletes it; one undo restores ----
  await page.keyboard.press("d");
  await sleep(150);
  assert((await hudMode()) === "D delete", "d → delete sub-mode");
  const n1 = await pt(120, 40); // node 1: el-local (80,0) + element offset (40,40)
  await page.mouse.click(n1.x, n1.y);
  await sleep(300);
  let m = await model();
  assert(m.el.nodes.length === 4, `delete-mode click removes the node (5 → ${m.el.nodes.length})`);
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(300);
  m = await model();
  assert(m.el.nodes.length === 5, "one undo restores the deleted node");
  await shot(page, "pm-02-delete");

  // ---- back to edit; shift-drag a node → constrained to the diagonal ----
  await page.keyboard.press("v");
  await sleep(150);
  assert((await hudMode()) === "V edit", "v → edit sub-mode");
  // node 1 is at figure (120, 40); incoming segment direction is (1,-1)/√2.
  const nd = await pt(120, 40);
  await page.mouse.move(nd.x, nd.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  // raw delta (30, -22): diagonal wins (|30·1 + 22·1|/√2 ≈ 36.8 > 30)
  for (let i = 1; i <= 8; i++) await page.mouse.move(nd.x + (30 * i) / 8, nd.y + (-22 * i) / 8);
  await sleep(120);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await sleep(300);
  m = await model();
  // figure-space position of the dragged node (refit may shift el.x/y)
  const fx = m.el.x + m.el.nodes[1].x;
  const fy = m.el.y + m.el.nodes[1].y;
  const dx = fx - 120;
  const dy = fy - 40;
  assert(near(dx, -dy, 1.0) && Math.abs(dx) > 15, `shift-drag rides the diagonal (Δ=(${dx.toFixed(1)},${dy.toFixed(1)}), dx≈−dy)`);
  await shot(page, "pm-03-constrained");

  // ---- shift-click WITHOUT drag still toggles node selection ----
  // helper: node index → client coords from the LIVE model (refit shifts el.x/y)
  const nodeClient = async (i: number) => {
    const mmm = await model();
    return page.evaluate(([fx2, fy2]: [number, number]) => {
      const F = (window as any).__flux;
      const vp = F.get(F.fig.viewport);
      const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
      return { x: host.left + vp.panX + fx2 * vp.zoom, y: host.top + vp.panY + fy2 * vp.zoom };
    }, [mmm.el.x + mmm.el.nodes[i].x, mmm.el.y + mmm.el.nodes[i].y] as [number, number]);
  };
  const c2 = await nodeClient(2);
  await page.mouse.click(c2.x, c2.y); // plain select
  await sleep(150);
  const c3 = await nodeClient(3);
  await page.keyboard.down("Shift");
  await page.mouse.click(c3.x, c3.y); // shift-click, no drag → toggle-add
  await page.keyboard.up("Shift");
  await sleep(200);
  const selCount = await page.evaluate(() => document.querySelectorAll(".node-pt.sel").length);
  assert(selCount === 2, `shift-click without drag adds to the selection (${selCount} selected)`);

  // ---- pen sub-mode: grid on, extend from the END endpoint, then close ----
  await page.keyboard.down("Shift"); await page.keyboard.press("KeyG"); await page.keyboard.up("Shift"); // grid ON
  await page.keyboard.press("p");
  await sleep(200);
  assert((await hudMode()) === "P pen", "p → pen sub-mode");
  assert(
    (await page.evaluate(() => document.querySelectorAll(".pen-anchor-ring").length)) === 2,
    "both endpoints show connect rings",
  );
  const endC = await nodeClient(4);
  await page.mouse.click(endC.x + 3, endC.y - 2); // within the 14px anchor radius → seed
  await sleep(200);
  assert(
    (await page.evaluate(() => document.querySelectorAll(".pen-anchor-ring").length)) === 1,
    "seeding drops the seed endpoint's ring",
  );
  // place one grid-snapped point: click at figure (410, 133) → snaps to (408, 136)? no:
  // nearest lattice of 8 → (408, 136)... compute: 410→408 (51.25→51), 133→136 (16.6→17).
  const free = await pt(410, 133);
  await page.mouse.click(free.x, free.y);
  await sleep(200);
  await page.keyboard.press("Enter"); // finish → extend-merge
  await sleep(400);
  m = await model();
  assert(m.count === 1, "extend-merge keeps ONE path element");
  assert(m.el.nodes.length === 6 && !m.el.closed, `merged node count 5+1 (${m.el.nodes.length}), still open`);
  const lastFx = m.el.x + m.el.nodes[5].x;
  const lastFy = m.el.y + m.el.nodes[5].y;
  assert(lastFx === 408 && lastFy === 136, `pen point landed on the grid lattice (${lastFx},${lastFy})`);
  assert((await hudMode()) === "P pen", "still in pen sub-mode after the merge");
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(300);
  m = await model();
  assert(m.el.nodes.length === 5, "the whole extension is ONE undo entry");
  await page.evaluate(() => (window as any).__flux.fig.redo());
  await sleep(300);

  // close: seed on the START endpoint, land on the END endpoint
  const startC = await nodeClient(0);
  await page.mouse.click(startC.x, startC.y);
  await sleep(200);
  const endC2 = await nodeClient(5);
  await page.mouse.click(endC2.x, endC2.y);
  await sleep(400);
  m = await model();
  assert(m.el.closed === true && m.el.nodes.length === 6, `start→end draft closes the path (closed=${m.el.closed}, n=${m.el.nodes.length})`);
  await shot(page, "pm-04-merged-closed");

  // ---- Esc ladder: cancel draft → edit mode → exit ----
  await page.evaluate(() => (window as any).__flux.fig.undo()); // reopen (undo the close)
  await sleep(300);
  const bg = await pt(500, 400);
  await page.mouse.click(bg.x, bg.y); // free draft node (grid-snapped, fine)
  await sleep(200);
  await page.keyboard.press("Escape"); // 1: cancel draft, stay in pen
  await sleep(150);
  assert((await hudMode()) === "P pen", "Esc 1: draft cancelled, still pen mode");
  m = await model();
  assert(m.count === 1, "cancelled draft created no element");
  await page.keyboard.press("Escape"); // 2: back to edit
  await sleep(150);
  assert((await hudMode()) === "V edit", "Esc 2: back to edit sub-mode");
  await page.keyboard.press("Escape"); // 3: exit node-edit
  await sleep(200);
  assert((await page.evaluate(() => !document.querySelector(".node-hud"))), "Esc 3: node-edit exited (HUD gone)");

  // grid back OFF (leave settings as found)
  if (await grid()) {
    await page.keyboard.down("Shift"); await page.keyboard.press("KeyG"); await page.keyboard.up("Shift");
  }

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF18 PATH-MODES ALL PASS" : `\nF18 PATH-MODES ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
