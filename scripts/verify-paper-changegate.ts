#!/usr/bin/env -S npx tsx
// WS-2 Fix 1 (fortify plan) — the change-gate contract for the block-widget
// StateFields (embeds/tables/math). Hermetic: builds EditorStates directly (no
// DOM, no dev server) on a 5k-line synthetic doc and asserts, per transaction
// shape, WHICH fields rebuild (paperPerf counters) and that the mapped
// decorations stay glued to their lines when a field does NOT rebuild.
//
//   npx tsx scripts/verify-paper-changegate.ts

import "./lib/cssStub.mjs"; // MUST register before the paper modules load (katex.min.css)
import { EditorState, type Extension } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

// Dynamic imports: static siblings would LOAD (and hit the .css) before the
// stub's registerHooks ever executes.
const { scienceEmbeds } = await import("../src/shell/modes/paper/science/embeds");
const { scienceTables } = await import("../src/shell/modes/paper/science/tables");
const { scienceMathBlocks } = await import("../src/shell/modes/paper/science/math");
const { paperPerf } = await import("../src/shell/modes/paper/science/changeGate");
const { citeNumberField } = await import("../src/shell/modes/paper/science/citeNumbers");

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- 5k-line synthetic doc -----------------------------------------------
const lines: string[] = ["---", 'title: "Gate"', "---", ""];
while (lines.length < 5000 - 20) {
  const i = lines.length;
  if (i === 1000) lines.push("![](../fig/renders/f0.svg){#fig-gate0}");
  else if (i === 1500) lines.push("Cited here [@smith2020] mid line for the mask cases.");
  else if (i === 2000) lines.push("| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |");
  else if (i === 2010) lines.push(""); // gap, then a labeled table with caption
  else if (i === 2011) lines.push("| H1 | H2 |", "|---|---|", "| x | y |", "", ": My caption {#tbl-gate}");
  else if (i === 3000) lines.push("$$", "E = mc^2", "$$");
  else if (i % 5 === 4) lines.push("");
  else lines.push(`Prose line ${i} — the quick brown fox jumps over the lazy dog.`);
}
while (lines.length < 5000) lines.push(`Tail ${lines.length}.`);
const DOC = lines.join("\n");
const EXTS: Extension[] = [scienceEmbeds, scienceTables, scienceMathBlocks, citeNumberField];

const lineStart = (state: EditorState, n: number) => state.doc.line(n).from;
const lineEnd = (state: EditorState, n: number) => state.doc.line(n).to;
const findLine = (state: EditorState, needle: string, from = 1) => {
  for (let i = from; i <= state.doc.lines; i++) if (state.doc.line(i).text.includes(needle)) return i;
  throw new Error(`line with ${JSON.stringify(needle)} not found`);
};
const counts = () => ({ ...paperPerf });
const delta = (b: ReturnType<typeof counts>) => ({
  embeds: paperPerf.embeds - b.embeds,
  tables: paperPerf.tables - b.tables,
  math: paperPerf.math - b.math,
  cite: paperPerf.citeScans - b.citeScans,
});
function widgets(set: DecorationSet): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const it = set.iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to });
    it.next();
  }
  return out;
}

const state0 = EditorState.create({ doc: DOC, extensions: EXTS });
assert(widgets(state0.field(scienceEmbeds)).length === 2, "initial: embed line + widget decorations present");
assert(widgets(state0.field(scienceTables)).length > 6, "initial: table line + widget decorations present");
assert(widgets(state0.field(scienceMathBlocks)).length === 4, "initial: math line + widget decorations present");

