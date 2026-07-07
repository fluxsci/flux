// Library actions — column sorting, modifier clicks (Ctrl = details, Ctrl+Shift = read/fetch
// PDF, Alt = open DOI), delete-with-undo (Alt+Del + checkbox bulk), and Alt+F fetch-checked.
// Drives the real Library over the demo fixture's in-memory FS: seeds a 4-entry FluxLib
// (+ enrich sidecar + one on-disk PDF), then exercises each feature end-to-end.
//   Run (dev server on :1420 must be up): node scripts/verify-lib-actions.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const pdfB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

const BIB = `% FluxLib — verify fixture
@article{smith2021,
  title = {Nutrient stress responses in filamentous fungi},
  author = {Smith, Jane and Doe, John},
  journal = {Journal of Mycology},
  year = {2021},
  doi = {10.1234/jmyc.2021.0045},
}

@article{abel2019,
  title = {Amber pathways in yeast},
  author = {Abel, Ada},
  journal = {Nature Fungi},
  year = {2019},
  doi = {10.9999/nf.2019.1},
}

@article{zorro2023,
  title = {Zygomycete cell walls},
  author = {Zorro, Zed},
  journal = {Zeitschrift für Pilze},
  year = {2023},
  doi = {10.9999/zp.2023.7},
}

@article{nodoi2020,
  title = {Mushroom kinetics without identifiers},
  author = {Miller, Mo},
  journal = {Fungal Letters},
  year = {2020},
}
`;

const ENRICH = {
  smith2021: { key: "smith2021", citedByCount: 50, fetchedAt: "2026-01-01", sources: ["openalex"] },
  abel2019: { key: "abel2019", citedByCount: 5, fetchedAt: "2026-01-01", sources: ["openalex"] },
  zorro2023: { key: "zorro2023", citedByCount: 500, fetchedAt: "2026-01-01", sources: ["openalex"] },
};

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });

// Seed the machine-global FluxLib (mem-FS) BEFORE entering Library, so its mount-reload
// sees it: 4 bib entries, the enrich sidecar, and one already-on-disk PDF (zorro2023).
await page.evaluate(
  async (bib, enrich, b64) => {
    const fig = window.fig;
    await fig.writeText("/home/demo/FluxLib/library.bib", bib);
    await fig.writeText("/home/demo/FluxLib/.fluxlib/enrich.json", JSON.stringify(enrich));
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await fig.writeFile("/home/demo/FluxLib/items/zorro2023/paper.pdf", bytes);
    // Seed the reader-side fixture too, so opening zorro2023 renders a real PDF.
    window.__fluxSeedReaderItem?.("zorro2023", b64);
  },
  BIB,
  ENRICH,
  pdfB64,
);
await clickMode(page, "Library");
await sleep(1200);

const ROWS = ".lib .grid .grow:not(.ghead)";
const rows = () =>
  page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((r) => ({
      author: r.querySelector(".ga")?.textContent?.trim() ?? "",
      year: r.querySelector(".gy")?.textContent?.trim() ?? "",
    }));
  }, ROWS);
const clickHeader = (label) =>
  page.evaluate((lbl) => {
    const b = [...document.querySelectorAll(".lib .hcol")].find((e) => e.textContent.trim().startsWith(lbl));
    if (!b) throw new Error("no header " + lbl);
    b.click();
  }, label);
const headerArrow = () =>
  page.evaluate(() => {
    const s = document.querySelector(".lib .hcol .sarr");
    return s ? { col: s.closest(".hcol").textContent.replace(/[▲▼]/g, "").trim(), dir: s.textContent } : null;
  });
const modClick = async (rowIdx, mods) => {
  const handles = await page.$$(ROWS);
  if (!handles[rowIdx]) throw new Error("no row " + rowIdx);
  for (const m of mods) await page.keyboard.down(m);
  await handles[rowIdx].click();
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
  await sleep(300);
};
const libToast = () => page.evaluate(() => document.querySelector(".lib .toast")?.textContent?.trim() ?? "");

// --- baseline: 4 seeded rows in file order -----------------------------------------------------
let r = await rows();
assert(r.length === 4, `4 seeded rows render (got ${r.length})`);
assert(r.map((x) => x.year).join(",") === "2021,2019,2023,2020", `natural file order first (${r.map((x) => x.year)})`);
assert((await headerArrow()) === null, "no sort arrow before any header click");

// --- sorting -----------------------------------------------------------------------------------
await clickHeader("Year");
await sleep(250);
r = await rows();
assert(r.map((x) => x.year).join(",") === "2023,2021,2020,2019", "click Year → newest first (desc)");
let a = await headerArrow();
assert(a && a.col === "Year" && a.dir === "▼", `arrow marks Year desc (${JSON.stringify(a)})`);
await clickHeader("Year");
await sleep(250);
r = await rows();
assert(r.map((x) => x.year).join(",") === "2019,2020,2021,2023", "click Year again → reversed (asc)");
a = await headerArrow();
assert(a && a.dir === "▲", "arrow flips to asc");
await clickHeader("Cited");
await sleep(250);
r = await rows();
const firstAuthors = () => r.map((x) => x.author.split(",")[0].trim()).join("|");
assert(
  firstAuthors() === "Zorro|Smith|Abel|Miller",
  `click Cited → most-cited first, no-enrich last (${firstAuthors()})`,
);
await clickHeader("Authors");
await sleep(250);
r = await rows();
assert(firstAuthors() === "Abel|Miller|Smith|Zorro", `click Authors → A→Z by first author (${firstAuthors()})`);

