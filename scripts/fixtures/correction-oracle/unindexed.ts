// Frozen c289627 unindexed explicit-vocabulary oracle. Keep independent of later optimization.
// Pure planning for Paper's local correction fabric. Harper finds candidate
// lints; this module decides which tiny subset is safe enough to apply without
// asking. It deliberately knows nothing about CodeMirror, workers, or storage
// so the scientific-safety contract is cheap to test exhaustively.

import {
  extractSentenceWindow,
  isSentenceBoundaryAt,
  type CorrectionTextWindow,
} from "../../../src/shell/modes/paper/editing/localCorrectionBoundary";

export type LocalLintKind =
  | "BoundaryError"
  | "Spelling"
  | "Typo"
  | "WordChoice"
  | string;

export interface LocalLintRecord {
  from: number;
  to: number;
  problem: string;
  kind: LocalLintKind;
  message: string;
  suggestions: string[];
  /** Additional one-edit words verified against Harper's local lexicon. */
  rescueSuggestions?: string[];
  /** Harper confirms every whitespace-separated part is itself a known word. */
  partsAreKnown?: boolean;
}

export interface PlannedLocalCorrection {
  from: number;
  to: number;
  original: string;
  replacement: string;
  kind: "spelling" | "spacing" | "typo";
  message: string;
}

export interface CorrectionWindow {
  from: number;
  to: number;
  text: string;
}

const LETTER = /[\p{L}\p{M}]/u;
const WORDISH = /^[\p{L}\p{M}'’\- ]+$/u;
const TOKEN_RE = /[\p{L}][\p{L}\p{M}\d_-]{1,63}/gu;
const SHORT_BOUNDARY_WORDS = new Set(["a", "i", "an", "as", "at", "by", "in", "is", "it", "of", "on", "or", "to", "up", "us"]);

export function correctionPairKey(original: string, replacement: string): string {
  return `${original.toLocaleLowerCase()}\u0000${replacement.toLocaleLowerCase()}`;
}

export function extractCorrectionWindow(
  doc: string,
  head: number,
  maxLength = 480,
): CorrectionWindow | null {
  const window = extractSentenceWindow(doc, head, maxLength);
  if (!window) return null;
  let from = window.from;
  while (from < window.to && /[\s#*-]/.test(doc[from])) from += 1;
  const text = doc.slice(from, window.to);
  return text.length >= 3 && LETTER.test(text) ? { from, to: window.to, text } : null;
}

/**
 * Harper rules that answer "does this token open its sentence correctly?".
 * They are meaningless — and confidently wrong — when the window does not
 * actually start one.
 */
const SENTENCE_START_KINDS = new Set(["Capitalization", "Punctuation"]);

/** Index just past the window's first sentence (its length when it holds only one). */
function firstSentenceEnd(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "\n") return i;
    if (/\s/.test(text[i]) && isSentenceBoundaryAt(text, i)) return i;
  }
  return text.length;
}

/**
 * Keep only the spans a focused window may act on. Everything else in the
 * window is context for the linter to read, and belongs to a wider lane —
 * this applies to the lints AND to every span derived from the window text,
 * including the confusion table and explicit-vocabulary matches that the
 * planners synthesize from the whole source.
 */
export function withinFocus<T extends { from: number; to: number }>(
  spans: readonly T[],
  focus?: { from: number; to: number },
): T[] {
  if (!focus) return [...spans];
  return spans.filter((span) => span.from >= focus.from && span.to <= focus.to);
}

/**
 * Reduce a window's lints to the ones that are about the manuscript rather than
 * about the cut. Every window is a SLICE, but the linter reads each one as a
 * whole document, so two corrections are needed:
 *
 * - a window that does not begin a sentence must not keep sentence-OPENING
 *   verdicts about its first sentence (the cut invented that position);
 * - a focused window may only report inside its focus.
 */
export function scopeWindowLints(
  window: Pick<CorrectionTextWindow, "text" | "focus">,
  lints: readonly LocalLintRecord[],
  startsSentence: boolean,
): LocalLintRecord[] {
  const firstEnd = startsSentence ? -1 : firstSentenceEnd(window.text);
  return withinFocus(
    lints.filter((lint) => !(lint.from < firstEnd && SENTENCE_START_KINDS.has(lint.kind))),
    window.focus,
  );
}

function lettersOnly(s: string): string {
  return [...s]
    .filter((c) => /[\p{L}\p{M}]/u.test(c))
    .join("")
    .toLocaleLowerCase();
}

export function safeTypoBoundary(original: string, replacement: string): boolean {
  const parts = replacement.trim().split(/\s+/);
  return (
    parts.length > 1 &&
    original.replace(/\s/g, "").length >= 6 &&
    lettersOnly(original) === lettersOnly(replacement) &&
    parts.some((part, index) => {
      const lower = part.toLocaleLowerCase();
      // A lowercase leading "i" is much more often a missing letter
      // (`istance` -> `instance`) than an omitted word boundary. Preserve the
      // uppercase pronoun path while deferring the lowercase ambiguity.
      if (index === 0 && lower === "i" && original[0] === original[0]?.toLocaleLowerCase()) return false;
      return SHORT_BOUNDARY_WORDS.has(lower);
    })
  );
}

function adjacentTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diffs.push(i);
  return (
    diffs.length === 2 &&
    diffs[1] === diffs[0] + 1 &&
    a[diffs[0]] === b[diffs[1]] &&
    a[diffs[1]] === b[diffs[0]]
  );
}

