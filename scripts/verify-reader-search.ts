// Pure gate for the reader Search pane's grouping (src/lib/pdf/findMatches.ts): matches
// bucket under the outline section they fall in, fall back to per-page groups when the
// PDF has no usable outline, and stay in document order either way.
//   Run: npx tsx scripts/verify-reader-search.ts
import { groupMatches, createFindMatchCollector, normalizedStart, normalizedEnd, FIND_CONTEXT, type FindMatch, type OutlineSection, type PdfPageDiffs } from "../src/lib/pdf/findMatches";

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

// --- snippets are cut where the match really is ---------------------------------------------
// PDF.js searches a normalized copy of the page and reports matches in ORIGINAL offsets; its
// table of differences says how the two relate. A snippet must go back through that table.
console.log("reader search — a hit's letters are the query's:");
{
  /** PDF.js's own forward mapping (PDFFindController getOriginalIndex), as the reference. */
  const original = (diffs: PdfPageDiffs, pos: number, len: number): [number, number] => {
    if (!diffs) return [pos, len];
    const [starts, shifts] = diffs;
    const last = (at: number) => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= at) i++; return i; };
    const end = pos + len - 1;
    const oStart = pos + shifts[last(pos)], oEnd = end + shifts[last(end)];
    return [oStart, oEnd + 1 - oStart];
  };
  // The page as PDF.js normalized it, with the shifts of a real page: a joined hyphenation (+1),
  // then expanded ligatures (−1 each).
  const text = "The visual cortex is the best studied. Cortical areas differ; a cortical column is efficient, and corticocortical loops are affiliated with thalamocortical ones.";
  const diffs: PdfPageDiffs = [[0, 18, 45, 74, 79, 125, 139], [0, 1, 0, -1, -2, -3, -3]];
  const words = [...text.matchAll(/cortical|Cortical|visual|efficient|affiliated|ones/g)].map((m) => ({ at: m.index!, word: m[0] }));
  const found = words.map(({ at, word }) => { const [o, l] = original(diffs, at, word.length); return { o, l, word, at }; });
  const collect = createFindMatchCollector();
  const rows = collect({ pageMatches: [found.map((f) => f.o)], pageMatchesLength: [found.map((f) => f.l)], _pageContents: [text], _pageDiffs: [diffs] }, "q");
  ok(rows.length === words.length && rows.every((r, i) => r.hit === words[i].word), `every hit is exactly its word (${rows.map((r) => r.hit).join(" | ")})`);
  ok(rows.every((r, i) => (text.slice(0, words[i].at).replace(/\s+/g, " ").endsWith(r.before)) && text.slice(words[i].at + words[i].word.length).replace(/\s+/g, " ").startsWith(r.after)), "the context on each side is the text on each side");
  ok(rows.every((r) => r.before.length <= FIND_CONTEXT && r.after.length <= FIND_CONTEXT), `context is at most ${FIND_CONTEXT} characters a side`);
  // The same offsets cut WITHOUT the table are wrong from the first difference on: that was the bug.
  const naive = found.map((f) => text.slice(f.o, f.o + f.l));
  ok(naive.filter((w, i) => w !== words[i].word).length >= 3, `cutting at the original offsets drifts (${naive.join(" | ")})`);
  // Without a table (an old PDF.js, or a page with no differences) offsets are used as they are.
  const plain = createFindMatchCollector()({ pageMatches: [[4]], pageMatchesLength: [[6]], _pageContents: [text] }, "q");
  ok(plain[0].hit === "visual", "a page with no differences is cut directly");
  ok(normalizedStart(null, 12) === 12 && normalizedEnd(undefined, 12) === 12 && normalizedStart([[], []], 7) === 7, "no table, or an empty one, maps an offset to itself");
  // Round trip over every position of the page, both directions.
  let worst = 0;
  for (let n = 0; n < text.length; n++) {
    const [o] = original(diffs, n, 1);
    const back = normalizedStart(diffs, o), backEnd = normalizedEnd(diffs, o);
    // Several normalized characters can share one original one: the start is the first of them, the end the last.
    worst = Math.max(worst, original(diffs, back, 1)[0] === o && original(diffs, backEnd, 1)[0] === o && back <= n && backEnd >= n ? 0 : 1);
  }
  ok(worst === 0, "every position maps back to a character with the same original offset, start ≤ it ≤ end");
  // A change of the table alone (same text, same offsets) invalidates the page's rows.
  const again = collect({ pageMatches: [found.map((f) => f.o)], pageMatchesLength: [found.map((f) => f.l)], _pageContents: [text], _pageDiffs: [[[0], [0]]] }, "q");
  ok(again[1].hit !== words[1].word || again[4].hit !== words[4].word, "a different table gives different snippets (it is part of a page's identity)");
  // 300 pages × 300 hits stays cheap: snippets are lazy and the lookup is a binary search.
  const big = Array.from({ length: 3000 }, (_, i) => i * 40), bigShift = big.map((_, i) => -i);
  const t0 = performance.now();
  for (let k = 0; k < 90000; k++) normalizedStart([big, bigShift], (k * 7) % 110000);
  ok(performance.now() - t0 < 400, `90,000 lookups in a 3,000-segment table take ${Math.round(performance.now() - t0)} ms (< 400)`);
}

console.log(`\n##VERIFY## ${JSON.stringify({ script: "verify-reader-search", ok: failures === 0, failed: failures })}`);
console.log(failures ? `READER SEARCH VERIFY: FAIL (${failures})` : "READER SEARCH VERIFY: PASS");
process.exit(failures ? 1 : 0);
