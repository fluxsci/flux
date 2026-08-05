// Table-ops gate — the state-level table editing core (editing/tableOps.ts):
// Tab/Shift-Tab cell walking (+ grow-by-row), Enter row-below / empty-row
// exit, row/column insert/delete, alignment cycling, cell jump, TSV copy —
// and the tableReflow transactionFilter: same-transaction padding (ONE undo
// unit), caret preserved by cell+offset, user-events only (undo/agent edits
// never reformat), fenced tables untouched.
// Run: npx tsx scripts/verify-table-ops.ts
import { EditorState, EditorSelection } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import {
  tabSpec,
  enterSpec,
  rowSpec,
  deleteRowSpec,
  colSpec,
  deleteColSpec,
  alignSpec,
  formatSpec,
  endAppendSpec,
  cellJumpSpec,
  tableTsv,
  locateTable,
  tableReflow,
} from "../src/shell/modes/paper/editing/tableOps";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TABLE = ["| Name | n |", "| :-- | --: |", "| alpha | 1 |", "| beta | 22 |"];
const mkState = (lines: string[], anchor: number, head = anchor, ext: unknown[] = []) =>
  EditorState.create({
    doc: lines.join("\n"),
    selection: EditorSelection.single(anchor, head),
    extensions: ext as never,
  });
/** Position of `needle` within the joined doc (first occurrence). */
const at = (lines: string[], needle: string, offset = 0): number =>
  lines.join("\n").indexOf(needle) + offset;
const selText = (st: EditorState) =>
  st.doc.sliceString(st.selection.main.from, st.selection.main.to);

// --- Tab walking --------------------------------------------------------------
{
  let st = mkState(TABLE, at(TABLE, "Name"));
  let spec = tabSpec(st, 1)!;
  st = st.update(spec).state;
  ok(selText(st) === "n", "Tab: header cell 1 → header cell 2 (content selected)", JSON.stringify(selText(st)));
  st = st.update(tabSpec(st, 1)!).state;
  ok(selText(st) === "alpha", "Tab: last header cell → first body cell");
  st = st.update(tabSpec(st, 1)!).state;
  st = st.update(tabSpec(st, 1)!).state;
  ok(selText(st) === "beta", "Tab keeps walking rows");
  st = st.update(tabSpec(st, 1)!).state;
  const before = st.doc.lines;
  st = st.update(tabSpec(st, 1)!).state;
  ok(st.doc.lines === before + 1, "Tab past the last cell grows a row", String(st.doc.lines));
  ok(st.selection.main.empty, "…caret in the new empty cell");
  const spec2 = tabSpec(st, -1)!;
  st = st.update(spec2).state;
  ok(selText(st) === "22", "Shift-Tab: back to the previous row's last cell");
}
{
  // Off-table: null (the key falls through to indentWithTab).
  const lines = ["prose line", "", ...TABLE];
  ok(tabSpec(mkState(lines, 2), 1) === null, "Tab off-table → null");
}
{
  // Reformat happens on Tab: a ragged unpadded table comes out canonical.
  const messy = ["|Name|n|", "|-|-|", "|alpha|1|"];
  let st = mkState(messy, at(messy, "Name"));
  st = st.update(tabSpec(st, 1)!).state;
  ok(st.doc.line(1).text === "| Name  | n   |", "Tab normalizes the block", JSON.stringify(st.doc.line(1).text));
  ok(st.doc.line(2).text === "| ----- | --- |", "…including the delimiter");
}

// --- Enter --------------------------------------------------------------------
{
  let st = mkState(TABLE, at(TABLE, "alpha", 2));
  st = st.update(enterSpec(st)!).state;
  ok(st.doc.lines === TABLE.length + 1, "Enter inserts a row below");
  ok(st.doc.line(4).text.startsWith("|") && /\|\s+\|/.test(st.doc.line(4).text), "…an empty piped row", st.doc.line(4).text);
  ok(st.selection.main.empty && st.doc.lineAt(st.selection.main.head).number === 4, "…caret in its first cell");
}
{
  // Empty last row + Enter = exit below the block (row removed).
  const lines = ["| a | b |", "| - | - |", "| 1 | 2 |", "|   |   |", ": Cap {#tbl-x}", "", "after"];
  let st = mkState(lines, at(lines, "|   |") + 2);
  st = st.update(enterSpec(st)!).state;
  ok(!st.doc.toString().includes("|   |"), "empty last row deleted on Enter");
  const caretLine = st.doc.lineAt(st.selection.main.head);
  ok(caretLine.text.trim() === "" && caretLine.number === 5, "caret exits BELOW the caption", `line ${caretLine.number}: ${JSON.stringify(caretLine.text)}`);
}

