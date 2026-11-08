// Journal styles — the pure descriptor + resolution core.
//
// A JournalStyle says how a manuscript should look WHEN EXPORTED for a given
// venue: how figure and panel references read, how citations are marked, how
// reference entries are built, what the section order is, and what the venue's
// advisory limits are.
//
// THE GOVERNING RULE: a journal style is EXPORT-ONLY. The Flux writer keeps its
// own conventions no matter which journal is selected — chips, figure refs and
// caption leads in the editor never restyle. Only the exported file and the
// preview (which exists to prove the export) follow the style. Numbering and
// (family, number) identity stay computed by the shared cores either way, so
// the editor and the output can differ in PRESENTATION without ever disagreeing
// about WHICH figure or WHICH reference something is. Pinned by
// scripts/verify-writer-neutral.ts.
//
// Descriptors are SPARSE: every field is optional and falls through to
// DEFAULT_JOURNAL_STYLE, which reproduces today's export byte-for-byte (pinned
// by verify-journalstyle's identity leg). Most journals differ from each other
// in a handful of fields, so `extends` lets one build on another.
//
// Twin-engine shared core (flux-core → src/lib): no Svelte, no DOM, no Node.

import { familyById, type FigureFamilyDef } from "../figfamily";

export const JOURNAL_STYLE_SCHEMA_VERSION = "0.1.0";

/** How a panel reference is phrased around the figure number.
 *   attached — Nature: "Fig. 1a", "Fig. 1a,b", "Fig. 1a–c" (one noun, letters glued on)
 *   science  — Science: "Fig. 1A", "Fig. 1, A and B", "Fig. 1, A to C", "Fig. 1, A, C, and E"
 *   cell     — Cell: "Figure 1A", "Figures 1A and 1B", "Figures 1A–1C" (number repeated,
 *              noun pluralised whenever more than one panel is named) */
export type PanelGrammar = "attached" | "science" | "cell";

/** How a panel suffix renders: "a", "a,b", "a–c", "(A)". */
export interface PanelStyle {
  /** Phrasing around the number (see PanelGrammar). Absent = "attached". */
  grammar?: PanelGrammar;
  /** Science: a paragraph that OPENS with a figure reference spells it out
   *  ("Figure 1 shows…"). Absent = "keep". */
  paragraphInitial?: "keep" | "spell-out";
  /** Panel letters as authored are lowercase; some venues print them capital. */
  letterCase: "lower" | "upper";
  /** Bare letter, or parenthesised as "(a)". */
  wrap: "none" | "parens";
  /** Between listed panels. Nature 2022+: ","  ·  Nature Comms: ", ". */
  listSeparator: string;
  /** Between the ends of a run: an en dash everywhere we have measured. */
  rangeSeparator: string;
  /** Consecutive letters collapse to a range at this length or more. */
  collapseRunsOfAtLeast: number;
}

export interface FigureStyleSpec {
  panels: PanelStyle;
  /** family id → sparse override of the resolved FigureFamilyDef. This is how
   *  a venue renames a family for EXPORT ("Supplementary Fig. 1" rather than
   *  Flux's house "Fig. S1") without touching project data. */
  familyOverrides: Record<string, Partial<FigureFamilyDef>>;
}

export interface CiteNumericSpec {
  /** "[1,2]" · "^1,2^" (superscript) · "(1, 2)" · Science's "(*1*, *2*)" — italic
   *  numerals inside roman parentheses. */
  presentation: "brackets" | "superscript" | "parens" | "parens-italic";
  /** Between separate ordinals. Nature: "," with no space. */
  separator: string;
  rangeSeparator: string;
  collapseRunsOfAtLeast: number;
  /** Nature puts the mark BEFORE the full stop; AMA-style venues after it.
   *  "keep" makes no change, which is what the house style does. */
  placement: "keep" | "before-punctuation" | "after-punctuation";
}

export interface CiteSpec {
  /** "inherit" defers to the document's own `citation-style:` front matter. */
  mode: "inherit" | "numeric" | "author-year";
  numeric: CiteNumericSpec;
}

