// Dissect viewer gate (browser, demo fixture): `d` on a selected plot opens the overlay on
// plots/_dissections/<key>/ in the Plots rail's sections (Summary tables, the loose images as
// Overview, one section per subfolder, Other files; 1–9 jump between them), windowed grid, Enter → detail with fit/1:1 zoom, CSV rendered as a
// real table (sticky header, sortable, numeric right-align), Esc ladder (detail → grid →
// closed), the keyboard modal while open (tool keys must NOT leak to the canvas), the
// empty-state create-folder affordance, and live re-list on a dissections watcher bump.
//   Run (dev server on :1420 must be up): node scripts/verify-dissect-gui.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

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
      sections: [...document.querySelectorAll("[data-dissect-grid] .section-head[data-section]")].map((t) => t.getAttribute("data-section")),
      cells: [...document.querySelectorAll("[data-dissect-cell]")].map((c) => ({
        name: c.getAttribute("data-name"),
        kind: c.getAttribute("data-kind"),
        group: c.getAttribute("data-group"),
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
      inspBtn: !!q("[data-dissect-open]"),
      inspCount: q("[data-dissect-open] .dcount")?.textContent?.trim() ?? "",
    };
  });

// ---- open on a plot with dissections --------------------------------------------
await page.evaluate(async (root) => {
  await window.__flux.io.importPlotsFromPaths([`${root}/plots/growth-cal.svg`]);
}, ROOT);
await sleep(400);
await page.keyboard.press("d");
await page.waitForFunction(() => document.querySelector('[data-dissect-cell][data-name="overview.svg"] img'), { timeout: 10000 }).catch(() => {});
let s = await snap();
ok(s.open, "d on a selected plot opens the Dissect overlay");
ok(
  JSON.stringify(s.sections) === JSON.stringify(["summary", "images:", "images:by_subject", "other"]),
  "sections: Summary tables, loose images (Overview), subfolders alphabetical, Other files",
  s.sections.join(","),
);
ok(
  s.cells.some((c) => c.name === "overview.svg" && c.kind === "image" && c.group === "" && c.hasImg),
  "Overview shows the loose image, decoded",
);
ok(
  s.cells.some((c) => c.name === "methods-note.md" && c.kind === "other"),
  "a .md is listed as a name card (no viewer yet)",
);
ok(s.inspBtn && s.inspCount === "8", `Inspector shows the Dissections button with its count (${s.inspCount || "none"})`);

// ---- modality: tool keys must not leak beneath ----------------------------------
await page.keyboard.down("Alt");await page.keyboard.press("r");await page.keyboard.up("Alt"); // rect tool if it leaked
s = await snap();
ok(s.tool === "select", "keyboard is modal — tool keys don't reach the canvas", s.tool);

// ---- grid nav + image detail ----------------------------------------------------
// Reading order is anova.csv (Summary, selected on open) → overview.svg — ArrowRight lands on the image.
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

// ---- the by_subject section + sidecar exclusion ---------------------------------
await page.keyboard.press("3"); // the third section: by_subject
await sleep(200);
s = await snap();
const bySubject = s.cells.filter((c) => c.group === "by_subject");
ok(bySubject.length === 5 && bySubject.every((c) => c.kind === "image"), `by_subject lists the 5 panels (${bySubject.length})`);
ok(s.cells.some((c) => c.selected && c.name === "subj01.svg"), "3 jumps to the by_subject section's first panel", JSON.stringify(s.cells.filter((c) => c.selected)));
ok(!s.cells.some((c) => c.name?.endsWith(".fluxplot.json")), "sidecars are never listed as cells");

// ---- CSV → a real table ---------------------------------------------------------
await page.keyboard.press("1"); // Summary: anova.csv
await sleep(200);
await page.keyboard.press("Enter");
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

