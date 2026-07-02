// PAP-19: the single source of truth for the Paper module's citation + cross-reference grammar.
// The editor chips (chips.ts), the render/export engine (renderManuscript.ts), the cited-keys
// scan (PaperMode.citedKeys) and the citation editor (scholar/citeOps.ts) previously each carried
// their own copy of these patterns — the origin of PAP-5/13/14-class editor↔export divergence.
// They now all draw from here so a grammar change lands everywhere at once.
//
// Each regex is exposed as a GETTER returning a FRESH /g instance: global regexes are stateful
// (lastIndex), so a single shared instance reused across modules would mis-scan. Callers keep
// their own instance (module const or local) exactly as before.

/** Citation-key char class: a letter then word / ':' / '.' / '-' chars (smith2020, doi:10.x/y). */
const KEY = "[A-Za-z][\\w:.-]*";

/** Cross-reference types that resolve to a NUMBER (fig/tbl). sec/eq are recognised as cross-refs
 *  — so they're never mistaken for citations — but carry no numbering and render verbatim. */
export const NUMBERED_CROSSREF = ["fig", "tbl"] as const;

/** `@fig-…` / `@tbl-…` cross-reference (+ an optional `,panel` list). Group 1 = the type. */
export const crossrefRe = (): RegExp => /@(fig|tbl)-[A-Za-z0-9_-]+(?:,[A-Za-z](?:-[A-Za-z])?)*/g;
/** A bracketed citation group `[@a; @b …]`. Group 1 = the inner `@…` text. */
export const bracketCiteRe = (): RegExp => /\[(@[^\]]+?)\]/g;
/** A bare `@key` outside brackets. Group 1 = the leading boundary char, group 2 = the key. */
export const bareCiteRe = (): RegExp => new RegExp(`(^|[\\s([])@(${KEY})`, "g");
/** Bracketed OR bare cite in one pass (the cited-keys scan). Group 1 = the key. */
export const anyCiteRe = (): RegExp => new RegExp(`(?:\\[@|(?:^|[\\s([])@)(${KEY})`, "g");

/** True if a key (`fig-1`, `sec-intro`, …) is a cross-reference, NOT a citation to resolve. */
export const isCrossrefKey = (k: string): boolean => /^(?:fig|tbl|sec|eq)-/.test(k);