export interface RefListSpec {
  /** "default" = Flux's existing two-style formatter, untouched (so the
   *  no-style path stays byte-identical). "nature" / "science" / "cell" = that
   *  journal's submission entry form (style/journalRefs.ts). */
  layout: "default" | "nature" | "science" | "cell";
  /** ≤ authorMax names are all listed; beyond it, keep `etAlKeep` then et al. */
  authorMax: number;
  etAlKeep: number;
  /** Joins the final author when the whole list is printed. */
  finalJoin: string;
  journalAbbrev: boolean;
  heading: string;
}

export interface StructureSpec {
  /** Ordered section roles for the exported document (Phase D). */
  order: string[];
  /** Roles this venue does not print as headings (Nature: Introduction/Results). */
  forbiddenHeadings: string[];
  /** Methods references continue the main numbering in a second list. */
  referenceListSplit: "single" | "main-plus-methods";
}

export interface LimitsSpec {
  titleChars?: number;
  subheadChars?: number;
  abstractWords?: number;
  abstractWordsHard?: number;
  mainTextWords?: number;
  methodsWords?: number;
  legendWords?: number;
  legendWordsHard?: number;
  mainRefs?: number;
  displayItems?: number;
  extendedDataItems?: number;
  /** Extended Data / supplementary legend ceiling (Nature: 1,000). */
  extendedLegendWords?: number;
  /** Cell Highlights: count range and per-bullet characters. */
  highlightsMin?: number;
  highlightsMax?: number;
  highlightChars?: number;
  /** Cell eTOC ("In brief") blurb words. */
  etocWords?: number;
  keywordsMax?: number;
  /** Science one-sentence summary characters. */
  oneSentenceSummaryChars?: number;
}

export interface DocFormatSpec {
  lineSpacing?: number;
  fontFamily?: string;
  fontSizePt?: number;
  lineNumbers?: boolean;
  /** Number every Nth line (Science's template counts by 5). Absent = 1. */
  lineNumberCountBy?: number;
  paperSize?: "letter" | "a4";
  /** Page margins in inches. */
  marginsIn?: { top: number; right: number; bottom: number; left: number };
  pageNumbers?: boolean;
  /** Body paragraphs indent their first line (Science's template: 0.5 in). */
  firstLineIndentIn?: number;
  /** Running header text (Science's template: "Submitted Manuscript: Confidential"). */
  headerText?: string;
}

/** Where a figure's image and legend go for one submission stage. */
export type FigurePlacement = "inline" | "legends-only";

/** How a figure legend is set. */
export interface LegendSpec {
  /** First sentence of the caption is the bold legend title. */
  boldTitle: boolean;
  /** Cell prints the title WITHOUT a final full stop. */
  titlePeriod: "keep" | "strip";
  /** Panel descriptors: Nature "**a**, text" · Science "(**A**) text" · Cell "(A) text", one per line. */
  panels: "letter-comma" | "parens-bold" | "parens-lines";
  /** Cell closes main legends with "See also Figure S…" when it can. */
  seeAlso?: boolean;
}

/**
 * Journal manuscript assembly — what turns an authored Flux manuscript into the
 * venue's SUBMISSION document (title page, section order and names, legends,
 * references). Present only on journal styles; the house style has none, so the
 * assembler never runs for it and today's export stays byte-identical.
 * Implemented by style/journalManuscript.ts.
 */
