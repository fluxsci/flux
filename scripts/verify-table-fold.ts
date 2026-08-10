#!/usr/bin/env -S npx tsx
// The collapsed table SOURCE (science/tableFold.ts, owner request 2026-08-10):
// a table's pipe block renders as one "Table N" pill unless the selection is
// inside it. Hermetic — EditorStates only, no DOM and no dev server, because
// the whole contract lives in the StateField:
//
//   A. COLLAPSE — every table starts folded, over its FULL block (header …
//      caption, the blank line before a detached caption included); the pill
//      carries the Quarto number (labeled tables only, unlabeled → none), and
//      the document is never touched.
//   B. REVEAL — a selection that touches the block, boundaries included, opens
//      exactly that block and nothing else; leaving re-collapses it; a range
//      spanning several tables opens all of them.
//   C. GATE — a prose keystroke, a caret move and an edit far from any table
//      cost ZERO document scans; edits in a cell OR in the caption do rebuild;
//      when nothing opens or closes the field returns the SAME value object
//      (CodeMirror then finds every decoration chunk shared and does no height
//      work).
//   D. STRUCTURE — folds never overlap, always cover whole lines, and a table
//      that stops being a table stops being folded.
//
//   npx tsx scripts/verify-table-fold.ts

import "./lib/cssStub.mjs"; // MUST register before the paper modules load (katex.min.css)
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

// Dynamic imports: static siblings would LOAD (and hit the .css) before the
// stub's registerHooks ever executes.
const { scienceTables } = await import("../src/shell/modes/paper/science/tables");
const { scienceTableFold } = await import("../src/shell/modes/paper/science/tableFold");
const { paperPerf } = await import("../src/shell/modes/paper/science/changeGate");

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const EXTS: Extension[] = [scienceTables, scienceTableFold];

const DOC = [
  "---", // 1
  'title: "Fold"', // 2
  "---", // 3
  "", // 4
  "Prose before the table with enough words to read as a paragraph.", // 5
  "", // 6
  "| Gene | Delta | p |", // 7
  "| --- | ---: | ---: |", // 8
  "| Foo | 1.2 | 0.01 |", // 9
  "| Bar | 3.4 | 0.02 |", // 10
  "", // 11
  ": First caption {#tbl-one}", // 12
  "", // 13
  "Prose between the two tables, also long enough to be a paragraph.", // 14
  "", // 15
  "| A | B |", // 16
  "| - | - |", // 17
  "| 1 | 2 |", // 18
  ": Second caption {#tbl-two}", // 19  (attached directly, no blank line)
  "", // 20
  "| Layout | Only |", // 21  (unlabeled — legitimate, just unnumbered)
  "| - | - |", // 22
  "| x | y |", // 23
  "", // 24
  "Prose after, far from every table, for the change-gate cases.", // 25
  "", // 26
  "```", // 27
  "| fenced | table |", // 28
  "| - | - |", // 29
  "```", // 30
  "", // 31
  ...Array.from({ length: 400 }, (_, i) => `Tail prose ${i} — the quick brown fox jumps over the lazy dog.`),
].join("\n");

const lineStart = (s: EditorState, n: number) => s.doc.line(n).from;
const lineEnd = (s: EditorState, n: number) => s.doc.line(n).to;
const folds = (s: EditorState): { from: number; to: number }[] => {
  const out: { from: number; to: number }[] = [];
  const it = (s.field(scienceTableFold).deco as DecorationSet).iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to });
    it.next();
  }
  return out;
};
const foldLines = (s: EditorState) =>
  folds(s).map((r) => `${s.doc.lineAt(r.from).number}-${s.doc.lineAt(r.to).number}`);
const pill = (s: EditorState, i: number) => {
  const e = s.field(scienceTableFold).entries[i];
  return e ? e.widget : null;
};
const at = (s: EditorState, pos: number) => s.update({ selection: { anchor: pos } }).state;

// ---- A. collapse ----------------------------------------------------------
const s0 = EditorState.create({ doc: DOC, extensions: EXTS, selection: { anchor: 0 } });

assert(
  JSON.stringify(foldLines(s0)) === JSON.stringify(["7-12", "16-19", "21-23"]),
  `(A) every table folded over its whole block, fenced one excluded (${foldLines(s0).join(" ")})`,
);
assert(
  folds(s0)[0].from === lineStart(s0, 7) && folds(s0)[0].to === lineEnd(s0, 12),
  "(A) the fold spans header … caption exactly, blank line before a detached caption included",
);
assert(
  pill(s0, 0)?.number === 1 && pill(s0, 1)?.number === 2 && pill(s0, 2)?.number === null,
  `(A) pills carry the Quarto number; the unlabeled table has none (${pill(s0, 0)?.number}/${pill(s0, 1)?.number}/${pill(s0, 2)?.number})`,
);
assert(
  pill(s0, 0)?.rows === 2 && pill(s0, 0)?.cols === 3 && pill(s0, 0)?.hasCaption === true,
  "(A) the pill knows its shape (rows × cols + caption) for the tooltip",
);
assert(s0.doc.toString() === DOC, "(A) folding never touches the document");
assert(
  s0.field(scienceTables).size > 0,
  "(A) the rendered-table field is untouched — the widget below the pill still exists",
);

