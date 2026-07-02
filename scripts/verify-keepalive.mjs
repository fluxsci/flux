// W16 (SHL-5) — mode keep-alive. Proves that switching modes no longer tears down and
// rebuilds the mode: the previous mode stays MOUNTED (hidden), so switching back preserves
// live editor state and skips the re-read/rebuild cost.
//
// The old {#key mode} remount would, on paper→figure, DESTROY the CodeMirror editor
// (window.__flux.editors → 0) and on the way back build a brand-new one (fresh instance,
// cursor reset). This checks the opposite:
//   • while on Figure, the Paper editor is still mounted (editors stays 1) — kept alive;
//   • the hidden Paper pane is visibility:hidden and the Figure pane is visible;
//   • back on Paper, it's the SAME EditorView instance (tag survives) with the cursor intact
//     (a re-read from disk would reset it) — i.e. onMount didn't re-run, no re-read;
//   • the Figure DOM node is likewise the same node after a round-trip;
//   • a warm switch is quick.
//   Run (dev server on :1420): node scripts/verify-keepalive.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const CURSOR = 15;
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });

// 1) Paper: tag the editor instance + place the cursor.
await clickMode(page, "Paper");
await sleep(400);
const step1 = await page.evaluate((cursor) => {
  const eds = window.__flux?.editors ?? [];
  if (!eds.length) return { error: "no paper editor after first Paper visit" };
  const v = eds[eds.length - 1];
  v.__kaTag = "PAPER_1";
  v.dispatch({ selection: { anchor: Math.min(cursor, v.state.doc.length) } });
  return { editors: eds.length, cursor: v.state.selection.main.head };
}, CURSOR);

// 2) Figure: paper must stay mounted (kept alive) and hidden; figure must be visible.
await clickMode(page, "Figure");
await sleep(600);
const step2 = await page.evaluate(() => {
  const fm = document.querySelector(".figure-mode");
  if (fm) fm.dataset.kaTag = "FIG_1";
  const mcOf = (sel) => document.querySelector(sel)?.closest(".mc");
  const vis = (el) => (el ? getComputedStyle(el).visibility : "absent");
  return {
    figurePresent: !!fm,
    paperEditorsWhileOnFigure: (window.__flux?.editors ?? []).length, // 1 = kept alive; 0 = old teardown
    figureVisible: vis(mcOf(".figure-mode")) === "visible",
    paperHidden: vis(mcOf(".cm-editor")) === "hidden",
  };
});

// 3) Back to Paper: same instance + cursor survived (⇒ not rebuilt, not re-read).
await clickMode(page, "Paper");
await sleep(400);
const step3 = await page.evaluate((cursor) => {
  const eds = window.__flux?.editors ?? [];
  const v = eds[eds.length - 1];
  return {
    editors: eds.length,
    sameInstance: v?.__kaTag === "PAPER_1",
    cursorPreserved: v?.state.selection.main.head === Math.min(cursor, v?.state.doc.length ?? 0),
  };
}, CURSOR);

// 4) Back to Figure: same DOM node (⇒ figure kept alive too, no loadFigInto re-run).
await clickMode(page, "Figure");
await sleep(400);
const step4 = await page.evaluate(() => ({
  figureSameNode: document.querySelector(".figure-mode")?.dataset.kaTag === "FIG_1",
}));

// 5) Warm-switch timing (both modes now visited → visibility flip only).
const timing = await page.evaluate(async () => {
  const btn = (lbl) => [...document.querySelectorAll("button[aria-label]")].find((e) => e.getAttribute("aria-label") === lbl);
  const measure = async (lbl) => {
    const t0 = performance.now();
    btn(lbl)?.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  };
  const toPaperMs = +(await measure("Paper")).toFixed(1);
  const toFigureMs = +(await measure("Figure")).toFixed(1);
  return { toPaperMs, toFigureMs };
});

const errs = realErrors(page);
await browser.close();

console.log(JSON.stringify({ step1, step2, step3, step4, timing, errs }, null, 2));

const ok =
  step1 && !step1.error && step1.editors === 1 &&
  step2.figurePresent && step2.paperEditorsWhileOnFigure === 1 && step2.figureVisible && step2.paperHidden &&
  step3.editors === 1 && step3.sameInstance && step3.cursorPreserved &&
  step4.figureSameNode &&
  errs.length === 0;

if (!ok) {
  console.error("\nW16 KEEP-ALIVE VERIFY: FAIL");
  process.exit(1);
}
console.log("\nW16 KEEP-ALIVE VERIFY: PASS");