function oneRemoval(longer: string, shorter: string): number | null {
  if (longer.length !== shorter.length + 1) return null;
  let i = 0;
  while (i < shorter.length && longer[i] === shorter[i]) i += 1;
  return longer.slice(0, i) + longer.slice(i + 1) === shorter ? i : null;
}

export function oneSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i] && ++n > 1) return false;
  return n === 1;
}

export function damerauLevenshtein(a: string, b: string): number {
  const aa = [...a.toLocaleLowerCase()];
  const bb = [...b.toLocaleLowerCase()];
  const d = Array.from({ length: aa.length + 1 }, () => new Array<number>(bb.length + 1));
  for (let i = 0; i <= aa.length; i += 1) d[i][0] = i;
  for (let j = 0; j <= bb.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= aa.length; i += 1) {
    for (let j = 1; j <= bb.length; j += 1) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        aa[i - 1] === bb[j - 2] &&
        aa[i - 2] === bb[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[aa.length][bb.length];
}

export function looksTechnical(token: string): boolean {
  const compact = token.replace(/\s/g, "");
  if (/\d/.test(compact)) return true;
  if (/[a-z][A-Z]|[A-Z][a-z]+[A-Z]/.test(compact)) return true;
  const capitals = compact.match(/[A-Z]/g)?.length ?? 0;
  return capitals >= 2;
}

function addRegexRanges(out: Array<[number, number]>, text: string, re: RegExp): void {
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
}

/** Syntax that a scientific writing assistant must never silently rewrite. */
export function protectedMarkdownRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  addRegexRanges(out, text, /`+[^`\n]*`+/g);
  addRegexRanges(out, text, /\$\$[^]*?\$\$|\$[^$\n]+\$/g);
  addRegexRanges(out, text, /https?:\/\/[^\s)>]+|\bwww\.[^\s)>]+/gi);
  addRegexRanges(out, text, /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi);
  addRegexRanges(out, text, /\[@[^\]]+\]|@[A-Za-z][\w:.-]*/g);
  addRegexRanges(out, text, /\{[^}\n]+\}/g);
  addRegexRanges(out, text, /\]\([^)\n]+\)/g);
  addRegexRanges(out, text, /<[^>\n]+>/g);
  addRegexRanges(out, text, /\\[A-Za-z]+(?:\{[^}\n]*\})?/g);
  // Exact quoted material is source-integrity-sensitive. Apostrophe-delimited
  // spans are intentionally excluded because contractions make them ambiguous.
  addRegexRanges(out, text, /“[^”\n]+”|"[^"\n]+"/g);

  let lineFrom = 0;
  let fence: { marker: string; from: number } | null = null;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = { marker: fenceMatch[1][0], from: lineFrom };
      else if (fence.marker === fenceMatch[1][0]) {
        out.push([fence.from, lineFrom + line.length]);
        fence = null;
      }
    }
    if (fence || line.includes("|") || /^\s*>/.test(line) || fenceMatch) {
      out.push([lineFrom, lineFrom + line.length]);
    }
    lineFrom += line.length + 1;
  }
  if (fence) out.push([fence.from, text.length]);
  return out.sort((a, b) => a[0] - b[0]);
}

function overlapsProtected(from: number, to: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => from < b && to > a);
}

function vocabularyForm(s: string): string {
  return [...s]
    .filter((c) => /[\p{L}\p{M}\d]/u.test(c))
    .join("")
    .toLocaleLowerCase();
}

function deletionPlusTransposition(longer: string, shorter: string): boolean {
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < longer.length; i += 1) {
    if (adjacentTransposition(longer.slice(0, i) + longer.slice(i + 1), shorter)) return true;
  }
  return false;
}

function explicitVocabularyMatch(original: string, canonical: string): number | null {
  const a = vocabularyForm(original);
  const b = vocabularyForm(canonical);
  if (!a || !b || a[0] !== b[0] || original === canonical) return null;
  if (a === b) return 140; // canonical casing, punctuation, or separators

  // Short all-caps identifiers commonly differ by a meaningful version digit
  // (SLAP2/SLAP3). An explicit SLAP2 entry must never rewrite a novel SLAP3.
  if (/^[A-Z]{2,10}\d{1,4}$/.test(original) && /^[A-Z]{2,10}\d{1,4}$/.test(canonical)) return null;
  if (!looksTechnical(original) && !looksTechnical(canonical)) return null;

  if (adjacentTransposition(a, b)) return 125;
  if (oneRemoval(a, b) != null || oneRemoval(b, a) != null) return 112;
  // The motivating fast-typing shape can combine one missing character with
  // one adjacent swap: IgluSnrf4 → iGluSnFR4f. Still reject arbitrary
  // substitutions, which may distinguish real scientific variants.
  if (
    Math.max(a.length, b.length) >= 8 &&
    (deletionPlusTransposition(a, b) || deletionPlusTransposition(b, a))
  ) return 104;
  return null;
}

/**
 * Match technical tokens directly against explicit personal/project words.
 * This supplements Harper, whose general dictionary suggestions are not
 * guaranteed to include mixed-case alphanumeric scientific terms.
 */
export function planExplicitVocabularyCorrections(
  source: string,
  words: readonly string[],
  blockedPairs: ReadonlySet<string> = new Set<string>(),
): PlannedLocalCorrection[] {
  const protectedRanges = protectedMarkdownRanges(source);
  const canonicals = [...new Map(
    words
      .map((word) => word.trim())
      .filter(Boolean)
      .map((word) => [word.toLocaleLowerCase(), word] as const),
  ).values()];
  const plans: PlannedLocalCorrection[] = [];

  for (const match of source.matchAll(TOKEN_RE)) {
    if (plans.length >= 6) break;
    const original = match[0];
    const from = match.index;
    const to = from + original.length;
    if (overlapsProtected(from, to, protectedRanges)) continue;

    const ranked = canonicals
      .map((canonical) => ({ canonical, score: explicitVocabularyMatch(original, canonical) }))
      .filter((candidate): candidate is { canonical: string; score: number } => candidate.score != null)
      .sort((a, b) => b.score - a.score || a.canonical.localeCompare(b.canonical));
    if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) continue;
    const replacement = ranked[0].canonical;
    if (blockedPairs.has(correctionPairKey(original, replacement))) continue;
    plans.push({
      from,
      to,
      original,
      replacement,
      kind: "spelling",
      message: "Matched your local dictionary",
    });
  }
  return plans;
}
