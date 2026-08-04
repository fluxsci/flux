// PaperKeys — the keyboard-first polish pass end-to-end.
// Verifies: FigurePicker arrow-grid + Enter inserts with focus returned to the
// editor; Escape returns focus from picker and palette; Mod-Enter follows the
// item under the caret (embed line → figure mode); section folding shows the
// ⋯ placeholder and unfolds from the caret; the status bar shows a live word
// count; preview toggles with Mod-Shift-E, Escape exits it, and its scroll
// survives an edit; Alt-C on a group opens the ordered pane (smoke — full
// coverage in verify-citegroup.mjs).
//   Run (dev server on :1420 must be up): node scripts/verify-paper-keyboard.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const setup = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  window.__fluxSeedFigures(
    [{ id: "f1", label: "fig-growth", name: "Figure 1", nickname: "Growth", family: "figure", order: 0, number: 1, display: "Fig. 1", captionLabel: "Figure 1 | ", canvas: "c1", caption: "Growth", panels: [] }],
    { f1: { id: "f1", name: "Growth", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] } },
    {},
  );
  window.__fluxSeedBib([
    { key: "refa", title: "A study", authors: ["Authora"], year: "2015" },
    { key: "refb", title: "B study", authors: ["Authorb"], year: "2016" },
  ]);
  const lines = [
    "# Intro",
    "",
    "Intro prose about things [@refa; @refb] cited.",
    "",
    "## Methods",
    "",
    // Long enough that the PREVIEW render is comfortably scrollable (>400px).
    ...Array.from({ length: 80 }, (_, i) => `Methods paragraph ${i} with several words in it.`),
    "",
    "## Results",
    "",
    "Results prose here.",
    "",
  ];
  const text = lines.join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
  await new Promise((r) => requestAnimationFrame(r));
  view.focus();
  return { ok: true, lines: view.state.doc.lines };
});
if (setup.error) {
  console.error(JSON.stringify(setup));
  process.exit(1);
}
const focusInEditor = () =>
  page.evaluate(() => !!document.activeElement?.closest(".cm-content"));

// --- status bar shows the word count -----------------------------------------
await sleep(400); // > the 150ms idle debounce
const statusBar = await page.evaluate(() => {
  const el = document.querySelector(".statusbar");
  return { present: !!el, text: el?.textContent?.trim() ?? "" };
});
const statusOk = statusBar.present && /\d+ words/.test(statusBar.text);

// --- FigurePicker: /figure → arrows → Enter inserts, focus back in editor ----
await page.evaluate(() => {
  const view = window.__fluxView;
  const end = view.state.doc.line(view.state.doc.lines).from;
  // scrollIntoView: CM only renders the completion tooltip for on-screen carets.
  view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
  view.focus();
});
const poll = async (fn, tries = 20, ms = 150) => {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(fn)) return true;
    await sleep(ms);
  }
  return false;
};
await page.keyboard.type("/figure");
// Wait until the FINAL keystroke's completion is active (a selected option
// whose label matches) — the tooltip element alone can belong to the previous
// keystroke's query while the last one is still pending.
await poll(() =>
  (
    document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent ?? ""
  ).includes("/figure"),
);
await sleep(250);
await page.keyboard.press("Enter"); // accept the completion → opens the picker
const pickerOpen = await poll(() => !!document.querySelector(".picker"));
await page.keyboard.press("ArrowDown"); // grid nav (single cell — stays at 0)
await page.keyboard.press("Enter"); // insert selected figure
const inserted = await poll(() =>
  window.__fluxView.state.doc.toString().includes("{#fig-growth}"),
);
const pickerOk = pickerOpen && inserted && (await focusInEditor());