export interface ManuscriptSpec {
  /** "literal": Flux numbers and formats every citation and writes the reference
   *  list itself (journalCitations/journalRefs) — needed for split lists,
   *  punctuation placement and Science notes. "citeproc": leave citations to
   *  pandoc with the document's own CSL (bioRxiv has no reference style). */
  citations: "literal" | "citeproc";
  titleBlock: "nature" | "science" | "cell" | "preprint";
  /** Where the abstract goes and how it is introduced. heading null = no heading. */
  abstract: { heading: string | null; label?: string; bold?: boolean };
  /** Level-1 heading case in the output. */
  headingCase: "as-is" | "upper";
  /** Roles whose HEADING is removed (content kept) — Nature prints no Introduction/Results heading. */
  dropHeadings: string[];
  /** Printed heading per role. */
  renameHeadings: Record<string, string>;
  /** Roles folded into one parent as run-in paragraphs (Science's Acknowledgments). */
  runIn?: { parent: string; heading: string; children: { role: string; label: string }[] };
  /** Science's "Main Text:" label before the body. */
  mainTextLabel?: string;
  /** Section order for the assembled document (roles; "body" = unrecognised sections). */
  order: string[];
  referencesHeading: string;
  /** Second list for references first cited after the main text (Nature's Methods references). */
  splitReferences?: { afterRole: string; heading: string | null };
  legendsHeading: string;
  legend: LegendSpec;
  figures: { initial: FigurePlacement; final: FigurePlacement };
  /** Footnotes: keep them, or turn them into numbered notes in the reference list (Science). */
  footnotes: "keep" | "notes-in-references";
  /** Word custom-style names the assembler tags blocks with (Science uses its template's names). */
  docxStyles?: Partial<Record<DocxStyleRole, string>>;
  /** Roles a submission must contain (reported, never fabricated). */
  required: { role: string; label: string; stage: "initial" | "final" }[];
  /** Front-matter items the venue asks for (reported when missing). */
  frontMatterItems?: ("highlights" | "etoc" | "keywords" | "one-sentence-summary" | "lead-contact")[];
  /** What the author still has to do outside Flux, listed in the export summary. */
  outsideFlux: string[];
  /** Figure-file guidance for the summary (widths, formats). */
  figureGuidance: string[];
}

export type DocxStyleRole =
  | "title"
  | "authors"
  | "affiliation"
  | "correspondence"
  | "abstract"
  | "teaser"
  | "label"
  | "bibliography"
  | "bibheading"
  | "acknowledgement"
  | "figure"
  | "legend"
  | "highlights";

/** The sparse, authored form. */
export interface JournalStyle {
  id: string;
  name: string;
  schemaVersion?: string;
  /** Builtin id this descriptor layers over (one level, builtins only). */
  extends?: string;
  blurb?: string;
  /** Formats this style can produce; omitted means all of them. */
  formats?: readonly ("pdf" | "docx" | "html")[];
  // Spelled out rather than `Partial<Spec> & {…}`: an intersection would make
  // `panels` require the FULL PanelStyle, defeating the point of sparseness.
  figures?: {
    panels?: Partial<PanelStyle>;
    familyOverrides?: Record<string, Partial<FigureFamilyDef>>;
  };
  citations?: { mode?: CiteSpec["mode"]; numeric?: Partial<CiteNumericSpec> };
  referenceList?: Partial<RefListSpec>;
  structure?: Partial<StructureSpec>;
  limits?: LimitsSpec;
  document?: DocFormatSpec;
  /** Journal manuscript assembly (journal styles only; sparse merge per key). */
  manuscript?: Partial<ManuscriptSpec>;
  /** Project-relative CSL file for the Quarto path (pandoc renders citations). */
  csl?: string;
  /** Which SHIPPED asset set this style uses (resources/csl/<key>.csl,
   *  resources/docx/<key>-reference.docx). Defaults to the style's own id, but
   *  INHERITS through `extends` — so a portfolio sibling reuses its parent's
   *  CSL and Word template instead of demanding files that do not ship. */
  assetKey?: string;
  /** Key into figure/journalSizing.ts JOURNAL_PRESETS — composed, not copied. */
  sizingFamily?: string;
}

/** The fully-merged form every consumer reads. */
export interface ResolvedJournalStyle {
  id: string;
  name: string;
  blurb: string;
  formats: readonly ("pdf" | "docx" | "html")[];
  figures: FigureStyleSpec;
  citations: CiteSpec;
  referenceList: RefListSpec;
  structure: StructureSpec;
  limits: LimitsSpec;
  document: DocFormatSpec;
  /** Absent on the house style — the assembler only runs for journal styles. */
  manuscript?: ManuscriptSpec;
  csl?: string;
  assetKey?: string;
  sizingFamily?: string;
}

/** House style — reproduces today's export exactly. Every absent field in a
 *  sparse descriptor lands here, so "no journal style" is a real no-op. */
