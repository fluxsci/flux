// 3.2 gate (pure) — the annotations→Markdown formatter: header, page grouping + sort,
// blockquotes, notes, colour labels, tags, and the empty case.
//   Run: npx tsx scripts/verify-annotations-md.ts
import { annotationsToMarkdown } from "../src/lib/references/annotationsMarkdown";

let fails = 0;
const ok = (c: boolean, name: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${name}${c || !extra ? "" : ` — ${extra}`}`);
  if (!c) fails++;
};

const ann = (over: Partial<import("../src/lib/references/annotations").Annotation>) => ({
  id: Math.random().toString(36).slice(2),
  page: 1,
  anchor: { quote: "a quote", prefix: "", suffix: "" },
  color: "yellow",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

// --- rich header ------------------------------------------------------------------------
{
  const md = annotationsToMarkdown(
    "marder1996",
    [ann({ page: 2, anchor: { quote: "rhythmic pattern generation", prefix: "", suffix: "" }, note: "central to the STG story", color: "green", tags: ["cpg"] })],
    { title: "Principles of rhythmic motor pattern generation", authors: ["Marder", "Calabrese"], year: "1996", doi: "10.1/x", exportedAt: "2026-07-07" },
  );
  ok(md.startsWith("# Principles of rhythmic motor pattern generation"), "title header", md.split("\n")[0]);
  ok(md.includes("Marder, Calabrese (1996)"), "author + year line");
  ok(md.includes("`@marder1996`") && md.includes("https://doi.org/10.1/x"), "citekey + doi links");
  ok(/1 highlight across 1 page · exported 2026-07-07/.test(md), "summary line with count + date");
  ok(md.includes("## Page 2"), "page header");
  ok(md.includes("> rhythmic pattern generation"), "quote as blockquote");
  ok(md.includes("central to the STG story"), "note rendered");
  ok(md.includes("🟢 green"), "colour label");
  ok(md.includes("#cpg"), "tags rendered");
}

// --- no metadata → citekey title --------------------------------------------------------
{
  const md = annotationsToMarkdown("smith2020", [ann({})]);
  ok(md.startsWith("# @smith2020"), "falls back to @citekey title", md.split("\n")[0]);
  ok(!/exported/.test(md), "no export-date when not supplied");
}

// --- page grouping + sort ---------------------------------------------------------------
{
  const md = annotationsToMarkdown("k", [
    ann({ page: 3, createdAt: "2026-01-03T00:00:00Z", anchor: { quote: "third", prefix: "", suffix: "" } }),
    ann({ page: 1, createdAt: "2026-01-02T00:00:00Z", anchor: { quote: "first-b", prefix: "", suffix: "" } }),
    ann({ page: 1, createdAt: "2026-01-01T00:00:00Z", anchor: { quote: "first-a", prefix: "", suffix: "" } }),
  ]);
  ok(md.indexOf("## Page 1") < md.indexOf("## Page 3"), "pages ascending");
  ok(md.indexOf("first-a") < md.indexOf("first-b"), "within a page, sorted by time");
  ok((md.match(/## Page 1/g) || []).length === 1, "one header per page (not per annotation)");
  ok(/3 highlights across 2 pages/.test(md), "plural counts");
}

// --- multi-line quote + whitespace collapse ---------------------------------------------
{
  const md = annotationsToMarkdown("k", [ann({ anchor: { quote: "line   with\nweird\t spacing", prefix: "", suffix: "" } })]);
  ok(md.includes("> line with weird spacing"), "quote whitespace collapsed into a single blockquote line", JSON.stringify(md));
}

// --- empty ------------------------------------------------------------------------------
{
  const md = annotationsToMarkdown("empty2020", []);
  ok(md.includes("# @empty2020") && md.includes("No highlights yet."), "empty list → graceful message");
  ok(/0 highlights across 0 pages/.test(md), "empty summary");
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
