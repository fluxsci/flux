// Per-RANGE formatting inside one text element (2026-09-22).
//
// A text element keeps ONE font (family/size/weight/style/underline) — that is
// the element's own look and the default for every character. `runs` overrides
// bold/italic/underline and the text COLOR for character ranges of `text`, so a
// species name can be italic, or one symbol red, inside an otherwise plain label
// without splitting the box into several elements.
//
// Invariants, all enforced by `normalizeRuns` and pinned by verify-text-runs:
//   * offsets index `text` in UTF-16 code units, `from` inclusive, `to`
//     exclusive, and are clamped to the text;
//   * runs are sorted, non-empty and NON-OVERLAPPING — resolving a character
//     is a lookup, never a fold over a stack;
//   * a flag or color left ABSENT inherits the element (tri-state); an explicit value
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
  /** Fill for this range; absent inherits the element's `color`. Metric-neutral. */
  color?: string;
  /** Superscript / subscript: smaller glyphs raised or lowered off the
   *  baseline (SCRIPT_* below). "normal" cancels a script beneath it, and is
   *  what the element says, so normalization prunes it. */
  script?: TextScript;
}

export type TextScript = "super" | "sub" | "normal";
/** Script glyphs are this fraction of the element's font size. */
export const SCRIPT_SCALE = 0.62;
/** Baseline offset of each script, as a fraction of the element's font size
 *  (SVG y grows downward: a superscript rises, a subscript drops). */
export const SCRIPT_SHIFT: Record<"super" | "sub", number> = { super: -0.36, sub: 0.16 };
/** The size and baseline offset a segment's script puts on its glyphs. */
export function scriptMetrics(script: TextScript | undefined, fontSize: number): { size: number; shift: number } {
  if (script !== "super" && script !== "sub") return { size: fontSize, shift: 0 };
  // Rounded to 1/100 px: exact enough for any render, and it keeps float noise
  // (-6.4799999999999995) out of every saved SVG.
  const round = (v: number) => Math.round(v * 100) / 100;
  return { size: round(fontSize * SCRIPT_SCALE), shift: round(fontSize * SCRIPT_SHIFT[script]) };
}

/** What an absent run field inherits: the element's flags, plus its color when known. */
export type RunBase = Record<RunKey, boolean> & { color?: string };

/** A piece of one visual line that carries a single resolved look. */
export interface TextSegment {
  text: string;
  /** Absolute offsets into the element's `text`. */
  from: number;
  to: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  script?: TextScript;
  /** Baseline offset (SVG dy) placed on this piece: into a script, out of one,
   *  or between two. Set by text.ts blockLayout, which also carries a shift a
   *  line ends on into the next line's own dy. Absent everywhere else. */
  dy?: number;
  /** Extra advance placed BEFORE this piece, in canvas px. Justification uses
   *  it to widen a word gap; absent everywhere else. */
  dx?: number;
}

/** What the ELEMENT itself says, i.e. what an absent run flag inherits. */
export function elementFlags(e: Pick<TextElement, "fontWeight" | "fontStyle" | "underline"> & { color?: string }): RunBase {
  const base: RunBase = { bold: e.fontWeight >= 600, italic: e.fontStyle === "italic", underline: !!e.underline };
  if (typeof e.color === "string") base.color = e.color;
  return base;
}

const sameColor = (a: string | undefined, b: string | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase());

/** Copy every run field a source actually carries (booleans for the flags, a
 *  non-empty string for color). The one place that knows the field set. */
function copyFields(into: TextRun | TextSegment, from: TextRun): void {
  for (const key of RUN_KEYS) if (typeof from[key] === "boolean") into[key] = from[key];
  if (typeof from.color === "string" && from.color) into.color = from.color;
  if (from.script === "super" || from.script === "sub" || from.script === "normal") into.script = from.script;
}

function flagsEqual(a: TextRun, b: TextRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && sameColor(a.color, b.color) && a.script === b.script;
}

