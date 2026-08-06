// Pure planning for Paper's local correction fabric. Harper finds candidate
// lints; this module decides which tiny subset is safe enough to apply without
// asking. It deliberately knows nothing about CodeMirror, workers, or storage
// so the scientific-safety contract is cheap to test exhaustively.

import { extractSentenceWindow } from "./localCorrectionBoundary";

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

const QWERTY_NEIGHBORS: Readonly<Record<string, string>> = Object.freeze({
  q: "wa", w: "qase", e: "wsdr", r: "edft", t: "rfgy", y: "tghu", u: "yhji", i: "ujko", o: "iklp", p: "ol",
  a: "qwsz", s: "weadzx", d: "erfsxc", f: "rtgdvc", g: "tyfhvb", h: "yugjbn", j: "uihknm", k: "iojml", l: "opk",
  z: "asx", x: "sdc z".replace(/ /g, ""), c: "dfxv", v: "fgcb", b: "ghvn", n: "hjbm", m: "jkn",
});

/**
 * Generate the small, high-value part of a one-edit spelling neighborhood.
 * The worker checks these forms against Harper's curated dictionary in one
 * batched lint. Keeping generation pure makes the exact rescue surface easy
 * to gate without moving any WASM work onto the renderer thread.
 */
export function generateMechanicalRescueVariants(original: string, limit = 96): string[] {
  if (!/^[A-Za-z]{4,32}$/.test(original)) return [];
  const chars = [...original];
  const variants = new Set<string>();
  const add = (value: string) => {
    if (value && value !== original && variants.size < limit) variants.add(value);
  };

  // Extra-key slips and adjacent transpositions are both common at full typing
  // speed, and they keep this first expansion independent of word frequency.
  for (let i = 0; i < chars.length; i += 1) add(chars.slice(0, i).concat(chars.slice(i + 1)).join(""));
  for (let i = 0; i + 1 < chars.length; i += 1) {
    if (chars[i] === chars[i + 1]) continue;
    const swapped = [...chars];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    add(swapped.join(""));
  }
  for (let i = 0; i < chars.length && variants.size < limit; i += 1) {
    const lower = chars[i].toLocaleLowerCase();
    for (const neighbor of QWERTY_NEIGHBORS[lower] ?? "") {
      const replaced = [...chars];
      replaced[i] = chars[i] === chars[i].toLocaleUpperCase() ? neighbor.toLocaleUpperCase() : neighbor;
      add(replaced.join(""));
      if (variants.size >= limit) break;
    }
  }
  return [...variants];
}

export function keyboardAdjacentSubstitution(original: string, replacement: string): boolean {
  const a = original.toLocaleLowerCase();
  const b = replacement.toLocaleLowerCase();
  if (!oneSubstitution(a, b)) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    return QWERTY_NEIGHBORS[a[i]]?.includes(b[i]) ?? false;
  }
  return false;
}

export function mechanicalScore(original: string, replacement: string): number {
  const a = original.toLocaleLowerCase();
  const b = replacement.toLocaleLowerCase();
  if (adjacentTransposition(a, b)) return 110;
  // Arbitrary one-letter substitutions are especially dangerous in science:
  // valid terms such as "somata" can sit one key from a common dictionary
  // word ("sonata"). Without a contextual model, never auto-apply this class.
  if (oneSubstitution(a, b)) {
    // Long adjacent-key slips are sparse enough to be useful mechanically;
    // short ones remain contextual (`somata`/`sonata`).
    if (a.length >= 8 && keyboardAdjacentSubstitution(a, b)) return 88;
    return 34;
  }

  const removed = oneRemoval(a, b);
  if (removed != null) {
    const c = a[removed];
    if (a[removed - 1] === c || a[removed + 1] === c) return 98;
    return 56;
  }
  const inserted = oneRemoval(b, a);
  if (inserted != null) {
    const c = b[inserted];
    if (b[inserted - 1] === c || b[inserted + 1] === c) return 94;
    return 58;
  }
  const distance = damerauLevenshtein(a, b);
  return distance === 1 ? 62 : distance === 2 ? 26 : 0;
}