// ---- (a) prose char insert → ZERO builds across all three fields ----------
{
  const proseAt = lineEnd(state0, findLine(state0, "Prose line 4000"));
  const b = counts();
  const s1 = state0.update({ changes: { from: proseAt, insert: "x" } }).state;
  const d = delta(b);
  assert(d.embeds === 0 && d.tables === 0 && d.math === 0 && d.cite === 0, `(a) prose char insert → zero builds/scans (${JSON.stringify(d)})`);
  // mapped positions: the embed widget stays glued to its line
  const embLine = findLine(s1, "{#fig-gate0}");
  const w = widgets(s1.field(scienceEmbeds));
  assert(
    w.some((r) => r.from === lineStart(s1, embLine)) && w.some((r) => r.to === lineEnd(s1, embLine)),
    "(a) embed decorations mapped to the same line",
  );
}
{
  // prose insert ABOVE the embed shifts everything — positions must follow
  const above = lineEnd(state0, 500);
  const b = counts();
  const s1 = state0.update({ changes: { from: above, insert: "yy" } }).state;
  const d = delta(b);
  assert(d.embeds === 0 && d.tables === 0 && d.math === 0, "(a2) prose insert above constructs → zero builds");
  const embLine = findLine(s1, "{#fig-gate0}");
  const w = widgets(s1.field(scienceEmbeds));
  assert(w.some((r) => r.from === lineStart(s1, embLine)), "(a2) embed decoration shifted with the doc (map)");
}

// ---- (b) edits inside construct lines → exactly that field rebuilds -------
{
  const embLine = findLine(state0, "{#fig-gate0}");
  const b = counts();
  state0.update({ changes: { from: lineEnd(state0, embLine) - 1, insert: "x" } }).state;
  const d = delta(b);
  assert(d.embeds >= 1, `(b) edit on the embed line rebuilds embeds (${d.embeds})`);
  assert(d.tables === 0 && d.math === 0, "(b) …and does not rebuild tables/math (their tokens/guards untouched)");
}
{
  const cellLine = findLine(state0, "| 1 | 2 |");
  const b = counts();
  state0.update({ changes: { from: lineEnd(state0, cellLine) - 2, insert: "9" } }).state;
  const d = delta(b);
  assert(d.tables >= 1, `(b) edit in a table cell rebuilds tables (${d.tables})`);
  assert(d.embeds === 0 && d.math === 0, "(b) …tables only");
}
{
  const mathLine = findLine(state0, "E = mc^2");
  const b = counts();
  state0.update({ changes: { from: lineEnd(state0, mathLine), insert: " + 1" } }).state;
  const d = delta(b);
  assert(d.math >= 1, `(b) edit inside $$ block rebuilds math (${d.math})`);
  assert(d.embeds === 0 && d.tables === 0, "(b) …math only");
}

// ---- (c) newline insert → all fields rebuild (line structure changed) -----
{
  const proseAt = lineEnd(state0, findLine(state0, "Prose line 4000"));
  const b = counts();
  state0.update({ changes: { from: proseAt, insert: "\n" } }).state;
  const d = delta(b);
  assert(d.embeds >= 1 && d.tables >= 1 && d.math >= 1, `(c) newline insert rebuilds all (${JSON.stringify(d)})`);
}

// ---- (d) paste containing construct tokens --------------------------------
{
  const proseAt = lineEnd(state0, findLine(state0, "Prose line 4010"));
  const b = counts();
  const s1 = state0.update({ changes: { from: proseAt, insert: " see ![alt](p.svg){#fig-new}" } }).state;
  const d = delta(b);
  assert(d.embeds >= 1, `(d) paste containing ![ rebuilds embeds (${d.embeds})`);
  void s1;
}

// ---- creation by TYPING (single chars — the token-on-touched-LINE clause) --
{
  // "!" then "[" — the second keystroke completes "![" on the new line
  const at = lineEnd(state0, findLine(state0, "Prose line 4020"));
  const s1 = state0.update({ changes: { from: at, insert: "!" } }).state;
  const b = counts();
  s1.update({ changes: { from: at + 1, insert: "[" } }).state;
  const d = delta(b);
  assert(d.embeds >= 1, "(typing) completing ![ char-by-char rebuilds embeds");
}
{
  // completing $$ char-by-char
  const at = lineEnd(state0, findLine(state0, "Prose line 4030"));
  const s1 = state0.update({ changes: { from: at, insert: "$" } }).state;
  const b = counts();
  s1.update({ changes: { from: at + 1, insert: "$" } }).state;
  const d = delta(b);
  assert(d.math >= 1, "(typing) completing $$ char-by-char rebuilds math");
}
{
  // deleting the "[" of an embed line (removed-text/old-line clause)
  const embLine = findLine(state0, "{#fig-gate0}");
  const from = lineStart(state0, embLine) + 1; // the "[" in "!["
  const b = counts();
  const s1 = state0.update({ changes: { from, to: from + 1 } }).state;
  const d = delta(b);
  assert(d.embeds >= 1, "(delete) removing the [ of ![ rebuilds embeds");
  assert(widgets(s1.field(scienceEmbeds)).length === 0, "(delete) …and the embed widget disappeared");
}

