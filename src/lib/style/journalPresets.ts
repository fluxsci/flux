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
  formats: ["docx", "pdf"],
  blurb: "Superscript citations · Fig. 1a,b · 12pt Times, double-spaced, line numbers · Methods references continue in a second list",
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
        captionTemplate: "Extended Data Fig. {num} | ", // [CE] 1,015×/78 papers, no variants
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
      "tables", // [CD] FG/FS: tables sit between the references and the legends
      "figure-legends",
      "methods",
      "data-availability",
      "code-availability",
      "methods-references",
      "acknowledgements",
      "funding",
      "author-contributions",
      "competing-interests",
      "ethics", // [CD] CK 2026 adds an Ethics Statement after competing interests
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
    titleChars: 75, // [CD] "≤75 characters including spaces, with no punctuation" (FG, CK 2026)
    subheadChars: 40, // [CD]
    abstractWords: 200, // [CD] FG: "ideally of no more than 200 words"
    // [CD] CK (2026-07-07 checklist) makes 230 the hard ceiling. 300 survives
    // only for an editor-approved "broader perspective" close (summary-paragraph
    // guide) — compliance mentions it rather than allowing it.
    abstractWordsHard: 230,
    mainTextWords: 4300, // [CD] 8-page bio/clinical/social article; INCLUDES the summary paragraph
    methodsWords: 3000, // [CD] a guideline ("may be longer if necessary")
    // [CD] nature.com CONTRADICTS ITSELF: the Initial-submission page says
    // "<250 words", the Formatting guide and the 2026 checklist say ≤300. Both
    // are carried so the checker can report the conflict honestly.
    legendWords: 250,
    legendWordsHard: 300,
    extendedLegendWords: 1000, // [CD] CK 2026 only
    mainRefs: 50, // [CD] Methods and SI references are excluded from this count
    displayItems: 6, // [CD] 5–6 for bio; 4 for physical sciences
    extendedDataItems: 10, // [CD]
  },
  document: {
    lineSpacing: 2, // [CD] double-spaced
    fontFamily: "Times New Roman", // [CD] "preferably 12-point Times New Roman"
    fontSizePt: 12, // [CD]
    lineNumbers: true, // [CD] required in a PDF; the system numbers Word files itself
    paperSize: "letter", // [INF] Nature names none
    marginsIn: { top: 1, right: 1, bottom: 1, left: 1 }, // [INF] Nature names none
    pageNumbers: true, // [INF] not required anywhere, harmless and asked for by reviewers
  },
  manuscript: {
    citations: "literal",
    titleBlock: "nature",
    // [CD] the "bold first paragraph" — no heading, set in bold at submission.
    abstract: { heading: null, bold: true },
    headingCase: "as-is",
    dropHeadings: ["introduction", "results"], // [CE] 0/61 papers print either heading
    renameHeadings: {
      methods: "Methods",
      "data-availability": "Data availability",
      "code-availability": "Code availability",
      acknowledgements: "Acknowledgements",
      funding: "Funding",
      "author-contributions": "Author contributions",
      "competing-interests": "Competing interests",
      ethics: "Ethics statement",
      "additional-information": "Additional information",
      "extended-data": "Extended Data",
    },
    // [CD] FG order; data/code availability BEFORE the Methods references
    // (FG, FS, code policy and 77/77 printed papers; the 2026 checklist differs —
    // owner ruling: follow FG).
    order: [
      "introduction",
      "results",
      "body",
      "discussion",
      "references",
      "figure-legends",
      "methods",
      "ai-declaration",
      "data-availability",
      "code-availability",
      "acknowledgements",
      "funding",
      "author-contributions",
      "competing-interests",
      "ethics",
      "additional-information",
      "supplementary",
      "extended-data",
    ],
    referencesHeading: "References",
    // [CD] Methods references continue the numbering in a second list.
    splitReferences: { afterRole: "code-availability", heading: null },
    legendsHeading: "Figure legends",
    legend: { boldTitle: true, titlePeriod: "keep", panels: "letter-comma" },
    // [CD] initial: each legend on the page of its figure; final: figures as files.
    figures: { initial: "inline", final: "legends-only" },
    footnotes: "keep", // [CD] "Do not use footnotes" — reported, not rewritten
    required: [
      { role: "methods", label: "Methods", stage: "initial" },
      { role: "data-availability", label: "Data availability", stage: "initial" },
      { role: "author-contributions", label: "Author contributions", stage: "final" },
      { role: "competing-interests", label: "Competing interests", stage: "initial" },
    ],
    outsideFlux: [
      "Reporting Summary (life-sciences, behavioural and social sciences, EEE papers) — fill in Nature's PDF form.",
      "Cover letter (optional, confidential) — declare related manuscripts under consideration elsewhere.",
      "At acceptance: ORCID linked for every author, licence to publish, third-party rights table, Source Data (one workbook per figure).",
      "Code availability: deposit custom code in a DOI-minting repository (Zenodo, Code Ocean) and cite it.",
    ],
    figureGuidance: [
      "Final figures: one editable vector file each (PDF/EPS/AI, live text, fonts embedded), RGB, ≤50 MB — not JPG/PNG/TIFF.",
      "Widths: 89 mm (single), 120–136 mm (1.5 column), 183 mm (double); height ≤170 mm.",
      "Type: Arial/Helvetica 5–7 pt; panel labels 8 pt bold lowercase; lines 0.25–1 pt.",
      "Extended Data: JPEG/TIFF/EPS, ≤300 ppi, ≤10 MB, 180 × 170 mm page, named Surname_EDfig1.jpg.",
    ],
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
  manuscript: {
    dropHeadings: ["introduction"],
    splitReferences: undefined,
  },
};