export const DEFAULT_JOURNAL_STYLE: ResolvedJournalStyle = {
  id: "flux",
  name: "Flux house style",
  blurb: "The default manuscript look.",
  formats: ["pdf", "docx", "html"],
  figures: {
    panels: {
      letterCase: "lower",
      wrap: "none",
      listSeparator: ",",
      rangeSeparator: "–",
      collapseRunsOfAtLeast: 3,
    },
    familyOverrides: {},
  },
  citations: {
    mode: "inherit",
    numeric: {
      presentation: "brackets",
      separator: ",",
      rangeSeparator: "–",
      collapseRunsOfAtLeast: 3,
      placement: "keep",
    },
  },
  referenceList: {
    layout: "default",
    authorMax: 20,
    etAlKeep: 20,
    finalJoin: ", & ",
    journalAbbrev: false,
    heading: "References",
  },
  structure: { order: [], forbiddenHeadings: [], referenceListSplit: "single" },
  limits: {},
  document: {},
};

/** Merge a sparse descriptor over a resolved base. One level deep per section,
 *  which is all the shape needs — no field is itself a nested object except
 *  familyOverrides, which merges per family id. */
function mergeStyle(base: ResolvedJournalStyle, s: JournalStyle): ResolvedJournalStyle {
  return {
    id: s.id,
    name: s.name,
    blurb: s.blurb ?? base.blurb,
    formats: s.formats ?? base.formats,
    figures: {
      panels: { ...base.figures.panels, ...(s.figures?.panels ?? {}) },
      familyOverrides: {
        ...base.figures.familyOverrides,
        ...(s.figures?.familyOverrides ?? {}),
      },
    },
    citations: {
      mode: s.citations?.mode ?? base.citations.mode,
      numeric: { ...base.citations.numeric, ...(s.citations?.numeric ?? {}) },
    },
    referenceList: { ...base.referenceList, ...(s.referenceList ?? {}) },
    structure: { ...base.structure, ...(s.structure ?? {}) },
    limits: { ...base.limits, ...(s.limits ?? {}) },
    document: { ...base.document, ...(s.document ?? {}) },
    manuscript: s.manuscript
      ? ({ ...(base.manuscript ?? {}), ...s.manuscript } as ManuscriptSpec)
      : base.manuscript,
    csl: s.csl ?? base.csl,
    // Own key → parent's key → own id. The middle step is what lets
    // nature-communications ship no assets of its own.
    assetKey: s.assetKey ?? base.assetKey ?? s.id,
    sizingFamily: s.sizingFamily ?? base.sizingFamily,
  };
}

/**
 * Resolve a style id to its fully-merged form. Unknown ids, absent ids and a
 * null pointer all degrade to the house style rather than throwing — the same
 * philosophy as `familyById`, because a project naming a style Flux no longer
 * ships must still open and export.
 */
export function resolveJournalStyle(
  id: string | null | undefined,
  available: readonly JournalStyle[] = [],
): ResolvedJournalStyle {
  if (!id || id === DEFAULT_JOURNAL_STYLE.id) return DEFAULT_JOURNAL_STYLE;
  const found = available.find((s) => s.id === id);
  if (!found) return DEFAULT_JOURNAL_STYLE;
  const base =
    found.extends && found.extends !== found.id
      ? resolveJournalStyle(found.extends, available.filter((s) => s.id !== found.id))
      : DEFAULT_JOURNAL_STYLE;
  return mergeStyle(base, found);
}

/**
 * Apply a style's family overrides to a resolved family definition.
 *
 * This is the ONE seam that gives the export a venue's figure wording. It is a
 * pure wrapper rather than a change to `familyMap`, which deliberately refuses
 * to let project data shadow builtin families — that invariant stays intact;
 * only an export style may override, and only for the duration of a render.
 * Returns the input object unchanged when nothing applies, so the no-style path
 * allocates nothing.
 */
export function styledFamilyDef(
  style: ResolvedJournalStyle | null | undefined,
  def: FigureFamilyDef,
): FigureFamilyDef {
  const o = style?.figures.familyOverrides?.[def.id];
  if (!o) return def;
  return { ...def, ...o, id: def.id };
}

/** Resolve a family id and apply the style's overrides in one step. */
export function styledFamilyById(
  style: ResolvedJournalStyle | null | undefined,
  id: string | undefined | null,
  custom?: readonly FigureFamilyDef[] | null,
): FigureFamilyDef {
  return styledFamilyDef(style, familyById(id, custom));
}

