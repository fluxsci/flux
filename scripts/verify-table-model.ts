// Table-model gate — the ONE escape-aware pipe-table grammar
// (science/tableModel.ts) that the editor widget, the editing ops and the
// paste conversion share. Fidelity target is markdown-it's GFM table rule (the
// export renderer): escaped pipes, trimmed rows with edge-cell dropping,
// header/delimiter column-count equality, terminator-based body absorption,
// fence/math suspension (refNumbers parity). Plus the serializer round-trip
// (idempotent, escape-preserving) and the TSV/CSV converters.
// Run: npx tsx scripts/verify-table-model.ts
import { Text } from "@codemirror/state";
import {
  rowCells,
  rowCellSpans,
  parseDelim,
  parseAt,
  scanTables,
  tableAt,
  formatTableLines,
  formatTableBlock,
  parseTsv,
  parseCsv,
  gridToTable,
  escapePipes,
  isTerminator,
} from "../src/shell/modes/paper/science/tableModel";
import { scanRefNumbers } from "../src/shell/modes/paper/science/refNumbers";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const doc = (...lines: string[]) => Text.of(lines);

// --- escape-aware splitting (markdown-it escapedSplit semantics) -------------
ok(JSON.stringify(rowCells("| a | b |")) === '["a","b"]', "plain row splits");
ok(JSON.stringify(rowCells("a | b")) === '["a","b"]', "edge pipes optional");
ok(JSON.stringify(rowCells("| a \\| b | c |")) === '["a | b","c"]', "\\| is a literal pipe, backslash consumed");
ok(JSON.stringify(rowCells("| `x\\|y` | c |")) === '["`x|y`","c"]', "escape works inside inline code (GFM rule)");
// markdown-it has no double-escape parity: ANY `\` before `|` escapes it, and
// exactly one backslash is consumed — `\\|` is a literal `\` plus a literal `|`.
ok(JSON.stringify(rowCells("| a \\\\| b |")) === '["a \\\\| b"]', "backslash before escaped pipe: one backslash consumed, no split", JSON.stringify(rowCells("| a \\\\| b |")));
{
  // …and that content round-trips through the serializer.
  const d = doc("| a \\\\| b | c |", "| - | - |");
  const t = parseAt(d, 1)!;
  const rt = parseAt(Text.of(formatTableBlock(d, t).split("\n")), 1)!;
  ok(rt.head[0] === t.head[0], "double-backslash content stable through format→parse", JSON.stringify({ t: t.head, rt: rt.head }));
}
ok(JSON.stringify(rowCells("| a || b |")) === '["a","","b"]', "interior empty cell survives");
ok(JSON.stringify(rowCells("| a \\|")) === '["a |"]', "escaped trailing pipe is content, not structure");

// --- cell spans (caret geometry) ---------------------------------------------
{
  const line = "| aa | b \\| c |  |";
  const spans = rowCellSpans(line);
  ok(spans.length === 3, "spans: three cells", JSON.stringify(spans));
  ok(line.slice(spans[0].contentFrom, spans[0].contentTo) === "aa", "span 0 content bounds");
  ok(line.slice(spans[1].contentFrom, spans[1].contentTo) === "b \\| c", "escaped span raw bounds");
  ok(spans[2].contentFrom === spans[2].contentTo, "empty cell → collapsed caret point");
}

// --- delimiter parsing (markdown-it's exact rule) ----------------------------
ok(JSON.stringify(parseDelim("| :-- | :-: | --: | --- |")) === '["left","center","right","left"]', "alignment colons parse");
ok(parseDelim("|---|---|") !== null, "compact delim ok");
ok(parseDelim("- - -") === null, "'- ' opener is a list, not a delim");
ok(parseDelim("| --- | x |") === null, "junk in delim rejected");
ok(parseDelim("---||---") === null, "interior empty delim cell rejected");

