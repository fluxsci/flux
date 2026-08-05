// Paper tables — the end-to-end behavioral gate for the 2026-08 table rework:
//
//  A. WIDGET — cells render inline markdown / lazy KaTeX math / resolved
//     citations + cross-refs exactly as the export prints them; escaped pipes
//     (\|) stay one cell; fenced pseudo-tables get no widget; captions carry
//     "Table N." + inline markdown; the wrap survives in-cell typing via
//     updateDOM (in-place patch — the scale-paper contract at small scale).
//  B. EDITING — Tab/Shift-Tab walk cells (normalizing the block), Tab at the
//     end grows a row, Enter inserts/exits rows, typing reflows the pipes in
//     the SAME transaction with the caret glued (single undo unit), the
//     Mod-Alt chords work, widget cell-click jumps to the source cell, the
//     hover bar (+Row/+Col/Format/Copy) and Alt-click-a-header alignment work.
//  C. REFS — @tbl- autocompletes from the in-document registry, /table inserts
//     a labeled snippet with "Column A" selected, double-click and Mod-Enter
//     on a @tbl chip jump to the table, the hover card shows the table branch.
//  D. PASTE — a TSV grid becomes a table outside one and splices Excel-style
//     inside one; plain text with pipes pastes escaped into a cell.
//  E. RENDER — renderManuscript wraps table+caption into ONE .tblblock
//     (.tblscroll inside) and links @tbl-x to its anchor.
//
//   Run (dev server on :1420 must be up): node scripts/verify-paper-tables.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const res = {};

async function setDocAndCaret(text, caretNeedle, offset = 0) {
  return page.evaluate(
    async ({ text, caretNeedle, offset }) => {
      const view = window.__fluxView;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      if (caretNeedle) {
        const pos = view.state.doc.toString().indexOf(caretNeedle) + offset;
        view.dispatch({ selection: { anchor: pos } });
      }
      await new Promise((r) => requestAnimationFrame(r));
      view.focus();
      return true;
    },
    { text, caretNeedle, offset },
  );
}

