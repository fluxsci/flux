// Numeric (Vancouver) citation support — the shared pure core. One module
// computes appearance-order ordinals and collapses them to display segments
// ("[3,5,9–14]"), consumed by BOTH the live editor (science/citeNumbers.ts →
// chip labels, margin badges) and the renderer/export (renderManuscript.ts),
// so what you see while writing is exactly what ships. The manuscript's
// front matter picks the style (`citation-style: numeric | author-year`);
// anything else — including absence — is author-year (back-compat).
//
// Source vs display: the document keeps the author's key order untouched;
// numeric DISPLAY is always sorted-collapsed (Vancouver convention).

import { frontMatterField } from "../frontmatter";
// The citation scanner + ordinals are the shared pure core (twin-engine rule):
// flux-core's compile summary and Manuscript Check read the same scan.
export { buildCitationOrdinals, type OrdinalScan } from "../../../../lib/manuscript/citations";

export type CitationStyle = "author-year" | "numeric";

export function parseCitationStyle(v: unknown): CitationStyle {
  return v === "numeric" ? "numeric" : "author-year";
}

/** Extract citation-style from a raw .qmd's YAML front matter (cheap regex —
 *  this runs per keystroke on the editor side; no yaml lib). */
export function citationStyleOf(src: string): CitationStyle {
  // WS-4.1: single-source front-matter extraction (frontmatter.ts).
  return parseCitationStyle(frontMatterField(src, "citation-style"));
}

export interface NumericSegment {
  /** Display text: "3" | "3,4" is two segments | "9–14" (en dash, ≥3 run). */
  text: string;
  /** Member ordinals, ascending (the renderer links each segment via its first). */
  ordinals: number[];
}

/** Sort + dedupe, collapse runs of ≥3 consecutive ordinals to "a–b" (en dash,
 *  matching the figure-panel precedent in figures.ts); pairs stay "a,b". */
export function collapseOrdinals(nums: number[]): NumericSegment[] {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const segs: NumericSegment[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const run = sorted.slice(i, j + 1);
    if (run.length >= 3) {
      segs.push({ text: `${run[0]}–${run[run.length - 1]}`, ordinals: run });
    } else {
      for (const n of run) segs.push({ text: String(n), ordinals: [n] });
    }
    i = j + 1;
  }
  return segs;
}

/** Chip/inline label for a key group: "[3,5,9–14]" (+ ",?" per unresolved key). */
export function formatNumericLabel(
  keys: string[],
  ordinal: (k: string) => number | undefined,
): { text: string; allResolved: boolean; anyResolved: boolean } {
  const nums: number[] = [];
  let unresolved = 0;
  for (const k of keys) {
    const n = ordinal(k);
    if (n === undefined) unresolved++;
    else nums.push(n);
  }
  const parts = collapseOrdinals(nums).map((s) => s.text);
  for (let u = 0; u < unresolved; u++) parts.push("?");
  return {
    text: `[${parts.join(",")}]`,
    allResolved: unresolved === 0 && nums.length > 0,
    anyResolved: nums.length > 0,
  };
}

// WS-4.2: the live registry/stores that used to live here (citationStyle,
// citationOrdinals, setCitationOrdinals, citeOrdinal, getCitationStyle) are
// gone — numbering is PER EDITOR now (scholar/numberingFacet.ts): the
// citeNumbers field publishes into its state's facet instance, chips read it
// in the same update, and margin views subscribe through the margin host.
