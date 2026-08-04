#!/usr/bin/env -S npx tsx
// The Nature preset, pinned to what Nature actually PRINTS.
//
// Every expectation here is a literal string counted over 88 Nature-proper PDFs
// (61 of them 2022+) or quoted from nature.com. The negative assertions matter
// as much as the positive ones: "Fig. 1a, b" is not merely un-preferred, it is
// the PRE-2022 style and is now wrong, and "Fig. 1a and b" never occurs at all.
//   Run: npx tsx scripts/verify-nature-style.ts
import { resolveJournalStyle, formatPanelSpec, styledFamilyById } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";
import { formatFamilyRef, formatCaptionLabel } from "../src/lib/figfamily";
import { formatNatureReference, formatCiteMark, natureAuthors } from "../src/lib/style/natureRefs";
import type { RefEntry } from "../src/lib/references/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const nature = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);
const P = nature.figures.panels;
const R = nature.referenceList;
const C = nature.citations.numeric;

// --- figure + panel references ----------------------------------------------
{
  const fig = (n: number, panel = "") => formatFamilyRef(styledFamilyById(nature, "figure"), n, panel);
  assert(fig(1) === "Fig. 1", "whole-figure ref is 'Fig. 1' (period always present)");
  assert(fig(1, formatPanelSpec("a", P)) === "Fig. 1a", "single panel: 'Fig. 1a'");

  const twoPanels = fig(1, formatPanelSpec("a,b", P));
  assert(twoPanels === "Fig. 1a,b", `two panels: 'Fig. 1a,b' (got ${twoPanels})`);
  // The 2022 switch, as negatives — these forms are WRONG for current Nature.
  assert(twoPanels !== "Fig. 1a, b", "NOT 'Fig. 1a, b' — that is the pre-2022 style");
  assert(twoPanels !== "Fig. 1a and b", "NOT 'Fig. 1a and b' — 0 occurrences in the whole corpus");

  const range = fig(1, formatPanelSpec("a-c", P));
  assert(range === "Fig. 1a–c", `range uses an EN DASH: 'Fig. 1a–c' (got ${range})`);
  assert(!range.includes("-"), "no hyphen anywhere in a panel range");
  assert(fig(2, formatPanelSpec("b-f,i", P)) === "Fig. 2b–f,i", "mixed range + single: 'Fig. 2b–f,i'");
  assert(fig(1, formatPanelSpec("A", P)) === "Fig. 1a", "capital panel letters are lowercased (0 occurrences capitalised)");

  // Supplementary is the correction the corpus forced: Nature does NOT write "Fig. S1".
  const sup = formatFamilyRef(styledFamilyById(nature, "supplementary"), 1);
  assert(sup === "Supplementary Fig. 1", `supplementary ref is 'Supplementary Fig. 1' (got ${sup})`);
  assert(sup !== "Fig. S1", "NOT 'Fig. S1' — that is Flux's house form, not Nature's");

  assert(formatFamilyRef(styledFamilyById(nature, "extended-data"), 4, "a") === "Extended Data Fig. 4a",
    "extended data: 'Extended Data Fig. 4a'");

  // Legend leads: "Fig. N |" appears 1017x, "Figure N |" 0x.
  const lead = formatCaptionLabel(styledFamilyById(nature, "figure"), 1);
  assert(lead === "Fig. 1 | ", `legend lead is 'Fig. 1 | ' (got ${JSON.stringify(lead)})`);
  assert(!lead.startsWith("Figure "), "NOT 'Figure 1 |' — 0 occurrences in the corpus");
}

// --- citation marks ----------------------------------------------------------
{
  assert(C.presentation === "superscript", "citations are superscript numerals");
  assert(C.placement === "before-punctuation", "the mark sits BEFORE terminal punctuation (1202x vs 0)");
  assert(formatCiteMark([1, 2], C) === "1,2", "multi-citation is '1,2' — comma, no space (1203x vs 0)");
  assert(formatCiteMark([2, 1], C) === "1,2", "ordinals print ascending regardless of source order");
  assert(formatCiteMark([1, 2, 3], C) === "1–3", "a run of 3 collapses to an en-dash range");
  assert(formatCiteMark([1, 2], C) !== "1–2", "a PAIR does not collapse");
  assert(formatCiteMark([1, 12, 13, 14], C) === "1,12–14", "mixed singles and runs: '1,12–14'");
  assert(!formatCiteMark([1, 2, 3], C).includes("-"), "ranges never use a hyphen");
  assert(formatCiteMark([3, 1, 2, 3], C) === "1–3", "duplicate ordinals are deduped");
}

// --- reference entries -------------------------------------------------------
const mk = (authors: [string, string][], rest: Partial<RefEntry> = {}): RefEntry =>
  ({
    key: "k",
    title: "Molecular structure of nucleic acids",
    authorsFull: authors.map(([family, given]) => ({ family, given })),
    authors: authors.map(([f]) => f),
    container: "Nature",
    volume: "171",
    pages: "737-738",
    year: "1953",
    ...rest,
  }) as RefEntry;

