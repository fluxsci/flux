// Nature-style reference entries + citation marks (export/preview only).
//
// Kept BESIDE references/format.ts rather than inside it: that module's two
// hand-tuned styles are what the editor and the house export use, and they must
// stay byte-identical while a journal style is selected. This file adds a third
// form without touching either.
//
// Verified against real published entries, e.g.
//   Hanse, E., Seth, H. & Riebe, I. AMPA-silent synapses in brain development
//   and pathology. Nat. Rev. Neurosci. 14, 839–850 (2013).
//   Trachtenberg, J. T. et al. Long-term in vivo imaging of experience-dependent
//   synaptic plasticity in adult cortex. Nature 420, 788–794 (2002).
//
// Pure: no Svelte, no DOM, no Node.

import type { RefEntry } from "../references/types";
import { abbrevJournal } from "../references/journalAbbrev";
import type { CiteNumericSpec, RefListSpec } from "./journalStyle";

/** "Francis" → "F.", "Jean-Paul" → "J.-P.", "F. H. C." → "F. H. C." */
function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w
        .split("-")
        .map((p) => (p ? `${p[0].toUpperCase()}.` : ""))
        .join("-"),
    )
    .join(" ");
}

function names(e: RefEntry): { family: string; given?: string }[] {
  if (e.authorsFull?.length) return e.authorsFull;
  return (e.authors ?? []).map((family) => ({ family }));
}

/**
 * Nature journal-abbreviation exceptions. Nature says only "abbreviated
 * according to common usage" and names NO standard, so ISO-4-with-periods is
 * our choice; these are the observed forms it would otherwise get wrong.
 */
const ABBREV_EXCEPTIONS: Record<string, string> = {
  "proceedings of the national academy of sciences": "Proc. Natl Acad. Sci. USA",
  "proceedings of the national academy of sciences of the united states of america":
    "Proc. Natl Acad. Sci. USA",
};

export function natureJournal(container: string, abbreviate: boolean): string {
  const key = container.trim().toLowerCase().replace(/\.$/, "");
  if (ABBREV_EXCEPTIONS[key]) return ABBREV_EXCEPTIONS[key];
  return abbreviate ? abbrevJournal(container) : container;
}

/** The author segment: ≤max listed in full with `&` before the last; beyond
 *  that, the first author (or `etAlKeep` of them) then "et al." */
export function natureAuthors(e: RefEntry, spec: RefListSpec): string {
  const ns = names(e);
  if (!ns.length) return e.key;
  const one = (n: { family: string; given?: string }) =>
    n.given ? `${n.family}, ${initials(n.given)}` : n.family;
  if (ns.length > spec.authorMax) {
    const kept = ns.slice(0, Math.max(1, spec.etAlKeep)).map(one);
    return `${kept.join(", ")} et al.`;
  }
  const list = ns.map(one);
  if (list.length === 1) return list[0];
  const last = list.pop()!;
  // No comma before the ampersand — measured in every sampled entry.
  return `${list.join(", ")}${spec.finalJoin}${last}`;
}

/**
 * Page ranges print with an en dash. Handles ALPHANUMERIC endpoints — journals
 * that number by article rather than page use forms like `E3131-E3140`, and
 * the older "hyphen followed by a digit" rule (references/format.ts:78) leaves
 * those with a hyphen because the character after it is a letter.
 * A field that is not a two-endpoint range (a bare article number, say) is
 * returned untouched rather than guessed at.
 */
export function natureePageRange(pages: string): string {
  const s = pages.trim();
  const m = /^([A-Za-z]*\d+[A-Za-z]*)\s*(?:--|—|–|-)\s*([A-Za-z]*\d+[A-Za-z]*)$/.exec(s);
  return m ? `${m[1]}–${m[2]}` : s;
}

export interface NatureRefParts {
  authors: string;
  title: string;
  /** Journal name — the caller italicises it. */
  journal: string;
  /** Volume — the caller bolds it. */
  volume: string;
  pages: string;
  year: string;
  /** Set for preprints/datasets, where the URL IS the identifier. */
  preprintAt?: string;
  publisher?: string;
  kind: "article" | "preprint" | "book";
}

const PREPRINT_RE = /biorxiv|medrxiv|arxiv|research square|ssrn|chemrxiv|preprint/i;

/** Structured pieces of a Nature reference entry; callers decide the markup
 *  (italic journal, bold volume) for their output format. */
export function natureReferenceParts(e: RefEntry, spec: RefListSpec): NatureRefParts {
  const container = (e.container ?? "").trim();
  const isPreprint = PREPRINT_RE.test(container) || PREPRINT_RE.test(e.url ?? "");
  const isBook = !container && !!e.publisher;
  const pages = natureePageRange(e.pages ?? "");
  return {
    authors: natureAuthors(e, spec),
    title: (e.title ?? "").trim(),
    journal: container ? natureJournal(container, spec.journalAbbrev) : "",
    volume: (e.volume ?? "").trim(),
    pages,
    year: (e.year ?? "").trim(),
    preprintAt: isPreprint ? (e.doi ? `https://doi.org/${e.doi}` : e.url) : undefined,
    publisher: e.publisher?.trim(),
    kind: isPreprint ? "preprint" : isBook ? "book" : "article",
  };
}

/**
 * One plain-text Nature reference line. Ordinary journal articles carry NO DOI
 * — Nature's own examples never append one; a DOI appears only where it IS the
 * identifier (preprints, datasets).
 */
export function formatNatureReference(e: RefEntry, spec: RefListSpec): string {
  const p = natureReferenceParts(e, spec);
  const dot = (s: string) => (s.endsWith(".") ? s : `${s}.`);
  const head = `${dot(p.authors)} ${p.title ? dot(p.title) : ""}`.trim();
  if (p.kind === "preprint") {
    return `${head} Preprint at ${p.preprintAt ?? ""} (${p.year}).`.replace(/\s+/g, " ").trim();
  }
  if (p.kind === "book") {
    return `${dot(p.authors)} ${p.title} (${[p.publisher, p.year].filter(Boolean).join(", ")}).`
      .replace(/\s+/g, " ")
      .trim();
  }
  const locator = [p.volume, p.pages].filter(Boolean).join(", ");
  return `${head} ${p.journal}${locator ? ` ${locator}` : ""} (${p.year}).`
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapse ordinals to printed segments: [1,2,3,5] → ["1–3","5"]. */
export function collapseCiteOrdinals(nums: number[], spec: CiteNumericSpec): string[] {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const runLength = j - i + 1;
    if (runLength >= spec.collapseRunsOfAtLeast) {
      out.push(`${sorted[i]}${spec.rangeSeparator}${sorted[j]}`);
      i = j + 1;
    } else {
      out.push(String(sorted[i]));
      i++;
    }
  }
  return out;
}

/** The printed citation mark for a group of ordinals, e.g. "1,12–14". The
 *  caller wraps it (superscript, brackets, parens) per `presentation`. */
export function formatCiteMark(nums: number[], spec: CiteNumericSpec): string {
  return collapseCiteOrdinals(nums, spec).join(spec.separator);
}