/**
 * Science (AAAS) Research Article. Sources: docs/journal_styleguide.md §3 —
 * the initial/revised-manuscript instructions (Aug 2025 / Mar 2025), the 2026
 * editorial policies, the Nov 2022 Word template (its STYLE NAMES are reused so
 * Science's metadata extraction recognises each block), and 25 Research
 * Articles 2020–2026 in FluxLib ([P]).
 */
export const SCIENCE_STYLE: JournalStyle = {
  id: "science",
  name: "Science",
  blurb: "Italic numbered citations (1) · Fig. 1, A and B · fig. S1 · single-spaced Times, US Letter · References and Notes",
  formats: ["docx", "pdf"],
  figures: {
    panels: {
      grammar: "science", // [P] "Fig. 1, A and B" 191×, "Fig. 1, A to C" 124×, "Fig. 1A–C" 0×
      paragraphInitial: "spell-out", // [D] TPL: 'write out "Figure" in full (e.g., "Figure 1 shows…")' 
      letterCase: "upper", // [D] "uppercase letters (A, B, etc.)"
      wrap: "none",
      listSeparator: ", ",
      rangeSeparator: "–",
      collapseRunsOfAtLeast: 3,
    },
    familyOverrides: {
      figure: { refTemplate: "Fig. {num}{panel}", captionTemplate: "Fig. {num}. " }, // [D] TPL "Fig. 1."
      // [D] "fig. S1 (note the lowercase 'f')"
      supplementary: { displayName: "Supplementary Figure", refTemplate: "fig. S{num}{panel}", captionTemplate: "Fig. S{num}. " },
      "extended-data": { refTemplate: "fig. S{num}{panel}", captionTemplate: "Fig. S{num}. " },
    },
  },
  citations: {
    mode: "numeric",
    numeric: {
      presentation: "parens-italic", // [D] "within parentheses, italicized: (18, 19) (18–20)"; [P] 1169 italic vs 21
      separator: ", ",
      rangeSeparator: "–",
      collapseRunsOfAtLeast: 3, // [P] two consecutive → comma 212×; 3+ → dash
      placement: "before-punctuation", // [P] 884 before vs 12 after
    },
  },
  referenceList: {
    layout: "science",
    authorMax: 1000, // [D] full author lists at submission (print truncates later)
    etAlKeep: 1000,
    finalJoin: ", ",
    journalAbbrev: true, // [P] ISO abbreviations in print
    heading: "References and Notes",
  },
  structure: { order: [], forbiddenHeadings: ["introduction"], referenceListSplit: "single" },
  limits: {
    titleChars: 96, // [D]
    abstractWords: 125, // [D] "125 words or less" (TPL: 100–125)
    mainTextWords: 3000, // [D] standard format (extended online format: 6000)
    displayItems: 5, // [D] 3–5
    mainRefs: 50, // [D] about 50; SM-only references not counted
    legendWords: 200, // [D] "No single caption should be longer than 200 words."
    oneSentenceSummaryChars: 125, // [D] TPL 2022
  },
  document: {
    lineSpacing: 1, // [D] "Use single spacing throughout"
    fontFamily: "Times New Roman", // [D]
    fontSizePt: 12, // [D] TPL body
    lineNumbers: true, // [D] "We also encourage use of line numbers"
    lineNumberCountBy: 5, // [D] TPL numbers every 5th line
    paperSize: "letter", // [D] "US letter, 8.5 × 11 in"
    marginsIn: { top: 0.9, right: 1, bottom: 0.9, left: 1 }, // [D] TPL section setup
    pageNumbers: true, // [D] "include page numbers in your submitted file"
    firstLineIndentIn: 0.5, // [D] TPL "Paragraph" style
    headerText: "Submitted Manuscript: Confidential", // [D] TPL running header
  },
  manuscript: {
    citations: "literal",
    titleBlock: "science",
    abstract: { heading: null, label: "Abstract:" }, // [D] key word for metadata extraction
    headingCase: "as-is",
    dropHeadings: ["introduction"], // [D] "Science does not allow headings before the first paragraph"
    renameHeadings: { methods: "Materials and Methods", supplementary: "Supplementary Materials" },
    runIn: {
      parent: "acknowledgements",
      heading: "Acknowledgments:",
      children: [
        { role: "funding", label: "Funding:" },
        { role: "author-contributions", label: "Author contributions:" },
        { role: "ethics", label: "Diversity, equity, ethics, and inclusion:" },
        { role: "competing-interests", label: "Competing interests:" },
        // [D] POL 2026 + 2026 print (owner ruling: the 2026 name)
        { role: "data-availability", label: "Data, code, and materials availability:" },
      ],
    },
    mainTextLabel: "Main Text:",
    order: [
      "introduction",
      "results",
      "body",
      "discussion",
      "limitations",
      "methods", // extended format: methods run after the main text
      "references",
      "acknowledgements",
      "supplementary",
      "figure-legends",
      "extended-data",
    ],
    referencesHeading: "References and Notes",
    legendsHeading: "Figure captions",
    legend: { boldTitle: true, titlePeriod: "keep", panels: "parens-bold" },
    figures: { initial: "inline", final: "legends-only" },
    footnotes: "notes-in-references", // [D] notes are numbered entries of References and Notes
    docxStyles: {
      title: "Head",
      authors: "Authors",
      affiliation: "Affiliations",
      correspondence: "Affiliations",
      abstract: "AbstractSummary",
      teaser: "Teaser",
      label: "Teaser",
      bibliography: "Referencesandnotes",
      acknowledgement: "Acknowledgement",
      legend: "Legend",
    },
    required: [
      { role: "funding", label: "Funding", stage: "initial" },
      { role: "author-contributions", label: "Author contributions", stage: "initial" },
      { role: "competing-interests", label: "Competing interests", stage: "initial" },
      { role: "data-availability", label: "Data, code, and materials availability", stage: "initial" },
    ],
    frontMatterItems: ["one-sentence-summary"],
    outsideFlux: [
      "Initial submission uploads THREE files: this .docx (figures embedded), a Combined PDF (main text + figures + tables + Supplementary Materials — export this manuscript as PDF and append the SM), and the Supplementary Materials as one .docx/PDF ≤50 MB.",
      "Standard Research Articles put Materials and Methods in the Supplementary Materials; keep them in the main text only for the extended online format (say why in the cover letter).",
      "Cover letter (required): main point, related manuscripts, where the data are deposited.",
      "At revision: ORCID for first and corresponding authors, the License to Publish, and each author's authorship/conflict-of-interest form; print papers list an MDAR Reproducibility Checklist.",
    ],
    figureGuidance: [
      "Revision figures: separate PDF/EPS/AI (vector) or TIFF ≥300 dpi files — no figures inside the .docx, no PowerPoint.",
      "Widths: 5.7 cm (1 column), 12.1 cm (2 columns), 18.4 cm (3 columns).",
      "Type: Helvetica, ~7 pt, never <5 pt; panel labels 10 pt bold capitals, upper left; lines ≥0.5 pt; no minor ticks.",
    ],
  },
  csl: "references/styles/science.csl",
  sizingFamily: "Science",
};