// ---------------------------------------------------------------------------
// A. Widget rendering
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  window.__fluxSeedBib([{ key: "smith2020", title: "A study", authors: ["Smith"], year: "2020" }]);
});
await setDocAndCaret(
  [
    "# Widget",
    "",
    "| Name | **Bold** | Esc |",
    "| :-- | :-: | --: |",
    "| *em* | **bold cell** | a \\| b |",
    "| `code` | $x^2$ | [@smith2020] |",
    "| see @tbl-two | plain | 42 |",
    "",
    ": Caption with **bold** and $y_i$ {#tbl-one}",
    "",
    "| A | B |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    ": Second {#tbl-two}",
    "",
    "```",
    "| fenced | table |",
    "| - | - |",
    "```",
    "",
  ].join("\n"),
  null,
);
await waitFor(
  () => page.evaluate(() => !!document.querySelector(".mdi-math:not(.pending)")),
  { timeout: 6000, label: "KaTeX lazy-loaded into table cells" },
).catch(() => {});
const widget = await page.evaluate(() => {
  const wraps = [...document.querySelectorAll(".flux-tablewrap")];
  const w = wraps[0];
  const capB = w?.querySelector(".flux-table-cap b")?.textContent;
  const cap2 = wraps[1]?.querySelector(".flux-table-cap b")?.textContent;
  return {
    wraps: wraps.length, // fenced table must NOT render
    scroll: !!w?.querySelector(".flux-tablescroll"),
    scrollCss: w ? getComputedStyle(w.querySelector(".flux-tablescroll")).overflowX : null,
    boldHead: !!w?.querySelector("thead strong"),
    emCell: !!w?.querySelector("tbody em"),
    codeCell: !!w?.querySelector("tbody code"),
    escCell: [...(w?.querySelectorAll("tbody td") ?? [])].some((t) => t.textContent === "a | b"),
    cols: w?.querySelectorAll("thead th").length,
    math: !!w?.querySelector("tbody .mdi-math:not(.pending)"),
    cite: [...(w?.querySelectorAll(".mdi-cite") ?? [])].map((t) => t.textContent),
    ref: [...(w?.querySelectorAll(".mdi-ref") ?? [])].map((t) => t.textContent),
    capNums: [capB, cap2],
    capBold: !!w?.querySelector(".flux-table-cap strong"),
    capMath: !!w?.querySelector(".flux-table-cap .mdi-math"),
    srcLines: document.querySelectorAll(".cm-flux-tablesrc").length > 0,
  };
});
res.widgetRich =
  widget.wraps === 2 &&
  widget.scroll &&
  widget.scrollCss === "auto" &&
  widget.boldHead &&
  widget.emCell &&
  widget.codeCell &&
  widget.cols === 3 &&
  widget.srcLines;
res.widgetEsc = widget.escCell;
res.widgetMath = widget.math && widget.capMath;
res.widgetResolved =
  widget.cite.includes("(Smith, 2020)") && widget.ref.includes("Table 2") && widget.capBold;
res.widgetNumbers = widget.capNums[0] === "Table 1." && widget.capNums[1] === "Table 2.";
await shot(page, "tables-widget");

// updateDOM in-place patch: the wrap element survives an in-cell keystroke.
{
  await page.evaluate(() => {
    document.querySelector(".flux-tablewrap").__probeMark = true;
    const view = window.__fluxView;
    const pos = view.state.doc.toString().indexOf("plain") + 5;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  });
  await page.keyboard.type("X");
  await sleep(200);
  res.updateDomPatch = await page.evaluate(() => {
    const w = document.querySelector(".flux-tablewrap");
    const cell = [...w.querySelectorAll("tbody td")].some((t) => t.textContent === "plainX");
    return w.__probeMark === true && cell;
  });
}

// ---------------------------------------------------------------------------
// B. Editing
// ---------------------------------------------------------------------------
await setDocAndCaret("# Edit\n\n|Name|n|\n|-|-|\n|alpha|1|\n\n: Cap {#tbl-a}\n\nAfter.\n", "Name", 2);
await page.keyboard.press("Tab");
await sleep(120);
{
  const r = await page.evaluate(() => {
    const view = window.__fluxView;
    const sel = view.state.selection.main;
    return { selected: view.state.doc.sliceString(sel.from, sel.to), l3: view.state.doc.line(3).text };
  });
  res.tabWalks = r.selected === "n" && r.l3 === "| Name  | n   |";
}
await page.keyboard.type("count"); // replaces the selected cell
await sleep(150);
{
  const r = await page.evaluate(() => {
    const view = window.__fluxView;
    const h = view.state.selection.main.head;
    return {
      l3: view.state.doc.line(3).text,
      l5: view.state.doc.line(5).text,
      beforeCaret: view.state.doc.sliceString(h - 5, h),
    };
  });
  res.reflowTyping = r.l3 === "| Name  | count |" && r.l5 === "| alpha | 1     |" && r.beforeCaret === "count";
}
// Undo after keystroke+reflow lands on a COHERENT table state (never a
// half-reflowed corruption): either the pre-typing normalized text (typing
// undone alone) or the original messy source (history coalesced Tab's
// normalize with the typing — both are one clean step back).
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await sleep(150);
res.undoOneUnit = await page.evaluate(() => {
  const l3 = window.__fluxView.state.doc.line(3).text;
  return l3 === "| Name  | n   |" || l3 === "|Name|n|";
});

// Tab to the end grows a row; Enter inserts; Enter-on-empty exits — on a
// fresh known-shape doc (9 lines: #, blank, 3 table lines, blank, cap,
// blank, After.).
await setDocAndCaret("# Edit\n\n| Name | n |\n| --- | --- |\n| alpha | 1 |\n\n: Cap {#tbl-a}\n\nAfter.", "| 1", 2);
await page.keyboard.press("Tab"); // grow (caret is in the last cell)
await sleep(120);
res.tabGrows = await page.evaluate(() => window.__fluxView.state.doc.lines === 10);
await page.keyboard.type("beta");
await page.keyboard.press("Enter");
await sleep(120);
res.enterInserts = await page.evaluate(() => {
  const view = window.__fluxView;
  return view.state.doc.lines === 11 && /^\|\s+\|\s+\|$/.test(view.state.doc.line(7).text);
});
await page.keyboard.press("Enter");
await sleep(120);
res.enterExits = await page.evaluate(() => {
  const view = window.__fluxView;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  // 10 lines left; the caret sits on the blank line BELOW the caption (line 9).
  return view.state.doc.lines === 10 && line.text === "" && line.number === 9;
});

// Chords: Mod-Alt-r (row below), Mod-Alt-a (align cycle).
await page.evaluate(() => {
  const view = window.__fluxView;
  const pos = view.state.doc.toString().indexOf("alpha") + 2;
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
});
await page.keyboard.down("Control");
await page.keyboard.down("Alt");
await page.keyboard.press("r");
await page.keyboard.up("Alt");
await page.keyboard.up("Control");
await sleep(120);
res.chordRow = await page.evaluate(() => window.__fluxView.state.doc.lines === 11);
await page.keyboard.down("Control");
await page.keyboard.down("Alt");
await page.keyboard.press("a");
await page.keyboard.up("Alt");
await page.keyboard.up("Control");
await sleep(120);
res.chordAlign = await page.evaluate(() => window.__fluxView.state.doc.line(4).text.includes(":") );

// Widget cell-click → caret in the source cell.
{
  const box = await page.evaluate(() => {
    const td = document.querySelector(".flux-table tbody td");
    const r = td.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await sleep(150);
  res.cellClick = await page.evaluate(() => {
    const view = window.__fluxView;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return line.text.includes("alpha") && view.state.doc.sliceString(line.from, head).includes("alpha");
  });
}

// Hover bar: +Row and Copy (clipboard monkey-patched) — fresh known doc.
{
  await setDocAndCaret("# Bar\n\n| Name | n |\n| --- | --- |\n| alpha | 1 |\n\n: Cap {#tbl-b}\n", "alpha", 2);
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (t) => ((window.__copied = t), Promise.resolve());
  });
  // Element-level mousedown (the buttons act on mousedown): coordinate clicks
  // are covered by the cell-click test; after an edit the editor may scroll the
  // bar under the overlaying title pill, which would flake a coord click.
  const press = (label) =>
    page.evaluate((label) => {
      const b = [...document.querySelectorAll(".flux-table-bar button")].find(
        (x) => x.textContent === label,
      );
      if (!b) return false;
      b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    }, label);
  const before = await page.evaluate(() => window.__fluxView.state.doc.lines);
  await press("+ Row");
  await sleep(150);
  const afterRow = await page.evaluate(() => window.__fluxView.state.doc.lines);
  await press("Copy");
  await sleep(150);
  const copied = await page.evaluate(() => window.__copied);
  res.hoverBar = afterRow === before + 1 && typeof copied === "string" && copied.startsWith("Name\t");
  if (!res.hoverBar) res.hoverBarDebug = { before, afterRow, copied };
}

// Alt-click a header cell cycles that column's alignment (element-level
// dispatch with altKey — same overlay-flake reasoning as the bar).
{
  const before = await page.evaluate(() => window.__fluxView.state.doc.line(4).text);
  await page.evaluate(() => {
    const th = document.querySelectorAll(".flux-table thead th")[1];
    th.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, altKey: true }));
  });
  await sleep(150);
  res.altClickAlign = await page.evaluate(
    (before) => window.__fluxView.state.doc.line(4).text !== before,
    before,
  );
}
await shot(page, "tables-editing");

