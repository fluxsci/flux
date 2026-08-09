// Pure verification of the text-extraction layer that full-text search and PDF identification
// BOTH sit on: joinTextItems (pdf.js text items → readable text), the separator-collapsing fold
// with its offset map, and the bibliography boundary detector.
//
// This gate exists because that seam was previously uncovered: verify-pdfidentify.ts feeds
// SYNTHETIC PdfSignals straight into identify(), so it never exercised the joiner, and a change
// there could silently corrupt every DOI in the library without turning a single gate red.
//   npx tsx scripts/verify-fulltext-extract.ts
import { joinTextItems, findDois, type TextItem } from "../src/lib/references/pdfIdentify";
import { foldForMatch, originalOffset, parseQueryTerms } from "../src/lib/references/textFold";
import { analyzePaperStructure, bodyOf, referencesOf, referenceDensity } from "../src/lib/references/paperStructure";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    console.log(`✗ ${label}`);
    failures++;
  }
}

/** Build a text item at a baseline. `w` is the advance width, matching pdf.js's `width`. */
const item = (str: string, x: number, y: number, w: number, eol = false, size = 10): TextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: w,
  hasEOL: eol,
});

// --- joinTextItems -----------------------------------------------------------------------------

// A styled run split mid-phrase must NOT gain a space. pdf.js emits a fresh item at every font
// change, so "(n = 16)" with an italic n arrives as touching runs; the old joiner produced
// "( n  =  16)" and a search for "Fig. 1A" missed ~half its true hits.
ok(
  joinTextItems([item("(", 10, 100, 3), item("n", 13, 100, 5), item(" = 16)", 18, 100, 20)]) === "(n = 16)",
  "touching runs are joined without a spurious space",
);

// A real word gap (>= 0.18em) still separates.
ok(joinTextItems([item("alpha", 10, 100, 25), item("beta", 38, 100, 20)]) === "alpha beta"
  , "a geometric word gap still yields one space");

// pdf.js marks a line end with a zero-width empty item. Committing its break immediately used to
// destroy the pending end-of-line hyphen before its continuation arrived.
ok(
  joinTextItems([
    item("sub", 10, 100, 20),
    item("-", 30, 100, 3),
    item("", 10, 88, 0, true),
    item("threshold dynamics", 10, 88, 80),
  ]) === "subthreshold dynamics",
  "line-wrap hyphen is rejoined across pdf.js's empty EOL item",
);

// A dash after a DIGIT belongs to a structured identifier and must survive.
ok(
  joinTextItems([
    item("10.1038/s41586-023-", 10, 100, 90),
    item("", 10, 88, 0, true),
    item("06812-9", 10, 88, 30),
  ]) === "10.1038/s41586-023-06812-9",
  "a wrapped DOI keeps its hyphen and stays one token",
);
ok(
  findDois(joinTextItems([
    item("10.1038/s41586-023-", 10, 100, 90),
    item("", 10, 88, 0, true),
    item("06812-9", 10, 88, 30),
  ]))[0]?.doi === "10.1038/s41586-023-06812-9",
  "…and is therefore recoverable by findDois",
);

// A run that starts far to the LEFT of the previous one is a positional discontinuity, not a
// continuation: bioRxiv's cover banner emits its line in reverse x order, and gluing there
// corrupted the DOI into "…436840doi:biorxiv".
ok(
  joinTextItems([item("https://doi.org/10.1101/436840", 126, 780, 108), item("doi:", 111, 780, 12)]) ===
    "https://doi.org/10.1101/436840\ndoi:",
  "a backtracking run breaks the line instead of gluing",
);
ok(
  findDois(joinTextItems([item("https://doi.org/10.1101/436840", 126, 780, 108), item("doi:", 111, 780, 12)]))[0]
    ?.doi === "10.1101/436840",
  "…leaving the bioRxiv DOI intact",
);