/**
 * Cell (Cell Press) research Article. Sources: docs/journal_styleguide.md §4 —
 * the official Cell Press LaTeX template v1.10 (Dec 2024), Cell Press blog
 * pages, star-methods.com, and 12 Cell papers 2023–2026 in FluxLib ([P]).
 * Cell has used numbered superscript citations since late 2022.
 */
export const CELL_STYLE: JournalStyle = {
  id: "cell",
  name: "Cell",
  blurb: "Superscript citations after punctuation · Figures 1A–1C · STAR Methods · Resource availability · 12pt Arial",
  formats: ["docx", "pdf"],
  figures: {
    panels: {
      grammar: "cell", // [P] "Figures 4C–4E" 96×, "4C–E" 0×; "Figures 1A and 1B" 74×
      letterCase: "upper", // [P] 883 "(A)" vs 2 "(a)"
      wrap: "none",
      listSeparator: ", ",
      rangeSeparator: "–",
      collapseRunsOfAtLeast: 3,
    },
    familyOverrides: {
      figure: { refTemplate: "Figure {num}{panel}", captionTemplate: "Figure {num}. " }, // [P] never "Fig."
      supplementary: { displayName: "Supplemental Figure", refTemplate: "Figure S{num}{panel}", captionTemplate: "Figure S{num}. " },
      "extended-data": { refTemplate: "Figure S{num}{panel}", captionTemplate: "Figure S{num}. " },
    },
  },
  citations: {
    mode: "numeric",
    numeric: {
      presentation: "superscript",
      separator: ",", // [P] 318 groups, comma no space
      rangeSeparator: "–",
      collapseRunsOfAtLeast: 3, // [P] pairs listed 203× vs 0 dashed
      placement: "after-punctuation", // [P] 554 after vs 1 before
    },
  },
  referenceList: {
    layout: "cell",
    authorMax: 10, // [D/P] ≥11 → first 10 + ", et al."
    etAlKeep: 10,
    finalJoin: ", and ",
    journalAbbrev: true,
    heading: "References",
  },
  structure: { order: [], forbiddenHeadings: [], referenceListSplit: "single" },
  limits: {
    titleChars: 145, // [M]
    abstractWords: 150, // [M] Summary, one paragraph
    mainTextWords: 7000, // [Sn] incl. main legends; excl. STAR Methods, SI legends, references
    displayItems: 7, // [Sn]
    highlightsMin: 3,
    highlightsMax: 4,
    highlightChars: 85, // [D]
    etocWords: 50, // [Sn]
    keywordsMax: 10, // [M]
  },
  document: {
    // No official page setup (initial submission is format-free): a house
    // choice per the owner ruling — 12 pt Arial, double-spaced, numbered.
    lineSpacing: 2,
    fontFamily: "Arial",
    fontSizePt: 12,
    lineNumbers: true,
    paperSize: "letter",
    marginsIn: { top: 1, right: 1, bottom: 1, left: 1 },
    pageNumbers: true,
  },
  manuscript: {
    citations: "literal",
    titleBlock: "cell",
    abstract: { heading: "Summary" },
    headingCase: "upper", // [M] ALL-CAPS unnumbered section heads
    dropHeadings: [],
    renameHeadings: {
      methods: "STAR Methods",
      "resource-availability": "Resource availability",
      acknowledgements: "Acknowledgments",
      "author-contributions": "Author contributions",
      "competing-interests": "Declaration of interests",
      "ai-declaration": "Declaration of generative AI and AI-assisted technologies",
      supplementary: "Supplemental information",
      "figure-legends": "Main figure titles and legends",
      keywords: "Keywords",
    },
    order: [
      "keywords",
      "introduction",
      "results",
      "body",
      "discussion",
      "resource-availability",
      "acknowledgements",
      "author-contributions",
      "competing-interests",
      "ai-declaration",
      "supplementary",
      "figure-legends",
      "references",
      "methods",
      "extended-data",
    ],
    referencesHeading: "References",
    legendsHeading: "Main figure titles and legends",
    legend: { boldTitle: true, titlePeriod: "strip", panels: "parens-lines" }, // [P] 0/75 titles end in "."
    figures: { initial: "inline", final: "legends-only" },
    footnotes: "keep",
    required: [
      { role: "author-contributions", label: "Author contributions", stage: "initial" },
      { role: "competing-interests", label: "Declaration of interests", stage: "initial" },
      { role: "methods", label: "STAR Methods", stage: "final" },
    ],
    frontMatterItems: ["highlights", "etoc", "keywords", "lead-contact"],
    outsideFlux: [
      "Declaration of Interests form (PDF) — required at initial submission.",
      "Cover letter (required).",
      "At revision: Highlights + eTOC blurb in their own Word file, the graphical abstract (1200 × 1200 px, Arial 8–12 pt, no data), and the Key Resources Table as a separate Word file (star-methods.com).",
      "Supplemental information goes in its own PDF (Document S1) with SI-only references in its own list; long tables as Excel.",
    ],
    figureGuidance: [
      "Figures: one file per figure (all panels), TIFF or PDF preferred, RGB, ≥300 dpi (≥1000 dpi line art).",
      "Widths: 85 mm (1 column), 114 mm (1.5 column), 174 mm (2 column).",
      "Type: Arial ~6–8 pt; panel labels capital letters (A, B, C); scale bars on micrographs.",
    ],
  },
  csl: "references/styles/cell.csl",
  sizingFamily: "Cell / PNAS",
};

