// Word budgets: per-section counts and the venue's buckets (abstract, main
// text, Methods, legends) — the numbers a journal's word limits are written in.
// The counting itself is wordCount.ts (THE counting law); this module only
// decides which words go in which bucket, using the same section reading as
// the journal assembler (journalManuscript.ts readSections + its abstract
// rule), so the editor's numbers and the export summary's numbers agree.
//
//   abstract  — a front-matter `abstract:`, else an "Abstract"/"Summary"
//               section, else the preamble (Nature's summary paragraph);
//   main      — top-level sections whose role is body / introduction /
//               results / discussion / limitations; Nature (and the house
//               style) add the abstract, Cell adds the main figure legends;
//   methods   — the Methods section(s), subsections included;
//   legends   — figure captions (alt text, or the figure model's caption) and
//               table captions, wherever they sit;
//   tables    — table cells (no venue counts them as text);
//   other     — everything else (back matter, Extended Data, supplementary).
// Headings are never counted. The top level is H1, or — when a manuscript
// uses no H1 (the title is the front matter's) — its shallowest heading level.
//
// Twin-engine shared core (flux-core → src/lib): no Svelte, no DOM, no Node.

import { JOURNAL_ROLE_ALIASES, normalizeHeading, type RoleAliases } from "./sections";
import { analyzeWords, countKinds, externalLegendWords, type AnalyzeOptions, type WordAnalysis } from "./wordCount";

/** Roles whose prose is "main text" (journalManuscript MAIN_ROLES). */
export const MAIN_TEXT_ROLES: readonly string[] = ["body", "introduction", "results", "discussion", "limitations"];
/** Roles whose legends are supplementary (not counted by Cell's main text). */
const SUPPLEMENTARY_ROLES: readonly string[] = ["extended-data", "supplementary"];

export interface CountRules {
  /** The main-text figure includes the abstract (Nature: the summary paragraph). */
  mainIncludesAbstract: boolean;
  /** The main-text figure includes the main figure legends (Cell). */
  mainIncludesLegends: boolean;
  aliases: RoleAliases;
}

/** The house rules = Nature's (main text includes the summary paragraph). */
export const HOUSE_COUNT_RULES: CountRules = {
  mainIncludesAbstract: true,
  mainIncludesLegends: false,
  aliases: JOURNAL_ROLE_ALIASES,
};

/** A venue's counting rules, from its manuscript spec (the same switch the
 *  journal assembler uses: `titleBlock`). No spec = the house rules. */
export function countRulesFor(style?: { manuscript?: { titleBlock?: string } } | null): CountRules {
  const tb = style?.manuscript?.titleBlock;
  if (!tb || tb === "nature") return HOUSE_COUNT_RULES;
  return { mainIncludesAbstract: false, mainIncludesLegends: tb === "cell", aliases: JOURNAL_ROLE_ALIASES };
}

export interface SectionCount {
  heading: string;
  level: number;
  /** Heading line start (the outline's key) and the end of the section,
   *  subsections included. */
  from: number;
  to: number;
  /** Role of the top-level section this heading belongs to. */
  role: string;
  /** A top-level section (the unit roles and budgets are read at). */
  top: boolean;
  /** Prose words, subsections included. */
  words: number;
  /** Prose words before the first subsection. */
  own: number;
  /** Legend words (in-text captions + figure-model captions), subsections included. */
  legends: number;
  /** Table-cell words, subsections included. */
  tables: number;
}

export interface WordBudget {
  abstract: number;
  abstractFrom: "front-matter" | "section" | "preamble" | "none";
  main: number;
  methods: number;
  legends: number;
  /** Main-figure legend words: figure-embed captions outside Extended Data /
   *  supplementary sections (no table captions, no figure-div text). */
  mainLegends: number;
  /** The longest figure legend (per-legend limits are what venues set). */
  longestLegend: { label: string; words: number } | null;
  tables: number;
  other: number;
  /** Every counted body word except headings: prose + legends + tables. */
  total: number;
  preamble: SectionCount;
  sections: SectionCount[];
}

/** Per-heading counts over an analysis. A section runs to the next heading of
 *  the same or a higher level, so counts nest like the outline. */
