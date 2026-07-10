// Embed source-line chip (owner review): the raw `![](…){#fig-x}` line renders
// as a compact accent chip carrying the figure NAME, hidden syntax by default;
// the caret touching the line reveals the raw source (chips.ts inline atomic —
// embeds.ts stays doc-pure). Verifies: chip shows the name; reveal-on-caret
// with ZERO scrollHeight change; ArrowDown crosses the embed line in exactly
// one keypress; unresolved embeds get the dimmed variant and KEEP their alt;
// renaming the figure updates the chip with zero document change.
//   Run (dev server on :1420 must be up): node scripts/verify-embed-chip.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const seed = (name) => ({
  figs: [{ id: "f1", label: "fig-growth", name, order: 0, number: "1", canvas: "c1", caption: "Growth over 24 h.", panels: [] }],
  canvases: { f1: { id: "f1", name, canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] } },
});

const res = await page.evaluate(async (s) => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  window.__fluxSeedFigures(s.figs, s.canvases, {});

  const text = [
    "# Chip test",
    "",
    "Prose before the figure.",
    "![](../fig/renders/f1.svg){#fig-growth width=50%}",
    "Prose after the figure.",
    "![Legacy alt survives.](../fig/renders/zz.svg){#fig-zz}",
    "Last line.",
  ].join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
  await raf();
  await raf();
  await new Promise((r) => setTimeout(r, 300)); // normalize pass settles

  const content = document.querySelector(".cm-content");
  const chipTexts = () => [...document.querySelectorAll(".flux-embedchip")].map((c) => c.textContent ?? "");

  // Collapsed by default: the resolved chip carries the figure NAME, the raw
  // path is not visible in the line, the unresolved one is flagged.
  const collapsed = {
    chips: chipTexts(),
    hasName: chipTexts().some((t) => t.includes("Growth")),
    unresolvedFlagged: !!document.querySelector(".flux-embedchip.unresolved"),
    rawHidden: ![...document.querySelectorAll(".cm-line.cm-flux-embedsrc")].some((l) =>
      (l.textContent ?? "").includes("../fig/renders/f1.svg"),
    ),
    altKept: view.state.doc.toString().includes("![Legacy alt survives.]"),
  };

  // Reveal on caret: scrollHeight must not move (feel contract).
  const h0 = content.scrollHeight;
  const embedLine = view.state.doc.line(4);
  view.dispatch({ selection: { anchor: embedLine.from } });
  await raf();
  await raf();
  const revealed = {
    rawVisible: [...document.querySelectorAll(".cm-line.cm-flux-embedsrc")].some((l) =>
      (l.textContent ?? "").includes("../fig/renders/f1.svg"),
    ),
    heightStable: Math.abs(content.scrollHeight - h0) < 1,
  };
  view.dispatch({ selection: { anchor: 0 } });
  await raf();

  return { collapsed, revealed, doc0: view.state.doc.toString() };
}, seed("Growth"));

// ArrowDown walk: every doc line costs exactly one keypress, embed line included.
await page.evaluate(() => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  view.dispatch({ selection: { anchor: 0 } });
  view.focus();
});
const linesTotal = 7;
const walk = [];
for (let i = 0; i < linesTotal - 1; i++) {
  await page.keyboard.press("ArrowDown");
  walk.push(
    await page.evaluate(() => {
      const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
      return view.state.doc.lineAt(view.state.selection.main.head).number;
    }),
  );
}
const walkOk = walk.every((n, i) => n === i + 2);

// Rename the figure: the chip re-renders with the new name, the DOC does not change.
const rename = await page.evaluate(async (s) => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  const before = view.state.doc.toString();
  window.__fluxSeedFigures(s.figs, s.canvases, {});
  await new Promise((r) => setTimeout(r, 400));
  return {
    chipRenamed: [...document.querySelectorAll(".flux-embedchip")].some((c) => (c.textContent ?? "").includes("Figure 3")),
    docUnchanged: view.state.doc.toString() === before,
  };
}, seed("Figure 3"));

await shot(page, "embed-chip");
const errs = realErrors(page);
await browser.close();

const checks = {
  hasName: res.collapsed?.hasName,
  unresolvedFlagged: res.collapsed?.unresolvedFlagged,
  rawHidden: res.collapsed?.rawHidden,
  altKept: res.collapsed?.altKept,
  rawVisibleOnCaret: res.revealed?.rawVisible,
  heightStable: res.revealed?.heightStable,
  walkOk,
  chipRenamed: rename.chipRenamed,
  docUnchanged: rename.docUnchanged,
};
console.log(JSON.stringify({ embedChip: checks, chips: res.collapsed?.chips, walk, errs }, null, 2));
const ok = !res.error && Object.values(checks).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nEMBED CHIP VERIFY: FAIL");
  process.exit(1);
}
console.log("\nEMBED CHIP VERIFY: PASS");