// ---- large real table: prefix is useful while counting, sorting paints ≤100ms ---
await page.keyboard.press("Escape");
await page.evaluate(async root=>{
  const filename=`${root}/plots/_dissections/growth-cal/_stats/dense.csv`;
  const csv='name,value,p\n'+Array.from({length:200000},(_,i)=>`subject${200000-i},${i},0.05`).join('\n');
  await window.fig.writeText(filename,csv);
  window.__fluxEmitFsChange({subsystem:'dissections',path:filename});
},ROOT);
await page.waitForSelector('[data-dissect-cell][data-name="dense.csv"]');
await page.click('[data-dissect-cell][data-name="dense.csv"]');
await page.evaluate(()=>{
  window.__dissectFrames=[];window.__dissectTracking=true;let previous=performance.now();
  const frame=now=>{if(!window.__dissectTracking)return;window.__dissectFrames.push(now-previous);previous=now;requestAnimationFrame(frame);};requestAnimationFrame(frame);
});
await page.keyboard.press('Enter');
await page.waitForFunction(()=>!!document.querySelector('[data-dissect-table] .row'));
const prefix=await page.evaluate(()=>({note:document.querySelector('[data-dissect-table] .note')?.textContent,rows:document.querySelectorAll('[data-dissect-table] .row').length}));
ok(prefix.note?.includes('counting')&&prefix.rows>0,'large CSV paints a windowed prefix while its exact row count is pending',JSON.stringify(prefix));
await page.waitForFunction(()=>document.querySelector('[data-dissect-table] .note')?.textContent.includes('200,000'),{timeout:15000});
const load=await page.evaluate(()=>{window.__dissectTracking=false;return {worstFrameMs:Math.max(...window.__dissectFrames),frames:window.__dissectFrames.length,note:document.querySelector('[data-dissect-table] .note')?.textContent,rendered:document.querySelectorAll('[data-dissect-table] .row').length};});
ok(load.frames>2&&load.worstFrameMs<=100,'large CSV counting yields within100ms frame budget',JSON.stringify(load));
ok(load.note.includes('5,000')&&load.rendered<100,'retained rows and rendered DOM stay bounded for200000 records',JSON.stringify(load));
const sort=await page.evaluate(()=>new Promise(resolve=>{
  const start=performance.now();document.querySelector('[data-dissect-table] .hcell').click();
  requestAnimationFrame(()=>resolve({ms:performance.now()-start,first:document.querySelector('[data-dissect-table] .row .cell')?.textContent}));
}));
ok(sort.ms<=100&&sort.first==='subject195001','5000-string prefix sort paints correct order within100ms',JSON.stringify(sort));
const noticeVisible=await page.$eval('[data-dissect-table] .note',el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.width>0;});
ok(noticeVisible,'prefix limitation is visibly present without scrolling to the final retained row');
await writeFile(path.join(process.env.FLUX_OUT??'test-results/out','dissect-dense.json'),JSON.stringify({records:200000,prefix,load,sort,noticeVisible},null,2)+'\n');
await shot(page,'dissect-dense-table');

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

