// PaperNav — Obsidian-grade cursor navigation through embeds/tables/chips.
//
// The old rendering replaced embed/table lines with ATOMIC block widgets and
// swapped them for raw text when the caret arrived (reveal-on-cursor). One
// ArrowUp over a table skipped every source line in the block, and the ~500px
// widget collapse reflowed the document mid-keystroke — the reported "arrow up
// jumps multiple lines" bug. The rewrite keeps every source line present and
// navigable (compact mono) and renders the figure/table as a side:1 block
// widget that never reacts to selection. This verifies the contract:
//   • every ArrowDown advances the caret by EXACTLY one line, through embed
//     source lines and every pipe row of a table;
//   • pure navigation causes zero layout shift: .cm-content scrollHeight and
//     the rendered widget count are constant as the caret crosses an embed;
//   • the goal column survives crossing an embed line;
//   • clicking a rendered figure puts the caret on its source line;
//   • Shift-Down selects across the embed line like plain text.
//   Run (dev server on :1420 must be up): node scripts/verify-paper-nav.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const setup = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  // Seed one real figure so the embed renders an actual SVG (not the missing box).
  window.__fluxSeedFigures(
    [{ id: "f1", label: "fig-growth", name: "Figure 1", nickname: "Growth", family: "figure", order: 0, number: 1, display: "Fig. 1", captionLabel: "Figure 1 | ", canvas: "c1", caption: "Growth", panels: [] }],
    { f1: { id: "f1", name: "Growth", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] } },
    {},
  );

  const text = [
    "# Nav test", // 1
    "", // 2
    "Prose one with enough words to hold a goal column test here.", // 3
    "Prose two with enough words to hold a goal column test here.", // 4
    "![Growth curve](../fig/renders/f1.svg){#fig-growth}", // 5 (embed)
    "Prose three with enough words to hold a goal column test.", // 6
    "", // 7
    "| Gene | Delta | p |", // 8
    "| --- | ---: | ---: |", // 9
    "| Foo | 1.2 | 0.01 |", // 10
    "| Bar | 3.4 | 0.02 |", // 11
    "", // 12
    ": Table caption {#tbl-one}", // 13
    "", // 14
    "Prose four with enough words to hold a goal column test here.", // 15
    "Prose five.", // 16
  ].join("\n");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
  });
  await raf();
  await raf();
  view.focus();
  return { lines: view.state.doc.lines };
});
if (setup.error) {
  console.error(JSON.stringify(setup));
  process.exit(1);
}

const snap = () =>
  page.evaluate(() => {
    const view = window.__fluxView;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    return {
      line: line.number,
      col: sel.head - line.from,
      selFrom: sel.from,
      selTo: sel.to,
      embeds: document.querySelectorAll(".flux-embed").length,
      tables: document.querySelectorAll(".flux-table").length,
      scrollH: document.querySelector(".cm-scroller").scrollHeight,
    };
  });

// --- 1. one keypress == one line, top to bottom -----------------------------
const s0 = await snap();
const walk = [];
for (let i = 0; i < setup.lines - 1; i++) {
  await page.keyboard.press("ArrowDown");
  walk.push(await snap());
}
const oneLineEach = walk.every((s, i) => s.line === i + 2);
const walkBackOk = await (async () => {
  for (let i = 0; i < setup.lines - 1; i++) await page.keyboard.press("ArrowUp");
  return (await snap()).line === 1;
})();

// --- 2. zero layout shift on pure navigation --------------------------------
const embedsStable = walk.every((s) => s.embeds === s0.embeds && s.tables === s0.tables);
const heightStable = walk.every((s) => s.scrollH === walk[0].scrollH);

// --- 3. goal column survives crossing the embed line ------------------------
await page.evaluate(() => {
  const view = window.__fluxView;
  const l = view.state.doc.line(4);
  view.dispatch({ selection: { anchor: l.from + 30 } });
  view.focus();
});
await page.keyboard.press("ArrowDown"); // onto the embed source line
await page.keyboard.press("ArrowDown"); // onto prose three
const goal = await snap();
// The goal is an x-COORDINATE (CM6/Obsidian semantics): crossing the 12px mono
// source line must not lose it. Landing column may differ by a glyph or two
// because the serif lines have different character widths at the same x.
const goalOk = goal.line === 6 && Math.abs(goal.col - 30) <= 2;

// --- 4. click on the rendered figure → caret on its source line -------------
const embedBox = await page.evaluate(() => {
  const el = document.querySelector(".flux-embed-art");
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(embedBox.x, embedBox.y);
await sleep(200);
const clicked = await snap();
const clickOk = clicked.line === 5;

// --- 5. Shift-Down selects across the embed like plain text -----------------
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  view.focus();
});
await page.keyboard.down("Shift");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.up("Shift");
const sel = await snap();
const selOk = await page.evaluate(
  (s) => {
    const view = window.__fluxView;
    return (
      s.selFrom === view.state.doc.line(4).from &&
      view.state.doc.lineAt(s.selTo).number === 6 &&
      view.state.sliceDoc(s.selFrom, s.selTo).includes("{#fig-growth}")
    );
  },
  sel,
);

await shot(page, "paper-nav-final");
const errs = realErrors(page);
await browser.close();

const res = { oneLineEach, walkBackOk, embedsStable, heightStable, goalOk, clickOk, selOk, walkLines: walk.map((s) => s.line) };
console.log(JSON.stringify({ nav: res, errs }, null, 2));

const ok =
  oneLineEach && walkBackOk && embedsStable && heightStable && goalOk && clickOk && selOk && errs.length === 0;
if (!ok) {
  console.error("\nPAPER NAV VERIFY: FAIL");
  process.exit(1);
}
console.log("\nPAPER NAV VERIFY: PASS");
