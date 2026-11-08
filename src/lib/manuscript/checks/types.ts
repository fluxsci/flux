// Manuscript Check — the shared contract (twin-engine core, guide §2).
//
// Deterministic, no-LLM checks a scientist wants before a paper goes out: one
// platform (checks/index.ts), several rule packs (one file each). The Paper
// margin pane (Alt+K) and flux-core's `check_manuscript` verb (`flux check`)
// both call `checkManuscript` with plain inputs; neither re-implements a rule.
//
// Pure: no Svelte, no DOM, no Node.

export type CheckSeverity = "error" | "warn" | "info";

/** Rule packs, in display order. */
export const CHECK_PACKS = ["references", "display", "placeholders", "abbreviations", "consistency", "comments"] as const;
export type CheckPackId = (typeof CHECK_PACKS)[number];

export const PACK_TITLES: Record<CheckPackId, string> = {
  references: "References & citations",
  display: "Figures & tables",
  placeholders: "Placeholders",
  abbreviations: "Abbreviations",
  consistency: "Consistent terms",
  comments: "Comments",
};

/** One exact text edit. `expect` is the text the range held when the check
 *  ran: an engine applies the fix only when every range still holds it. */
export interface CheckEdit {
  from: number;
  to: number;
  insert: string;
  expect: string;
}

/** A safe one-click fix — offered only where the right edit is unambiguous. */
export interface CheckFix {
  label: string;
  edits: CheckEdit[];
}

export interface CheckFinding {
  /** Stable id ("ref.undefined-crossref") — gates and UI key on it. */
  ruleId: string;
  pack: CheckPackId;
  severity: CheckSeverity;
  /** One sentence, user register. */
  message: string;
  /** Project-relative document path ("" for an unsaved demo document). */
  doc: string;
  /** Character range in the document text, when the finding has a place. */
  from?: number;
  to?: number;
  /** 1-based line / column of `from` (derived; for CLI output and agents). */
  line?: number;
  col?: number;
  /** The offending text, for display. */
  excerpt?: string;
  fix?: CheckFix;
}

/** A figure as both engines know it: identity from the Figure model, never
 *  re-derived from embed order. */
export interface CheckFigure {
  /** Reference label, "fig-growth" (with the fig- prefix). */
  label: string;
  /** Family id ("figure", "supplementary", "extended", custom…). */
  family: string;
  /** Number within the family. */
  number: number;
  /** In-text display, "Fig. 2" / "Fig. S4" (figfamily's template). */
  display: string;
  /** Composed caption markdown (the model's legend). */
  caption: string;
  /** Ordered panel letters; [] when the figure has none. */
  panels: string[];
}

/** The bibliography fields the checks read (a projection of RefEntry). */
export interface CheckBibEntry {
  key: string;
  /** BibTeX entry type, lowercase ("article", "book"…); "" when unknown. */
  type: string;
  title: string;
  authors: string[];
  year: string;
  container?: string;
  doi?: string;
}

/** An open-or-resolved margin comment thread, with its range resolved in
 *  `text` (see checks/comments.ts `commentInputs`). */
export interface CheckComment {
  id: string;
  resolved: boolean;
  quote: string;
  from?: number;
  to?: number;
}

export interface CheckInput {
  /** Project-relative document path, carried into every finding. */
  doc: string;
  /** The document's own source text (includes are not expanded). */
  text: string;
  figures: readonly CheckFigure[];
  /** The project bibliography (references/library.bib). */
  bib: readonly CheckBibEntry[];
  comments?: readonly CheckComment[];
  /** Restrict to these packs (default: all). */
  packs?: readonly CheckPackId[];
}

export interface CheckResult {
  doc: string;
  findings: CheckFinding[];
  counts: Record<CheckSeverity, number>;
}
