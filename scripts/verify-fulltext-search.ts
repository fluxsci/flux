// 2.3 gate — full-text search engine (flux-core/fulltextSearch.ts) over a temp FluxLib
// with \f-joined fixture texts. Pure/Node, hermetic (XDG isolation). AND semantics,
// phrases, page numbers from form-feeds, diacritic folding, limit/truncation,
// missing-text backfill list, key restriction. Run: npx tsx scripts/verify-fulltext-search.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseQueryTerms, foldText } from "../src/lib/references/textFold";
import { extractFulltext, hasFulltext } from "../src/lib/references/query";

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flux-ft-cfg-"));
const { searchFulltext } = await import("../flux-core/fulltextSearch");

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- grammar (pure) ---------------------------------------------------------------------
{
  const q = parseQueryTerms('optogenetic "parvalbumin interneurons" Café');
  ok(JSON.stringify(q.terms) === JSON.stringify(["optogenetic", "cafe"]), "terms folded (diacritics stripped)", JSON.stringify(q.terms));
  ok(JSON.stringify(q.phrases) === JSON.stringify(["parvalbumin interneurons"]), "quoted phrase captured", JSON.stringify(q.phrases));
  ok(foldText("RésuméNext") === "resumenext", "foldText preserves the form-feed");
}

// --- fulltext grammar (query.ts, pure) --------------------------------------------------
{
  ok(hasFulltext("ft:optogenetic") && hasFulltext("author:x fulltext:y") && hasFulltext("text:z"), "hasFulltext detects all three prefixes");
  ok(!hasFulltext("author:smith year:2020"), "plain metadata query is not full-text");
  const a = extractFulltext("ft:hippocampal replay");
  ok(a.fulltext === "hippocampal replay" && a.rest === "", "ft: captures the whole tail as the query");
  const b = extractFulltext('author:smith year:2020 ft:"long-term potentiation"');
  ok(b.fulltext === '"long-term potentiation"' && b.rest === "author:smith year:2020", "leading metadata → scope, quoted phrase preserved");
  const c = extractFulltext("no prefix here");
  ok(c.fulltext === "" && c.rest === "no prefix here", "no prefix → all metadata, empty fulltext");
  const parsed = parseQueryTerms(b.fulltext);
  ok(parsed.phrases.length === 1 && parsed.terms.length === 0, "extracted phrase parses as a phrase downstream");
}

// --- temp lib with fixtures --------------------------------------------------------------
const lib = fs.mkdtempSync(path.join(os.tmpdir(), "flux-ft-lib-"));
function item(key: string, pages: string[], withPdf = true) {
  const dir = path.join(lib, "items", key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fulltext.txt"), pages.join("\n\f\n"));
  if (withPdf) fs.writeFileSync(path.join(dir, "paper.pdf"), "%PDF-1.4\n%%EOF\n");
}
item("marder1996", ["Rhythmic motor pattern generation in the STOMATOGASTRIC ganglion.", "Page two mentions optogenetic silencing of neurons briefly.", "Parvalbumin interneurons appear on page three, twice: parvalbumin again."]);
item("buzsaki2004", ["Neuronal oscillations in cortical networks are the topic here.", "No mention of the O-word on this page.", "But optogenetic tools recur: optogenetic, optogenetic — three times total counting page one? no."]);
item("nomatch2010", ["This paper is about something else entirely — plate tectonics."]);
// A PDF with NO fulltext.txt → should surface in missingText.
fs.mkdirSync(path.join(lib, "items", "scanned2001"), { recursive: true });
fs.writeFileSync(path.join(lib, "items", "scanned2001", "paper.pdf"), "%PDF-1.4\n%%EOF\n");

// --- single term ------------------------------------------------------------------------
{
  const r = await searchFulltext("optogenetic", { libPath: lib });
  const keys = r.hits.map((h) => h.key).sort();
  ok(JSON.stringify(keys) === JSON.stringify(["buzsaki2004", "marder1996"]), "single term finds both papers", JSON.stringify(keys));
  ok(r.missingText.includes("scanned2001"), "PDF without text → missingText backfill candidate");
  const marder = r.hits.find((h) => h.key === "marder1996")!;
  ok(marder.snippets[0].page === 2, `snippet page from \\f offset (p${marder.snippets[0].page})`);
  ok(/optogenetic/i.test(marder.snippets[0].text), "snippet contains the term");
  ok(
    !/Rhythmic/i.test(marder.snippets[0].text) && !/Parvalbumin/i.test(marder.snippets[0].text),
    "snippet stays within its page (no cross-\\f bleed)",
    marder.snippets[0].text,
  );
}

// --- AND semantics ----------------------------------------------------------------------
{
  const r = await searchFulltext("optogenetic parvalbumin", { libPath: lib });
  ok(r.hits.length === 1 && r.hits[0].key === "marder1996", "AND: both terms required → only marder", JSON.stringify(r.hits.map((h) => h.key)));
}

// --- phrase -----------------------------------------------------------------------------
{
  const yes = await searchFulltext('"parvalbumin interneurons"', { libPath: lib });
  ok(yes.hits.length === 1 && yes.hits[0].key === "marder1996", "phrase matches marder");
  const no = await searchFulltext('"interneurons parvalbumin"', { libPath: lib });
  ok(no.hits.length === 0, "reversed phrase does NOT match (verbatim)");
}

// --- count + ranking --------------------------------------------------------------------
{
  const r = await searchFulltext("parvalbumin", { libPath: lib });
  ok(r.hits[0].key === "marder1996" && r.hits[0].count === 2, `count reflects occurrences (${r.hits[0]?.count})`);
}

// --- diacritics + case ------------------------------------------------------------------
{
  item("cafe2020", ["A study conducted at the Café near the STOMATOGASTRIC lab."]);
  const r = await searchFulltext("cafe", { libPath: lib });
  ok(r.hits.some((h) => h.key === "cafe2020"), "folded query matches accented source");
}

// --- limit / truncation -----------------------------------------------------------------
{
  const r = await searchFulltext("stomatogastric", { libPath: lib, limit: 1 });
  ok(r.hits.length === 1 && r.truncated, "limit caps hits + flags truncated");
}

// --- key restriction --------------------------------------------------------------------
{
  const r = await searchFulltext("optogenetic", { libPath: lib, keys: ["buzsaki2004"] });
  ok(r.hits.length === 1 && r.hits[0].key === "buzsaki2004", "keys[] restricts the scan");
}

// --- empty query ------------------------------------------------------------------------
{
  const r = await searchFulltext("   ", { libPath: lib });
  ok(r.hits.length === 0, "blank query → no hits (no full scan)");
}

fs.rmSync(lib, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
