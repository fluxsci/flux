// 2.4 gate (browser) — the Import modal end-to-end against a seeded FluxLib. A DEV seam
// (window.__fluxImportText) stands in for the native file dialog so the renderer path is
// exercised headlessly: open the modal → format sniff (.bib AND .ris) → dedupe PREVIEW
// from the shared planner → commit → the grid reloads with the new rows → re-import is
// recognized as already-in-library (idempotent). PDF attach is covered by the CLI e2e.
//   Run (dev server on :1420 must be up): node scripts/verify-import-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg, extra = "") => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Library").catch(() => {});
await sleep(600);
await page.waitForFunction(() => !!window.__fluxSeedScaleLibrary, { timeout: 15000 });
await page.evaluate(() => window.__fluxSeedScaleLibrary(4));
await page.waitForFunction(() => document.querySelectorAll(".grid .grow:not(.ghead)").length >= 4, { timeout: 15000 }).catch(() => {});
const baseRows = await page.evaluate(() => document.querySelectorAll(".grid .grow:not(.ghead)").length);

const openImport = () => page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Import…")?.click());

// --- BibTeX import: two brand-new entries -----------------------------------------------
const BIB = `@article{feynman1948, title={Space-time approach to non-relativistic quantum mechanics}, author={Feynman, Richard}, year={1948}, journal={Rev Mod Phys}, doi={10.1103/x.1}}

@article{shannon1948, title={A mathematical theory of communication}, author={Shannon, Claude}, year={1948}, journal={Bell System Tech J}, doi={10.1002/x.2}}`;

await page.evaluate((text) => (window.__fluxImportText = { name: "refs.bib", text }), BIB);
await openImport();
await sleep(500);

let prev = await page.evaluate(() => ({
  header: document.querySelector(".ihf")?.textContent || "",
  newPill: document.querySelector(".pill.new")?.textContent?.trim() || "",
  rows: document.querySelectorAll(".rows li").length,
  hasImportBtn: !!document.querySelector(".if .prim"),
}));
ok(/BIBTEX/.test(prev.header), "sniffed as BibTeX", prev.header);
ok(prev.newPill === "2 new", `preview shows 2 new (${prev.newPill})`);
ok(prev.rows === 2, `preview lists both entries (${prev.rows})`);

// Commit.
await page.evaluate(() => document.querySelector(".if .prim")?.click());
await sleep(700);
const done = await page.evaluate(() => document.querySelector(".ok")?.textContent?.trim() || "");
ok(/Imported 2 reference/.test(done), `done state confirms the import (${done})`);

// Close and confirm the grid reloaded with the two new rows.
await page.evaluate(() => [...document.querySelectorAll(".if .ghost")].find((b) => b.textContent?.trim() === "Close")?.click());
await sleep(600);
const afterRows = await page.evaluate(() => document.querySelectorAll(".grid .grow:not(.ghead)").length);
ok(afterRows === baseRows + 2, `grid grew by 2 after import (${baseRows} → ${afterRows})`);

// --- idempotency: re-importing the same file shows them as already-in-library -----------
await page.evaluate((text) => (window.__fluxImportText = { name: "refs.bib", text }), BIB);
await openImport();
await sleep(500);
const re = await page.evaluate(() => ({
  newPill: document.querySelector(".pill.new")?.textContent?.trim() || "",
  mergedPill: document.querySelector(".pill.merged")?.textContent?.trim() || "",
  importDisabled: document.querySelector(".if .prim")?.disabled ?? null,
}));
ok(re.newPill === "0 new", `re-import: 0 new (${re.newPill})`);
ok(/2 already in library/.test(re.mergedPill), `re-import: 2 already present (${re.mergedPill})`);
ok(re.importDisabled === true, "re-import: the Import button is disabled (nothing new)");
await page.evaluate(() => [...document.querySelectorAll(".if .ghost")].find((b) => b.textContent?.trim() === "Cancel")?.click());
await sleep(300);

// --- RIS sniff --------------------------------------------------------------------------
const RIS = ["TY  - JOUR", "AU  - Dijkstra, Edsger", "TI  - A note on two problems in connexion with graphs", "PY  - 1959", "JO  - Numerische Mathematik", "DO  - 10.1007/x3", "ER  -"].join("\n");
await page.evaluate((text) => (window.__fluxImportText = { name: "one.ris", text }), RIS);
await openImport();
await sleep(500);
const ris = await page.evaluate(() => ({
  header: document.querySelector(".ihf")?.textContent || "",
  newPill: document.querySelector(".pill.new")?.textContent?.trim() || "",
  key: document.querySelector(".rows li .rk")?.textContent?.trim() || "",
}));
ok(/RIS/.test(ris.header), "sniffed as RIS", ris.header);
ok(ris.newPill === "1 new", `RIS preview shows 1 new (${ris.newPill})`);
ok(/^@dijkstra1959/.test(ris.key), `RIS entry got an AuthorYear key (${ris.key})`);
await page.evaluate(() => [...document.querySelectorAll(".if .ghost")].find((b) => b.textContent?.trim() === "Cancel")?.click());
await sleep(300);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors during import flow", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
