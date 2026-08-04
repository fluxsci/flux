// Built-in journal styles.
//
// Provenance tags on every value:
//   [CE] confirmed empirically — counted over 88 Nature-proper PDFs (61 of them
//        2022+) in a real FluxLib, so it reflects what Nature actually PRINTS
//   [CD] confirmed documented — stated on nature.com's author pages
//   [INF] inferred — a defensible extension of a confirmed rule, flagged so a
//        future reader knows it was not measured
//
// The single most important measurement: Nature changed its panel separator in
// 2022. "Fig. 1a,b" (no space) appears 0× in 2021 and 99× in 2022, rising to
// 442× in 2024; the spaced "Fig. 1a, b" runs the other way and is dead after
// 2021. "Fig. 1a and b" appears ZERO times in the whole corpus. Nature
// Communications, meanwhile, still prints the spaced form — which is exactly
// why the separator is a per-style parameter and not a constant.

import type { JournalStyle } from "./journalStyle";

export const NATURE_STYLE: JournalStyle = {
  id: "nature",
  name: "Nature",
  blurb: "Superscript citations · Fig. 1a,b · 12pt Times, double-spaced, line numbers",
  figures: {
    panels: {
      letterCase: "lower", // [CE] capital panel letters: 0 occurrences
      wrap: "none", // [CE]
      listSeparator: ",", // [CE] the 2022 switch — no space
      rangeSeparator: "–", // [CE] en dash; hyphen form: 0 occurrences
      collapseRunsOfAtLeast: 3, // [CE] "Fig. 1a–c" for runs, pairs stay listed
    },
    familyOverrides: {
      // [CE] "Fig." always carries its period in a running reference.
      figure: {
        refTemplate: "Fig. {num}{panel}",
        // [CE] "Fig. N |" appears 1017×; "Figure N |" 0×.
        captionTemplate: "Fig. {num} | ",
      },
      // [CE/CD] Nature writes "Supplementary Fig. 1" — NOT Flux's house "Fig. S1".
      supplementary: {
        displayName: "Supplementary Figure",
        refTemplate: "Supplementary Fig. {num}{panel}",
        captionTemplate: "Supplementary Fig. {num} | ", // [INF] from the main-legend pattern
      },
      // [CE] "Extended Data Fig. 4a" — 547× inside cross-class joins alone.
      "extended-data": {
        refTemplate: "Extended Data Fig. {num}{panel}",
        captionTemplate: "Extended Data Fig. {num} | ", // [INF]
      },
    },
  },
  citations: {
    mode: "numeric", // [CD] numbered by order of first appearance
    numeric: {
      presentation: "superscript", // [CD/CE] superscript numerals, not brackets
      separator: ",", // [CE] "1,2" — 1203× vs 0 for the spaced form
      rangeSeparator: "–", // [CE] 1072× en dash; hyphen: 0
      collapseRunsOfAtLeast: 3,
      placement: "before-punctuation", // [CE] 1202× before the stop, 0× after
    },
  },
  referenceList: {
    layout: "nature",
    // [CE] ≤5 authors are ALL listed; ≥6 collapse to the first author alone.
    // Counted: 5-author entries 277, 6-author entries 0, "1 + et al." 1592.
    authorMax: 5,
    etAlKeep: 1,
    finalJoin: " & ", // [CE] no comma before the ampersand
    journalAbbrev: true, // [CD] "abbreviated according to common usage"
    heading: "References",
  },
  structure: {
    // [CD] quoted from the formatting guide, in order.
    order: [
      "abstract",
      "body",
      "discussion",
      "references",
      "figure-legends",
      "methods",
      "data-availability",
      "code-availability",
      "methods-references",
      "acknowledgements",
      "funding",
      "author-contributions",
      "competing-interests",
      "additional-information",
      "extended-data",
    ],
    // [CE] 0/61 sampled papers print an Introduction or Results heading.
    forbiddenHeadings: ["introduction", "results"],
    // [CE] Methods references continue the main numbering as a second list
    // (vardalaki: main 1–40, Methods 41–46).
    referenceListSplit: "main-plus-methods",
  },
  limits: {
    titleChars: 75, // [CD]
    subheadChars: 40, // [CD]
    abstractWords: 200, // [CD]
    abstractWordsHard: 300, // [CD] 300 only with the broader-perspective block
    mainTextWords: 4300, // [CD] bio/clinical/social ≈8 pages (phys sciences ≈2500)
    methodsWords: 3000, // [CD]
    // [CD] nature.com CONTRADICTS ITSELF here — the figure guide says 250, the
    // submission guide 300. Both are carried so the checker can report the
    // conflict honestly instead of inventing a single number.
    legendWords: 250,
    legendWordsHard: 300,
    mainRefs: 50, // [CD] Methods and SI references are excluded from this count
    displayItems: 6, // [CD] 5–6 for bio; 4 for physical sciences
    extendedDataItems: 10, // [CD]
  },
  document: {
    lineSpacing: 2, // [CD] double-spaced
    fontFamily: "Times New Roman", // [CD] "preferably 12-point Times New Roman"
    fontSizePt: 12, // [CD]
    lineNumbers: true, // [CD] required; page numbers are nowhere required
  },
  csl: "references/styles/nature.csl",
  sizingFamily: "Nature",
};

/**
 * Nature Communications — kept deliberately as the second preset because it is
 * the proof that the schema earns its shape: it differs from Nature in three
 * measured ways and inherits everything else in a handful of lines.
 */
export const NATURE_COMMUNICATIONS_STYLE: JournalStyle = {
  id: "nature-communications",
  name: "Nature Communications",
  extends: "nature",
  blurb: "Nature portfolio style with spaced panel lists (Fig. 1a, b)",
  figures: {
    // [CE] 30 spaced vs 0 unspaced in the sampled Nat. Commun. papers — the one
    // portfolio journal that did NOT follow the 2022 switch.
    panels: { listSeparator: ", " },
  },
  structure: {
    // [CE] prints a Results heading, and has no Extended Data tier at all.
    forbiddenHeadings: [],
    referenceListSplit: "single",
  },
};

export const BUILTIN_JOURNAL_STYLES: readonly JournalStyle[] = [
  NATURE_STYLE,
  NATURE_COMMUNICATIONS_STYLE,
];

/** Menu rows for the export dialog: the house style first, then the builtins. */
export function journalStyleOptions(): { id: string; label: string; blurb?: string }[] {
  return [
    { id: "flux", label: "Flux house style", blurb: "The default manuscript look." },
    ...BUILTIN_JOURNAL_STYLES.map((s) => ({ id: s.id, label: s.name, blurb: s.blurb })),
  ];
}