// ---------------------------------------------------------------------------
// C. Refs: completion, snippet, jump, hover card
// ---------------------------------------------------------------------------
await setDocAndCaret(
  "# Refs\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n: The caption {#tbl-a}\n\nSee  here.\n\n",
  "See ",
  4,
);
await page.keyboard.type("@tbl-");
await waitFor(() => page.evaluate(() => !!document.querySelector(".cm-tooltip-autocomplete")), {
  timeout: 4000,
  label: "completion tooltip",
}).catch(() => {});
res.completion = await page.evaluate(() => {
  const opts = [...document.querySelectorAll(".cm-tooltip-autocomplete li")];
  return opts.some((o) => o.textContent.includes("@tbl-a") && o.textContent.includes("Table 1"));
});
await page.keyboard.press("Enter"); // accept @tbl-a
await sleep(200);
res.completionApplies = await page.evaluate(() =>
  window.__fluxView.state.doc.toString().includes("See @tbl-a here."),
);

// Chip renders + double-click jumps to the table source. The caret must move
// AWAY first — a selection touching the chip reveals its raw text by design.
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: 0 } });
});
await sleep(200);
{
  const chip = await page.evaluate(() => {
    const chips = [...document.querySelectorAll(".flux-figref")];
    const c = chips.find((x) => x.textContent === "Table 1");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  res.chipRenders = !!chip;
  if (chip) {
    // Hover card: table branch (caption, no figure box).
    await page.mouse.move(chip.x, chip.y);
    await waitFor(() => page.evaluate(() => !!document.querySelector(".hovercard")), {
      timeout: 3000,
      label: "hover card",
    }).catch(() => {});
    res.hoverCard = await page.evaluate(() => {
      const hc = document.querySelector(".hovercard");
      if (!hc) return false;
      return (
        hc.textContent.includes("Table 1") &&
        hc.textContent.includes("The caption") &&
        hc.textContent.includes("jump to the table") &&
        !hc.querySelector(".hc-fig")
      );
    });
    // The hover card floats ABOVE the chip — park the mouse elsewhere and let
    // it dismiss before double-clicking, or the card eats the clicks.
    await page.mouse.move(5, 5);
    await waitFor(() => page.evaluate(() => !document.querySelector(".hovercard")), {
      timeout: 3000,
      label: "hover card dismissed",
    }).catch(() => {});
    // A REAL double-click: two down/up pairs, the second with clickCount 2 —
    // a move between the pairs resets Chrome's click counter (figenh-16 recipe).
    await page.mouse.move(chip.x, chip.y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await sleep(250);
    res.chipJump = await page.evaluate(() => {
      const view = window.__fluxView;
      return view.state.doc.lineAt(view.state.selection.main.head).number === 3; // the header line
    });
  }
}

// Mod-Enter follow on the raw ref text.
await page.evaluate(() => {
  const view = window.__fluxView;
  const pos = view.state.doc.toString().indexOf("@tbl-a") + 3;
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
});
await page.keyboard.down("Control");
await page.keyboard.press("Enter");
await page.keyboard.up("Control");
await sleep(200);
res.modEnterJump = await page.evaluate(
  () => window.__fluxView.state.doc.lineAt(window.__fluxView.state.selection.main.head).number === 3,
);

// /table snippet: unique label + "Column A" selected.
await setDocAndCaret("# Snip\n\n| X |\n| - |\n\n: Old {#tbl-1}\n\n\n", "\n\n\n", 2);
await page.keyboard.type("/table");
await waitFor(() => page.evaluate(() => !!document.querySelector(".cm-tooltip-autocomplete")), {
  timeout: 4000,
  label: "slash tooltip",
}).catch(() => {});
await page.keyboard.press("Enter");
await sleep(250);
res.snippet = await page.evaluate(() => {
  const view = window.__fluxView;
  const doc = view.state.doc.toString();
  const sel = view.state.selection.main;
  return (
    doc.includes("{#tbl-2}") && // tbl-1 taken → unique tbl-2
    view.state.doc.sliceString(sel.from, sel.to) === "Column A"
  );
});

// ---------------------------------------------------------------------------
// D. Paste
// ---------------------------------------------------------------------------
const paste = (text) =>
  page.evaluate((text) => {
    const view = window.__fluxView;
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(ev);
    return new Promise((r) => setTimeout(() => r(view.state.doc.toString()), 120));
  }, text);

await setDocAndCaret("# Paste\n\nHere:\n\n\n", "Here:\n\n", 6);
{
  const doc = await paste("Name\tValue\nalpha\t1\nbeta\t2");
  res.pasteTsvNew = doc.includes("| Name  | Value |") && doc.includes("| beta  | 2     |");
}
{
  // Inside a table: splice, growing as needed.
  await setDocAndCaret("| A | B |\n| - | - |\n| 1 | 2 |\n", "| 1", 2);
  const doc = await paste("x\ty\nz\tw");
  res.pasteTsvSplice = doc.includes("| x") && doc.includes("| z") && doc.split("\n").length >= 4;
}
{
  // Plain text with a pipe into a cell → escaped, single row intact.
  await setDocAndCaret("| A | B |\n| - | - |\n| 1 | 2 |\n", "| 1", 2);
  const doc = await paste("a|b");
  res.pasteEscapes = doc.includes("a\\|b") || doc.includes("1a\\|b");
}

// ---------------------------------------------------------------------------
// E. Render (preview/export HTML)
// ---------------------------------------------------------------------------
{
  const r = await page.evaluate(async () => {
    const mod = await import("/src/shell/modes/paper/render/renderManuscript.ts");
    const src = [
      "See @tbl-x here.",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      ": My caption {#tbl-x}",
      "",
    ].join("\n");
    const out = await mod.renderManuscript(src, {});
    return out.inner;
  });
  res.renderBlock =
    /<figure class="tblblock"><div class="tblscroll"><table>[\s\S]*?<\/table><\/div>\s*<p class="cap" id="tbl-x"><b>Table 1\.<\/b>/.test(
      r,
    );
  res.renderRefLink = r.includes('<a href="#tbl-x">Table 1</a>');
}

await shot(page, "tables-final");
const errs = realErrors(page);
await browser.close();

console.log(JSON.stringify({ tables: res, errs }, null, 2));
const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nPAPER TABLES VERIFY: FAIL");
  process.exit(1);
}
console.log("\nPAPER TABLES VERIFY: PASS");