/**
 * Render a panel spec under a style. Input is the authored source grammar
 * (`a`, `a-c`, `a,b`, `a-c,e`); output is the venue's printed form.
 *
 * Panels may carry a sub-number (`b1`, `c12`) for multi-part figures whose panel b
 * is itself b1..b5. Sub-numbered ranges are within one letter (`b1-b5`); a range
 * crossing letters (`b1-c2`) has no well-defined member list and passes through.
 *
 * Runs are re-derived rather than trusted: an author may write `a,b,c` where a
 * venue prints `a–c`, and the collapse threshold is per-style.
 */
/** One panel: a letter, plus an OPTIONAL sub-number (`a`, `b1`, `c12`).
 *  `sub` is null for a bare letter — distinct from 0, which is a legitimate sub-number. */
interface PanelAtom {
  letter: string;
  sub: number | null;
}

const PANEL_ATOM_RE = /^([A-Za-z])(\d*)$/;

function parsePanelAtom(s: string): PanelAtom | null {
  const m = PANEL_ATOM_RE.exec(s);
  if (!m) return null;
  return { letter: m[1], sub: m[2] === "" ? null : Number(m[2]) };
}

/** Successor within a run: b1→b2 within a letter, or a→b across bare letters.
 *  A bare letter and a sub-numbered one are never adjacent — `a` then `b1` starts a new run,
 *  because "a–b1" is not a range any venue prints. */
function isPanelSuccessor(prev: PanelAtom, next: PanelAtom): boolean {
  if (prev.sub === null && next.sub === null) {
    return next.letter.charCodeAt(0) === prev.letter.charCodeAt(0) + 1;
  }
  if (prev.sub !== null && next.sub !== null) {
    return next.letter === prev.letter && next.sub === prev.sub + 1;
  }
  return false;
}

function renderPanelAtom(a: PanelAtom, p: PanelStyle): string {
  const letter = p.letterCase === "upper" ? a.letter.toUpperCase() : a.letter.toLowerCase();
  return a.sub === null ? letter : `${letter}${a.sub}`;
}

export function formatPanelSpec(spec: string, p: PanelStyle): string {
  const atoms: PanelAtom[] = [];
  for (const part of spec.split(",")) {
    const t = part.trim();
    const dash = t.indexOf("-");
    if (dash < 0) {
      const a = parsePanelAtom(t);
      if (!a) return spec; // not the grammar we know — pass through untouched
      atoms.push(a);
      continue;
    }
    // Expand an authored range so re-collapsing is uniform.
    const from = parsePanelAtom(t.slice(0, dash));
    const to = parsePanelAtom(t.slice(dash + 1));
    if (!from || !to) return spec;
    if (from.sub === null && to.sub === null) {
      const f = from.letter.charCodeAt(0);
      const l = to.letter.charCodeAt(0);
      if (l < f) return spec;
      for (let c = f; c <= l; c++) atoms.push({ letter: String.fromCharCode(c), sub: null });
    } else if (from.sub !== null && to.sub !== null && from.letter === to.letter) {
      // A sub-numbered range lives inside ONE panel letter: b1-b5. A range that crosses
      // letters (b1-c2) has no well-defined member list — how many sub-panels has b? — so
      // it is passed through rather than guessed at.
      if (to.sub < from.sub) return spec;
      for (let n = from.sub; n <= to.sub; n++) atoms.push({ letter: from.letter, sub: n });
    } else {
      return spec;
    }
  }
  if (!atoms.length) return spec;

  // Group consecutive panels, then print runs at/above the threshold as ranges.
  const groups: PanelAtom[][] = [];
  for (const a of atoms) {
    const last = groups[groups.length - 1];
    if (last && isPanelSuccessor(last[last.length - 1], a)) last.push(a);
    else groups.push([a]);
  }
  const parts = groups.flatMap((g) =>
    g.length >= p.collapseRunsOfAtLeast
      ? [
          `${renderPanelAtom(g[0], p)}${p.rangeSeparator}${renderPanelAtom(g[g.length - 1], p)}`,
        ]
      : g.map((a) => renderPanelAtom(a, p)),
  );
  const joined = parts.join(p.listSeparator);
  return p.wrap === "parens" ? `(${joined})` : joined;
}

/** Expand an authored panel spec into its atoms, or null when it is not the
 *  grammar we know (the caller then passes the spec through untouched). */
