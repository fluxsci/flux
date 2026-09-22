// Per-RANGE formatting inside one text element (2026-09-22).
//
// A text element keeps ONE font (family/size/weight/style/underline) — that is
// the element's own look and the default for every character. `runs` overrides
// bold/italic/underline for character ranges of `text`, so a species name can
// be italic inside an otherwise upright label without splitting the box into
// several elements.
//
// Invariants, all enforced by `normalizeRuns` and pinned by verify-text-runs:
//   * offsets index `text` in UTF-16 code units, `from` inclusive, `to`
//     exclusive, and are clamped to the text;
//   * runs are sorted, non-empty and NON-OVERLAPPING — resolving a character
//     is a lookup, never a fold over a stack;
//   * a flag left ABSENT inherits the element (tri-state); an explicit value
//     equal to what the element already says is pruned, so `runs` disappears
//     entirely when it carries nothing the element does not. Absence is the
//     default, which is what keeps every pre-2026-09-22 file byte-identical.
//
// Pure: no DOM, no Svelte, no Node. Both engines load it (twin-engine rule).
import type { TextElement } from "./types";

export type RunKey = "bold" | "italic" | "underline";
export const RUN_KEYS: readonly RunKey[] = ["bold", "italic", "underline"];

/** One formatted range of a text element's string. */
export interface TextRun {
  from: number;
  to: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** A piece of one visual line that carries a single resolved look. */
export interface TextSegment {
  text: string;
  /** Absolute offsets into the element's `text`. */
  from: number;
  to: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** What the ELEMENT itself says, i.e. what an absent run flag inherits. */
export function elementFlags(e: Pick<TextElement, "fontWeight" | "fontStyle" | "underline">): Record<RunKey, boolean> {
  return { bold: e.fontWeight >= 600, italic: e.fontStyle === "italic", underline: !!e.underline };
}

function flagsEqual(a: TextRun, b: TextRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline;
}

function empty(run: TextRun): boolean {
  return run.bold === undefined && run.italic === undefined && run.underline === undefined;
}

/**
 * Sort, clamp, split overlaps (a LATER run wins the overlap, per key), merge
 * equal neighbours and drop anything that says nothing. With `base` (the
 * element's own flags) an explicit value that merely restates the element is
 * pruned too — that is how a run vanishes when the whole box is italicised.
 */
export function normalizeRuns(
  runs: readonly TextRun[] | undefined,
  length: number,
  base?: Record<RunKey, boolean>,
): TextRun[] {
  if (!runs || !runs.length || length <= 0) return [];
  const clamped: TextRun[] = [];
  for (const run of runs) {
    const from = Math.max(0, Math.min(length, Math.floor(run.from)));
    const to = Math.max(0, Math.min(length, Math.floor(run.to)));
    if (!(to > from)) continue;
    const next: TextRun = { from, to };
    for (const key of RUN_KEYS) if (typeof run[key] === "boolean") next[key] = run[key];
    if (!empty(next)) clamped.push(next);
  }
  if (!clamped.length) return [];
  // Resolve overlaps on the boundary lattice: every interval between two
  // consecutive boundaries has ONE answer per key — the last run covering it.
  const bounds = [...new Set(clamped.flatMap((r) => [r.from, r.to]))].sort((a, b) => a - b);
  const out: TextRun[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i], to = bounds[i + 1];
    const piece: TextRun = { from, to };
    for (const run of clamped) {
      if (run.from > from || run.to < to) continue;
      for (const key of RUN_KEYS) if (typeof run[key] === "boolean") piece[key] = run[key];
    }
    if (base) for (const key of RUN_KEYS) if (piece[key] === base[key]) delete piece[key];
    if (empty(piece)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.to === from && flagsEqual(prev, piece)) prev.to = to;
    else out.push(piece);
  }
  return out;
}

/** The run covering `index`, or undefined where the element's own look wins. */
export function runAt(runs: readonly TextRun[] | undefined, index: number): TextRun | undefined {
  if (!runs) return undefined;
  for (const run of runs) {
    if (index < run.from) return undefined; // sorted: no later run can cover it
    if (index < run.to) return run;
  }
  return undefined;
}

/**
 * Cut `text.slice(from, to)` into single-look segments. Returns ONE segment
 * for an unformatted range, so a caller can skip the nested-tspan path when
 * `segments.length === 1 && no flags`.
 */
export function segmentRange(
  text: string,
  runs: readonly TextRun[] | undefined,
  from: number,
  to: number,
): TextSegment[] {
  const start = Math.max(0, from), end = Math.min(text.length, to);
  if (!(end > start)) return [];
  const out: TextSegment[] = [];
  let at = start;
  const push = (stop: number, run?: TextRun) => {
    if (stop <= at) return;
    const segment: TextSegment = { text: text.slice(at, stop), from: at, to: stop };
    if (run) for (const key of RUN_KEYS) if (typeof run[key] === "boolean") segment[key] = run[key];
    out.push(segment);
    at = stop;
  };
  if (runs) {
    for (const run of runs) {
      if (run.to <= start) continue;
      if (run.from >= end) break;
      push(Math.max(start, run.from)); // the gap before this run
      push(Math.min(end, run.to), run);
    }
  }
  push(end);
  return out;
}

/** Is every character of [from, to) already `which`? Empty range → false. */
export function rangeIsOn(
  e: Pick<TextElement, "text" | "runs" | "fontWeight" | "fontStyle" | "underline">,
  from: number,
  to: number,
  which: RunKey,
): boolean {
  const base = elementFlags(e);
  const segments = segmentRange(e.text, e.runs, from, to);
  if (!segments.length) return false;
  return segments.every((s) => (s[which] === undefined ? base[which] : s[which]) === true);
}

/**
 * Toggle `which` over [from, to) the way every editor does: a range that is
 * entirely ON turns off, anything else turns on. Returns the element's NEW
 * normalized runs — it never mutates.
 */
export function toggleRunRange(
  e: Pick<TextElement, "text" | "runs" | "fontWeight" | "fontStyle" | "underline">,
  from: number,
  to: number,
  which: RunKey,
): TextRun[] {
  const lo = Math.max(0, Math.min(e.text.length, Math.floor(from)));
  const hi = Math.max(0, Math.min(e.text.length, Math.floor(to)));
  if (!(hi > lo)) return normalizeRuns(e.runs, e.text.length, elementFlags(e));
  const value = !rangeIsOn(e, lo, hi, which);
  return normalizeRuns(
    [...(e.runs ?? []), { from: lo, to: hi, [which]: value } as TextRun],
    e.text.length,
    elementFlags(e),
  );
}

/**
 * Carry runs across a text edit. The edit is derived as ONE replaced range
 * (common prefix/suffix), which is exactly what a textarea `input` gives us
 * and what typing, pasting and deleting all reduce to.
 *
 * Boundary rule: text inserted strictly INSIDE a run joins it (typing in the
 * middle of an italic word stays italic); text inserted at either edge stays
 * outside it, so you can always type unformatted text against a formatted
 * word. Deleted text takes its runs with it.
 */
export function remapRuns(
  runs: readonly TextRun[] | undefined,
  oldText: string,
  newText: string,
): TextRun[] {
  if (!runs || !runs.length) return [];
  if (oldText === newText) return normalizeRuns(runs, newText.length);
  let prefix = 0;
  const max = Math.min(oldText.length, newText.length);
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix++;
  const removedEnd = oldText.length - suffix;        // [prefix, removedEnd) went away
  const delta = newText.length - oldText.length;
  // A pure insertion has no removed range, so "before" and "after" the edit
  // point need the strict/non-strict comparisons spelled out: an offset AT the
  // caret shifts when it is a run's start (the new text sits outside the run)
  // and stays when it is a run's end (likewise outside).
  const pureInsertion = removedEnd === prefix;
  const mapStart = (i: number) =>
    pureInsertion ? (i >= prefix ? i + delta : i)
    : i <= prefix ? i
    : i >= removedEnd ? i + delta
    : prefix;
  const mapEnd = (i: number) =>
    pureInsertion ? (i > prefix ? i + delta : i)
    : i <= prefix ? i
    : i >= removedEnd ? i + delta
    : prefix;
  const mapped: TextRun[] = [];
  for (const run of runs) {
    const from = mapStart(run.from);
    const to = mapEnd(run.to);
    if (!(to > from)) continue; // the edit swallowed this run whole
    const next: TextRun = { from, to };
    for (const key of RUN_KEYS) if (typeof run[key] === "boolean") next[key] = run[key];
    mapped.push(next);
  }
  return normalizeRuns(mapped, newText.length);
}

/** The look a segment actually renders with, resolved against the element. */
export function resolvedRunStyle(
  e: Pick<TextElement, "fontWeight" | "fontStyle" | "underline">,
  segment: Pick<TextSegment, RunKey>,
): { fontWeight: number; fontStyle: "normal" | "italic"; underline: boolean } {
  return {
    fontWeight: segment.bold === undefined ? e.fontWeight : segment.bold ? 700 : 400,
    fontStyle: segment.italic === undefined ? e.fontStyle : segment.italic ? "italic" : "normal",
    underline: segment.underline === undefined ? !!e.underline : segment.underline,
  };
}

/** Does this element carry any per-range formatting at all? */
export function hasRuns(e: Pick<TextElement, "runs">): boolean {
  return !!e.runs && e.runs.length > 0;
}
