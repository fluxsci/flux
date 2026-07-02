// P5 — Reader find-in-document (LR-6 pt 2). The match-finding + navigation math is pure and gets
// real unit tests; the PdfView/ReaderMode wiring (all-page text index, quote-anchored overlay,
// search bar) is asserted against source because the reader needs real PDF bytes the headless
// harness can't supply (the demo FluxLib entry has no paper.pdf).
//   Run: npx tsx scripts/verify-p5-reader-find.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findMatchesInPages, stepIndex, MIN_QUERY } from "../src/lib/pdf/search.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  } else {
    console.log("  ok:", msg);
  }
}
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), msg);

console.log("LR-6 — findMatchesInPages (pure):");
const pages = [
  { page: 1, text: "Alpha beta gamma. Beta again." },
  { page: 2, text: "" }, // empty page contributes nothing
  { page: 3, text: "The BETA decay of the nucleus." },
];
const m = findMatchesInPages(pages, "beta");
eq(
  m,
  [
    { page: 1, start: 6, end: 10 },
    { page: 1, start: 18, end: 22 },
    { page: 3, start: 4, end: 8 },
  ],
  "case-insensitive, ordered by page then position, empty page skipped",
);
assert(findMatchesInPages([{ page: 1, text: "aaaa" }], "aa").length === 2, "non-overlapping: 'aa' in 'aaaa' → 2 matches");
eq(findMatchesInPages(pages, "z"), [], `sub-min-length query (< ${MIN_QUERY}) → no matches`);
eq(findMatchesInPages(pages, "   "), [], "blank query → no matches");
eq(findMatchesInPages(pages, "delta"), [], "absent term → no matches");
// Pages given out of order still come back page-ordered.
const oo = findMatchesInPages([{ page: 5, text: "xx" }, { page: 2, text: "xx" }], "xx");
eq(oo.map((x) => x.page), [2, 5], "results are page-ordered even when input pages are not");

console.log("\nLR-6 — stepIndex (pure navigation):");
assert(stepIndex(0, -1, "next") === -1, "no matches → -1");
assert(stepIndex(3, -1, "first") === 0, "first → 0");
assert(stepIndex(3, -1, "next") === 0, "next from -1 → 0 (treated as first)");
assert(stepIndex(3, 2, "next") === 0, "next wraps at the end");
assert(stepIndex(3, 0, "prev") === 2, "prev wraps at the start");
assert(stepIndex(3, 1, "next") === 2 && stepIndex(3, 1, "prev") === 0, "next/prev step by one");

console.log("\nLR-6 — PdfView wiring (source):");
const pv = readFileSync(join(root, "src/shell/modes/reader/PdfView.svelte"), "utf8");
assert(/find\?:\s*\{ query: string; nonce: number; dir:/.test(pv), "accepts a nonce-driven `find` prop");
assert(/onFind\?:\s*\(r: \{ total: number; index: number; page: number \}\)/.test(pv), "reports {total,index,page} via onFind");
assert(/import \{ findMatchesInPages, stepIndex/.test(pv), "uses the pure search core");
assert(/async function ensureSearchText\(\)/.test(pv) && /getTextContent\(\)/.test(pv), "builds an all-page text index lazily via getTextContent");
assert(/makeQuoteAnchor\(searchText\.get\(m\.page\)/.test(pv), "each match carries a quote anchor (same machinery as annotations)");
assert(/locateQuote\(st\.info!\.text, m\.anchor\)/.test(pv), "matches are located on the rendered page via the fuzzy quote locator");
assert(/sLayer\?: HTMLDivElement/.test(pv) && /className = "search-layer"/.test(pv), "a dedicated per-page search overlay (separate from annotations)");
assert(/\.search-hl\.active/.test(pv), "the active match is styled distinctly");
assert(/st\.sLayer\?\.remove\(\)/.test(pv), "freePage tears down the search overlay (no leak on virtualization)");

console.log("\nLR-6 — ReaderMode search bar (source):");
const rm = readFileSync(join(root, "src/shell/modes/reader/ReaderMode.svelte"), "utf8");
assert(/const findProp = \$derived\(/.test(rm), "derives the find prop from the bar state");
assert(/e\.key === "f" \|\| e\.key === "F"/.test(rm) && /openFind\(\)/.test(rm), "⌘/Ctrl-F opens the find bar (focus-gated)");
assert(/stepFind\(e\.shiftKey \? "prev" : "next"\)/.test(rm), "Enter / Shift-Enter step next / prev");
assert(/find=\{findProp\}\s+onFind=\{\(r\)/.test(rm), "PdfView is wired to the bar");
assert(/class="rfind"/.test(rm) && /class="rfind-count"/.test(rm), "the bar renders an input + match counter");

if (failures) {
  console.error(`\nP5 READER-FIND VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nP5 READER-FIND VERIFY: PASS");
