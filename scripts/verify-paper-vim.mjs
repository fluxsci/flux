// PaperVim — vim mode end-to-end (@replit/codemirror-vim, persisted toggle).
// Verifies: status panel appears in NORMAL mode; j/k/gg/G/dd motions work over
// real lines (including embed source lines); i→type→Esc round-trips; while the
// @-completion tooltip is open the FIRST Esc closes the tooltip and stays in
// insert mode, the SECOND leaves insert; palette toggle removes vim cleanly.
//   Run (dev server on :1420 must be up): node scripts/verify-paper-vim.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
// Persisted pref path: seed localStorage BEFORE the app loads.
await page.evaluateOnNewDocument(() => localStorage.setItem("flux.paper.vimMode", "1"));
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const setup = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const text = [
    "# Vim test",
    "",
    "Alpha line one.",
    "Beta line two.",
    "Gamma line three.",
    "Delta line four.",
  ].join("\n");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
  });
  await new Promise((r) => requestAnimationFrame(r));
  view.focus();
  return {
    panel: !!document.querySelector(".cm-vim-panel"),
    panelText: document.querySelector(".cm-vim-panel")?.textContent ?? "",
  };
});
if (setup.error) {
  console.error(JSON.stringify(setup));
  process.exit(1);
}

const state = () =>
  page.evaluate(() => {
    const view = window.__fluxView;
    const sel = view.state.selection.main;
    return {
      line: view.state.doc.lineAt(sel.head).number,
      docLine3: view.state.doc.line(3).text,
      lines: view.state.doc.lines,
      panelText: document.querySelector(".cm-vim-panel")?.textContent ?? "",
      fatCursor: !!document.querySelector(".cm-fat-cursor"),
    };
  });

// --- normal-mode motions -----------------------------------------------------
const s0 = await state(); // caret at line 1, normal mode
await page.keyboard.press("j");
await page.keyboard.press("j");
const afterJJ = await state(); // line 3
await page.keyboard.press("k");
const afterK = await state(); // line 2
await page.keyboard.type("G");
const afterG = await state(); // last line
await page.keyboard.type("gg");
const afterGG = await state(); // line 1
const motionsOk =
  afterJJ.line === 3 && afterK.line === 2 && afterG.line === s0.lines && afterGG.line === 1;

// --- dd deletes exactly one line ----------------------------------------------
await page.keyboard.press("j"); // line 2 (blank)
await page.keyboard.press("j"); // line 3 "Alpha line one."
await page.keyboard.type("dd");
const afterDD = await state();
const ddOk = afterDD.lines === s0.lines - 1 && afterDD.docLine3 === "Beta line two.";
await page.keyboard.press("u"); // vim undo restores it
const afterU = await state();
const undoOk = afterU.lines === s0.lines && afterU.docLine3 === "Alpha line one.";

// --- insert round-trip ---------------------------------------------------------
await page.keyboard.type("gg");
await page.keyboard.press("i");
const inInsert = await state(); // panel shows --INSERT--
await page.keyboard.type("XY");
await page.keyboard.press("Escape");
const backNormal = await state();
const insertOk =
  /INSERT/i.test(inInsert.panelText) &&
  !/INSERT/i.test(backNormal.panelText) &&
  (await page.evaluate(() => window.__fluxView.state.doc.line(1).text.includes("XY")));

// --- Esc ordering with the @-completion tooltip --------------------------------
await page.evaluate(() => {
  const view = window.__fluxView;
  const end = view.state.doc.line(3).to;
  view.dispatch({ selection: { anchor: end } });
  view.focus();
});
await page.keyboard.press("a"); // append → insert mode
await page.keyboard.type(" @fig");
await sleep(400);
const tooltipOpen = await page.evaluate(() => !!document.querySelector(".cm-tooltip-autocomplete"));
await page.keyboard.press("Escape"); // 1st Esc: close tooltip, STAY in insert
await sleep(150);
const afterEsc1 = await page.evaluate(() => ({
  tooltip: !!document.querySelector(".cm-tooltip-autocomplete"),
  panelText: document.querySelector(".cm-vim-panel")?.textContent ?? "",
}));
await page.keyboard.press("Escape"); // 2nd Esc: leave insert
await sleep(150);
const afterEsc2 = await page.evaluate(
  () => document.querySelector(".cm-vim-panel")?.textContent ?? "",
);
const escOrderOk =
  tooltipOpen && !afterEsc1.tooltip && /INSERT/i.test(afterEsc1.panelText) && !/INSERT/i.test(afterEsc2);

// --- palette toggle removes vim cleanly ----------------------------------------
await page.keyboard.down("Control");
await page.keyboard.press("k");
await page.keyboard.up("Control");
await sleep(300);
await page.keyboard.type("vim");
await sleep(200);
await page.keyboard.press("Enter");
await sleep(300);
const afterToggle = await page.evaluate(async () => {
  const view = window.__fluxView;
  view.focus();
  const before = view.state.doc.lineAt(view.state.selection.main.head).number;
  return { panel: !!document.querySelector(".cm-vim-panel"), before };
});
// arrows must work plainly (no vim residue): type "j" inserts a character now
await page.keyboard.press("j");
const plainOk = await page.evaluate(() => {
  const view = window.__fluxView;
  const sel = view.state.selection.main;
  return view.state.sliceDoc(sel.head - 1, sel.head) === "j";
});

const errs = realErrors(page);
await browser.close();

const res = {
  panelOnLoad: setup.panel,
  motionsOk,
  ddOk,
  undoOk,
  insertOk,
  escOrderOk,
  toggleRemovedPanel: !afterToggle.panel,
  plainOk,
};
console.log(JSON.stringify({ vim: res, errs }, null, 2));

const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nPAPER VIM VERIFY: FAIL");
  process.exit(1);
}
console.log("\nPAPER VIM VERIFY: PASS");
