// 2026-09-15 surface redesign gate (browser) — the X-ray's MULTI-SELECT and
// MULTI-PLOT roots, and "Animate selected" in Slide mode:
//   · two plots selected + Alt+R → ONE X-ray: a `set` root, both plots as
//     element rows, and a "Common parts" list of what they share
//   · picking a common row selects that part on EVERY plot (partSelections);
//     x hides it on all of them, x again shows all
//   · Shift+click picks a run of part rows; x hides the pick; Enter opens the
//     property menu for the whole pick (and Escape closes only the menu)
//   · in Slide mode `a` offers Appear/Emphasize/Disappear/Change; `1` lands
//     one appearance per picked target on the timeline and closes the X-ray
//   Run (dev server on :1420): node scripts/verify-xray-multi-gui.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForGone } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("xm-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0; g.y = 0; g.width = 1100; g.height = 700;
        g.elements = [
          { type: "plot", id: "xm-a", x: 40, y: 40, width: 420, height: 300, rotation: 0, assetId: "xm-asset", overrides: {} },
          { type: "plot", id: "xm-b", x: 40, y: 360, width: 420, height: 300, rotation: 0, assetId: "xm-asset", overrides: {} },
        ];
        F.activeFigureId.set(g.id);
      });
      F.selection.set(new Set(["xm-a", "xm-b"]));
      F.viewport.set({ panX: 80, panY: 100, zoom: 0.8 });
    },
    SVG,
    MANIFEST,
  );
  await sleep(400);
  const overrides = () => page.evaluate(() => {
    const f = window.__flux.figures()[0];
    return Object.fromEntries(f.elements.map((e) => [e.id, structuredClone(e.overrides ?? {})]));
  });
  const parts = () => page.evaluate(() => window.__flux.get(window.__flux.fig.partSelections).map((p) => `${p.elementId}:${p.partId}`));
  const rowsOf = () => page.evaluate(() => [...document.querySelectorAll(".xray .row")].map((r) => ({ kind: r.dataset.kind, label: r.querySelector(".rlabel")?.textContent.trim(), sel: r.classList.contains("sel"), rid: r.dataset.rid })));
  const rowEl = (kind, label, nth = 0) => page.evaluateHandle(([k, l, n]) => [...document.querySelectorAll(`.xray .row[data-kind="${k}"]`)].filter((r) => r.querySelector(".rlabel")?.textContent.trim() === l)[n] ?? null, [kind, label, nth]);
  const clickRow = async (kind, label, init = {}, nth = 0) => {
    const h = await rowEl(kind, label, nth);
    const found = await page.evaluate((el) => !!el, h);
    if (!found) return false;
    await page.evaluate((el, i) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...i })), h, init);
    await sleep(80);
    return true;
  };

  // --- 1. multi-plot root -------------------------------------------------------------
  await page.mouse.move(300, 300);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyR");
  await page.keyboard.up("Alt");
  await waitFor(page, () => document.querySelectorAll(".xray .row").length > 0, null, { label: "x-ray rows" });
  let rows = await rowsOf();
  ok(rows.some((r) => r.kind === "set" && r.label === "2 plots"), "two selected plots x-ray together under a `2 plots` root");
  ok(rows.filter((r) => r.kind === "element").length === 2, "…both plots are element rows");
  const common = rows.filter((r) => r.kind === "common");
  ok(common.length > 5 && common.some((r) => r.label === "X axis"), `common parts listed (${common.length}, incl. X axis)`);
  ok(await page.evaluate(() => !!document.querySelector(".xray .section")), "a Common parts section header separates them");
  await shot(page, "xray-multi-01");

  // --- 2. a common row selects the part on every plot; x hides everywhere -----------------
  ok(await clickRow("common", "X axis"), "click the common X axis row");
  let ps = await parts();
  ok(ps.length === 2 && ps.includes("xm-a:axis.x") && ps.includes("xm-b:axis.x"), `common row → the part on every plot (${ps.join(", ")})`);
  await page.keyboard.press("x");
  await sleep(200);
  let ov = await overrides();
  ok(ov["xm-a"]["axis.x"]?.hidden === true && ov["xm-b"]["axis.x"]?.hidden === true, "x hides the x-axis on BOTH plots");
  rows = await rowsOf();
  await page.keyboard.press("x");
  await sleep(200);
  ov = await overrides();
  ok(ov["xm-a"]["axis.x"]?.hidden === false && ov["xm-b"]["axis.x"]?.hidden === false, "x again shows it on both");

  await page.keyboard.press('Escape'); await waitForGone(page, '.xray');
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyR'); await page.keyboard.up('Alt');
  await waitFor(page, () => !!document.querySelector('.xray .row[data-kind="set"]'), null, { label: 'reopened multi-plot root' });
  ok((await parts()).length === 2, "reopening a common-part pick preserves every plot and its selected parts");
  await clickRow("common", "X axis");

  // Keyboard navigation must follow the primary row below the visible fold.
  for (let i = 0; i < 35; i++) await page.keyboard.press("ArrowDown");
  await waitFor(page, () => {
    const row = document.querySelector('.xray .row.primary')?.getBoundingClientRect();
    const tree = document.querySelector('.xray .tree')?.getBoundingClientRect();
    return row && tree && row.top >= tree.top && row.bottom <= tree.bottom;
  }, null, { label: "keyboard pick remains visible below the fold" });
  ok(await page.$eval('.xray .tree', (t) => t.scrollTop > 0), "keyboard navigation scrolls just enough to keep its row in view");

  // A common row can straddle visible and stashed parts in Slide. Exercise
  // the shared exclusion policy explicitly; a blocked member stays byte-identical.
  await page.evaluate(() => window.__flux.fig.setEditorSelectionExclusions(new Set(), new Map([["xm-b", new Set(["axis.x"])]])));
  await clickRow("common", "X axis");
  ps = await parts();
  ok(ps.length === 1 && ps[0] === "xm-a:axis.x", "a common pick omits its stashed member");
  await page.keyboard.press("x");
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "xm-a").overrides["axis.x"]?.hidden === true);
  ov = await overrides();
  ok(ov["xm-b"]["axis.x"]?.hidden === false, "common hide preserves the stashed plot part");
  await page.keyboard.press("x");
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "xm-a").overrides["axis.x"]?.hidden === false);
  ok((await overrides())["xm-b"]["axis.x"]?.hidden === false, "common show uses only editable members when deciding direction");
  await page.evaluate(() => window.__flux.fig.setEditorSelectionExclusions(new Set()));

  // The synthetic root has an eye too: it must act on its plots, not be a no-op.
  await clickRow("set", "2 plots");
  await page.keyboard.press("x");
  await waitFor(page, () => window.__flux.figures()[0].elements.every((e) => e.hidden));
  ok(await page.$eval('.xray .row[data-kind="set"] .eye', (e) => e.classList.contains('off')), "the set eye hides both plots and reflects their shared state");
  await page.keyboard.press("x");
  await waitFor(page, () => window.__flux.figures()[0].elements.every((e) => !e.hidden));

  // --- 3. shift-click a run of part rows; x hides the pick; Enter opens properties -------
  // Expand the top plot (first element row) and its Plot area.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.xray .row[data-kind="element"]')][0];
    if (!el.nextElementSibling?.matches('[data-kind="part"]')) el.querySelector("button.tw")?.click();
  });
  await sleep(150);
  rows = await rowsOf();
  const partRows = rows.filter((r) => r.kind === "part");
  ok(partRows.length >= 3, `the plot expands into part rows (${partRows.length})`);
  const first = partRows[0], third = partRows[2];
  await page.evaluate((rid) => document.querySelector(`.xray .row[data-rid="${rid}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true })), first.rid);
  await sleep(80);
  await page.evaluate((rid) => document.querySelector(`.xray .row[data-rid="${rid}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })), third.rid);
  await sleep(120);
  rows = await rowsOf();
  ok(rows.filter((r) => r.sel).length === 3, `Shift+click picks the run (${rows.filter((r) => r.sel).length} rows)`);
  ps = await parts();
  const owner = ps[0]?.split(":")[0];
  ok(ps.length === 3 && ps.every((p) => p.startsWith(owner + ":")), `…and publishes three parts of ONE plot (${owner}: ${ps.length})`);
  await page.keyboard.press("x");
  await sleep(200);
  ov = await overrides();
  const hiddenIds = ps.map((p) => p.split(":")[1]);
  ok(hiddenIds.every((id) => ov[owner][id]?.hidden === true), "x hides every picked part");
  await page.keyboard.press("x");
  await sleep(150);
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "property menu on top" });
  const menu = await page.evaluate(() => ({
    ctx: document.querySelector(".fluxFigMenu .ctx")?.textContent ?? "",
    above: +getComputedStyle(document.querySelector(".fwrap")).zIndex > +getComputedStyle(document.querySelector(".xwrap")).zIndex,
    overlapsXray: (() => { const a = document.querySelector(".fluxFigMenu").getBoundingClientRect(), b = document.querySelector(".xray").getBoundingClientRect(); return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom); })(),
  }));
  ok(/3 plot parts/.test(menu.ctx) && menu.above, `Enter opens the property menu for the whole pick, on top (${menu.ctx})`);
  ok(menu.overlapsXray === false, "…placed beside the X-ray, not over it");
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu");
  ok(!!(await page.$(".xray")), "Escape closes the menu, the X-ray stays");
  const animFig = await page.evaluate(() => document.querySelector(".xray .animbtn")?.disabled);
  ok(animFig === true, "Animate selected is greyed out in Figure mode");
  await page.keyboard.press("Escape");
  await waitForGone(page, ".xray");

  // --- 4. Slide mode: Animate selected lands on the timeline -------------------------------
  // A fresh page: the figure legs above seeded a plot asset the demo bridge
  // cannot persist, and the tenancy handoff rightly refuses to evict a figure
  // whose save failed. Slide mode gets its own boot.
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Slide");
  await waitFor(page, () => !!document.querySelector(".slide-mode .deckbar") && !document.querySelector(".slide-mode .editor-loading"), null, { label: "slide editor ready", timeout: 15000 });
  await sleep(400);
  const seeded = await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("xm-asset", svg, manifest);
      const sid = F.get ? null : null;
      const id = window.__flux.get(F.activeFigureId);
      if (!id) return false;
      F.commit((p) => {
        const s = p.figures.find((x) => x.id === id);
        s.elements.push({ type: "plot", id: "xm-s", x: 40, y: 40, width: 420, height: 300, rotation: 0, assetId: "xm-asset", overrides: {} });
        s.elements.push({ type: "plot", id: "xm-t", x: 500, y: 40, width: 420, height: 300, rotation: 0, assetId: "xm-asset", overrides: {} });
      });
      F.selectOnly("xm-s");
      return true;
    },
    SVG,
    MANIFEST,
  );
  ok(seeded, "a plot is seeded on the active slide");
  await sleep(400);
  await page.mouse.move(300, 300);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyR");
  await page.keyboard.up("Alt");
  await waitFor(page, () => document.querySelectorAll(".xray .row").length > 0, null, { label: "slide x-ray" });
  rows = await rowsOf();
  const p2 = rows.filter((r) => r.kind === "part");
  await page.evaluate((rid) => document.querySelector(`.xray .row[data-rid="${rid}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true })), p2[0].rid);
  await sleep(60);
  await page.evaluate((rid) => document.querySelector(`.xray .row[data-rid="${rid}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })), p2[1].rid);
  await sleep(100);
  const animSlide = await page.evaluate(() => document.querySelector(".xray .animbtn")?.disabled);
  ok(animSlide === false, "Animate selected is live in Slide mode once rows are picked");
  await page.keyboard.press("a");
  await sleep(150);
  ok(await page.evaluate(() => !!document.querySelector(".xray .animmenu")), "a opens the animate chooser");
  await page.keyboard.press("1");
  await waitForGone(page, ".xray");
  ok(!(await page.$(".xray")), "choosing Appear closes the X-ray");
  await waitFor(page, () => document.querySelectorAll(".animator .lane-row[data-track-id]").length >= 2, null, { label: "timeline lanes" });
  const lanes = await page.evaluate(() => {
    const deck = window.__flux.slide.currentDeck();
    const sid = window.__flux.get(window.__flux.fig.activeFigureId);
    const slide = deck.slides.find((s) => s.id === sid);
    const tracks = slide.beats.flatMap((b, i) => b.tracks.map((t) => ({ i, target: t.target, part: t.part, preset: t.preset })));
    return { tracks, lanes: document.querySelectorAll(".animator .lane-row[data-track-id]").length };
  });
  const mine = lanes.tracks.filter((t) => t.target === "xm-s" && t.part);
  ok(mine.length === 2 && mine.every((t) => t.i >= 1), `two part appearances landed on a build step (${mine.map((t) => t.part).join(", ")})`);
  ok(lanes.lanes >= 2, `…and the timeline shows them (${lanes.lanes} lanes)`);
  await shot(page, "xray-multi-02-animated");

  // The same axis picked through Common parts and its individual plot row
  // must not animate twice or inflate the chooser's target count.
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["xm-s", "xm-t"])));
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyR"); await page.keyboard.up("Alt");
  await page.waitForSelector('.xray .search-in');
  await page.click('.xray .search-in'); await page.type('.xray .search-in', 'X axis');
  await waitFor(page, () => document.querySelectorAll('.xray .row[data-kind="part"]').length >= 2);
  await clickRow("common", "X axis");
  await clickRow("part", "X axis", { metaKey: true });
  await page.$eval('.xray', (el) => el.focus());
  await page.keyboard.press('a');
  await waitFor(page, () => document.querySelector('.xray .am-ttl')?.textContent.includes('2 targets'));
  const beforeDuplicate = await page.evaluate(() => window.__flux.slide.currentDeck().slides.flatMap((s) => s.beats.flatMap((b) => b.tracks)).length);
  await page.keyboard.press('2');
  await waitForGone(page, '.xray');
  const afterDuplicate = await page.evaluate(() => window.__flux.slide.currentDeck().slides.flatMap((s) => s.beats.flatMap((b) => b.tracks)).length);
  ok(afterDuplicate - beforeDuplicate === 2, "common + individual rows add exactly two unique appearances");

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-XRAY-MULTI-GUI ALL PASS" : `\nVERIFY-XRAY-MULTI-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
