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

import { get, writable } from "svelte/store";
import { anyCiteRe, isCrossrefKey } from "../science/grammar";
import { maskInlineMath, MathBlockTracker } from "../science/mathGrammar";
import { frontMatterBounds, frontMatterField } from "../frontmatter";

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

export interface OrdinalScan {
  /** key → 1-based ordinal by first appearance (only keys passing isNumbered). */
  map: Map<string, number>;
  /** Every citation-token range found (resolved or not) — the editor's change
   *  gate maps these through edits to decide when a rescan is needed. */
  ranges: { from: number; to: number }[];
}

/**
 * Appearance-order ordinals over a manuscript. Masks YAML front matter,
 * fenced code, inline code spans, AND math (inline `$…$` + `$$` display
 * blocks) — the SAME regions the renderer skips (renderManuscript
 * preprocess/transformInline), or numeric mode would number keys that never
 * reach the References list. Cross-ref keys (@fig-…) are ignored; keys
 * failing `isNumbered` (not in the bib) get no ordinal so the References
 * stay contiguous 1..N; repeat cites keep their first number.
 */
export function buildCitationOrdinals(
  src: string,
  isNumbered: (key: string) => boolean,
): OrdinalScan {
  const map = new Map<string, number>();
  const ranges: { from: number; to: number }[] = [];
  let next = 1;

  // WS-4.1: single-source boundary (frontmatter.ts).
  const bodyStart = frontMatterBounds(src).bodyStart;

  let pos = bodyStart;
  let inFence = false;
  const math = new MathBlockTracker(); // display math masks whole lines (2.1 parity)
  let lineNo = 0;
  while (pos <= src.length) {
    let nl = src.indexOf("\n", pos);
    if (nl < 0) nl = src.length;
    const rawLine = src.slice(pos, nl);
    lineNo++;
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
    } else if (!inFence) {
      const wasInMath = math.inMath;
      const closed = math.feed(lineNo, rawLine);
      if (!wasInMath && !math.inMath && !closed) {
        // Prose line: mask inline math (length-preserving), then mask inline code
        // spans (n-backtick runs), then scan the prose between.
        const line = maskInlineMath(rawLine);
        const CODE = /(`+)(?:.*?)\1/g;
        let last = 0;
        let cm: RegExpExecArray | null;
        const scan = (seg: string, base: number) => {
          const re = anyCiteRe();
          let m: RegExpExecArray | null;
          while ((m = re.exec(seg))) {
            const key = m[1];
            if (isCrossrefKey(key)) continue;
            ranges.push({ from: base + m.index, to: base + m.index + m[0].length });
            if (!map.has(key) && isNumbered(key)) map.set(key, next++);
          }
        };
        while ((cm = CODE.exec(line))) {
          scan(line.slice(last, cm.index), pos + last);
          last = cm.index + cm[0].length;
        }
        scan(line.slice(last), pos + last);
      }
    }
    pos = nl + 1;
  }
  return { map, ranges };
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