function empty(run: TextRun): boolean {
  return run.bold === undefined && run.italic === undefined && run.underline === undefined && run.color === undefined && run.script === undefined;
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
  base?: RunBase,
): TextRun[] {
  if (!runs || !runs.length || length <= 0) return [];
  const clamped: TextRun[] = [];
  for (const run of runs) {
    const from = Math.max(0, Math.min(length, Math.floor(run.from)));
    const to = Math.max(0, Math.min(length, Math.floor(run.to)));
    if (!(to > from)) continue;
    const next: TextRun = { from, to };
    copyFields(next, run);
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
      copyFields(piece, run);
    }
    if (base) {
      for (const key of RUN_KEYS) if (piece[key] === base[key]) delete piece[key];
      if (base.color !== undefined && sameColor(piece.color, base.color)) delete piece.color;
      if (piece.script === "normal") delete piece.script; // the element never scripts itself
    }
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
    if (run) copyFields(segment, run);
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
 * Paint [from, to) with `color`, or with `null` hand the range back to the
 * element's own color. Returns the element's NEW normalized runs; it never
 * mutates. A color equal to the element's is pruned, so recoloring a word back
 * to the box color leaves no run behind.
 */
export function setRunColor(
  e: Pick<TextElement, "text" | "runs" | "fontWeight" | "fontStyle" | "underline" | "color">,
  from: number,
  to: number,
  color: string | null,
): TextRun[] {
  const lo = Math.max(0, Math.min(e.text.length, Math.floor(from)));
  const hi = Math.max(0, Math.min(e.text.length, Math.floor(to)));
  const base = elementFlags(e);
  if (!(hi > lo)) return normalizeRuns(e.runs, e.text.length, base);
  // null resets: a run of the element's own color overrides whatever color lay
  // beneath it, and normalization then prunes it as saying nothing.
  return normalizeRuns([...(e.runs ?? []), { from: lo, to: hi, color: color ?? e.color }], e.text.length, base);
}

/** The single color every character of [from, to) shows, or null when mixed. */
export function rangeColor(
  e: Pick<TextElement, "text" | "runs" | "color">,
  from: number,
  to: number,
): string | null {
  const segments = segmentRange(e.text, e.runs, from, to);
  if (!segments.length) return null;
  const first = segments[0].color ?? e.color;
  return segments.every((s) => sameColor(s.color ?? e.color, first)) ? first : null;
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
    copyFields(next, run);
    mapped.push(next);
  }
  return normalizeRuns(mapped, newText.length);
}

/** The look a segment actually renders with, resolved against the element. */
export function resolvedRunStyle(
  e: Pick<TextElement, "fontWeight" | "fontStyle" | "underline"> & { color?: string },
  segment: Pick<TextSegment, RunKey | "color">,
): { fontWeight: number; fontStyle: "normal" | "italic"; underline: boolean; color?: string } {
  // color appears only when the RANGE sets one, so an unformatted segment
  // resolves to exactly the element font it always did.
  const color = segment.color;
  return {
    fontWeight: segment.bold === undefined ? e.fontWeight : segment.bold ? 700 : 400,
    fontStyle: segment.italic === undefined ? e.fontStyle : segment.italic ? "italic" : "normal",
    underline: segment.underline === undefined ? !!e.underline : segment.underline,
    ...(color !== undefined ? { color } : {}),
  };
}

/** Does this segment carry anything the element does not already say? */
export function segmentFormatted(segment: TextSegment): boolean {
  return segment.bold !== undefined || segment.italic !== undefined || segment.underline !== undefined || segment.color !== undefined || (segment.script !== undefined && segment.script !== "normal");
}

/** Does this segment change glyph advances (bold, or a script's smaller size)?
 *  The inline editor can only mirror one font, so these are what can move a
 *  wrap point (text.ts plainWrapMatches). */
export function runChangesMetrics(run: Pick<TextRun, "bold" | "script">): boolean {
  return run.bold !== undefined || run.script === "super" || run.script === "sub";
}

/** The script every character of [from, to) has ("normal" when none), or null
 *  when the range mixes them. */
export function rangeScript(e: Pick<TextElement, "text" | "runs">, from: number, to: number): TextScript | null {
  const segments = segmentRange(e.text, e.runs, from, to);
  if (!segments.length) return null;
  const at = (s: TextSegment) => (s.script === "super" || s.script === "sub" ? s.script : "normal");
  const first = at(segments[0]);
  return segments.every((s) => at(s) === first) ? first : null;
}

/** Toggle superscript or subscript over [from, to): a range that already is
 *  `which` everywhere goes back to the baseline, anything else becomes `which`
 *  (so super -> sub is one press). Returns NEW normalized runs; never mutates. */
export function toggleScriptRange(
  e: Pick<TextElement, "text" | "runs" | "fontWeight" | "fontStyle" | "underline" | "color">,
  from: number,
  to: number,
  which: "super" | "sub",
): TextRun[] {
  const lo = Math.max(0, Math.min(e.text.length, Math.floor(from)));
  const hi = Math.max(0, Math.min(e.text.length, Math.floor(to)));
  const base = elementFlags(e);
  if (!(hi > lo)) return normalizeRuns(e.runs, e.text.length, base);
  const script: TextScript = rangeScript(e, lo, hi) === which ? "normal" : which;
  return normalizeRuns([...(e.runs ?? []), { from: lo, to: hi, script }], e.text.length, base);
}

/** Does this element carry any per-range formatting at all? */
export function hasRuns(e: Pick<TextElement, "runs">): boolean {
  return !!e.runs && e.runs.length > 0;
}
