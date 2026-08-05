// Table-aware SOURCE editing (Flux_Paper_Plan.md B3, the editing tier): the
// GFM pipe rows in the document stay the single source of truth — these ops
// rewrite them canonically (tableModel.ts formatTableLines) and move the
// selection semantically (BY CELL, recomputed against the formatted text).
//
//   • Tab / Shift-Tab walk cells (selecting their content); Tab past the last
//     cell grows a row — the spreadsheet muscle memory.
//   • Enter inserts a row below the caret's; Enter on an EMPTY last row
//     deletes it and exits below the block (the list-editing pattern).
//   • Row/column insert/delete + per-column alignment as commands/chords.
//   • tableReflow: a transactionFilter that re-pads the pipes of the table
//     being TYPED IN, appended to the same transaction (one undo unit, caret
//     recomputed by cell+offset). It fires only for user input/delete events —
//     never undo/redo, IME composition, or external/agent reloads (text is
//     truth: files reformat only when the user edits that table).
//
// Everything is state-level (TransactionSpec builders) so the pure tier can
// exercise it without a DOM; the exported keymap wraps them as view commands.
// All bindings return false off-table, so Tab/Enter fall through to their
// usual behavior.

import { EditorSelection, EditorState, Text, ChangeSet, type TransactionSpec } from "@codemirror/state";
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import { frontMatterEndLine } from "../frontmatter";
import {
  tableAt,
  rowCellSpans,
  formatTableLines,
  type Align,
  type ParsedTable,
  type TableRow,
} from "../science/tableModel";

// ---------------------------------------------------------------------------
// Location (fence-/math-/front-matter-aware — tableAt itself is fence-blind)
// ---------------------------------------------------------------------------