// --- Rows / columns / alignment ----------------------------------------------
{
  let st = mkState(TABLE, at(TABLE, "alpha", 1));
  st = st.update(rowSpec(st, "above")!).state;
  ok(st.doc.line(3).text.includes("|") && st.doc.line(4).text.includes("alpha"), "row above inserts before the caret row");
  st = st.update(deleteRowSpec(st)!).state;
  ok(st.doc.lines === TABLE.length && st.doc.line(3).text.includes("alpha"), "delete row restores");
}
{
  let st = mkState(TABLE, at(TABLE, "alpha", 1));
  st = st.update(colSpec(st, "right")!).state;
  ok(st.doc.line(1).text.split("|").length === 5, "column inserted", st.doc.line(1).text);
  ok(st.selection.main.head < st.doc.length && st.doc.lineAt(st.selection.main.head).number === 3, "caret in the new cell of the caret row");
  st = st.update(deleteColSpec(st)!).state;
  ok(st.doc.line(1).text.split("|").length === 4, "column deleted");
}
{
  // Single-column table: deleteCol refuses.
  const one = ["| a |", "| - |", "| 1 |"];
  ok(deleteColSpec(mkState(one, at(one, "1"))) === null, "last column can't be deleted");
}
{
  let st = mkState(TABLE, at(TABLE, "Name", 1));
  st = st.update(alignSpec(st, "cycle")!).state;
  ok(st.doc.line(2).text.startsWith("| :") && st.doc.line(2).text.includes(":"), "align cycle left→center rewrites the delimiter", st.doc.line(2).text);
  st = st.update(alignSpec(st, "cycle")!).state;
  const cell = st.doc.line(2).text.split("|")[1].trim();
  ok(/^-+:$/.test(cell), "center→right", st.doc.line(2).text);
}

// --- format / jump / tsv / hover appends -------------------------------------
{
  const messy = ["|Name|n|", "|-|-|", "|alpha|1|", "absorbed prose", ": Cap {#tbl-f}"];
  let st = mkState(messy, at(messy, "alpha", 3));
  st = st.update(formatSpec(st)!).state;
  ok(st.doc.line(1).text === "| Name  | n   |", "format normalizes");
  ok(st.doc.line(4).text === "absorbed prose", "verbatim row untouched by format");
  const head = st.selection.main.head;
  ok(st.doc.lineAt(head).number === 3 && st.doc.sliceString(head - 3, head) === "alp", "caret preserved at cell offset", st.doc.sliceString(head - 3, head));
}
{
  const st = mkState(TABLE, 0);
  const spec = cellJumpSpec(st, at(TABLE, "beta"), 1, 1)!;
  const pos = (spec.selection as EditorSelection).main.head;
  ok(st.doc.sliceString(pos - 2, pos) === "22", "cell jump lands at content end", st.doc.sliceString(pos - 2, pos));
}
{
  const st = mkState(TABLE, 0);
  const t = locateTable(st.doc, at(TABLE, "alpha"))!;
  ok(tableTsv(t) === "Name\tn\nalpha\t1\nbeta\t22", "TSV copy", JSON.stringify(tableTsv(t)));
}
{
  let st = mkState(TABLE, 0);
  st = st.update(endAppendSpec(st, at(TABLE, "alpha"), "row")!).state;
  ok(st.doc.lines === TABLE.length + 1, "hover +Row appends at the end");
  st = st.update(endAppendSpec(st, at(TABLE, "alpha"), "col")!).state;
  ok(st.doc.line(1).text.split("|").length === 5, "hover +Col appends at the right");
  ok(st.doc.lineAt(st.selection.main.head).number === 1, "…and targets the new header cell");
}

