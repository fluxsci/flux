// Line endpoint pivot (owner review, Figma parity) — a SINGLE selected line
// shows two ENDPOINT handles (no bbox handles, no rotate handle), and a real
// mouse drag on one endpoint moves it while the other endpoint's world
// position stays fixed. Esc mid-drag restores the pre-gesture line. Shift
// snaps the moving endpoint to 45° about the fixed one.
//   Run (dev server on :1420): node scripts/verify-line-pivot.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const lineId = await page.evaluate(() => {
    const F = window.__flux.fig;
    let id = "";
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0;
      g.y = 0;
      g.width = 800;
      g.height = 500;
      g.elements = [];
      id = F.newId("line");
      g.elements.push({
        type: "line", id, x: 200, y: 200, width: 0, height: 0, rotation: 0,
        x1: 0, y1: 0, x2: 200, y2: 0, stroke: "#222", strokeWidth: 3, arrowEnd: true,
      });
    });
    F.viewport.set({ panX: 60, panY: 120, zoom: 1 });
    F.selection.set(new Set([id]));
    return id;
  });
  await sleep(300);

  const model = () =>
    page.evaluate((id) => {
      const e = window.__flux.figures().flatMap((f) => f.elements).find((x) => x.id === id);
      return e ? { x: e.x, y: e.y, x2: e.x2, y2: e.y2, rotation: e.rotation } : null;
    }, lineId);
  // World endpoints (figure at 0,0 → world == figure-local); CLIENT px =
  // canvas-host offset + pan + world·zoom (page.mouse works in client coords).
  const off = await page.evaluate(() => {
    const r = document.querySelector(".canvas-host").getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const scr = (wx, wy) => ({ x: off.x + 60 + wx, y: off.y + 120 + wy });

  // --- handle chrome: endpoints only ------------------------------------------
  const chrome = await page.evaluate(() => ({
    endpoints: document.querySelectorAll(".endpoint-handle").length,
    boxHandles: document.querySelectorAll(".overlay .handle, svg .handle").length,
    rotate: document.querySelectorAll(".rot-handle").length,
    selBox: document.querySelectorAll(".sel-box").length,
  }));
  ok(chrome.endpoints === 2, `single line selection shows 2 endpoint handles (got ${chrome.endpoints})`);
  ok(chrome.boxHandles === 0, "no bbox resize handles for a single line");
  ok(chrome.rotate === 0, "no rotate handle for a single line (endpoints subsume it)");
  ok(chrome.selBox === 0, "no selection box for a single line");

  // --- pivot drag: endpoint 2 moves, endpoint 1 fixed --------------------------
  const b0 = await model();
  const from = scr(b0.x + b0.x2, b0.y + b0.y2); // endpoint 2 on screen
  const to = scr(500, 380);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  const b1 = await model();
  ok(near(b1.x, b0.x) && near(b1.y, b0.y), "fixed endpoint (1) did not move");
  ok(near(b1.x + b1.x2, 500) && near(b1.y + b1.y2, 380), `dragged endpoint landed at the pointer (got ${b1.x + b1.x2},${b1.y + b1.y2})`);
  ok(b1.rotation === 0, "pivot keeps rotation 0");

  // --- Esc mid-drag cancels ----------------------------------------------------
  const e2 = scr(b1.x + b1.x2, b1.y + b1.y2);
  await page.mouse.move(e2.x, e2.y);
  await page.mouse.down();
  await page.mouse.move(e2.x + 80, e2.y - 60, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await sleep(150);
  const b2 = await model();
  ok(near(b2.x + b2.x2, b1.x + b1.x2) && near(b2.y + b2.y2, b1.y + b1.y2), "Esc mid-drag restores the pre-gesture endpoint");

  // --- shift = 45° about the FIXED endpoint ------------------------------------
  const e3 = scr(b2.x + b2.x2, b2.y + b2.y2);
  await page.mouse.move(e3.x, e3.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  const fx = scr(b2.x, b2.y); // fixed endpoint 1 on screen
  await page.mouse.move(fx.x + 200, fx.y + 75, { steps: 6 }); // ~20.6° → snaps
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await sleep(150);
  const b3 = await model();
  const ang = ((Math.atan2(b3.y2, b3.x2) * 180) / Math.PI + 360) % 360;
  ok(near(ang % 45, 0, 0.5) || near(45 - (ang % 45), 0, 0.5), `shift-drag snaps to 45° steps (got ${ang.toFixed(1)}°)`);
  ok(near(b3.x, b2.x) && near(b3.y, b2.y), "shift pivot also keeps the fixed endpoint");

  await shot(page, "line-pivot");
  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
} finally {
  await browser.close();
}
if (fails) {
  console.error(`\nLINE PIVOT VERIFY: FAIL (${fails})`);
  process.exit(1);
}
console.log("\nLINE PIVOT VERIFY: PASS");