// --- Mod-Enter on the embed line → figure mode --------------------------------
const embedFound = await page.evaluate(() => {
  const view = window.__fluxView;
  let embedLine = 0;
  for (let i = 1; i <= view.state.doc.lines; i++)
    if (view.state.doc.line(i).text.includes("{#fig-growth}")) embedLine = i;
  if (!embedLine) return false;
  view.dispatch({ selection: { anchor: view.state.doc.line(embedLine).from }, scrollIntoView: true });
  view.focus();
  return true;
});
if (!embedFound) {
  console.error("no embed line to follow — picker step failed upstream");
  await browser.close();
  process.exit(1);
}
await page.keyboard.down("Control");
await page.keyboard.press("Enter");
await page.keyboard.up("Control");
await sleep(700);
const inFigureMode = await page.evaluate(() => {
  const active = document.querySelector('button[aria-label][aria-current="true"], button[aria-label].active');
  return active?.getAttribute("aria-label") === "Figure";
});
// revealFigure opened Figure in a SPLIT (Paper keeps its pane) — refocus the
// paper pane the way a user would: click into its editor. (The rail's Paper
// button is a guarded no-op while a paper pane already exists.)
const cmBox = await page.evaluate(() => {
  const el = document.querySelector(".cm-scroller");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Mid-pane: clear of the floating TitlePill at the top of the editor column.
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (cmBox) await page.mouse.click(cmBox.x, cmBox.y);
await sleep(500);
const backInPaper = await page.evaluate(
  () => document.querySelector(".titlebar .modestrip button.active")?.getAttribute("aria-label") === "Paper",
);
if (!backInPaper) {
  console.error("could not refocus the Paper pane");
  await browser.close();
  process.exit(1);
}
await page.evaluate(() => window.__fluxView?.focus());

// --- folding: caret mid-section → fold → placeholder → unfold ----------------
const foldRes = await page.evaluate(async () => {
  const view = window.__fluxView;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  let target = 0;
  for (let i = 1; i <= view.state.doc.lines; i++)
    if (view.state.doc.line(i).text.startsWith("Methods paragraph 5")) target = i;
  view.dispatch({ selection: { anchor: view.state.doc.line(target).from } });
  view.focus();
  const mod = await import("/src/shell/modes/paper/editing/folding.ts");
  const folded = mod.foldSection(view);
  await raf();
  const placeholder = !!document.querySelector(".cm-foldPlaceholder");
  const caretLine = view.state.doc.lineAt(view.state.selection.main.head).text;
  const unfolded = mod.unfoldSection(view);
  await raf();
  const placeholderGone = !document.querySelector(".cm-foldPlaceholder");
  return { folded, placeholder, caretLine, unfolded, placeholderGone };
});
const foldOk =
  foldRes.folded &&
  foldRes.placeholder &&
  foldRes.caretLine.startsWith("## Methods") &&
  foldRes.unfolded &&
  foldRes.placeholderGone;

// --- preview: Mod-Shift-E in, scroll survives an edit, Escape out ------------
// The iframe is sandboxed WITHOUT allow-same-origin — the parent can't read
// its document or scrollY. Drive + observe through the postMessage protocol
// the feature itself uses: send fluxScrollTo down, record the iframe's
// fluxPreviewScroll reports in the parent.
await page.evaluate(() => {
  window.__pv = [];
  window.addEventListener("message", (e) => {
    const y = e.data?.fluxPreviewScroll;
    if (typeof y === "number") window.__pv.push(y);
  });
});
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("KeyE");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
// Poll for the iframe (160ms debounce + async module loads on first render).
let previewOn = false;
for (let i = 0; i < 25 && !previewOn; i++) {
  await sleep(200);
  previewOn = await page.evaluate(() => !!document.querySelector(".preview iframe"));
}
await sleep(800); // let the first load settle
await page.evaluate(() => {
  document
    .querySelector(".preview iframe")
    ?.contentWindow?.postMessage({ fluxScrollTo: 400 }, "*");
});
await sleep(400); // iframe scrolls → throttled report bubbles up
const reported = await page.evaluate(() => window.__pv.at(-1) ?? -1);
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nOne more line." } });
});
await sleep(1500); // debounce + reload + restore → restore itself reports up
const restored = await page.evaluate(() => window.__pv.at(-1) ?? -1);
await page.keyboard.press("Escape");
await sleep(300);
const previewClosed = await page.evaluate(() => !document.querySelector(".preview iframe"));
// `reported` is the clamped scroll the iframe actually reached; the restore
// after the srcdoc reload must land back on it.
const previewOk =
  previewOn &&
  reported > 100 &&
  Math.abs(restored - reported) < 40 &&
  previewClosed &&
  (await focusInEditor());

// --- palette Escape returns focus ---------------------------------------------
await page.keyboard.down("Control");
await page.keyboard.press("KeyK");
await page.keyboard.up("Control");
await sleep(300);
const paletteOpened = await page.evaluate(() => !!document.querySelector(".cp-scrim"));
await page.keyboard.press("Escape");
await sleep(200);
const paletteFocusOk = paletteOpened && (await focusInEditor());

// --- Alt-C smoke: group pane opens with ordered members ----------------------
await page.evaluate(() => {
  const view = window.__fluxView;
  const line = view.state.doc.line(3);
  view.dispatch({
    selection: { anchor: line.from + line.text.indexOf("[@") },
    scrollIntoView: true,
  });
  view.focus();
});
await page.keyboard.down("Alt");
await page.keyboard.press("KeyC");
await page.keyboard.up("Alt");
await sleep(400);
const altcOk = await page.evaluate(() => {
  const m = [...document.querySelectorAll(".cgp .row.member .who")].map((e) => e.textContent?.trim());
  return m.length === 2 && (m[0]?.startsWith("Authora") ?? false);
});

await shot(page, "paper-keyboard-final");
const errs = realErrors(page);
await browser.close();

const res = { statusOk, statusText: statusBar.text, pickerOk, inFigureMode, foldOk, previewOk, previewOn, reported, restored, previewClosed, paletteFocusOk, altcOk };
console.log(JSON.stringify({ keys: res, errs }, null, 2));
const ok =
  statusOk && pickerOk && inFigureMode && foldOk && previewOk && paletteFocusOk && altcOk && errs.length === 0;
if (!ok) {
  console.error("\nPAPER KEYBOARD VERIFY: FAIL");
  process.exit(1);
}
console.log("\nPAPER KEYBOARD VERIFY: PASS");