/**
 * bioRxiv preprint. bioRxiv sets no style (biorxiv.org/submit-a-manuscript,
 * /about/FAQ): one PDF with text and figures together is the simplest deposit,
 * the title/authors/affiliations/abstract are extracted FROM that PDF, and
 * references may follow any style — so citations stay with the document's own
 * CSL. Flux supplies a clean preprint layout: a proper title page, figures
 * beside their legends, line numbers for reviewers' comments.
 */
export const BIORXIV_STYLE: JournalStyle = {
  id: "biorxiv",
  name: "bioRxiv preprint",
  blurb: "Single PDF with figures beside their legends · title page bioRxiv can read · your citation style kept",
  formats: ["pdf", "docx"],
  figures: {
    panels: { letterCase: "lower", wrap: "none", listSeparator: ",", rangeSeparator: "–", collapseRunsOfAtLeast: 3 },
    familyOverrides: {
      figure: { refTemplate: "Figure {num}{panel}", captionTemplate: "Figure {num}. " },
      supplementary: { refTemplate: "Figure S{num}{panel}", captionTemplate: "Figure S{num}. " },
      "extended-data": { refTemplate: "Extended Data Figure {num}{panel}", captionTemplate: "Extended Data Figure {num}. " },
    },
  },
  citations: { mode: "inherit" },
  document: {
    lineSpacing: 1.5,
    fontFamily: "Arial",
    fontSizePt: 11,
    lineNumbers: true,
    paperSize: "letter",
    marginsIn: { top: 1, right: 1, bottom: 1, left: 1 },
    pageNumbers: true,
  },
  manuscript: {
    citations: "citeproc",
    titleBlock: "preprint",
    abstract: { heading: "Abstract" },
    headingCase: "as-is",
    dropHeadings: [],
    renameHeadings: {},
    order: [],
    referencesHeading: "References",
    legendsHeading: "Figure legends",
    legend: { boldTitle: true, titlePeriod: "keep", panels: "letter-comma" },
    figures: { initial: "inline", final: "inline" },
    footnotes: "keep",
    required: [],
    outsideFlux: [
      "bioRxiv asks for a competing-interest statement, funders (ROR IDs + grant numbers) and a licence (CC BY, CC BY-NC…) in its submission form.",
      "Supplementary files are uploaded separately and posted as-is; large datasets belong in a community repository.",
      "No identifiable faces in figures (blurring is not enough); clinical research goes to medRxiv instead.",
    ],
    figureGuidance: ["Figures sit beside their legends in the PDF; bioRxiv builds its full-text HTML from this file."],
  },
};

/** Figures embedded in a journal manuscript: print resolution at the placed
 *  size. Every venue accepts 300 dpi at submission (Nature, Science, Cell). */
export const JOURNAL_FIGURE_DPI = 300;

export const BUILTIN_JOURNAL_STYLES: readonly JournalStyle[] = [
  NATURE_STYLE,
  SCIENCE_STYLE,
  CELL_STYLE,
  BIORXIV_STYLE,
  NATURE_COMMUNICATIONS_STYLE,
];

/** Menu rows for the export dialog: the house style first, then the builtins. */
export function journalStyleOptions(): { id: string; label: string; blurb?: string; formats?: readonly ("pdf" | "docx" | "html")[] }[] {
  return [
    { id: "flux", label: "Flux house style", blurb: "The default manuscript look." },
    ...BUILTIN_JOURNAL_STYLES.map((s) => ({ id: s.id, label: s.name, blurb: s.blurb, formats: s.formats })),
  ];
}