// ---- B. reveal ------------------------------------------------------------
{
  const s = at(s0, lineStart(s0, 9) + 3); // inside a body row
  assert(
    JSON.stringify(foldLines(s)) === JSON.stringify(["16-19", "21-23"]),
    `(B) caret in a row opens THAT table only (${foldLines(s).join(" ")})`,
  );
  const back = at(s, lineStart(s0, 5));
  assert(
    JSON.stringify(foldLines(back)) === JSON.stringify(foldLines(s0)),
    "(B) leaving re-collapses it, identically",
  );
}
for (const [label, pos] of [
  ["block start", lineStart(s0, 7)],
  ["block end", lineEnd(s0, 12)],
  ["delimiter row", lineStart(s0, 8) + 2],
  ["blank line inside the block", lineStart(s0, 11)],
  ["caption line", lineStart(s0, 12) + 4],
] as const) {
  const s = at(s0, pos);
  assert(!foldLines(s).includes("7-12"), `(B) caret at the ${label} reveals the source`);
}
for (const [label, pos] of [
  ["line above", lineEnd(s0, 6)],
  ["line below", lineStart(s0, 13)],
] as const) {
  const s = at(s0, pos);
  assert(foldLines(s).includes("7-12"), `(B) caret on the ${label} leaves it collapsed`);
}
{
  const s = s0.update({ selection: { anchor: lineStart(s0, 9), head: lineStart(s0, 18) } }).state;
  assert(folds(s).length === 1, `(B) a selection across two tables opens both (${foldLines(s).join(" ")})`);
}
{
  // The paper editor is single-selection today (nothing enables the facet), but
  // the predicate reads EVERY range — pinned here so a future multi-cursor
  // editor cannot silently leave a cursor stranded inside hidden text.
  const multi = EditorState.create({
    doc: DOC,
    extensions: [EXTS, EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create([
      EditorSelection.cursor(lineStart(s0, 9)),
      EditorSelection.cursor(lineStart(s0, 22)),
    ]),
  });
  assert(
    JSON.stringify(foldLines(multi)) === JSON.stringify(["16-19"]),
    `(B) multiple cursors open every table they touch (${foldLines(multi).join(" ")})`,
  );
}

// ---- C. change gate + value identity --------------------------------------
const counts = () => paperPerf.tableFold;
const FAR = 40; // deep in the tail prose, well outside every table's guard window
{
  const b = counts();
  const s1 = s0.update({ changes: { from: lineEnd(s0, FAR), insert: "x" } }).state;
  assert(counts() === b, "(C) a prose keystroke far from any table → ZERO scans");
  assert(
    JSON.stringify(foldLines(s1)) === JSON.stringify(foldLines(s0)),
    "(C) …and the folds map through the change, still whole blocks",
  );
}
{
  const b = counts();
  const s1 = at(s0, lineStart(s0, FAR));
  assert(counts() === b, "(C) a caret move between prose lines → ZERO scans");
  assert(
    s1.field(scienceTableFold) === s0.field(scienceTableFold),
    "(C) …and the field value is the SAME object (no decoration churn, no height work)",
  );
}
{
  const opened = at(s0, lineStart(s0, 9) + 3);
  const b = counts();
  const moved = at(opened, lineStart(s0, 10) + 3); // another row of the same table
  assert(counts() === b, "(C) moving between rows of an OPEN table → ZERO scans");
  assert(
    moved.field(scienceTableFold) === opened.field(scienceTableFold),
    "(C) …and still the same value object (the open/closed set did not change)",
  );
}
{
  const b = counts();
  s0.update({ changes: { from: lineEnd(s0, 9) - 2, insert: "9" } }).state;
  assert(counts() > b, "(C) an edit in a table cell DOES rescan");
}
{
  const b = counts();
  s0.update({ changes: { from: lineStart(s0, 12) + 4, insert: "!" } }).state;
  assert(counts() > b, "(C) an edit in the CAPTION rescans too — no trigger token on that line");
}
{
  // The caption of an OPEN table carries no fold decoration of its own; the
  // gate must still fire off the table's span (that is what `spans` is for).
  const open = at(s0, lineStart(s0, 12) + 4);
  const b = counts();
  const s1 = open.update({ changes: { from: lineStart(s0, 12) + 4, insert: "!" } }).state;
  assert(counts() > b, "(C) …including while that table is revealed");
  assert(
    at(s1, 0).field(scienceTableFold).entries[0].to === lineEnd(s1, 12),
    "(C) …so the re-collapsed fold covers the edited caption, not a stale range",
  );
}

// ---- D. structure ---------------------------------------------------------
{
  const f = folds(s0);
  assert(
    f.every((r, i) => i === 0 || r.from > f[i - 1].to),
    "(D) folds never overlap",
  );
  assert(
    f.every((r) => lineStart(s0, s0.doc.lineAt(r.from).number) === r.from && lineEnd(s0, s0.doc.lineAt(r.to).number) === r.to),
    "(D) folds cover whole lines (a partial line would hide text mid-row)",
  );
}
{
  // Break the delimiter row: markdown-it stops seeing a table, so must we.
  const s1 = s0.update({ changes: { from: lineStart(s0, 17), to: lineEnd(s0, 17), insert: "not a delimiter" } }).state;
  assert(
    !foldLines(s1).includes("16-19"),
    `(D) a table that stops being a table stops being folded (${foldLines(s1).join(" ")})`,
  );
}
{
  // Deleting the whole first block leaves the others correctly placed.
  const s1 = s0.update({ changes: { from: lineStart(s0, 7), to: lineEnd(s0, 12) } }).state;
  assert(
    foldLines(s1).length === 2 && s1.doc.sliceString(folds(s1)[0].from, folds(s1)[0].to).startsWith("| A |"),
    `(D) deleting a whole block re-derives the rest against the new doc (${foldLines(s1).join(" ")})`,
  );
}

console.log(failures ? `\nTABLE FOLD: FAIL (${failures})` : "\nTABLE FOLD: PASS");
process.exit(failures ? 1 : 0);