// --- parseAt: markdown-it fidelity -------------------------------------------
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |");
  const t = parseAt(d, 1)!;
  ok(!!t && t.head.length === 2 && t.rows.length === 1, "basic table parses");
}
ok(parseAt(doc("| a | b |", "| - | - | - |"), 1) === null, "header/delimiter column mismatch = NOT a table (markdown-it rejects)");
ok(parseAt(doc("    | a | b |", "| - | - |"), 1) === null, "4-space-indented header is a code block");
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "prose absorbed as a row", "", "after");
  const t = parseAt(d, 1)!;
  ok(t.rows.length === 2 && t.rows[1].piped === false, "pipe-less line under a table is an (unpiped) row — GFM absorption");
  ok(t.rows[1].cells.length === 1, "absorbed row = one cell");
}
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "# heading");
  ok(parseAt(d, 1)!.rows.length === 1, "heading terminates the body");
}
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "- list item");
  ok(parseAt(d, 1)!.rows.length === 1, "list terminates the body");
}
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "$$", "x = 1", "$$");
  ok(parseAt(d, 1)!.rows.length === 1, "display-math opener terminates the body");
}
ok(isTerminator("> quote"), "blockquote is a terminator");
ok(!isTerminator("plain | prose"), "prose is not a terminator");

// --- caption attachment (refNumbers parity) ----------------------------------
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", ": The caption {#tbl-x}");
  const t = parseAt(d, 1)!;
  ok(t.label === "tbl-x" && t.caption === "The caption" && t.captionLine === 4, "caption directly below attaches");
  ok(t.to === d.line(4).to, "block extends over the caption");
}
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "", ": Spaced {#tbl-sp}");
  ok(parseAt(d, 1)!.label === "tbl-sp", "caption after one blank attaches");
}
{
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "absorbed prose", ": Cap {#tbl-n}");
  const t = parseAt(d, 1)!;
  ok(t.label === null, "caption after an unpiped absorbed row does NOT attach (refNumbers rule)");
}
{
  // The twins agree on every scan case in this doc.
  const lines = [
    "| a | b |", "| - | - |", "| 1 | 2 |", ": One {#tbl-one}", "",
    "```", "| f | g |", "| - | - |", ": Fenced {#tbl-fenced}", "```", "",
    "| c | d |", "| - | - |", "| 3 | 4 |", "",
    "| e | f |", "| - | - |", "| 5 | 6 |", "", ": Two {#tbl-two}",
    "$$", ": Math {#tbl-math}", "$$",
  ];
  const tables = scanTables(Text.of(lines));
  const nums = scanRefNumbers(lines.join("\n"));
  const labeled = tables.filter((t) => t.label).map((t) => t.label);
  ok(JSON.stringify(labeled) === '["tbl-one","tbl-two"]', "scanTables labels = refNumbers labels", JSON.stringify(labeled));
  ok(nums.tbl.get("tbl-one") === 1 && nums.tbl.get("tbl-two") === 2 && nums.tbl.size === 2, "refNumbers agrees");
  ok(tables.length === 3, "fenced table skipped, unlabeled table still renders", String(tables.length));
}

// --- tableAt ------------------------------------------------------------------
{
  const d = doc("prose", "", "| a | b |", "| - | - |", "| 1 | 2 |", ": Cap {#tbl-t}", "", "after");
  const inCell = tableAt(d, d.line(5).from + 2);
  ok(!!inCell && inCell!.headerLine === 3, "tableAt finds the table from a body row");
  ok(tableAt(d, d.line(1).from) === null, "tableAt null in prose");
  ok(!!tableAt(d, d.line(6).from + 3), "tableAt finds the table from the caption line");
  ok(tableAt(d, d.line(8).from) === null, "tableAt null after the block");
}
{
  // Caption after ONE blank: still the table's block (the widget's posAtDOM
  // lands at the caption end — the hover bar/cell-click path depends on this).
  const d = doc("| a | b |", "| - | - |", "| 1 | 2 |", "", ": Cap {#tbl-sp}");
  const t = tableAt(d, d.line(5).to);
  ok(!!t && t!.headerLine === 1 && t!.captionLine === 5, "tableAt from a blank-separated caption line");
}

