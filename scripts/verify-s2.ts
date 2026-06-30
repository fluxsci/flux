#!/usr/bin/env -S npx tsx
// Headless unit test for the pure Semantic Scholar layer (src/lib/references/
// semanticscholar.ts). No network. Run: npx tsx scripts/verify-s2.ts
import {
  s2PaperId,
  s2RecommendationsUrl,
  s2CitationsUrl,
  s2ToBrief,
  s2CitationToBrief,
} from "../src/lib/references/semanticscholar";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// paperId
assert(s2PaperId({ doi: "10.1038/nature14539" }) === "DOI:10.1038/nature14539", "paperId from DOI");
assert(s2PaperId({ s2Id: "abc123" }) === "abc123", "paperId from s2Id");
assert(s2PaperId({}) === undefined, "no id → undefined");

// recommendations URL — DOI slash stays LITERAL in the path (S2 needs it that way)
const recUrl = s2RecommendationsUrl("DOI:10.1038/nature14539", { limit: 30 });
assert(recUrl.includes("/recommendations/v1/papers/forpaper/DOI:10.1038/nature14539"), "rec URL keeps literal DOI slash");
assert(recUrl.includes("limit=30") && recUrl.includes("fields="), "rec URL has fields + limit");
assert(s2RecommendationsUrl("X", { limit: 999 }).includes("limit=100"), "rec limit clamped to 100");

// citations URL — fields include the context/intent/influential richness
const citUrl = s2CitationsUrl("DOI:10.1038/nature14539", { limit: 50, offset: 10 });
assert(citUrl.includes("/graph/v1/paper/DOI:10.1038/nature14539/citations"), "citations URL path");
assert(decodeURIComponent(citUrl).includes("fields=isInfluential,contexts,intents"), "citations fields include contexts/intents/influential");
assert(citUrl.includes("offset=10"), "citations offset passed");

// recommendation paper → brief
const rec = s2ToBrief({
  paperId: "W1",
  title: "Deep learning",
  year: 2015,
  externalIds: { DOI: "10.1038/NATURE14539" },
  citationCount: 80000,
  authors: [{ name: "Yann LeCun" }, { name: "Yoshua Bengio" }],
  venue: "Nature",
  tldr: { text: "Deep learning works." },
});
assert(rec.source === "s2" && rec.openalexId === "S2:W1", "brief source + id");
assert(rec.doi === "10.1038/nature14539", "brief doi lowercased");
assert(rec.title === "Deep learning" && rec.year === "2015" && rec.citedByCount === 80000, "brief core fields");
assert(eq(rec.authors, ["Yann LeCun", "Yoshua Bengio"]) && rec.container === "Nature", "brief authors + venue");
assert(rec.tldr === "Deep learning works.", "brief tldr");

// citation entry → citing-paper brief with context + influential
const cit = s2CitationToBrief({
  isInfluential: true,
  contexts: ["...as demonstrated by LeCun et al., deep nets...", "second mention"],
  intents: ["methodology"],
  citingPaper: { paperId: "W2", title: "A follow-up", year: 2018, externalIds: { DOI: "10.1/x" }, authors: [{ name: "A. B." }] },
});
assert(cit.source === "s2" && cit.title === "A follow-up", "citation maps the citing paper");
assert(cit.influential === true, "influential flag carried");
assert(cit.context === "...as demonstrated by LeCun et al., deep nets...", "first context captured");

console.log("\nALL S2 TESTS PASSED");
