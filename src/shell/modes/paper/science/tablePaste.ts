// Table-aware paste (Flux_Paper_Plan.md B3 "paste TSV→table"):
//
//   • OUTSIDE a table, pasting a TSV grid (an Excel/Sheets/pandas copy —
//     every line the same tab count) inserts a canonical markdown table.
//   • INSIDE a table, a TSV grid splices Excel-style: cells fill right/down
//     from the caret cell, growing rows/columns as needed.
//   • INSIDE a table, plain text containing `|` pastes with the pipes
//     ESCAPED — pasting "a|b" into a cell must never shear the row apart.
//
// CSV never auto-converts (commas are prose) — the "Paste as table" palette
// command is the explicit path (PaperMode.pasteAsTable, shared conversion in
// tableModel.ts). Whole-DOI pastes are claimed by doiPaste before this runs.

import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { parseTsv, gridToTable, escapePipes, type TableRow } from "./tableModel";
import { locateTable, cellIndexAt } from "../editing/tableOps";
import { formatTableLines, rowCellSpans, type Align } from "./tableModel";

export function tablePaste() {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return false;
      const sel = view.state.selection.main;
      const t = locateTable(view.state.doc, sel.head);

      if (!t) {
        const grid = parseTsv(text);
        if (!grid || grid.length < 2 || (grid[0]?.length ?? 0) < 2) return false;
        event.preventDefault();
        const line = view.state.doc.lineAt(sel.from);
        const table = gridToTable(grid);
        const empty = line.text.trim() === "";
        const insert = empty ? table : `\n\n${table}`;
        const from = empty ? line.from : line.to;
        const to = empty ? line.to : line.to;
        view.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.cursor(from + insert.length),
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        return true;
      }

      const ci = cellIndexAt(view.state.doc, t, sel.head);
      if (!ci) return false; // caption line: default paste

      const grid = parseTsv(text);
      if (grid) {
        // Excel-style splice: fill right/down from the caret cell.
        event.preventDefault();
        const startRow = ci.row === -2 ? -1 : ci.row;
        const cols = Math.max(t.head.length, ci.col + Math.max(...grid.map((r) => r.length)));
        const head = [...t.head];
        while (head.length < cols) head.push("");
        const aligns: Align[] = [...t.aligns];
        while (aligns.length < cols) aligns.push("left");
        const rows: TableRow[] = t.rows.map((r) => ({ ...r, cells: [...r.cells] }));
        for (let g = 0; g < grid.length; g++) {
          const rIdx = startRow + g;
          const target =
            rIdx < 0
              ? head
              : (rows[rIdx] ??= { line: -1, cells: [], piped: true }).cells;
          if (rIdx >= 0 && !rows[rIdx].piped) continue; // never rewrite absorbed prose
          for (let c = 0; c < grid[g].length; c++) target[ci.col + c] = grid[g][c];
        }
        for (const r of rows) if (r.piped) while (r.cells.length < cols) r.cells.push("");
        const f = formatTableLines({ head, aligns, rows });
        const lines = [f.header, f.delim];
        for (let i = 0; i < rows.length; i++)
          lines.push(f.rows[i] ?? view.state.doc.line(rows[i].line).text);
        const blockFrom = t.from;
        const blockTo = view.state.doc.line(t.lastRowLine).to;
        // Caret: end of the LAST pasted cell.
        const lastRow = Math.min(startRow + grid.length - 1, rows.length - 1);
        const lineIdx = lastRow < 0 ? 0 : 2 + lastRow;
        let caret = blockFrom;
        for (let i = 0; i < lineIdx; i++) caret += lines[i].length + 1;
        const spans = rowCellSpans(lines[lineIdx]);
        const s = spans[Math.min(ci.col + (grid[grid.length - 1]?.length ?? 1) - 1, spans.length - 1)];
        view.dispatch({
          changes: { from: blockFrom, to: blockTo, insert: lines.join("\n") },
          selection: EditorSelection.cursor(s ? caret + s.contentTo : caret),
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        return true;
      }

      // Plain text into a cell: escape pipes, collapse newlines (a multi-line
      // paste would shear the row structure).
      if (/[|\n]/.test(text)) {
        event.preventDefault();
        const safe = escapePipes(text.replace(/\s*\n\s*/g, " "));
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: safe },
          selection: EditorSelection.cursor(sel.from + safe.length),
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        return true;
      }
      return false;
    },
  });
}
