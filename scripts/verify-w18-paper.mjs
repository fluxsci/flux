// W18 — Paper per-keystroke / per-caret-move hot paths (PAP-7, PAP-22). Driven through the
// real editor on a 20k-line doc (the size the plan targets; m10 only covered 5k keystroke
// rebuilds, never selection-only caret moves).
//
// PAP-7 (the substantive change): the embeds + tables block-widget StateFields used to
// re-scan the WHOLE document on every selection change (every arrow key). They now rebuild on
// a caret move ONLY when the caret entered/left a block line. This verifies:
//   • reveal-on-cursor still works — caret onto an embed line reveals its raw markdown, and
//     onto the blank line that sits between a table and its caption reveals the table (the
//     tricky multi-line / blank-in-block edge the cheap predicate has to get right);
//   • a caret move between prose lines is now cheap on a 20k-line doc (the skip), where a full
//     rescan would blow the frame budget.
// PAP-7 (debounce): the TOC recomputes ~150ms after typing settles, not per keystroke — a
// typed heading still shows up in the outline once it settles.
//
// PAP-22 (Map-indexed resolvers) is a pure find()→Map.get() equivalence covered by svelte-check;
// the embed reveal here also exercises resolveFigure()'s new index path (miss case).
//   Run (dev server on :1420 must be up): node scripts/verify-w18-paper.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const res = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  // ~20k-line doc. A table (with a blank line before its caption) + an embed every 60 lines,
  // prose between. First block sits near the top so it's in the initial viewport.
  const block = (i) => [
    "| Gene | Δ | p |",
    "| --- | ---: | ---: |",
    "| Foo | 1.2 | 0.01 |",
    "| Bar | 3.4 | 0.02 |",
    "", // <- the internal blank line: caption sits one blank below the table body
    `: Table ${i} {#tbl-blk${i}}`,
    "",
    `![Growth ${i}](../fig/renders/growth${i}.svg){#fig-growth${i}}`,
    "",
  ];
  const lines = ["# W18 perf doc", ""];
  let b = 0;
  while (lines.length < 20000) {
    if (lines.length % 60 === 2) lines.push(...block(b++));
    else lines.push(`Prose line ${lines.length} — words to scan, no pipe or bang markers here.`);
  }
  const text = lines.join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
  await raf();

  const doc = () => view.state.doc;
  const posOfLine = (n) => doc().line(n).from;
  const nEmbed = () => document.querySelectorAll(".flux-embed").length;
  const nTable = () => document.querySelectorAll(".flux-table").length;

  // Locate the first embed line, the first table caption line, and its internal blank line.
  let embedLine = -1, captionLine = -1;
  for (let i = 1; i <= doc().lines; i++) {
    const t = doc().line(i).text;
    if (embedLine < 0 && t.indexOf("![Growth") >= 0) embedLine = i;
    if (captionLine < 0 && t.indexOf("{#tbl-") >= 0) captionLine = i;
    if (embedLine > 0 && captionLine > 0) break;
  }
  const tableBlankLine = captionLine - 1; // the blank between the body and the caption

  // --- correctness: reveal-on-cursor (the rebuild MUST still fire when a block is touched) ---
  const moveTo = async (line) => { view.dispatch({ selection: { anchor: posOfLine(line) } }); await raf(); await raf(); };

  const embedProse = embedLine + 2; // prose just below the block, shares the viewport with the embed
  const tableProse = Math.max(1, captionLine - 7); // prose/heading just above the block

  await moveTo(embedProse); // embed is in-viewport, rendered as a widget
  const embedBefore = nEmbed();
  await moveTo(embedLine); // caret onto the embed line → reveals raw
  const embedOn = nEmbed();
  await moveTo(embedProse); // back to prose → widget returns
  const embedBack = nEmbed();

  await moveTo(tableProse); // table is in-viewport, rendered as a widget
  const tableBefore = nTable();
  await moveTo(tableBlankLine); // caret onto the blank-line-in-block → reveals the table raw
  const tableOn = nTable();
  await moveTo(tableProse);
  const tableBack = nTable();

  // --- perf: selection-only nav between two prose lines (both in the top viewport) ----------
  // On a 20k-line doc a full rescan would be ~10ms; the skip should be ~0. We also time a
  // keystroke (which DOES rebuild) for contrast.
  const p1 = 20, p2 = 25; // both prose, both visible at the top
  await moveTo(p1);
  const nav = [];
  for (let k = 0; k < 40; k++) {
    const line = k % 2 ? p1 : p2;
    const t0 = performance.now();
    view.dispatch({ selection: { anchor: posOfLine(line) } });
    void view.contentHeight; // force layout read
    nav.push(performance.now() - t0);
    await raf();
  }
  nav.sort((a, b) => a - b);

  const keys = [];
  for (let k = 0; k < 20; k++) {
    const end = doc().line(10).to;
    const t0 = performance.now();
    view.dispatch({ changes: { from: end, insert: "x" } });
    void view.contentHeight;
    keys.push(performance.now() - t0);
    await raf();
  }
  keys.sort((a, b) => a - b);

  // --- PAP-7 debounce: a typed heading appears in the TOC after it settles (~150ms) ---------
  const headingText = "Zzz Debounce Heading";
  view.dispatch({ changes: { from: doc().line(2).from, insert: `## ${headingText}\n` } });
  const tocImmediate = [...document.querySelectorAll(".oitem")].some((e) => e.textContent.includes(headingText));
  await new Promise((r) => setTimeout(r, 260)); // > the 150ms idle debounce
  await raf();
  const tocAfterSettle = [...document.querySelectorAll(".oitem")].some((e) => e.textContent.includes(headingText));

  const med = (a) => +a[Math.floor(a.length / 2)].toFixed(2);
  return {
    lineCount: doc().lines,
    embedLine, captionLine, tableBlankLine,
    reveal: {
      embed: { before: embedBefore, on: embedOn, back: embedBack, ok: embedOn === embedBefore - 1 && embedBack === embedBefore },
      table: { before: tableBefore, on: tableOn, back: tableBack, ok: tableOn === tableBefore - 1 && tableBack === tableBefore },
    },
    perf: {
      proseNavMedianMs: med(nav),
      proseNavMaxMs: +nav[nav.length - 1].toFixed(2),
      keystrokeMedianMs: med(keys),
      navFast: med(nav) < 4 && nav[nav.length - 1] < 16.6,
      navBeatsRebuild: med(nav) < med(keys), // the skip is cheaper than the rebuild path
    },
    toc: { immediate: tocImmediate, afterSettle: tocAfterSettle, debounced: tocAfterSettle && !tocImmediate },
  };
});

const errs = realErrors(page); // drops the pre-existing demo-asset 404
await browser.close();

console.log(JSON.stringify({ w18: res, errs }, null, 2));

const ok =
  res && !res.error &&
  res.reveal.embed.ok &&
  res.reveal.table.ok &&
  res.perf.navFast &&
  res.perf.navBeatsRebuild &&
  res.toc.afterSettle &&
  errs.length === 0;

if (!ok) {
  console.error("\nW18 PAPER VERIFY: FAIL");
  process.exit(1);
}
console.log("\nW18 PAPER VERIFY: PASS");
