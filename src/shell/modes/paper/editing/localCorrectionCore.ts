// Pure planning for Paper's local correction fabric. Harper finds candidate
// lints; this module decides which tiny subset is safe enough to apply without
// asking. It deliberately knows nothing about CodeMirror, workers, or storage
// so the scientific-safety contract is cheap to test exhaustively.

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

export function correctionPairKey(original: string, replacement: string): string {
  return `${original.toLocaleLowerCase()}\u0000${replacement.toLocaleLowerCase()}`;
}

export function extractCorrectionWindow(
  doc: string,
  head: number,
  maxLength = 480,
): CorrectionWindow | null {
  let to = Math.max(0, Math.min(head, doc.length));
  while (to > 0 && /\s/.test(doc[to - 1])) to -= 1;
  if (to === 0) return null;

  const floor = Math.max(0, to - maxLength);
  let from = floor;
  for (let i = to - 1; i > floor; i -= 1) {
    // A blank line is a hard prose-block boundary.
    if (doc[i] === "\n" && doc[i - 1] === "\n") {
      from = i + 1;
      break;
    }
    // Keep only the current sentence. Closing quotes/brackets may sit between
    // punctuation and whitespace, so walk over them before checking.
    if (/\s/.test(doc[i])) {
      let j = i - 1;
      while (j >= floor && /["'’\])}]/.test(doc[j])) j -= 1;
      if (j >= floor && /[.!?]/.test(doc[j]) && j < to - 1) {
        from = i + 1;
        break;
      }
    }
  }

  while (from < to && /[\s>#*-]/.test(doc[from])) from += 1;
  const text = doc.slice(from, to);
  return text.length >= 3 && LETTER.test(text) ? { from, to, text } : null;
}

function lettersOnly(s: string): string {
  return [...s]
    .filter((c) => /[\p{L}\p{M}]/u.test(c))
    .join("")
    .toLocaleLowerCase();
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

function oneSubstitution(a: string, b: string): boolean {
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

function looksTechnical(token: string): boolean {
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

  let lineFrom = 0;
  for (const line of text.split("\n")) {
    if (line.includes("|") || /^\s*(?:```|~~~)/.test(line)) {
      out.push([lineFrom, lineFrom + line.length]);
    }
    lineFrom += line.length + 1;
  }
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

function mechanicalScore(original: string, replacement: string): number {
  const a = original.toLocaleLowerCase();
  const b = replacement.toLocaleLowerCase();
  if (adjacentTransposition(a, b)) return 110;
  // Arbitrary one-letter substitutions are especially dangerous in science:
  // valid terms such as "somata" can sit one key from a common dictionary
  // word ("sonata"). Without a contextual model, never auto-apply this class.
  if (oneSubstitution(a, b)) return 34;

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
  if (best.mechanical >= 94) return best.replacement;
  if (best.score < 62) return null;
  if (second && best.score - second.score < 14) return null;
  return best.replacement;
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
        const splitParts = candidate.trim().split(/\s+/);
        const safeSplit =
          splitParts.length === 1 ||
          // Missing spaces next to very short function words ("objectis")
          // are mechanical. Open/closed scientific compounds ("timepoint",
          // "brainstem", "wildtype") are editorial choices, not typos.
          (lint.problem.replace(/\s/g, "").length >= 6 && splitParts.some((part) => part.length <= 2));
        if (
          safeSplit &&
          (lettersOnly(lint.problem) === lettersOnly(candidate) ||
            damerauLevenshtein(lint.problem, candidate) <= 2)
        ) {
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
  return [...counts.values()]
    .filter(({ exemplar, n }) => vocabularyTokenIsTechnical(exemplar) || (exemplar.length >= 4 && n >= 3))
    .map(({ exemplar }) => exemplar)
    .slice(0, 4000);
}