function chooseSpelling(
  original: string,
  suggestions: string[],
  projectWords: ReadonlySet<string>,
): string | null {
  const ranked = suggestions
    .filter((s) => s && s !== original && WORDISH.test(s) && !s.includes(" "))
    .map((replacement, index) => {
      const mechanical = mechanicalScore(original, replacement);
      const sameLength = original.length === replacement.length ? 8 : 0;
      const project = projectWords.has(replacement.toLocaleLowerCase()) ? 32 : 0;
      const order = Math.max(0, 6 - index * 2);
      return { replacement, mechanical, score: mechanical + sameLength + project + order };
    })
    .filter((c) => c.mechanical > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const [best, second] = ranked;
  if (projectWords.has(best.replacement.toLocaleLowerCase()) && best.mechanical >= 56) return best.replacement;
  if (adjacentTransposition(original.toLocaleLowerCase(), best.replacement.toLocaleLowerCase())) return best.replacement;
  // A long, dominant adjacent-key substitution is still safely mechanical.
  // Insertions/deletions are deferred because even one edit can change valid
  // scientific morphology (`hypothalamic`/`hypothalami`) or choose the wrong
  // ordinary word (`loger`/`logger`/`longer`).
  if (
    lettersOnly(original).length >= 7 &&
    oneSubstitution(original.toLocaleLowerCase(), best.replacement.toLocaleLowerCase()) &&
    keyboardAdjacentSubstitution(original, best.replacement) &&
    best.score >= 88 &&
    (!second || best.score - second.score >= 14)
  ) return best.replacement;
  return null;
}

export function planLocalCorrections(
  source: string,
  lints: readonly LocalLintRecord[],
  options: {
    blockedPairs?: ReadonlySet<string>;
    projectWords?: ReadonlySet<string>;
    explicitWords?: readonly string[];
  } = {},
): PlannedLocalCorrection[] {
  const blocked = options.blockedPairs ?? new Set<string>();
  const projectWords = options.projectWords ?? new Set<string>();
  const explicitWords = options.explicitWords ?? [];
  const explicitKeys = new Set(explicitWords.map((word) => word.toLocaleLowerCase()));
  const protectedRanges = protectedMarkdownRanges(source);
  const plans = planExplicitVocabularyCorrections(source, explicitWords, blocked);

  for (const lint of [...lints].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (plans.length >= 6) break;
    if (lint.from < 0 || lint.to <= lint.from || lint.to > source.length) continue;
    if (source.slice(lint.from, lint.to) !== lint.problem) continue;
    if (overlapsProtected(lint.from, lint.to, protectedRanges)) continue;
    if (plans.some((p) => lint.from < p.to && lint.to > p.from)) continue;
    if (explicitKeys.has(lint.problem.toLocaleLowerCase())) continue;
    if (looksTechnical(lint.problem) || !WORDISH.test(lint.problem)) continue;

    const suggestions = [...new Set(lint.suggestions.map((s) => s.trim()))].filter(
      (s) => s && s.length <= 48 && WORDISH.test(s),
    );
    let replacement: string | null = null;
    let kind: PlannedLocalCorrection["kind"] = "typo";

    if (lint.kind === "WordChoice" || lint.kind === "BoundaryError") {
      const parts = lint.problem.trim().split(/\s+/);
      if (
        suggestions.length === 1 &&
        lint.partsAreKnown !== true &&
        parts.some((part) => part.length <= 3) &&
        lettersOnly(lint.problem) === lettersOnly(suggestions[0]) &&
        lint.problem !== suggestions[0]
      ) {
        replacement = suggestions[0];
        kind = "spacing";
      }
    } else if (lint.kind === "Typo") {
      if (suggestions.length === 1) {
        const candidate = suggestions[0];
        const safeSplit =
          !/\s/.test(candidate) ||
          // Missing spaces next to very short function words ("objectis")
          // are mechanical. Open/closed scientific compounds ("timepoint",
          // "brainstem", "wildtype") and nonsense fragments such as
          // "bi logical" are editorial/model questions, not local fixes.
          (lint.partsAreKnown !== true && safeTypoBoundary(lint.problem, candidate));
        const locallyKnown = projectWords.has(candidate.toLocaleLowerCase());
        const mechanicalTypo = /\s/.test(candidate)
          ? safeSplit
          : adjacentTransposition(lint.problem.toLocaleLowerCase(), candidate.toLocaleLowerCase()) || locallyKnown;
        if (safeSplit && mechanicalTypo) {
          replacement = candidate;
          kind = /\s/.test(lint.problem + candidate) ? "spacing" : "typo";
        }
      }
    } else if (lint.kind === "Spelling") {
      // Short function words carry scientific meaning out of proportion to
      // their size (not/no/nor). Harper's dedicated Typo rules still handle
      // transpositions such as "teh"; generic spelling never touches them.
      replacement = lettersOnly(lint.problem).length <= 3
        ? null
        : chooseSpelling(lint.problem, suggestions, projectWords);
      kind = "spelling";
    }

    if (!replacement || replacement === lint.problem) continue;
    if (looksTechnical(replacement) || blocked.has(correctionPairKey(lint.problem, replacement))) continue;
    // This first local tier never changes punctuation, case alone, or more than
    // two edit operations. Phrase-level intent belongs to the future model tier.
    if (lettersOnly(lint.problem) === lettersOnly(replacement)) {
      // spacing/transposition is allowed
    } else if (damerauLevenshtein(lint.problem, replacement) > 2) {
      continue;
    }

    plans.push({
      from: lint.from,
      to: lint.to,
      original: lint.problem,
      replacement,
      kind,
      message: lint.message,
    });
  }
  return plans;
}

function vocabularyTokenIsTechnical(token: string): boolean {
  return /\d/.test(token) || /[a-z][A-Z]|[A-Z][a-z]+[A-Z]/.test(token) || /^[A-Z]{2,12}$/.test(token);
}

/**
 * Build an on-device project lexicon. Mixed-case/acronym/digit terms are
 * protected immediately; ordinary lowercase terms must recur three times so a
 * single typo is never learned merely because it exists in the manuscript.
 */
export function extractProjectVocabulary(sources: readonly string[]): string[] {
  const counts = extractProjectVocabularyOccurrences(sources);
  return [...counts.values()]
    .filter(({ exemplar, n }) => vocabularyTokenIsTechnical(exemplar) || (exemplar.length >= 4 && n >= 3))
    .map(({ exemplar }) => exemplar)
    .slice(0, 4000);
}

export function extractProjectVocabularyOccurrences(
  sources: readonly string[],
): Map<string, { exemplar: string; n: number }> {
  const counts = new Map<string, { exemplar: string; n: number }>();
  for (const source of sources) {
    for (const match of source.matchAll(TOKEN_RE)) {
      const token = match[0].replace(/^[-_]+|[-_]+$/g, "");
      if (token.length < 2 || token.length > 48) continue;
      const key = token.toLocaleLowerCase();
      const cur = counts.get(key);
      counts.set(key, { exemplar: cur?.exemplar ?? token, n: (cur?.n ?? 0) + 1 });
    }
  }
  return counts;
}
