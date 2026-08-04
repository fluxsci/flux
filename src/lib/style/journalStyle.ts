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

/** How a panel suffix renders: "a", "a,b", "a–c", "(A)". */
export interface PanelStyle {
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
  /** "[1,2]" · "^1,2^" (superscript) · "(1, 2)". */
  presentation: "brackets" | "superscript" | "parens";
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
   *  no-style path stays byte-identical). "nature" = the Nature entry form. */
  layout: "default" | "nature";
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
}

export interface DocFormatSpec {
  lineSpacing?: number;
  fontFamily?: string;
  fontSizePt?: number;
  lineNumbers?: boolean;
}

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
  /** Project-relative CSL file for the Quarto path (pandoc renders citations). */
  csl?: string;
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
  csl?: string;
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
    csl: s.csl ?? base.csl,
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
 * Runs are re-derived rather than trusted: an author may write `a,b,c` where a
 * venue prints `a–c`, and the collapse threshold is per-style.
 */
export function formatPanelSpec(spec: string, p: PanelStyle): string {
  const letters: string[] = [];
  for (const part of spec.split(",")) {
    const m = /^([A-Za-z])(?:-([A-Za-z]))?$/.exec(part.trim());
    if (!m) return spec; // not the grammar we know — pass through untouched
    if (!m[2]) {
      letters.push(m[1]);
      continue;
    }
    // Expand an authored range so re-collapsing is uniform.
    const from = m[1].charCodeAt(0);
    const to = m[2].charCodeAt(0);
    if (to < from) return spec;
    for (let c = from; c <= to; c++) letters.push(String.fromCharCode(c));
  }
  if (!letters.length) return spec;

  const cased = letters.map((l) => (p.letterCase === "upper" ? l.toUpperCase() : l.toLowerCase()));
  // Group consecutive letters, then print runs at/above the threshold as ranges.
  const groups: string[][] = [];
  for (const l of cased) {
    const last = groups[groups.length - 1];
    if (last && l.charCodeAt(0) === last[last.length - 1].charCodeAt(0) + 1) last.push(l);
    else groups.push([l]);
  }
  const parts = groups.flatMap((g) =>
    g.length >= p.collapseRunsOfAtLeast ? [`${g[0]}${p.rangeSeparator}${g[g.length - 1]}`] : g,
  );
  const joined = parts.join(p.listSeparator);
  return p.wrap === "parens" ? `(${joined})` : joined;
}
