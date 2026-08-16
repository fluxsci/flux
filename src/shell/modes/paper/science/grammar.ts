// PAP-19: the single source of truth for the Paper module's citation + cross-reference grammar.
// The editor chips (chips.ts), the render/export engine (renderManuscript.ts), the cited-keys
// scan (PaperMode.citedKeys) and the citation editor (scholar/citeOps.ts) previously each carried
// their own copy of these patterns — the origin of PAP-5/13/14-class editor↔export divergence.
// They now all draw from here so a grammar change lands everywhere at once.
//
// Each regex is exposed as a GETTER returning a FRESH /g instance: global regexes are stateful
// (lastIndex), so a single shared instance reused across modules would mis-scan. Callers keep
// their own instance (module const or local) exactly as before.

/** Citation key: a letter, then word / ':' / '.' / '-' chars — but never ENDING in
 *  punctuation (smith2020, doi:10.x-y). Keys can contain dots, yet a trailing dot is
 *  sentence punctuation: "@smith2020." must cite smith2020, not the key "smith2020.". */
const KEY = "[A-Za-z](?:[\\w:.-]*\\w)?";

/** Cross-reference types that resolve to a NUMBER (fig/tbl/eq — eq landed with 2.1 math:
 *  labeled `$$ … $$ {#eq-id}` equations number by appearance via science/refNumbers). sec is
 *  recognised as a cross-ref — so it's never mistaken for a citation — but carries no
 *  numbering and renders verbatim. */
export const NUMBERED_CROSSREF = ["fig", "tbl", "eq"] as const;

/** `@fig-…` / `@tbl-…` / `@eq-…` cross-reference (+ an optional `,panel` list). Group 1 = the type.
 *  A panel atom is a letter with an OPTIONAL sub-number (`a`, `b1`, `c12`): a multi-part figure
 *  names its panels b1..b5 within panel b, and scholar/figText.panelSpec has always been able to
 *  emit those names. Before the sub-number was admitted here, a comma-continued `,b1` tokenized
 *  only as far as `,b` and the digit fell outside the reference. */
export const crossrefRe = (): RegExp =>
  /@(fig|tbl|eq)-[A-Za-z0-9_-]+(?:,[A-Za-z]\d*(?:-[A-Za-z]\d*)?)*/g;
/** A bracketed citation group `[@a; @b …]`. Group 1 = the inner `@…` text. */
export const bracketCiteRe = (): RegExp => /\[(@[^\]]+?)\]/g;
/** A bare `@key` outside brackets. Group 1 = the leading boundary char, group 2 = the key. */
export const bareCiteRe = (): RegExp => new RegExp(`(^|[\\s([])@(${KEY})`, "g");
/** Bracketed OR bare cite in one pass (the cited-keys scan). Group 1 = the key. */
export const anyCiteRe = (): RegExp => new RegExp(`(?:\\[@|(?:^|[\\s([])@)(${KEY})`, "g");

/** True if a key (`fig-1`, `sec-intro`, …) is a cross-reference, NOT a citation to resolve. */
export const isCrossrefKey = (k: string): boolean => /^(?:fig|tbl|sec|eq)-/.test(k);