{
  // ≤5 authors: ALL listed, "&" before the last, NO comma before the ampersand.
  const three = mk([
    ["Hanse", "E."],
    ["Seth", "H."],
    ["Riebe", "I."],
  ]);
  assert(natureAuthors(three, R) === "Hanse, E., Seth, H. & Riebe, I.",
    `3 authors all listed with '&' before the last (got: ${natureAuthors(three, R)})`);
  assert(!natureAuthors(three, R).includes(", &"), "NO comma before the ampersand");

  const five = mk([["A", "A."], ["B", "B."], ["C", "C."], ["D", "D."], ["E", "E."]]);
  assert(natureAuthors(five, R) === "A, A., B, B., C, C., D, D. & E, E.",
    "5 authors are still listed in full (5-author entries: 277 in the corpus)");

  // ≥6: first author ONLY + et al. — not "first six", the rule most guides use.
  const six = mk([["A", "A."], ["B", "B."], ["C", "C."], ["D", "D."], ["E", "E."], ["F", "F."]]);
  assert(natureAuthors(six, R) === "A, A. et al.",
    `6 authors collapse to the FIRST author + et al. (got: ${natureAuthors(six, R)})`);
  assert(!natureAuthors(six, R).includes("B, B."), "the second author is dropped entirely at 6+");

  // Full entry shape.
  const line = formatNatureReference(three, R);
  assert(line === "Hanse, E., Seth, H. & Riebe, I. Molecular structure of nucleic acids. Nature 171, 737–738 (1953).",
    `full entry matches the published shape (got: ${line})`);
  assert(line.endsWith("(1953)."), "the year comes LAST, parenthesised");
  assert(line.includes("737–738"), "page range uses an en dash");
  assert(!/doi|https?:/i.test(line), "an ordinary journal article carries NO DOI");

  // Journal abbreviation, including the exception Nature prints without a period.
  const pnas = mk([["Huang", "X."], ["B", "B."], ["C", "C."], ["D", "D."], ["E", "E."], ["F", "F."]], {
    container: "Proceedings of the National Academy of Sciences",
    volume: "112",
    pages: "E3131-E3140",
    year: "2015",
  });
  const pnasLine = formatNatureReference(pnas, R);
  assert(pnasLine.includes("Proc. Natl Acad. Sci. USA"),
    `PNAS abbreviates to 'Proc. Natl Acad. Sci. USA' (got: ${pnasLine})`);
  assert(!pnasLine.includes("Natl."), "'Natl' takes NO period — it is a contraction");
  assert(pnasLine.includes("E3131–E3140"), "alphanumeric page ranges also get the en dash");

  // Single-word journals are never abbreviated.
  assert(formatNatureReference(mk([["Watson", "J. D."], ["Crick", "F. H. C."]]), R).includes(" Nature 171"),
    "'Nature' stays unabbreviated");

  // Preprints: the URL/DOI IS the identifier.
  const pre = mk([["Babichov", "S. A."]], {
    container: "bioRxiv",
    doi: "10.1101/2023.06.27.546656",
    volume: "",
    pages: "",
    year: "2023",
  });
  const preLine = formatNatureReference(pre, R);
  assert(preLine.includes("Preprint at https://doi.org/10.1101/2023.06.27.546656 (2023)."),
    `preprint uses the 'Preprint at <doi> (year).' form (got: ${preLine})`);

  // Books: publisher + year in parentheses.
  const book = mk([["Jones", "R. A. L."]], {
    title: "Soft Machines",
    container: "",
    publisher: "Oxford Univ. Press",
    volume: "",
    pages: "",
    year: "2004",
  });
  assert(formatNatureReference(book, R) === "Jones, R. A. L. Soft Machines (Oxford Univ. Press, 2004).",
    `book form is 'Title (Publisher, Year).' (got: ${formatNatureReference(book, R)})`);
}

// --- limits carry the documented conflict honestly ---------------------------
{
  assert(nature.limits.legendWords === 250 && nature.limits.legendWordsHard === 300,
    "BOTH legend bounds are carried — nature.com states 250 in one place and 300 in another");
  assert(nature.limits.abstractWords === 200 && nature.limits.abstractWordsHard === 300,
    "summary paragraph: 200 nominal, 300 hard ceiling with the broader-perspective block");
  assert(nature.limits.mainRefs === 50, "main-text reference cap is 50 (Methods/SI excluded)");
  assert(nature.structure.forbiddenHeadings.includes("results"),
    "Results is a forbidden heading (0/61 sampled papers print one)");
  assert(nature.structure.referenceListSplit === "main-plus-methods",
    "Methods references continue the main numbering in a second list");
  assert(nature.document.lineNumbers === true && nature.document.lineSpacing === 2,
    "submission format: double-spaced with line numbers");
}

console.log("\nNATURE-STYLE VERIFY: PASS");