// ---- table caption typed below the block (guardLines: 2) ------------------
{
  const capTableLine = findLine(state0, "| x | y |");
  // the blank line right below the last row, one above the caption slot
  const at = lineStart(state0, capTableLine + 1);
  const b = counts();
  state0.update({ changes: { from: at, insert: "z" } }).state; // typing near the caption gap
  const d = delta(b);
  assert(d.tables >= 1, "(guard) edit in the caption gap (≤2 lines below the block) rebuilds tables");
}

// ---- multi-line cut crossing a table (risk battery) -----------------------
{
  const headLine = findLine(state0, "| A | B |");
  const from = lineStart(state0, headLine - 1);
  const to = lineEnd(state0, headLine + 2); // removes header+delim+first row
  const b = counts();
  const s1 = state0.update({ changes: { from, to } }).state;
  const d = delta(b);
  assert(d.tables >= 1, "(cut) multi-line cut crossing a table rebuilds tables");
  const w = widgets(s1.field(scienceTables));
  assert(
    !s1.doc.toString().includes("| A | B |") && w.length > 0,
    "(cut) …the cut table is gone, the OTHER table's decorations remain",
  );
}

// ---- fence toggling around math (``` on touched line) ---------------------
{
  const mathLine = findLine(state0, "E = mc^2");
  const above = lineEnd(state0, mathLine - 3);
  // type the third backtick of a fence opener two lines above the $$ block
  const s1 = state0.update({ changes: { from: above, insert: "``" } }).state;
  const b = counts();
  s1.update({ changes: { from: above + 2, insert: "`" } }).state;
  const d = delta(b);
  assert(d.math >= 1, "(fence) completing ``` char-by-char rebuilds math (fence flips interpretation)");
}

// ---- WS-2 Fix 3: narrowed cite-rescan triggers -----------------------------
{
  const at = lineEnd(state0, findLine(state0, "Prose line 4040"));
  const b = counts();
  state0.update({ changes: { from: at, insert: "`" } }).state;
  const d = delta(b);
  assert(d.cite === 0, "(cite) backtick in plain prose does NOT rescan (was: full O(doc) rescan)");
}
{
  const at = lineEnd(state0, findLine(state0, "Prose line 4050"));
  const b = counts();
  state0.update({ changes: { from: at, insert: "$" } }).state;
  const d = delta(b);
  assert(d.cite === 0, "(cite) $ in plain prose does NOT rescan");
}
{
  const citeLine = findLine(state0, "[@smith2020]");
  const b = counts();
  state0.update({ changes: { from: lineStart(state0, citeLine) + 1, insert: "`" } }).state;
  const d = delta(b);
  assert(d.cite >= 1, "(cite) backtick on a cite-bearing line DOES rescan (masking may flip)");
}
{
  const citeLine = findLine(state0, "[@smith2020]");
  const inside = state0.doc.line(citeLine).text.indexOf("smith2020");
  const b = counts();
  state0.update({ changes: { from: lineStart(state0, citeLine) + inside + 3, insert: "x" } }).state;
  const d = delta(b);
  assert(d.cite >= 1, "(cite) typing inside a [@…] key rescans (range overlap)");
}
{
  // completing a ``` fence char-by-char rescans (multi-line masking flip)
  const at = lineStart(state0, findLine(state0, "Prose line 4060") + 1);
  const s1 = state0.update({ changes: { from: at, insert: "``" } }).state;
  const b = counts();
  s1.update({ changes: { from: at + 2, insert: "`" } }).state;
  const d = delta(b);
  assert(d.cite >= 1, "(cite) completing a ``` fence rescans");
}

console.log(failures ? `\nCHANGEGATE: FAIL (${failures})` : "\nCHANGEGATE: PASS");
process.exit(failures ? 1 : 0);