export function sectionCounts(a: WordAnalysis, aliases: RoleAliases = JOURNAL_ROLE_ALIASES): { preamble: SectionCount; sections: SectionCount[] } {
  const hs = a.headings;
  const end = a.length;
  const preEnd = hs.length ? hs[0].from : end;
  const pk = countKinds(a, a.bodyStart, preEnd);
  const preamble: SectionCount = {
    heading: "",
    level: 0,
    from: 0,
    to: preEnd,
    role: "abstract",
    top: true,
    words: pk.prose,
    own: pk.prose,
    legends: pk.legend + externalLegendWords(a, 0, preEnd),
    tables: pk.table,
  };
  const topLevel = hs.some((h) => h.level === 1) ? 1 : hs.reduce((m, h) => Math.min(m, h.level), 7);
  const sections: SectionCount[] = [];
  let role = "body";
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    let j = i + 1;
    while (j < hs.length && hs[j].level > h.level) j++;
    const to = j < hs.length ? hs[j].from : end;
    const ownTo = i + 1 < hs.length ? hs[i + 1].from : end;
    const top = h.level <= topLevel;
    if (top) role = (aliases[normalizeHeading(h.text)] as string | undefined) ?? "body";
    const k = countKinds(a, h.lineEnd, to);
    sections.push({
      heading: h.text,
      level: h.level,
      from: h.from,
      to,
      role,
      top,
      words: k.prose,
      own: countKinds(a, h.lineEnd, ownTo).prose,
      legends: k.legend + externalLegendWords(a, h.from, to),
      tables: k.table,
    });
  }
  return { preamble, sections };
}

/** The venue's buckets for one analysed manuscript. */
export function wordBudget(a: WordAnalysis, rules: CountRules = HOUSE_COUNT_RULES): WordBudget {
  const { preamble, sections } = sectionCounts(a, rules.aliases);
  const tops = sections.filter((s) => s.top);
  const sum = (xs: SectionCount[], f: (s: SectionCount) => number) => xs.reduce((n, s) => n + f(s), 0);
  // The lead: everything before the first TOP-level heading (the assembler's
  // preamble — a stray H2 above the first H1 belongs to it).
  const firstTop = tops.length ? tops[0].from : a.length;
  const lk = countKinds(a, a.bodyStart, firstTop);
  const lead = { words: lk.prose, legends: lk.legend + externalLegendWords(a, 0, firstTop), tables: lk.table };
  const absSections = tops.filter((s) => s.role === "abstract");
  let abstract = 0;
  let abstractFrom: WordBudget["abstractFrom"] = "none";
  if (a.fmAbstract != null && a.fmAbstract > 0) {
    abstract = a.fmAbstract;
    abstractFrom = "front-matter";
  } else if (absSections.length && sum(absSections, (s) => s.words) > 0) {
    abstract = sum(absSections, (s) => s.words);
    abstractFrom = "section";
  } else if (lead.words > 0) {
    abstract = lead.words;
    abstractFrom = "preamble";
  }
  const mainSecs = tops.filter((s) => MAIN_TEXT_ROLES.includes(s.role));
  const legends = lead.legends + sum(tops, (s) => s.legends);
  // Main-figure legends (Cell's main text counts them): figure-embed captions
  // outside Extended Data / supplementary sections — as the assembler counts
  // its figure-family legends. Table captions and figure-div text are not.
  const suppSpans = tops.filter((s) => SUPPLEMENTARY_ROLES.includes(s.role));
  let mainLegends = 0;
  for (const l of a.legendItems) {
    if (!l.label.startsWith("fig-")) continue;
    if (suppSpans.some((s) => l.at >= s.from && l.at < s.to)) continue;
    mainLegends += l.words;
  }
  let main = sum(mainSecs, (s) => s.words);
  if (rules.mainIncludesAbstract) main += abstract;
  if (rules.mainIncludesLegends) main += mainLegends;
  const methods = sum(tops.filter((s) => s.role === "methods"), (s) => s.words);
  let longestLegend: WordBudget["longestLegend"] = null;
  for (const l of a.legendItems) {
    if (l.label.startsWith("tbl-")) continue;
    if (!longestLegend || l.words > longestLegend.words) longestLegend = { label: l.label, words: l.words };
  }
  const tables = lead.tables + sum(tops, (s) => s.tables);
  const prose = lead.words + sum(tops, (s) => s.words);
  // Prose outside abstract / main / Methods (back matter, an un-abstracted preamble).
  const counted = sum(mainSecs, (s) => s.words) + methods + (abstractFrom === "front-matter" ? 0 : abstract);
  return {
    abstract,
    abstractFrom,
    main,
    methods,
    legends,
    mainLegends,
    longestLegend,
    tables,
    other: Math.max(0, prose - counted),
    total: prose + legends + tables,
    preamble,
    sections,
  };
}

/** One-call convenience: the main-text words of a manuscript under `rules`
 *  (the number the status bar and flux-connect's document list show). */
export function mainTextWords(src: string, rules: CountRules = HOUSE_COUNT_RULES, opts?: AnalyzeOptions): number {
  return wordBudget(analyzeWords(src, opts), rules).main;
}
