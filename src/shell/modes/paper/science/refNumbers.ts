// ONE appearance-order numbering rule for inline-defined cross-referenceables —
// labeled tables today, labeled display equations when math lands (2.1). Consumed
// by BOTH the editor decorations (science/tables.ts keeps its registry aligned)
// and the renderer/export (render/renderManuscript.ts resolves @tbl/@eq from a
// pre-scan of the SAME text it renders) so one document can never number
// differently in the two — the old editor counted EVERY pipe table while the
// export counted captioned ones, making a single export self-contradictory.
//
// Semantics (Quarto's): only LABELED constructs participate in numbering.
//   table:    a `: Caption {#tbl-id}` line attached to a pipe table (directly
//             below it, or after one blank line — the editor's adjacency rule);
//             a stray caption line numbers nothing.
//   equation: a display block `$$ … $$` whose CLOSING line ends `{#eq-id}`
//             (single-line `$$…$$ {#eq-id}` too).
// Fenced code (``` / ~~~) is skipped. Pure text-in maps-out — no CodeMirror, no
// DOM — so it runs identically in the editor, the renderer, and tests.

export { TBL_CAPTION_RE, EQ_LABEL_RE } from "./refNumberGrammar";
import { EQ_LABEL_RE } from "./refNumberGrammar";
import { Text } from "@codemirror/state";
import { scanTables, numberTables } from "./tableModel";
export interface RefNumbers {
  tbl: Map<string, number>;
  eq: Map<string, number>;
}

import { MathBlockTracker } from "./mathGrammar";
import { protectedDocumentSpans } from "../../../../lib/manuscript/documentContext";

export function scanRefNumbers(text: string): RefNumbers {
  const tbl = new Map<string, number>(), eq = new Map<string, number>();
  const lines = text.split("\n"), spans = protectedDocumentSpans(text, { math: false, inline: false });
  const tracker = new MathBlockTracker();
  let offset = 0, spanIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    while (spanIndex < spans.length && spans[spanIndex].to <= offset) spanIndex++;
    if (!(spans[spanIndex]?.from <= offset)) {
      const block = tracker.feed(i + 1, lines[i]);
      if (block?.label && !eq.has(block.label)) eq.set(block.label, eq.size + 1);
    }
    offset += lines[i].length + 1;
  }
  for (const [table, number] of numberTables(scanTables(Text.of(lines)))) if (table.label && !tbl.has(table.label)) tbl.set(table.label, number);
  return { tbl, eq };
}