// --- serializer ---------------------------------------------------------------
{
  const f = formatTableLines({
    head: ["Name", "n"],
    aligns: ["left", "right"],
    rows: [
      { line: 3, cells: ["alpha", "1"], piped: true },
      { line: 4, cells: ["a|b", "22"], piped: true },
    ],
  });
  ok(f.header === "| Name  | n   |", "header padded", JSON.stringify(f.header));
  ok(f.delim === "| ----- | --: |", "delim carries alignment at width", JSON.stringify(f.delim));
  ok(f.rows[1] === "| a\\|b  | 22  |", "pipes re-escaped on emit", JSON.stringify(f.rows[1]));
}
{
  // Round-trip: format(parse(format(x))) is byte-stable, verbatim rows untouched.
  const d = doc("| a | b |", "|:-:|-|", "| longer cell | 2 |", "absorbed prose line", ": Cap {#tbl-r}");
  const t = parseAt(d, 1)!;
  const once = formatTableBlock(d, t);
  const d2 = Text.of([...once.split("\n"), ": Cap {#tbl-r}"]);
  const t2 = parseAt(d2, 1)!;
  ok(formatTableBlock(d2, t2) === once, "serializer idempotent", JSON.stringify({ once, twice: formatTableBlock(d2, t2) }));
  ok(once.split("\n")[3] === "absorbed prose line", "verbatim row passes through unformatted");
  const rt = parseAt(Text.of(once.split("\n")), 1)!;
  ok(JSON.stringify(rt.rows[0].cells) === JSON.stringify(t.rows[0].cells) && JSON.stringify(rt.head) === JSON.stringify(t.head), "content survives the round-trip");
  ok(rt.aligns[0] === "center" && rt.aligns[1] === "left", "alignment survives the round-trip");
}
{
  // Escaped-pipe content round-trips through format → parse.
  const d = doc("| a \\| b | c |", "| - | - |", "| x | y |");
  const t = parseAt(d, 1)!;
  const text = formatTableBlock(d, t);
  const rt = parseAt(Text.of(text.split("\n")), 1)!;
  ok(rt.head[0] === "a | b", "escaped pipe content stable", JSON.stringify({ text, head: rt.head }));
}
ok(escapePipes("a|b|c") === "a\\|b\\|c", "escapePipes");

// --- TSV / CSV ----------------------------------------------------------------
{
  const g = parseTsv("Name\tValue\nalpha\t1\nbeta\t2\n");
  ok(!!g && g.length === 3 && g[1][0] === "alpha", "TSV parses");
  ok(parseTsv("no tabs here\nstill none") === null, "no tabs → not TSV");
  ok(parseTsv("a\tb\nc\td\te") === null, "inconsistent tab counts → not TSV (prose guard)");
  const md = gridToTable(g!);
  const t = parseAt(Text.of(md.split("\n")), 1)!;
  ok(t.head[0] === "Name" && t.rows.length === 2, "grid → canonical table parses back");
}
{
  const g = parseCsv('name,note\nalpha,"contains, comma"\nbeta,"say ""hi"""');
  ok(!!g && g![1][1] === "contains, comma" && g![2][1] === 'say "hi"', "quoted CSV parses", JSON.stringify(g));
  ok(parseCsv("just prose\nmore prose") === null, "single-column CSV rejected");
  ok(parseCsv("a,b\nc,d,e") === null, "ragged CSV rejected");
}
{
  const md = gridToTable([["h1", "h|2"], ["a", "b"]]);
  ok(md.includes("h\\|2"), "grid cells with pipes escape on emit", md);
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
