// Pure annotation model + text-quote anchoring for FluxReader. Highlights/notes are
// stored per paper in items/<citekey>/annotations.json and anchored by quote+prefix+
// suffix (a W3C TextQuoteSelector — the Hypothesis approach), so they survive re-render
// and zoom: located in the pdf.js text layer at render time, NOT by stored pixel coords.
// No I/O / no DOM here (browser+node safe); the reader maps the located char range to
// DOM rects, and flux-core reads/searches the JSON.
import search from "approx-string-match";

export interface TextQuoteSelector {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface Annotation {
  id: string;
  page: number; // 1-based
  anchor: TextQuoteSelector;
  color: string; // highlight color token, e.g. "yellow" | "green" | "blue" | "pink"
  note?: string;
  tags?: string[];
  createdAt: string; // ISO
}

export interface AnnotationFile {
  version: 1;
  annotations: Annotation[];
}

export const ANNOTATION_COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export const emptyAnnotationFile = (): AnnotationFile => ({ version: 1, annotations: [] });

const CTX = 40;

/** Build a quote anchor from a page's text + a char range [start,end). */
export function makeQuoteAnchor(pageText: string, start: number, end: number): TextQuoteSelector {
  return {
    quote: pageText.slice(start, end),
    prefix: pageText.slice(Math.max(0, start - CTX), start),
    suffix: pageText.slice(end, Math.min(pageText.length, end + CTX)),
  };
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Locate an anchor's quote within a page's text → { start, end } char offsets, or null.
 * Exact matches first (disambiguated by prefix/suffix overlap), then a fuzzy fallback
 * (approx-string-match, ≤25% edit distance) — robust to pdf.js text extraction quirks.
 */
export function locateQuote(pageText: string, a: TextQuoteSelector): { start: number; end: number } | null {
  const q = a.quote;
  if (!q || !pageText) return null;

  const exact: number[] = [];
  for (let i = pageText.indexOf(q); i !== -1; i = pageText.indexOf(q, i + 1)) exact.push(i);

  if (exact.length === 1) return { start: exact[0], end: exact[0] + q.length };
  if (exact.length > 1) {
    let bestStart = exact[0];
    let bestScore = -1;
    for (const s of exact) {
      const pre = pageText.slice(Math.max(0, s - a.prefix.length), s);
      const suf = pageText.slice(s + q.length, s + q.length + a.suffix.length);
      const score = commonSuffix(pre, a.prefix) + commonPrefix(suf, a.suffix);
      if (score > bestScore) {
        bestScore = score;
        bestStart = s;
      }
    }
    return { start: bestStart, end: bestStart + q.length };
  }

  // fuzzy
  const maxErrors = Math.max(1, Math.floor(q.length * 0.25));
  const matches = search(pageText, q, maxErrors);
  if (!matches.length) return null;
  const best = matches.sort((x, y) => x.errors - y.errors)[0];
  return { start: best.start, end: best.end };
}

/** Library/within-paper search predicate over an annotation's text. */
export function annotationMatches(a: Annotation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [a.anchor.quote, a.note ?? "", (a.tags ?? []).join(" ")].join(" ").toLowerCase().includes(q);
}