function panelAtoms(spec: string): PanelAtom[] | null {
  const atoms: PanelAtom[] = [];
  for (const part of spec.split(",")) {
    const t = part.trim();
    const dash = t.indexOf("-");
    if (dash < 0) {
      const a = parsePanelAtom(t);
      if (!a) return null;
      atoms.push(a);
      continue;
    }
    const from = parsePanelAtom(t.slice(0, dash));
    const to = parsePanelAtom(t.slice(dash + 1));
    if (!from || !to) return null;
    if (from.sub === null && to.sub === null) {
      const f = from.letter.charCodeAt(0);
      const l = to.letter.charCodeAt(0);
      if (l < f) return null;
      for (let c = f; c <= l; c++) atoms.push({ letter: String.fromCharCode(c), sub: null });
    } else if (from.sub !== null && to.sub !== null && from.letter === to.letter && to.sub >= from.sub) {
      for (let n = from.sub; n <= to.sub; n++) atoms.push({ letter: from.letter, sub: n });
    } else return null;
  }
  return atoms.length ? atoms : null;
}

function panelRuns(atoms: PanelAtom[]): PanelAtom[][] {
  const groups: PanelAtom[][] = [];
  for (const a of atoms) {
    const last = groups[groups.length - 1];
    if (last && isPanelSuccessor(last[last.length - 1], a)) last.push(a);
    else groups.push([a]);
  }
  return groups;
}

/** "A", "A and B", "A, C, and E" — the serial-comma English list both
 *  Science and Cell print. */
function englishList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** "Fig." → "Figs.", "Figure" → "Figures", "Extended Data Fig." → "Extended Data Figs." */
export function pluralizeFigureNoun(noun: string): string {
  return noun.replace(/(fig(?:ure)?)(\.?)(\s*)$/i, (_m, w: string, dot: string, ws: string) => `${w}s${dot}${ws}`);
}

/**
 * A complete figure reference in the venue's grammar: noun, number and panels.
 * `attached` reproduces formatFamilyRef + formatPanelSpec exactly (Nature and the
 * house style). `science` and `cell` need the whole phrase, because the panel
 * part changes the noun (Cell pluralises) or inserts its own punctuation
 * (Science's "Fig. 1, A to C"). An unparseable spec passes through verbatim.
 */
export function formatStyledFigureRef(
  def: FigureFamilyDef,
  num: number,
  spec: string,
  p: PanelStyle,
): string {
  const grammar = p.grammar ?? "attached";
  let tpl = def.refTemplate;
  if (!tpl.includes("{num}")) tpl = `${tpl.trimEnd()} {num}`;
  if (!tpl.includes("{panel}")) tpl = `${tpl}{panel}`;
  const plain = (panel: string) => tpl.replaceAll("{num}", String(num)).replaceAll("{panel}", panel);
  if (!spec) return plain("");
  if (grammar === "attached") return plain(formatPanelSpec(spec, p));
  const atoms = panelAtoms(spec);
  if (!atoms) return plain(spec);
  const letter = (a: PanelAtom) => renderPanelAtom(a, p);
  const runs = panelRuns(atoms);
  if (grammar === "science") {
    if (atoms.length === 1) return plain(letter(atoms[0]));
    const items = runs.flatMap((g) =>
      g.length >= p.collapseRunsOfAtLeast ? [`${letter(g[0])} to ${letter(g[g.length - 1])}`] : g.map(letter),
    );
    return plain(`, ${englishList(items)}`);
  }
  // cell — the number is repeated on every panel and the noun pluralises.
  const at = tpl.indexOf("{num}");
  const head = tpl.slice(0, at);
  const sp = head.lastIndexOf(" ");
  const noun = sp >= 0 ? head.slice(0, sp) : head;
  const numPrefix = sp >= 0 ? head.slice(sp + 1) : "";
  const tail = tpl.slice(at + "{num}".length).replace("{panel}", "");
  const id = (a: PanelAtom) => `${numPrefix}${num}${letter(a)}`;
  if (atoms.length === 1) return `${noun} ${id(atoms[0])}${tail}`;
  const items = runs.flatMap((g) =>
    g.length >= p.collapseRunsOfAtLeast ? [`${id(g[0])}${p.rangeSeparator}${id(g[g.length - 1])}`] : g.map(id),
  );
  return `${pluralizeFigureNoun(noun)} ${englishList(items)}${tail}`;
}