// Exactly one newline per line — the old joiner could emit one from hasEOL AND one from the
// Y-jump, and the resulting blank-line-per-line text defeated every downstream normalizer.
ok(
  !/\n\n/.test(joinTextItems([item("one", 10, 100, 15, true), item("two", 10, 88, 15, true), item("three", 10, 76, 20)])),
  "no doubled newlines between consecutive lines",
);

// A capitalised continuation is NOT a wrapped word.
ok(
  joinTextItems([item("COVID-", 10, 100, 30), item("", 10, 88, 0, true), item("19 cases", 10, 88, 30)]) ===
    "COVID-\n19 cases",
  "a digit continuation does not trigger de-hyphenation",
);

// --- foldForMatch / offset map -----------------------------------------------------------------

ok(foldForMatch("sleep  deprived\nafter").text === "sleep deprived after", "separator runs collapse to one space");
ok(foldForMatch("decision-making").text === "decision making", "hyphens fold to the separator");
ok(foldForMatch("p1\fp2").text === "p1\fp2", "page boundaries survive folding");

{
  const src = "we found that sleep\ndeprived  animals showed reduced\nreplay";
  const f = foldForMatch(src);
  const q = parseQueryTerms('"sleep deprived animals"').phrases[0];
  ok(f.text.includes(q), "a phrase typed with single spaces matches text that wrapped mid-phrase");
  const at = f.text.indexOf(q);
  ok(src.slice(originalOffset(f, at), originalOffset(f, at) + 5) === "sleep", "offset maps back to the original");
  let monotonic = true;
  for (let i = 1; i < f.text.length; i++) if (originalOffset(f, i) < originalOffset(f, i - 1)) monotonic = false;
  ok(monotonic, "the offset map is monotonic");
}

// --- bibliography boundary ---------------------------------------------------------------------

const BODY = ("We recorded from hippocampal neurons during sleep and found replay of waking " +
  "sequences. The effect persisted across sessions and was abolished by muscimol infusion. ").repeat(24);
const REFS =
  "References\n" +
  Array.from({ length: 40 }, (_, i) =>
    `${i + 1}. Smith, J.R., Jones, A.B. & Lee, C. Hippocampal replay during rest. J. Neurosci. ${20 + i}, ${100 + i}–${120 + i} (20${10 + (i % 15)}).`,
  ).join("\n");

{
  const doc = BODY + "\n" + REFS;
  const st = analyzePaperStructure(doc);
  ok(st.referencesStart !== null, "bibliography located");
  ok(st.referencesMethod === "heading", "…via its heading");
  ok(doc.slice(st.referencesStart ?? 0).startsWith("References"), "boundary lands on the heading line");
  ok(!bodyOf(doc, st).includes("J. Neurosci."), "bodyOf excludes the bibliography");
  ok(referencesOf(doc, st).includes("Smith, J.R."), "referencesOf contains the entries");
}

{
  // Nature style: no heading at all, and supplementary material AFTER the list.
  const supp = "\nSupplementary Methods\n" + "Animals were housed under a 12 h light cycle. ".repeat(90);
  const doc = BODY + "\n" + REFS.replace("References\n", "") + supp;
  const st = analyzePaperStructure(doc);
  ok(st.referencesStart !== null && st.referencesMethod === "density", "heading-less bibliography found by density");
  ok(/^\s*1\.\s+Smith/.test(doc.slice(st.referencesStart ?? 0, (st.referencesStart ?? 0) + 40)), "boundary snaps to entry 1");
  ok(st.referencesEnd !== null && st.referencesEnd < doc.length, "bibliography has an end, not the whole tail");
  ok(bodyOf(doc, st).includes("Animals were housed"), "supplementary material after the list stays in the body");
}

ok(referenceDensity(BODY) < 6, "prose scores below the bibliography threshold");
ok(referenceDensity(REFS) > 12, "a reference list scores above it");

console.log(failures === 0 ? "\nall green" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
