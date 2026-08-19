// Figure ORDER in the sidebar — the drag + the Alt+↑/↓ chord, against the real
// app. The pure contract lives in verify-fig-order.ts (ops.reorderFigures);
// this gate covers the wiring nobody else can see:
//   A. drag a figure row up the Figures list → the list reorders, the figure
//      does NOT move on the canvas, and its number does not change
//   B. a plain click still goes to the figure (the drag threshold, and the
//      suppressed post-drag click, never eat an ordinary click)
//   C. Alt+↑ / Alt+↓ move the active figure one slot, and stop at the ends
//   D. Ctrl+click / Shift+click pick several rows; a chord (and a drag) moves
//      the whole pick as one block
//   E. one undo per gesture puts the order back
// Run (dev server on :1420): node scripts/verify-fig-order-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-fig-order-gui");
const FIG = ".sidebar section:nth-of-type(2)";
// The "toggle one row" modifier is the platform's: macOS Chrome turns a
// Ctrl+click into a secondary click, so the app takes metaKey there (the
// sidebar accepts either) and this gate must press the same key the user does.
const TOGGLE = process.platform === "darwin" ? "Meta" : "Control";

const { browser, page } = await launch();
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 3500 });
await clickMode(page, "Figure").catch(() => {});
await sleep(600);

const names = () => page.$$eval(`${FIG} li .item`, (els) => els.map((e) => e.textContent.trim().split(/\s{2,}|\n/)[0]));
const model = () =>
  page.evaluate(() => {
    const p = window.__flux.get(window.__flux.fig.project);
    const cid = window.__flux.get(window.__flux.fig.activeCanvasId);
    return {
      figures: p.figures
        .filter((f) => f.canvasId === cid)
        .map((f) => ({ id: f.id, name: f.name, number: f.number, x: f.x, y: f.y })),
      active: window.__flux.get(window.__flux.fig.activeFigureId),
      picked: [...window.__flux.get(window.__flux.fig.figureSelection)],
    };
  });
const rowBox = async (i) =>
  page.evaluate(
    (sel, idx) => {
      const li = document.querySelectorAll(`${sel} li`)[idx];
      if (!li) return null;
      const r = li.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    FIG,
    i,
  );

// Two more figures, so there is an order to rearrange (the demo ships one).
await page.click(`${FIG} .mini`);
await sleep(200);
await page.click(`${FIG} .mini`);
await sleep(300);
const start = await model();
h.eq(start.figures.length, 3, `three figures to order (${start.figures.map((f) => f.name).join(" · ")})`);
const geom0 = new Map(start.figures.map((f) => [f.id, `${f.x},${f.y}`]));
const num0 = new Map(start.figures.map((f) => [f.id, f.number]));
const id0 = start.figures.map((f) => f.id);

// --- A. drag the last row to the top -----------------------------------------
h.section("A — drag a row up the list");
{
  const from = await rowBox(2);
  const to = await rowBox(0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 8); // past the drag threshold
  await page.mouse.move(from.x, to.y, { steps: 6 });
  await page.mouse.up();
  await sleep(250);
  const m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[2], id0[0], id0[1]], "the dragged figure is now first");
  h.ok(
    m.figures.every((f) => `${f.x},${f.y}` === geom0.get(f.id)),
    "no figure moved on the canvas (x/y unchanged)",
  );
  h.ok(
    m.figures.every((f) => f.number === num0.get(f.id)),
    "no figure was renumbered (that stays the namer's job)",
  );
  h.eq(m.active, id0[2], "the dragged figure became the active one");
  const shown = await names();
  h.eq(shown[0], start.figures[2].name, `the sidebar shows it first (${shown.join(" · ")})`);
}

// --- B. a plain click is still a plain click ---------------------------------
h.section("B — click still goes to the figure");
{
  const b = await rowBox(2);
  await page.mouse.click(b.x, b.y);
  await sleep(200);
  const m = await model();
  h.eq(m.active, id0[1], "clicking the last row activates that figure");
  h.eq(m.figures.map((f) => f.id), [id0[2], id0[0], id0[1]], "…and changes no order");
  h.eq(m.picked, [id0[1]], "…and picks exactly that row");
}

// --- C. Alt+↑ / Alt+↓ --------------------------------------------------------
h.section("C — Alt+↑ / Alt+↓ move the active figure");
{
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Alt");
  await sleep(200);
  let m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[2], id0[1], id0[0]], "Alt+↑ moves it one slot up");
  h.ok(
    m.figures.every((f) => `${f.x},${f.y}` === geom0.get(f.id)),
    "…without moving anything on the canvas",
  );

  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Alt");
  await sleep(200);
  m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[2], id0[0], id0[1]], "Alt+↓ moves it back down");

  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Alt");
  await sleep(200);
  m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[2], id0[0], id0[1]], "Alt+↓ at the bottom is a no-op");
}

// --- D. several rows at once -------------------------------------------------
h.section("D — a multi-row pick moves as one block");
{
  // Ctrl/Cmd+click the middle row into the pick (the last row is already picked).
  const mid = await rowBox(1);
  await page.keyboard.down(TOGGLE);
  await page.mouse.click(mid.x, mid.y);
  await page.keyboard.up(TOGGLE);
  await sleep(200);
  let m = await model();
  h.eq(m.picked.slice().sort(), [id0[0], id0[1]].slice().sort(), "Ctrl/Cmd+click picks a second row");

  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Alt");
  await sleep(200);
  m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[0], id0[1], id0[2]], "Alt+↑ moves both picked rows as a block");

  // Shift+click extends a range from the active row; dragging one of the picked
  // rows carries the whole pick.
  const first = await rowBox(0);
  await page.mouse.click(first.x, first.y);
  await sleep(150);
  const second = await rowBox(1);
  await page.keyboard.down("Shift");
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up("Shift");
  await sleep(200);
  m = await model();
  h.eq(m.picked.length, 2, "Shift+click picks the range between the two rows");

  const last = await rowBox(2);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(first.x, first.y + 8);
  await page.mouse.move(first.x, last.y, { steps: 6 });
  await page.mouse.up();
  await sleep(250);
  m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[2], id0[0], id0[1]], "dragging a picked row carries the whole block to the end");
}

// --- E. undo -----------------------------------------------------------------
h.section("E — one undo per gesture");
{
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(250);
  const m = await model();
  h.eq(m.figures.map((f) => f.id), [id0[0], id0[1], id0[2]], "Ctrl+Z puts the order back in one step");
}

const errs = realErrors(page);
h.ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ")}` : "zero console errors");
await h.done(() => browser.close());
