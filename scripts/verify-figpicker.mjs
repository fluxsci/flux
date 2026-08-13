// FigurePicker at project scale (issue #10): with MANY figures the height-
// constrained grid used to COMPRESS every row to fit — .cell{overflow:hidden}
// zeroes each grid item's automatic minimum size, so cells clipped to ~30px
// slivers (no thumbnails, no names) and the scrollbar never appeared. Verifies
// the row floor (grid-auto-rows: max-content): full-size cells, a genuinely
// scrolling grid, keyboard selection following the scroll — plus the canvas
// scope dropdown: filters to one canvas, search composes within it, and the
// picker still inserts.
//   Run (dev server on :1420 must be up): node scripts/verify-figpicker.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, waitForSelector, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-figpicker");
const { browser, page } = await launch({ width: 1600, height: 1000 });
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 3000 });
  await clickMode(page, "Paper").catch(() => {});
  await waitFor(page, () => !!(window.__flux?.editors ?? [])[0], null, { timeout: 15000, label: "paper editor mounted" });

  // 46 wide panel-strip figures (the reported shape) across two canvases.
  await page.evaluate(() => {
    const strip = (i) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="240" viewBox="0 0 1000 240">` +
      [0, 1, 2, 3].map((k) =>
        `<ellipse cx="${140 + k * 240}" cy="120" rx="100" ry="70" fill="${k % 2 ? "#d97706" : "#0f766e"}"/>`).join("") +
      `<text x="500" y="30" text-anchor="middle" font-size="18">Panel strip ${i}</text></svg>`;
    const refs = [], figs = {}, data = {};
    for (let i = 1; i <= 46; i++) {
      const id = `fig${i}`;
      data[`a${i}`] = `data:image/svg+xml;base64,${btoa(strip(i))}`;
      refs.push({ id, label: `fig-${id}`, name: `Figure ${i}`, family: "figure", number: i,
        display: `Fig. ${i}`, captionLabel: `Figure ${i} | `, order: i,
        canvas: i <= 20 ? "c1" : "c2", caption: `strip caption ${i}`, panels: [] });
      figs[id] = { id, name: `F${i}`, width: 1000, height: 240,
        elements: [{ type: "plot", id: `pl${i}`, assetId: `a${i}`, x: 0, y: 0, width: 1000, height: 240, rotation: 0, overrides: {} }] };
    }
    window.__fluxSeedFigures(refs, figs, data, [], {}, [],
      [{ id: "c1", name: "Main figures" }, { id: "c2", name: "Supplement" }]);
    const view = (window.__flux?.editors ?? [])[0];
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "\n\n" }, selection: { anchor: end + 2 } });
    view.focus();
  });

  h.section("open at scale");
  await page.keyboard.type("/figure", { delay: 40 });
  // Enter accepts the completion only once the option is the SELECTED one —
  // waiting for the label alone raced the list's async selection update.
  await waitFor(page, () => {
    const sel = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel');
    return sel?.textContent === "/figure";
  }, null, { timeout: 5000, label: "/figure option selected" });
  // debounce: 120ms — CodeMirror autocomplete's interactionDelay (75ms) ignores
  // an accept that lands right after the list updates; Enter inside that window
  // falls through to the editor as a newline and the picker never opens.
  await sleep(120);
  await page.keyboard.press("Enter");
  await waitForSelector(page, ".picker .cell", { timeout: 8000, label: "picker cells" });
  await sleep(400); // popIn transition settles before geometry reads

  const m = await page.evaluate(() => {
    const grid = document.querySelector(".picker .grid");
    const cell = document.querySelector(".picker .cell");
    const meta = document.querySelector(".picker .meta");
    return {
      cells: document.querySelectorAll(".picker .cell").length,
      cellH: cell ? Math.round(cell.getBoundingClientRect().height) : 0,
      metaH: meta ? Math.round(meta.getBoundingClientRect().height) : 0,
      metaText: meta?.textContent?.trim() ?? "",
      scrollH: grid?.scrollHeight ?? 0,
      clientH: grid?.clientHeight ?? 0,
    };
  });
  h.ok(m.cells === 46, `all 46 figures render as cells (got ${m.cells})`);
  h.ok(m.cellH >= 150, `cells keep full thumb+meta height, never slivers (got ${m.cellH}px)`);
  h.ok(m.metaH > 20 && m.metaText.includes("Fig. 1"), `figure name visible in the meta bar (got "${m.metaText}")`);
  h.ok(m.scrollH > m.clientH + 200, `grid overflows and scrolls (scroll ${m.scrollH} vs client ${m.clientH})`);

  const reach = await page.evaluate(() => {
    const grid = document.querySelector(".picker .grid");
    grid.scrollTop = grid.scrollHeight;
    const last = document.querySelector('.picker .cell[data-i="45"]');
    const gr = grid.getBoundingClientRect();
    const lr = last?.getBoundingClientRect();
    return !!lr && lr.bottom <= gr.bottom + 8 && lr.height >= 150;
  });
  h.ok(reach, "scrolling reaches the last cell at full size");

  await page.evaluate(() => { document.querySelector(".picker .grid").scrollTop = 0; });
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowDown");
  await waitFor(page, () => {
    const selCell = document.querySelector(".picker .cell.sel");
    const grid = document.querySelector(".picker .grid");
    if (!selCell || !grid) return false;
    const gr = grid.getBoundingClientRect();
    const sr = selCell.getBoundingClientRect();
    return sr.top >= gr.top - 4 && sr.bottom <= gr.bottom + 4;
  }, null, { timeout: 3000, label: "keyboard selection scrolled into view" });
  h.ok(true, "keyboard selection stays scrolled into view across the list");

  h.section("canvas scope");
  h.ok(await page.evaluate(() => !!document.querySelector(".picker .canvas-scope")),
    "canvas dropdown present with 2 canvases");
  await page.select(".picker .canvas-scope", "c2");
  await waitFor(page, () => document.querySelectorAll(".picker .cell").length === 26, null,
    { timeout: 3000, label: "canvas scope filter" });
  const first = await page.evaluate(() => document.querySelector(".picker .meta")?.textContent?.trim() ?? "");
  h.ok(first.includes("Fig. 21"), `scope shows only that canvas, from its first figure (got "${first}")`);

  await page.click(".picker .search");
  await page.keyboard.type("Figure 3", { delay: 30 });
  await waitFor(page, () => document.querySelectorAll(".picker .cell").length === 10, null,
    { timeout: 3000, label: "composed filter" });
  const composed = await page.evaluate(() =>
    [...document.querySelectorAll(".picker .meta b")].map((b) => b.textContent.trim()));
  h.ok(composed.every((t) => /Fig\. 3\d/.test(t)),
    `search composes within the scoped canvas (got ${JSON.stringify(composed.slice(0, 3))}…)`);

  await page.select(".picker .canvas-scope", "");
  await waitFor(page, () => document.querySelectorAll(".picker .cell").length === 11, null,
    { timeout: 3000, label: "unscoped search set" });
  h.ok(true, "clearing the scope restores the full search set (Fig. 3 + 30–39)");

  h.section("insert still works");
  await page.evaluate(() => document.querySelector(".picker .search").focus());
  for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace");
  await waitFor(page, () => document.querySelectorAll(".picker .cell").length === 46, null,
    { timeout: 3000, label: "query cleared" });
  await page.keyboard.press("Enter");
  await waitFor(page, () => !document.querySelector(".picker"), null, { timeout: 3000, label: "picker closed" });
  h.ok(await page.evaluate(() =>
    (window.__flux?.editors ?? [])[0]?.state.doc.toString().includes("{#fig-fig1}")),
    "Enter inserts the selected figure's embed");

  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean (${errs.length ? errs[0].slice(0, 120) : "no errors"})`);
} finally {
  await browser.close();
}
await h.done();