// --- fences -------------------------------------------------------------------
{
  const lines = ["```", ...TABLE, "```"];
  ok(locateTable(mkState(lines, 0).doc, at(lines, "alpha")) === null, "fenced table is not editable as a table");
  ok(tabSpec(mkState(lines, at(lines, "alpha")), 1) === null, "Tab inside a fenced pseudo-table falls through");
}

// --- tableReflow filter -------------------------------------------------------
{
  // Typing inside a cell reformats the whole block in the SAME transaction,
  // with the caret glued to the typed text.
  const messy = ["|Name|n|", "|-|-|", "|alpha|1|"];
  const pos = at(messy, "alpha", 5);
  let st = mkState(messy, pos, pos, [history(), tableReflow]);
  const tr = st.update({
    changes: { from: pos, to: pos, insert: "X" },
    selection: EditorSelection.single(pos + 1),
    userEvent: "input.type",
  });
  st = tr.state;
  ok(st.doc.line(1).text === "| Name   | n   |", "reflow pads the header in the same transaction", JSON.stringify(st.doc.line(1).text));
  ok(st.doc.line(3).text === "| alphaX | 1   |", "typed char landed + row padded", JSON.stringify(st.doc.line(3).text));
  const h = st.selection.main.head;
  ok(st.doc.sliceString(h - 6, h) === "alphaX", "caret rides the typed text", JSON.stringify(st.doc.sliceString(h - 6, h)));
  // ONE undo unit: undo restores the pre-keystroke text exactly.
  let undone: EditorState | null = null;
  undo({ state: st, dispatch: (t) => (undone = t.state) });
  ok(undone !== null && (undone as unknown as EditorState).doc.toString() === messy.join("\n"), "keystroke+reflow undo as ONE unit", (undone as unknown as EditorState)?.doc.toString());
}
{
  // Non-user events (agent reload, programmatic dispatch) never reformat.
  const messy = ["|Name|n|", "|-|-|", "|alpha|1|"];
  const pos = at(messy, "alpha", 5);
  const st0 = mkState(messy, pos, pos, [tableReflow]);
  const st = st0.update({ changes: { from: pos, to: pos, insert: "X" } }).state;
  ok(st.doc.line(1).text === "|Name|n|", "no userEvent → no reflow", st.doc.line(1).text);
  const st2 = st0.update({ changes: { from: pos, to: pos, insert: "X" }, userEvent: "undo" }).state;
  ok(st2.doc.line(1).text === "|Name|n|", "undo events never reflow");
}
{
  // Typing in PROSE near a pipe never triggers table work; fenced tables stay
  // byte-frozen even while typed in.
  const lines = ["```", "|a|b|", "|-|-|", "|1|2|", "```"];
  const pos = at(lines, "|1|2|", 2);
  const st = mkState(lines, pos, pos, [tableReflow]).update({
    changes: { from: pos, to: pos, insert: "Z" },
    selection: EditorSelection.single(pos + 1),
    userEvent: "input.type",
  }).state;
  ok(st.doc.line(4).text === "|1Z|2|", "fenced pseudo-table never reflows", st.doc.line(4).text);
}
{
  // The absorbed (pipe-less) prose row is NEVER rewritten by reflow — pipes
  // are the author's declaration of row-ness.
  const lines = ["| a | b |", "| - | - |", "| 1 | 2 |", "absorbed prose"];
  const pos = at(lines, "prose", 5);
  const st = mkState(lines, pos, pos, [tableReflow]).update({
    changes: { from: pos, to: pos, insert: "X" },
    selection: EditorSelection.single(pos + 1),
    userEvent: "input.type",
  }).state;
  ok(st.doc.line(4).text === "absorbed proseX", "verbatim row keeps its text (no pipes invented)", st.doc.line(4).text);
}
{
  // Escaped pipes survive a reflow round-trip.
  const lines = ["| a \\| b | c |", "| - | - |", "| x | y |"];
  const pos = at(lines, "| x", 2);
  const st = mkState(lines, pos, pos, [tableReflow]).update({
    changes: { from: pos, to: pos, insert: "Q" },
    selection: EditorSelection.single(pos + 1),
    userEvent: "input.type",
  }).state;
  ok(st.doc.line(1).text.includes("a \\| b"), "escaped pipe content stable under reflow", st.doc.line(1).text);
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
