// P5 — Library row multiselect + bulk add-to-project (LR-U2), driven for real in the headless
// harness (the demo fixture ships a small FluxLib, so the grid has selectable rows).
//   Run (dev server on :1420 must be up): node scripts/verify-p5-library-ui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Library").catch(() => {});
await sleep(1200);

const rowSel = ".grid .grow:not(.ghead) .gsel input";
const headSel = ".grow.ghead.selectable .gsel input";

const snap = () =>
  page.evaluate(() => {
    const rows = document.querySelectorAll(".grid .grow:not(.ghead)").length;
    const bar = document.querySelector(".selbar");
    const count = document.querySelector(".selcount")?.textContent?.trim() ?? "";
    const addBtn = document.querySelector(".selact");
    const checked = document.querySelectorAll(".grid .grow:not(.ghead) .gsel input:checked").length;
    const headChecked = !!document.querySelector(".grow.ghead.selectable .gsel input")?.checked;
    const selRows = document.querySelectorAll(".grid .grow.sel").length;
    return {
      rows,
      bar: !!bar,
      count,
      addPresent: !!addBtn,
      addDisabled: addBtn ? addBtn.disabled : null,
      addLabel: addBtn?.textContent?.trim() ?? "",
      checked,
      headChecked,
      selRows,
    };
  });

// --- baseline: selectable grid renders, nothing selected --------------------------------------
let s = await snap();
const N = s.rows;
assert(N >= 1, `Library grid has at least one selectable row (got ${N})`);
assert(!s.bar, "no selection bar before anything is selected");

// --- header select-all → every shown row selected (row-count-agnostic) ------------------------
await page.click(headSel);
await sleep(150);
s = await snap();
assert(s.count === `${N} selected`, `header select-all selects every shown row (${s.count})`);
assert(s.checked === N && s.headChecked, "all row checkboxes + the header checkbox read checked");
assert(s.addPresent, `the bar offers an "Add to project" action ("${s.addLabel}")`);
// The add-action's enabled state must be consistent with whether a project is open: the label
// says "(none open)" iff there's no project to receive the references.
const noneOpen = s.addLabel.includes("(none open)");
assert(s.addDisabled === noneOpen, `Add is ${noneOpen ? "disabled with no project" : "enabled for the open project"}`);

// --- header select-all again → deselects all --------------------------------------------------
await page.click(headSel);
await sleep(150);
s = await snap();
assert(!s.bar && s.checked === 0, "toggling header select-all again clears the selection");

// --- single-row select + Clear ----------------------------------------------------------------
await page.click(rowSel);
await sleep(150);
s = await snap();
assert(s.bar && s.count === "1 selected", `selecting one row shows the bar ("${s.count}")`);
assert(s.checked === 1 && s.selRows === 1, "the row checkbox + row .sel highlight reflect the selection");
await page.click(".selclear");
await sleep(150);
s = await snap();
assert(!s.bar && s.checked === 0, "Clear dismisses the bar and unchecks every row");

// --- keyboard: Space toggles the highlighted row ----------------------------------------------
await page.focus(".grid");
await page.keyboard.press(" ");
await sleep(150);
s = await snap();
assert(s.bar && s.count === "1 selected", "Space on the focused grid toggles the highlighted row into the selection");

const errs = realErrors(page);
await browser.close();
if (errs.length) {
  console.error("\nP5 LIBRARY UI VERIFY: FAIL — console errors:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
console.log("\nP5 LIBRARY UI VERIFY: PASS");
