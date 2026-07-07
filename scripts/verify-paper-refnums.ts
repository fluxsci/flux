// V1-readiness 0.5 gate — the ONE table/equation numbering rule (science/refNumbers.ts)
// + embed-caption escaping (science/figureAttrs.ts). The old editor counted EVERY pipe
// table while the export counted captioned ones — one document, two numberings; and a
// caption containing "](" split the embed line. Run: npx tsx scripts/verify-paper-refnums.ts
import { scanRefNumbers, TBL_CAPTION_RE } from "../src/shell/modes/paper/science/refNumbers";
import { EMBED_RE, escapeEmbedCaption, unescapeEmbedCaption } from "../src/shell/modes/paper/science/figureAttrs";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TABLE = (label?: string, cap = "Caption text") =>
  ["| a | b |", "| - | - |", "| 1 | 2 |", label ? `: ${cap} {#${label}}` : ""].filter(Boolean).join("\n");

// --- table numbering ---------------------------------------------------------------
{
  const doc = [TABLE(), "", "prose", "", TABLE("tbl-one"), "", TABLE(), "", TABLE("tbl-two")].join("\n");
  const { tbl } = scanRefNumbers(doc);
  ok(tbl.get("tbl-one") === 1 && tbl.get("tbl-two") === 2, "only LABELED tables number, in appearance order", JSON.stringify([...tbl]));
}
{
  // Caption after exactly one blank line (the editor's adjacency rule).
  const doc = ["| a | b |", "| - | - |", "| 1 | 2 |", "", ": Spaced caption {#tbl-sp}"].join("\n");
  ok(scanRefNumbers(doc).tbl.get("tbl-sp") === 1, "caption after one blank line still attaches");
}
{
  // A STRAY caption line (no table above) numbers nothing.
  const doc = ["prose paragraph", "", ": Orphan caption {#tbl-orphan}"].join("\n");
  ok(!scanRefNumbers(doc).tbl.has("tbl-orphan"), "stray caption (no table above) is not numbered");
}
{
  // Fenced code is skipped entirely.
  const doc = ["```", TABLE("tbl-infence"), "```", "", TABLE("tbl-real")].join("\n");
  const { tbl } = scanRefNumbers(doc);
  ok(!tbl.has("tbl-infence") && tbl.get("tbl-real") === 1, "fenced tables don't count");
}
{
  // Duplicate labels keep the first number (stable refs).
  const doc = [TABLE("tbl-dup"), "", TABLE("tbl-dup")].join("\n");
  ok(scanRefNumbers(doc).tbl.get("tbl-dup") === 1, "duplicate label keeps the first table's number");
}
ok(TBL_CAPTION_RE.test(": A caption {#tbl-x}"), "shared caption regex matches the canonical form");

// --- equation numbering (consumed by 2.1 math; the scan rule lands with the scanner) --
{
  const doc = ["$$", "E = mc^2", "$$ {#eq-mass}", "", "$$ a^2 + b^2 = c^2 $$ {#eq-pyth}", "", "$$", "x", "$$"].join("\n");
  const { eq } = scanRefNumbers(doc);
  ok(eq.get("eq-mass") === 1 && eq.get("eq-pyth") === 2, "labeled display equations number in order", JSON.stringify([...eq]));
  ok(eq.size === 2, "unlabeled display math gets no number");
}
{
  const doc = ["```", "$$", "code not math", "$$ {#eq-fenced}", "```"].join("\n");
  ok(scanRefNumbers(doc).eq.size === 0, "math inside a fence doesn't count");
}
{
  // A `: caption`-looking line INSIDE display math must not number a table.
  const doc = ["| a |", "| - |", "$$", ": not a caption {#tbl-inmath}", "$$"].join("\n");
  ok(!scanRefNumbers(doc).tbl.has("tbl-inmath"), "table-caption grammar suspended inside display math");
}

// --- caption escaping round-trip ------------------------------------------------------
const HOSTILE = ['A caption with a [subset](note) link', "brackets ] and [ loose", "back\\slash", "multi\nline   caption"];
for (const cap of HOSTILE) {
  const esc = escapeEmbedCaption(cap);
  const line = `![${esc}](../fig/renders/f1.svg){#fig-x width=60%}`;
  const m = EMBED_RE.exec(line);
  ok(!!m, `hostile caption still matches EMBED_RE (${JSON.stringify(cap.slice(0, 24))})`, line);
  if (m) {
    const collapsed = cap.replace(/\s+/g, " ").trim();
    ok(unescapeEmbedCaption(m[1]) === collapsed, `round-trips (${JSON.stringify(collapsed.slice(0, 24))})`, `got ${JSON.stringify(unescapeEmbedCaption(m[1]))}`);
    ok(m[3] === "fig-x" && /width=60%/.test(m[4]), "id + attrs survive");
  }
}
{
  // Plain captions are untouched (no escaping churn on existing docs).
  ok(escapeEmbedCaption("Growth over 24 h.") === "Growth over 24 h.", "plain captions unchanged");
  const m = EMBED_RE.exec("![Growth over 24 h.](../fig/renders/f1.svg){#fig-growth}");
  ok(!!m && m[1] === "Growth over 24 h.", "legacy unescaped lines still parse");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