// ---- 2026-11-18 rebuild: the rolodex, results read as sentences, numbers as a reader wants them ----
// A statistics table in fluxplot's _stats shape arrives live, like the one above.
await page.evaluate(async (root) => {
  const file = `${root}/plots/_dissections/growth-cal/_stats/ttest.csv`;
  await window.fig.writeText(file, "sig_test_used,test_statistic_value,p-value,p_corrected_holm,dof,effect_size_method,effect_size_value,effect_size_ci_low,effect_size_ci_high,n_total,groups\nPaired t-test,6.596349872904714,3.8829874339838984e-05,7.765974867967797e-05,11.0,Hedges' g_z,1.7713508719955768,0.9222804075578142,2.8575306535839893,12,\"['open', 'laparoscopic']\"\n");
  window.__fluxEmitFsChange({ subsystem: "dissections", path: file });
}, ROOT);
await page.waitForSelector('[data-dissect-cell][data-name="ttest.csv"]');
// The grid's own card already shows the rounded value with its marks, the file's text in the tooltip.
const card = await page.$eval('[data-dissect-cell][data-name="ttest.csv"]', (cell) => {
  const p = [...cell.querySelectorAll(".td, .v")].find((n) => n.dataset.sig);
  return p ? { text: p.textContent, marks: getComputedStyle(p, "::after").content, raw: p.title } : null;
});
ok(card?.text === "3.9 × 10⁻⁵" && card.marks === '"***"' && card.raw === "3.8829874339838984e-05", "a table card shows a p-value rounded, with its marks, and keeps the file's text in the tooltip", JSON.stringify(card));
await page.click('[data-dissect-cell][data-name="ttest.csv"]');
await page.keyboard.press("Enter");
await page.waitForSelector("[data-dissect-report]");
const read = await page.evaluate(() => {
  const report = document.querySelector("[data-dissect-report]"), row = document.querySelector("[data-dissect-table] .row");
  const cells = [...row.querySelectorAll(".cell")];
  return { sentence: report.querySelector("li").textContent.replace(/\s+/g, " ").trim(), statistic: cells[1].textContent, statisticRaw: cells[1].title, p: cells[2].textContent, marks: getComputedStyle(cells[2], "::after").content,
    seg: [...document.querySelectorAll("[data-dissect-table] .seg button")].map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`) };
});
ok(/open vs laparoscopic/.test(read.sentence) && /t\(11\) = 6\.596/.test(read.sentence) && /p = 3\.9 × 10⁻⁵/.test(read.sentence) && /Holm 7\.8 × 10⁻⁵/.test(read.sentence) && /Hedges' g_z = 1\.771 \[0\.922, 2\.86\]/.test(read.sentence) && /n = 12/.test(read.sentence),
  "a statistics table is also read out as a result sentence", read.sentence);
ok(read.statistic === "6.596" && read.statisticRaw === "6.596349872904714" && read.p === "3.9 × 10⁻⁵" && read.marks === '"***"', "long numbers are rounded in the table; the tooltip keeps what the file says; p-values carry their marks", JSON.stringify(read));
ok(JSON.stringify(read.seg) === JSON.stringify(["Rounded:true", "As written:false"]), "Rounded is the default of the two ways to show numbers", JSON.stringify(read.seg));
await page.evaluate(() => [...document.querySelectorAll("[data-dissect-table] .seg button")].find((b) => b.textContent === "As written").click());
await page.waitForFunction(() => document.querySelector("[data-dissect-table] .row .cell:nth-child(2)")?.textContent === "6.596349872904714");
ok(true, "As written shows every cell exactly as the file has it");
await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text) => { window.__copied.push(text); } }); });
await page.evaluate(() => document.querySelector("[data-dissect-report] .copy").click());
await page.waitForFunction(() => window.__copied.length === 1);
ok(await page.evaluate(() => window.__copied[0] === "open vs laparoscopic: Paired t-test: t(11) = 6.596, p = 3.9 × 10⁻⁵ (Holm 7.8 × 10⁻⁵), Hedges' g_z = 1.771 [0.922, 2.86], n = 12"), "Copy puts the sentence on the clipboard, ready for a results section");
// The rolodex: every file in one strip under the open one; the keys flip without leaving it.
const strip = async () => page.evaluate(() => {
  const el = document.querySelector("[data-dissect-strip]"), current = el?.querySelector(".item.current");
  const box = el?.getBoundingClientRect(), c = current?.getBoundingClientRect();
  return { there: !!el, current: current?.dataset.stripItem ?? "", centred: !!box && !!c && (Math.abs(c.left + c.width / 2 - (box.left + box.width / 2)) < 60 || el.scrollLeft === 0 || el.scrollLeft >= el.scrollWidth - el.clientWidth - 1),
    groups: [...(el?.querySelectorAll(".group") ?? [])].map((g) => g.textContent), open: document.querySelector(".opened .fname")?.textContent ?? "", detail: !!document.querySelector("[data-dissect-detail]"), pos: document.querySelector(".opened .pos")?.textContent ?? "" };
});
let st = await strip();
ok(st.there && st.detail && st.current === "ttest.csv" && st.open === "ttest.csv" && st.centred, "an open file has the strip of all files under it, itself marked and in view", JSON.stringify(st));
ok(st.groups.includes("Summary") && st.groups.includes("by_subject"), "the strip names where each group starts", st.groups.join(","));
const before = st.pos;
await page.keyboard.press("ArrowRight");
st = await strip();
ok(st.detail && st.open !== "ttest.csv" && st.current === st.open && st.pos !== before, "→ flips to the next file and stays in the open view", JSON.stringify(st));
await page.keyboard.press("ArrowLeft");
st = await strip();
ok(st.open === "ttest.csv", "← flips back");
await page.keyboard.press("ArrowDown");
st = await strip();
const afterDown = st.open;
ok(st.detail && afterDown === "overview.svg", "↓ steps to the next group's first file", afterDown);
await page.keyboard.press("3");
st = await strip();
ok(st.detail && st.open === "subj01.svg", "a digit opens that section's first file without going back to the grid", st.open);
await page.keyboard.press("End");
st = await strip();
const last = st.open;
await page.keyboard.press("Home");
st = await strip();
ok(st.detail && last !== st.open && /^1 of /.test(st.pos.trim()), "End and Home go to the last and the first file", `${last} → ${st.open} (${st.pos})`);
await page.click('[data-dissect-strip] [data-strip-item="subj02.svg"]').catch(() => {});
st = await strip();
ok(st.open === "subj02.svg" && st.current === "subj02.svg", "a click in the strip opens that file", st.open);
ok(await page.evaluate(() => [...document.querySelectorAll("[data-dissect] *")].flatMap((e) => e.getAnimations()).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length === 0), "nothing in the viewer animates at rest");
await shot(page, "dissect-rolodex");
await page.keyboard.press("Escape"); // open file → grid

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
