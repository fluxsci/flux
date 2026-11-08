// THE citation scanner — one walk over a manuscript that finds every `@key` /
// `[@key; …]` citation token outside the regions the renderer never
// transforms: YAML front matter, fenced code, inline code spans, and math
// (inline `$…$` and `$$` display blocks). Cross-reference keys (`@fig-…`,
// `@tbl-…`, `@eq-…`, `@sec-…`) are not citations and are skipped.
//
// Consumers (twin-engine rule, guide §2 — extend this, never re-implement it):
//   · buildCitationOrdinals (below) — numeric ordinals for the editor chips
//     (science/citeNumbers.ts) and the renderer/export (renderManuscript.ts);
//   · PaperMode's cited-keys set (the References red dots);
//   · flux-core `compile`'s "citation keys missing from the bibliography";
//   · Manuscript Check (checks/references.ts).
// Before 2026-11-08 flux-core carried its own `citationKeysIn` regex (looser
// key grammar, no code/math masking), so `flux compile` could report a key
// inside a code block as missing while the editor never chipped it.
//
// Pure: no Svelte, no DOM, no Node.

import { anyCiteRe, isCrossrefKey } from "./grammar";
import { maskInlineMath, MathBlockTracker } from "./mathGrammar";
import { frontMatterBounds } from "./frontmatter";

/** One citation token: the key and the source range of `[@key` / `@key`
 *  (the range starts at the `[` for a bracketed group's first key, else at
 *  the boundary character's successor — exactly the range the change gate
 *  has always mapped). */
export interface CitationOccurrence {
  key: string;
  from: number;
  to: number;
}

/** Every citation occurrence in document order (repeats included). */
export function scanCitations(src: string): CitationOccurrence[] {
  const out: CitationOccurrence[] = [];
  const bodyStart = frontMatterBounds(src).bodyStart;
  let pos = bodyStart;
  let inFence = false;
  const math = new MathBlockTracker(); // display math masks whole lines (2.1 parity)
  let lineNo = 0;
  const re = anyCiteRe();
  const scan = (seg: string, base: number) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg))) {
      const key = m[1];
      if (isCrossrefKey(key)) continue;
      out.push({ key, from: base + m.index, to: base + m.index + m[0].length });
    }
  };
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
      if (!wasInMath && !math.inMath && !closed && rawLine.includes("@")) {
        // Prose line: mask inline math (length-preserving), then mask inline code
        // spans (n-backtick runs), then scan the prose between.
        const line = maskInlineMath(rawLine);
        const CODE = /(`+)(?:.*?)\1/g;
        let last = 0;
        let cm: RegExpExecArray | null;
        while ((cm = CODE.exec(line))) {
          scan(line.slice(last, cm.index), pos + last);
          last = cm.index + cm[0].length;
        }
        scan(line.slice(last), pos + last);
      }
    }
    pos = nl + 1;
  }
  return out;
}

/** Distinct cited keys in first-appearance order. */
export function citedKeysIn(src: string): string[] {
  return [...new Set(scanCitations(src).map((o) => o.key))];
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
export function buildCitationOrdinals(src: string, isNumbered: (key: string) => boolean): OrdinalScan {
  const map = new Map<string, number>();
  const ranges: { from: number; to: number }[] = [];
  let next = 1;
  for (const o of scanCitations(src)) {
    ranges.push({ from: o.from, to: o.to });
    if (!map.has(o.key) && isNumbered(o.key)) map.set(o.key, next++);
  }
  return { map, ranges };
}
