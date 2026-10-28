// Harper-only spelling diagnostics. This module never changes manuscript text;
// accepting a suggestion is an explicit user edit in the controller.
import { damerauLevenshtein, protectedMarkdownRanges, type LocalLintRecord } from "./localCorrectionCore";

export interface SpellingCandidate {
  from: number;
  to: number;
  original: string;
  suggestions: string[];
}

export function spellingIssueId(from: number, to: number, original: string): string {
  return `spelling-${from}-${to}-${original}`;
}

export function normalizeSpellingCandidates(
  source: string,
  records: readonly LocalLintRecord[],
  words: readonly string[] = [],
): SpellingCandidate[] {
  const known = new Set(words.map((word) => word.toLocaleLowerCase()));
  const protectedRanges = protectedMarkdownRanges(source);
  const out: SpellingCandidate[] = [];
  for (const record of records) {
    const { from, to } = record;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > source.length) continue;
    if (protectedRanges.some(([a, b]) => from < b && to > a)) continue;
    const original = source.slice(from, to);
    if (record.problem !== original || (/spelling|typo/i.test(record.kind) && known.has(original.toLocaleLowerCase()))) continue;
    // Only spelling/typo diagnostics can teach unconditional word mappings.
    // Grammar and capitalization choices depend on sentence position (a/an,
    // the/The) and must never become global aliases.
    if (!/^(?:Spelling|Typo)$/.test(record.kind) || !/^[\p{L}\p{M}\d][\p{L}\p{M}\d_'’.-]{0,63}$/u.test(original)) continue;
    const suggestions = [...new Set([...record.suggestions, ...(record.rescueSuggestions ?? [])])]
      .filter((word) => word !== original && /^[\p{L}\p{M}\d][\p{L}\p{M}\d_'’.-]{0,63}$/u.test(word))
      .map((word, index) => ({ word, index, distance: damerauLevenshtein(original.toLocaleLowerCase(), word.toLocaleLowerCase()) }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, 5).map((item) => item.word);
    const existing = out.find((candidate) => candidate.from === from && candidate.to === to);
    if (existing) existing.suggestions = [...new Set([...existing.suggestions, ...suggestions])].slice(0, 5);
    else out.push({ from, to, original, suggestions });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
