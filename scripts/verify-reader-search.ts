// Pure gate for the reader Search pane's grouping (src/lib/pdf/findMatches.ts): matches
// bucket under the outline section they fall in, fall back to per-page groups when the
// PDF has no usable outline, and stay in document order either way.
//   Run: npx tsx scripts/verify-reader-search.ts
import { groupMatches, type FindMatch, type OutlineSection } from "../src/lib/pdf/findMatches";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log("  ok:", msg);
  else {
    console.error("  FAIL:", msg);
    failures++;
  }
};

const m = (index: number, page: number, hit = "x"): FindMatch => ({
  index,
  page,
  matchInPage: 0,
  before: "…",
  hit,
  after: "…",
});

console.log("reader search — grouping:");

// --- no outline → one group per page ------------------------------------------------
{
  const groups = groupMatches([m(0, 1), m(1, 1), m(2, 4)], []);
  ok(groups.length === 2, `two pages → two groups (${groups.length})`);
  ok(groups[0].label === "Page 1" && groups[1].label === "Page 4", `page labels (${groups.map((g) => g.label).join(", ")})`);
  ok(groups[0].matches.length === 2 && groups[1].matches.length === 1, "matches land in their page's group");
}

// --- with an outline → section labels ------------------------------------------------
const sections: OutlineSection[] = [
  { title: "Introduction", page: 2 },
  { title: "Results", page: 5 },
  { title: "Discussion", page: 9 },
];
{
  const groups = groupMatches([m(0, 3), m(1, 6), m(2, 6), m(3, 12)], sections);
  ok(groups.map((g) => g.label).join("|") === "Introduction|Results|Discussion", `section labels (${groups.map((g) => g.label).join("|")})`);
  ok(groups[1].matches.length === 2, "two hits in one section stay in one group");
  ok(groups[2].page === 12, "a group reports the page of its first match");
}

// A match BEFORE the first section (cover page, unlabelled abstract) keeps a page label
// rather than being dropped or forced into the first named section.
{
  const groups = groupMatches([m(0, 1), m(1, 3)], sections);
  ok(groups[0].label === "Page 1", `pre-outline match keeps a page label (${groups[0].label})`);
  ok(groups[1].label === "Introduction", "later matches still get their section");
}

// --- ordering + degenerate inputs ----------------------------------------------------
{
  const groups = groupMatches([m(0, 6), m(1, 3), m(2, 6)], sections);
  ok(
    groups.map((g) => g.label).join("|") === "Results|Introduction|Results",
    `document order wins over label merging (${groups.map((g) => g.label).join("|")})`,
  );
  ok(groupMatches([], sections).length === 0, "no matches → no groups");
  ok(groupMatches([m(0, 2)], [{ title: "   ", page: 1 }])[0].label === "Page 2", "a blank section title falls back to the page");
  ok(groupMatches([m(0, 2)], [{ title: "Bad", page: 0 }])[0].label === "Page 2", "a section resolved to page 0 is ignored");
  const unsorted = groupMatches([m(0, 10)], [{ title: "Late", page: 9 }, { title: "Early", page: 1 }]);
  ok(unsorted[0].label === "Late", "sections need not be pre-sorted");
}

console.log(`\n##VERIFY## ${JSON.stringify({ script: "verify-reader-search", ok: failures === 0, failed: failures })}`);
console.log(failures ? `READER SEARCH VERIFY: FAIL (${failures})` : "READER SEARCH VERIFY: PASS");
process.exit(failures ? 1 : 0);
