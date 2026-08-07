// Dissect viewer gate (browser, demo fixture): `d` on a selected plot opens the overlay on
// plots/_dissections/<key>/ — group tabs (loose files = the · default group, subfolders =
// named groups), windowed image grid, Enter → detail with fit/1:1 zoom, CSV rendered as a
// real table (sticky header, sortable, numeric right-align), Esc ladder (detail → grid →
// closed), the keyboard modal while open (tool keys must NOT leak to the canvas), the
// empty-state create-folder affordance, and live re-list on a dissections watcher bump.
//   Run (dev server on :1420 must be up): node scripts/verify-dissect-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg, extra = "") =>
  cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : "")));

const ROOT = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Figure");
await sleep(700);

// ---- seed a plot + its dissection tree ------------------------------------------
await page.evaluate(async (root) => {
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="48pt" viewBox="0 0 72 48"><rect width="72" height="48" fill="${fill}"/></svg>`;
  const D = `${root}/plots/_dissections/growth-cal`;
  await window.fig.writeText(`${root}/plots/growth-cal.svg`, svg("#d95f02"));
  await window.fig.writeText(`${root}/plots/bravo-nodiss.svg`, svg("#1b9e77"));
  // loose files → the default (·) group
  await window.fig.writeText(`${D}/overview.svg`, svg("#7570b3"));
  await window.fig.writeText(`${D}/methods-note.md`, "# notes\n");
  // a named group of per-subject panels
  for (let i = 1; i <= 5; i++) await window.fig.writeText(`${D}/by_subject/subj0${i}.svg`, svg("#e7298a"));
  // a sidecar that must NOT be listed
  await window.fig.writeText(`${D}/by_subject/subj01.fluxplot.json`, "{}");
  // stats as CSV
  await window.fig.writeText(`${D}/_stats/anova.csv`, "term,estimate,p\nintake,0.42,0.003\nexercise,-0.11,0.2\nage,0.05,0.71\n");
}, ROOT);

const snap = () =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      open: !!q("[data-dissect]"),
      empty: !!q("[data-dissect-empty]"),
      createBtn: !!q("[data-dissect-create]"),
      tabs: [...document.querySelectorAll("[data-dissect-tab]")].map((t) => t.getAttribute("data-dissect-tab")),
      cells: [...document.querySelectorAll("[data-dissect-cell]")].map((c) => ({
        name: c.getAttribute("data-name"),
        kind: c.getAttribute("data-kind"),
        selected: c.classList.contains("selected"),
        hasImg: !!c.querySelector("img"),
      })),
      detail: !!q("[data-dissect-detail]"),
      detailImg: !!q("[data-dissect-detail] img"),
      zoomLabel: q("[data-dissect-zoom]")?.textContent?.trim() ?? "",
      table: !!q("[data-dissect-table]"),
      tableHeader: [...document.querySelectorAll("[data-dissect-table] .hcell .ht")].map((n) => n.textContent),
      tableFirstRow: [...(document.querySelector("[data-dissect-table] .row")?.querySelectorAll(".cell") ?? [])].map(
        (n) => n.textContent,
      ),
      numAligned: [...(document.querySelector("[data-dissect-table] .row")?.querySelectorAll(".cell.num") ?? [])].length,
      tool: window.__flux.get(window.__flux.fig.activeTool),
    };
  });

// ---- open on a plot with dissections --------------------------------------------
await page.evaluate(async (root) => {
  await window.__flux.io.importPlotsFromPaths([`${root}/plots/growth-cal.svg`]);
}, ROOT);
await sleep(400);
await page.keyboard.press("d");
await sleep(600); // listing + first image decodes
let s = await snap();
ok(s.open, "d on a selected plot opens the Dissect overlay");
ok(
  JSON.stringify(s.tabs) === JSON.stringify(["·", "_stats", "by_subject"]),
  "groups: loose files = · default, subfolders alphabetical",
  s.tabs.join(","),
);
ok(
  s.cells.some((c) => c.name === "overview.svg" && c.kind === "image" && c.hasImg),
  "default group shows the loose image, decoded",
);
ok(
  s.cells.some((c) => c.name === "methods-note.md" && c.kind === "other"),
  "a .md is listed as a name card (no viewer yet)",
);

// ---- modality: tool keys must not leak beneath ----------------------------------
await page.keyboard.press("r"); // rect tool if it leaked
s = await snap();
ok(s.tool === "select", "keyboard is modal — tool keys don't reach the canvas", s.tool);

// ---- grid nav + image detail ----------------------------------------------------
// Default group sorts [methods-note.md, overview.svg] — ArrowRight lands on the image.
await page.keyboard.press("ArrowRight");
s = await snap();
ok(s.cells.some((c) => c.selected && c.name === "overview.svg"), "arrows move the grid selection", JSON.stringify(s.cells));
await page.keyboard.press("Enter");
await sleep(400);
s = await snap();
ok(s.detail && s.detailImg, "Enter expands the image into the detail view");
ok(s.zoomLabel === "fit", `detail opens at fit (${s.zoomLabel})`);
await page.keyboard.press("Enter"); // toggle 1:1
s = await snap();
ok(s.zoomLabel === "100%", `Enter toggles fit → 1:1 (${s.zoomLabel})`);
await page.keyboard.press("0");
s = await snap();
ok(s.zoomLabel === "fit", `0 resets to fit (${s.zoomLabel})`);
await page.keyboard.press("Escape");
s = await snap();
ok(s.open && !s.detail, "Esc steps detail → grid (overlay stays open)");

// ---- the by_subject group + sidecar exclusion -----------------------------------
await page.click('[data-dissect-tab="by_subject"]');
await sleep(400);
s = await snap();
ok(s.cells.length === 5, `by_subject lists the 5 panels (${s.cells.length})`);
ok(!s.cells.some((c) => c.name?.endsWith(".fluxplot.json")), "sidecars are never listed as cells");

// ---- CSV → a real table ---------------------------------------------------------
await page.click('[data-dissect-tab="_stats"]');
await sleep(200);
await page.keyboard.press("Enter"); // the only file: anova.csv
await sleep(400);
s = await snap();
ok(s.table, "Enter on a CSV renders the table view");
ok(JSON.stringify(s.tableHeader) === JSON.stringify(["term", "estimate", "p"]), "header row is the sticky header", s.tableHeader.join(","));
ok(JSON.stringify(s.tableFirstRow) === JSON.stringify(["intake", "0.42", "0.003"]), "body cells render in file order", s.tableFirstRow.join(","));
ok(s.numAligned === 2, `numeric columns right-align (estimate + p, got ${s.numAligned})`);
await page.evaluate(() => {
  const h = [...document.querySelectorAll("[data-dissect-table] .hcell")];
  h[2]?.click(); // sort by p ascending
});
await sleep(150);
s = await snap();
ok(s.tableFirstRow[0] === "intake" && s.tableFirstRow[2] === "0.003", "header click sorts (p ascending: intake first)", s.tableFirstRow.join(","));
await page.evaluate(() => {
  const h = [...document.querySelectorAll("[data-dissect-table] .hcell")];
  h[2]?.click(); // → descending
});
await sleep(150);
s = await snap();
ok(s.tableFirstRow[0] === "age" && s.tableFirstRow[2] === "0.71", "second click flips the sort (p descending: age first)", s.tableFirstRow.join(","));

// ---- live re-list on a dissections watcher bump ---------------------------------
await page.keyboard.press("Escape"); // table → grid
await page.evaluate(async (root) => {
  await window.fig.writeText(`${root}/plots/_dissections/growth-cal/_stats/tukey.csv`, "a,b\n1,2\n");
  window.__fluxEmitFsChange({ subsystem: "dissections", path: `${root}/plots/_dissections/growth-cal/_stats/tukey.csv` });
}, ROOT);
await sleep(500);
s = await snap();
ok(
  s.cells.some((c) => c.name === "tukey.csv"),
  "an external write pops in live (dissections subsystem → re-list)",
  s.cells.map((c) => c.name).join(","),
);

// ---- Esc ladder closes ----------------------------------------------------------
await page.keyboard.press("Escape");
s = await snap();
ok(!s.open, "Esc from the grid closes the overlay");

// ---- empty state + create -------------------------------------------------------
await page.evaluate(async (root) => {
  await window.__flux.io.importPlotsFromPaths([`${root}/plots/bravo-nodiss.svg`]);
}, ROOT);
await sleep(400);
await page.keyboard.press("d");
await sleep(400);
s = await snap();
ok(s.open && s.empty && s.createBtn, "a plot without dissections gets the empty state + create affordance");
await page.click("[data-dissect-create]");
await sleep(300);
s = await snap();
ok(s.open && s.empty && !s.createBtn, "create makes the folder — now the empty-folder state (no button)");
const created = await page.evaluate(
  (root) => window.fig.exists(`${root}/plots/_dissections/bravo-nodiss`),
  ROOT,
);
ok(created, "the dissection root exists on disk after create");
await page.keyboard.press("Escape");

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