// --- Ctrl+click toggles the detail strip --------------------------------------------------------
const detailCount = () => page.evaluate(() => document.querySelectorAll(".lib .detail").length);
await modClick(0, ["Control"]);
assert((await detailCount()) === 1, "Ctrl+click opens the row's detail strip");
await modClick(0, ["Control"]);
assert((await detailCount()) === 0, "Ctrl+click again closes it");

// --- Alt+click opens the DOI externally ---------------------------------------------------------
await page.evaluate(() => {
  window.__ext = [];
  window.fig.openExternal = (u) => {
    window.__ext.push(u);
  };
});
await modClick(0, ["Alt"]); // Abel — has a DOI
const ext = await page.evaluate(() => window.__ext);
assert(
  ext.length === 1 && ext[0] === "https://doi.org/10.9999/nf.2019.1",
  `Alt+click opens the DOI in the browser (${ext[0]})`,
);
await modClick(1, ["Alt"]); // Miller — no DOI
assert(/no doi/i.test(await libToast()), `Alt+click without a DOI explains itself ("${await libToast()}")`);
await sleep(3800); // let that toast clear

// --- Ctrl+Shift+click: fetch-then-read (miss path) ---------------------------------------------
await page.evaluate(() => {
  window.fig.netGet = async () => ({ error: "HTTP 404", status: 404 });
});
await modClick(0, ["Control", "Shift"]); // Abel — no PDF, every route 404s
await sleep(1500);
assert(/no open-access pdf/i.test(await libToast()), `failed fetch surfaces the reason ("${await libToast()}")`);

// --- Ctrl+Shift+click: PDF on disk → opens the reader -------------------------------------------
await modClick(3, ["Control", "Shift"]); // Zorro — paper.pdf seeded
await sleep(1500);
const readerVisible = () =>
  page.evaluate(() => {
    const mc = document.querySelector(".mc:not(.hidden)");
    return !!mc?.querySelector(".reader");
  });
assert(await readerVisible(), "Ctrl+Shift+click on a row with a PDF opens FluxReader");
await clickMode(page, "Library");
await sleep(600);

// --- Alt+Del deletes the highlighted row, toast Undo restores it --------------------------------
// (the Ctrl+Shift+click above left Zorro highlighted)
await page.keyboard.down("Alt");
await page.keyboard.press("Delete");
await page.keyboard.up("Alt");
await sleep(700);
r = await rows();
assert(r.length === 3, `Alt+Del removes the highlighted row (${r.length} left)`);
assert(!r.some((x) => x.author.startsWith("Zorro")), "…and it was the highlighted one (Zorro)");
const undoByText = (frag) =>
  page.evaluate((f) => {
    const t = [...document.querySelectorAll(".toasts .toast")].find((e) => e.textContent.includes(f));
    const b = t?.querySelector(".t-act");
    if (!b) return false;
    b.click();
    return true;
  }, frag);
assert(await undoByText("Deleted 1 reference"), "delete toast offers Undo");
await sleep(700);
r = await rows();
assert(r.length === 4 && r.some((x) => x.author.startsWith("Zorro")), "Undo restores the reference");

// --- checkbox multi-select + Delete N ------------------------------------------------------------
const clickRowCheckbox = async (idx) => {
  const handles = await page.$$(ROWS);
  const cb = await handles[idx].$(".gsel input");
  await cb.click();
  await sleep(150);
};
await clickRowCheckbox(0); // Abel
await clickRowCheckbox(1); // Miller
const delLabel = await page.evaluate(() => document.querySelector(".seldel")?.textContent?.trim() ?? "");
assert(delLabel === "Delete 2", `selection bar shows "${delLabel}"`);
await page.click(".seldel");
await sleep(700);
r = await rows();
assert(r.length === 2, `bulk delete removes both checked rows (${r.length} left)`);
assert(await undoByText("Deleted 2 references"), "bulk-delete toast offers Undo");
await sleep(700);
r = await rows();
assert(r.length === 4, "Undo restores both");

// --- Alt+F runs the PDF pipeline on just the checked rows ----------------------------------------
// Abel + Smith: both have DOIs (Miller wouldn't be fetchable), neither has a PDF on disk.
await clickRowCheckbox(0);
await clickRowCheckbox(2);
await page.keyboard.down("Alt");
await page.keyboard.press("f");
await page.keyboard.up("Alt");
let summary = "";
for (let i = 0; i < 40; i++) {
  await sleep(250);
  summary = await libToast();
  if (/fetched/i.test(summary)) break;
}
assert(/fetched 0/i.test(summary), `Alt+F ran the fetch pipeline over the checked rows ("${summary}")`);
assert(/2 need library sign-in/.test(summary), "…and over exactly the 2 checked references");

const errs = realErrors(page);
await browser.close();
if (errs.length) {
  console.error("\nLIB ACTIONS VERIFY: FAIL — console errors:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
console.log("\nLIB ACTIONS VERIFY: PASS");