const FENCE = /^\s*(```|~~~)/;
const MATH_CLOSE = /\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/;

function suspendedAt(doc: Text, lineNo: number, fmEnd: number): boolean {
  let inFence = false;
  let inMath = false;
  for (let n = fmEnd + 1; n < lineNo; n++) {
    const t = doc.line(n).text.trim();
    if (!inMath && FENCE.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (inMath) {
      if (MATH_CLOSE.test(t)) inMath = false;
      continue;
    }
    if (t.startsWith("$$")) {
      const rest = t.slice(2);
      if (!(MATH_CLOSE.test(rest) && rest.includes("$$"))) inMath = true;
    }
  }
  return inFence || inMath;
}

/** The real table at `pos`, or null (prose, front matter, fenced/math code). */
export function locateTable(doc: Text, pos: number): ParsedTable | null {
  const fmEnd = frontMatterEndLine(doc);
  if (doc.lineAt(pos).number <= fmEnd) return null;
  const t = tableAt(doc, pos);
  if (!t) return null;
  if (suspendedAt(doc, t.headerLine, fmEnd)) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Cell addressing. row: -1 = header, -2 = delimiter, 0.. = body row index;
// the caption line has no cells (→ null).
// ---------------------------------------------------------------------------

export interface CellRef {
  row: number;
  col: number;
}

export function cellIndexAt(doc: Text, t: ParsedTable, pos: number): CellRef | null {
  const line = doc.lineAt(pos);
  let row: number;
  if (line.number === t.headerLine) row = -1;
  else if (line.number === t.delimLine) row = -2;
  else {
    const idx = t.rows.findIndex((r) => r.line === line.number);
    if (idx < 0) return null;
    row = idx;
  }
  const spans = rowCellSpans(line.text);
  if (!spans.length) return { row, col: 0 };
  const off = pos - line.from;
  for (let i = 0; i < spans.length; i++) if (off <= spans[i].slotTo) return { row, col: i };
  return { row, col: spans.length - 1 };
}

// ---------------------------------------------------------------------------
// Block planning: shape mutation → canonical lines → one TransactionSpec with
// a cell-targeted selection computed against the NEW text.
// ---------------------------------------------------------------------------

interface Target {
  row: number; // -1 header, -2 delim, 0.. body (indices in the NEW row list)
  col: number;
  /** Cursor at contentFrom+offset instead of selecting the cell's content. */
  offset?: number;
  /** Place the cursor at the END of the content (cell jump). */
  atEnd?: boolean;
}

function planLines(doc: Text, head: string[], aligns: Align[], rows: TableRow[]): string[] {
  const f = formatTableLines({ head, aligns, rows });
  const lines = [f.header, f.delim];
  for (let i = 0; i < rows.length; i++) {
    lines.push(f.rows[i] ?? doc.line(rows[i].line).text);
  }
  return lines;
}

function selectionFor(blockFrom: number, lines: string[], target: Target): EditorSelection {
  const idx = target.row === -1 ? 0 : target.row === -2 ? 1 : 2 + target.row;
  const lineIdx = Math.max(0, Math.min(lines.length - 1, idx));
  let start = blockFrom;
  for (let i = 0; i < lineIdx; i++) start += lines[i].length + 1;
  const spans = rowCellSpans(lines[lineIdx]);
  if (!spans.length) return EditorSelection.single(start + lines[lineIdx].length);
  const s = spans[Math.max(0, Math.min(spans.length - 1, target.col))];
  if (target.offset !== undefined) {
    const off = Math.max(0, Math.min(s.contentTo - s.contentFrom, target.offset));
    return EditorSelection.single(start + s.contentFrom + off);
  }
  if (target.atEnd) return EditorSelection.single(start + s.contentTo);
  return EditorSelection.single(start + s.contentFrom, start + s.contentTo);
}

function blockSpec(
  state: EditorState,
  t: ParsedTable,
  lines: string[],
  target: Target,
): TransactionSpec {
  const blockFrom = t.from;
  const blockTo = state.doc.line(t.lastRowLine).to;
  const text = lines.join("\n");
  const orig = state.doc.sliceString(blockFrom, blockTo);
  return {
    changes: text === orig ? [] : [{ from: blockFrom, to: blockTo, insert: text }],
    selection: selectionFor(blockFrom, lines, target),
    scrollIntoView: true,
    userEvent: "input.table",
  };
}

const emptyRow = (cols: number): TableRow => ({ line: -1, cells: Array(cols).fill(""), piped: true });

// ---------------------------------------------------------------------------
// Spec builders (pure; the keymap wraps them)
// ---------------------------------------------------------------------------

export function tabSpec(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci) return null;
  const cols = t.head.length;
  const row = ci.row === -2 ? -1 : ci.row;
  const cellCount = (r: number): number => (r === -1 ? cols : t.rows[r].piped ? cols : 1);
  const col = Math.min(ci.col, cellCount(row) - 1);
  let nr = row;
  let nc = col + dir;
  if (dir > 0 && nc >= cellCount(row)) {
    if (row + 1 < t.rows.length || (row === -1 && t.rows.length > 0)) {
      nr = row === -1 ? 0 : row + 1;
      nc = 0;
    } else {
      // Tab past the last cell grows the table by a row.
      const rows = [...t.rows, emptyRow(cols)];
      return blockSpec(state, t, planLines(state.doc, t.head, t.aligns, rows), {
        row: rows.length - 1,
        col: 0,
      });
    }
  } else if (dir < 0 && nc < 0) {
    if (row === -1) {
      nc = 0; // first cell of the header: stay (still swallow the key — a
      // Shift-Tab dedent inside a table would mangle the row)
    } else {
      nr = row === 0 ? -1 : row - 1;
      nc = cellCount(nr) - 1;
    }
  }
  return blockSpec(state, t, planLines(state.doc, t.head, t.aligns, t.rows), { row: nr, col: nc });
}

export function enterSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci) return null;
  const row = ci.row === -2 ? -1 : ci.row;

  // Enter on an EMPTY last row: delete it and exit below the block (the
  // "Enter twice ends the list" pattern).
  if (
    row >= 0 &&
    row === t.rows.length - 1 &&
    t.rows[row].piped &&
    t.rows[row].cells.every((c) => c === "")
  ) {
    const rowLine = state.doc.line(t.rows[row].line);
    const changes: { from: number; to: number; insert: string }[] = [
      { from: rowLine.from - 1, to: rowLine.to, insert: "" }, // the row + its newline
    ];
    // Land after the block (after the caption when attached), on a blank line.
    const endLineNo = t.captionLine ?? t.lastRowLine;
    const endPos = state.doc.line(endLineNo).to;
    let caretSrc: number;
    if (endLineNo + 1 <= state.doc.lines && state.doc.line(endLineNo + 1).text.trim() === "") {
      caretSrc = state.doc.line(endLineNo + 1).from;
    } else {
      changes.push({ from: endPos, to: endPos, insert: "\n" });
      caretSrc = endPos + 1;
    }
    const cs = ChangeSet.of(changes, state.doc.length);
    return {
      changes,
      selection: EditorSelection.single(cs.mapPos(caretSrc, 1)),
      scrollIntoView: true,
      userEvent: "input.table",
    };
  }

  const insertAt = row < 0 ? 0 : row + 1;
  const rows = [...t.rows];
  rows.splice(insertAt, 0, emptyRow(t.head.length));
  return blockSpec(state, t, planLines(state.doc, t.head, t.aligns, rows), {
    row: insertAt,
    col: 0,
  });
}

export function rowSpec(state: EditorState, where: "above" | "below"): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci) return null;
  const row = ci.row === -2 ? -1 : ci.row;
  const insertAt = row < 0 ? 0 : where === "above" ? row : row + 1;
  const rows = [...t.rows];
  rows.splice(insertAt, 0, emptyRow(t.head.length));
  return blockSpec(state, t, planLines(state.doc, t.head, t.aligns, rows), {
    row: insertAt,
    col: 0,
  });
}

export function deleteRowSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci || ci.row < 0) return null; // header/delimiter rows are structure
  const rows = [...t.rows];
  rows.splice(ci.row, 1);
  const target: Target = rows.length
    ? { row: Math.min(ci.row, rows.length - 1), col: ci.col }
    : { row: -1, col: ci.col };
  return blockSpec(state, t, planLines(state.doc, t.head, t.aligns, rows), target);
}

export function colSpec(state: EditorState, where: "left" | "right"): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci) return null;
  const at = where === "left" ? ci.col : ci.col + 1;
  const head = [...t.head];
  const aligns = [...t.aligns];
  head.splice(at, 0, "");
  aligns.splice(at, 0, "left");
  const rows = t.rows.map((r) => {
    if (!r.piped) return r;
    const cells = [...r.cells];
    while (cells.length < t.head.length) cells.push(""); // ragged rows: complete first
    cells.splice(at, 0, "");
    return { ...r, cells };
  });
  return blockSpec(state, t, planLines(state.doc, head, aligns, rows), {
    row: ci.row === -2 ? -1 : ci.row,
    col: at,
  });
}

export function deleteColSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci || t.head.length <= 1) return null;
  const at = Math.min(ci.col, t.head.length - 1);
  const head = [...t.head];
  const aligns = [...t.aligns];
  head.splice(at, 1);
  aligns.splice(at, 1);
  const rows = t.rows.map((r) => {
    if (!r.piped) return r;
    const cells = [...r.cells];
    if (at < cells.length) cells.splice(at, 1);
    return { ...r, cells };
  });
  return blockSpec(state, t, planLines(state.doc, head, aligns, rows), {
    row: ci.row === -2 ? -1 : ci.row,
    col: Math.min(at, head.length - 1),
  });
}

const ALIGN_CYCLE: Record<Align, Align> = { left: "center", center: "right", right: "left" };

export function alignSpec(state: EditorState, align: Align | "cycle"): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  if (!ci) return null;
  const aligns = [...t.aligns];
  const col = Math.min(ci.col, aligns.length - 1);
  aligns[col] = align === "cycle" ? ALIGN_CYCLE[aligns[col] ?? "left"] : align;
  return blockSpec(state, t, planLines(state.doc, t.head, aligns, t.rows), {
    row: ci.row === -2 ? -1 : ci.row,
    col,
  });
}

/** Column alignment WITHOUT caret involvement (the widget's Alt-click-a-header
 *  path — the caret may be anywhere; the selection just maps through). */
export function alignColSpec(
  state: EditorState,
  pos: number,
  col: number,
  align: Align | "cycle",
): TransactionSpec | null {
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const aligns = [...t.aligns];
  const c = Math.max(0, Math.min(col, aligns.length - 1));
  aligns[c] = align === "cycle" ? ALIGN_CYCLE[aligns[c] ?? "left"] : align;
  const text = planLines(state.doc, t.head, aligns, t.rows).join("\n");
  const blockTo = state.doc.line(t.lastRowLine).to;
  if (text === state.doc.sliceString(t.from, blockTo)) return null;
  return { changes: [{ from: t.from, to: blockTo, insert: text }], userEvent: "input.table" };
}

export function formatSpec(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head;
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const ci = cellIndexAt(state.doc, t, pos);
  const lines = planLines(state.doc, t.head, t.aligns, t.rows);
  if (!ci) {
    // Caret on the caption line: format the rows, keep the caret put.
    const spec = blockSpec(state, t, lines, { row: -1, col: 0 });
    const cs = ChangeSet.of(
      (spec.changes as { from: number; to: number; insert: string }[]) ?? [],
      state.doc.length,
    );
    return { ...spec, selection: EditorSelection.single(cs.mapPos(pos, -1)), scrollIntoView: false };
  }
  const line = state.doc.lineAt(pos);
  const spans = rowCellSpans(line.text);
  const s = spans[Math.min(ci.col, Math.max(0, spans.length - 1))];
  const offset = s ? Math.max(0, pos - line.from - s.contentFrom) : 0;
  return blockSpec(state, t, lines, { row: ci.row, col: ci.col, offset });
}

/** Hover-bar actions: append a row / column at the table's end. `pos` is any
 *  position inside the table (PaperMode resolves it via view.posAtDOM). */
export function endAppendSpec(
  state: EditorState,
  pos: number,
  what: "row" | "col",
): TransactionSpec | null {
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  if (what === "row") {
    const rows = [...t.rows, emptyRow(t.head.length)];
    return blockSpec(state, t, planLines(state.doc, t.head, t.aligns, rows), {
      row: rows.length - 1,
      col: 0,
    });
  }
  const head = [...t.head, ""];
  const aligns: Align[] = [...t.aligns, "left"];
  const rows = t.rows.map((r) => {
    if (!r.piped) return r;
    const cells = [...r.cells];
    while (cells.length < head.length) cells.push("");
    return { ...r, cells };
  });
  // Select the new HEADER cell — naming the column is the next thing you do.
  return blockSpec(state, t, planLines(state.doc, head, aligns, rows), {
    row: -1,
    col: head.length - 1,
  });
}

/** Widget cell click → caret at the END of that cell's source content. */
export function cellJumpSpec(
  state: EditorState,
  pos: number,
  row: number,
  col: number,
): TransactionSpec | null {
  const t = locateTable(state.doc, pos);
  if (!t) return null;
  const lineNo = row < 0 ? t.headerLine : t.rows[Math.min(row, t.rows.length - 1)]?.line;
  if (lineNo === undefined) return null;
  const line = state.doc.line(lineNo);
  const spans = rowCellSpans(line.text);
  if (!spans.length) return { selection: EditorSelection.single(line.to), scrollIntoView: true };
  const s = spans[Math.max(0, Math.min(spans.length - 1, col))];
  return {
    selection: EditorSelection.single(line.from + s.contentTo),
    scrollIntoView: true,
    userEvent: "select",
  };
}

/** The table as tab-separated values (TRUE cell content — pastes into
 *  Excel/Sheets/R). */
export function tableTsv(t: ParsedTable): string {
  const cols = t.head.length;
  const row = (cells: string[]): string =>
    Array.from({ length: cols }, (_, i) => cells[i] ?? "").join("\t");
  return [row(t.head), ...t.rows.map((r) => row(r.cells))].join("\n");
}

// ---------------------------------------------------------------------------
// Auto-reflow: pad the pipes of the table being typed in, in the SAME
// transaction (one undo unit). User input/delete only — never undo/redo,
// composition, or programmatic/agent edits.
// ---------------------------------------------------------------------------

export const tableReflow = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (!(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
  if (tr.isUserEvent("input.type.compose")) return tr; // never fight the IME
  const doc = tr.newDoc;
  const cands: number[] = [];
  tr.changes.iterChanges((_fa, _ta, fb, tb) => {
    cands.push(fb);
    if (tb !== fb) cands.push(tb);
  });
  const seen = new Set<number>();
  const changes: { from: number; to: number; insert: string }[] = [];
  let sel: EditorSelection | undefined;
  const head = tr.newSelection.main.head;
  for (const cand of cands) {
    const pos = Math.min(cand, doc.length);
    if (!doc.lineAt(pos).text.includes("|")) continue; // cheap prose bail
    const t = locateTable(doc, pos);
    if (!t || seen.has(t.headerLine)) continue;
    seen.add(t.headerLine);
    const lines = planLines(doc, t.head, t.aligns, t.rows);
    const blockTo = doc.line(t.lastRowLine).to;
    if (lines.join("\n") === doc.sliceString(t.from, blockTo)) continue;
    // Per-line diffs (decorations map tighter than a whole-block splice).
    for (let i = 0; i < lines.length; i++) {
      const old = doc.line(t.headerLine + i);
      if (old.text !== lines[i]) changes.push({ from: old.from, to: old.to, insert: lines[i] });
    }
    // Caret preservation by (cell, offset-in-content) — padding must never
    // push the caret around. Single-cursor only; multi-cursor falls back to
    // positional mapping.
    if (tr.newSelection.ranges.length === 1 && head >= t.from && head <= blockTo) {
      const ci = cellIndexAt(doc, t, head);
      if (ci) {
        const oldLine = doc.lineAt(head);
        const spans = rowCellSpans(oldLine.text);
        const s = spans[Math.min(ci.col, Math.max(0, spans.length - 1))];
        const offset = s ? Math.max(0, head - oldLine.from - s.contentFrom) : 0;
        const lineIdx = oldLine.number - t.headerLine;
        let start = t.from;
        for (let i = 0; i < lineIdx; i++) start += lines[i].length + 1;
        const spans2 = rowCellSpans(lines[lineIdx]);
        const s2 = spans2[Math.min(ci.col, Math.max(0, spans2.length - 1))];
        if (s2) {
          const off = Math.min(offset, s2.contentTo - s2.contentFrom);
          sel = EditorSelection.single(start + s2.contentFrom + off);
        }
      }
    }
  }
  if (!changes.length) return tr;
  return [tr, { changes, selection: sel, sequential: true }];
});

// ---------------------------------------------------------------------------
// Keymap (returns false off-table so every key falls through)
// ---------------------------------------------------------------------------

const run =
  (fn: (state: EditorState) => TransactionSpec | null) =>
  (view: EditorView): boolean => {
    const spec = fn(view.state);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };

export const tableCommands = {
  tabNext: run((s) => tabSpec(s, 1)),
  tabPrev: run((s) => tabSpec(s, -1)),
  enter: run(enterSpec),
  rowAbove: run((s) => rowSpec(s, "above")),
  rowBelow: run((s) => rowSpec(s, "below")),
  deleteRow: run(deleteRowSpec),
  colLeft: run((s) => colSpec(s, "left")),
  colRight: run((s) => colSpec(s, "right")),
  deleteCol: run(deleteColSpec),
  alignCycle: run((s) => alignSpec(s, "cycle")),
  format: run(formatSpec),
};

const bindings: KeyBinding[] = [
  { key: "Tab", run: tableCommands.tabNext },
  { key: "Shift-Tab", run: tableCommands.tabPrev },
  { key: "Enter", run: tableCommands.enter },
  { key: "Mod-Alt-r", run: tableCommands.rowBelow },
  { key: "Mod-Alt-Shift-r", run: tableCommands.deleteRow },
  { key: "Mod-Alt-c", run: tableCommands.colRight },
  { key: "Mod-Alt-Shift-c", run: tableCommands.deleteCol },
  { key: "Mod-Alt-a", run: tableCommands.alignCycle },
];

/** Compose BEFORE markdown-setup's trailing default keymap (indentWithTab must
 *  lose to table-Tab). */
export const tableKeymap = keymap.of(bindings);
