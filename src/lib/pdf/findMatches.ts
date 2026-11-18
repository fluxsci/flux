// Find-in-document result shapes + the pure grouping the reader's Search pane renders.
// PdfView produces the flat match list (read off pdf.js's own scan, so the list can
// never disagree with what the viewer highlights); this module decides how the list is
// labelled and bucketed for display.

/** One find hit, with enough surrounding text for a sidebar result row. */
export interface FindMatch {
  /** Position in document order — the same index the find controller reports. */
  index: number;
  page: number;
  /** Which hit this is WITHIN its page — how PdfView.goToMatch steps to it. */
  matchInPage: number;
  before: string;
  hit: string;
  after: string;
}

/** An outline entry resolved to the page it lands on. */
export interface OutlineSection {
  title: string;
  page: number;
}

export interface MatchGroup {
  /** Section title, or "Page N" when the PDF has no usable outline. */
  label: string;
  /** Page of the group's first match — shown as the group's page hint. */
  page: number;
  matches: FindMatch[];
}

/**
 * Bucket matches for display: under the outline section they fall in (the last section
 * starting at or before the match's page), else one group per page. Consecutive matches
 * in the same bucket collapse into one group, so the list reads in document order.
 *
 * A PDF whose outline starts after page 1 (a cover page, an unlabelled abstract) still
 * groups its early matches — they fall under a leading "Page N" bucket rather than being
 * dropped or forced into the first named section.
 */
export function groupMatches(matches: FindMatch[], sections: OutlineSection[] = []): MatchGroup[] {
  const sorted = [...sections].filter((s) => s.title.trim() && s.page >= 1).sort((a, b) => a.page - b.page);
  const labelFor = (page: number): string => {
    let found = "";
    for (const s of sorted) {
      if (s.page > page) break;
      found = s.title.trim();
    }
    return found || `Page ${page}`;
  };
  const out: MatchGroup[] = [];
  for (const m of matches) {
    const label = labelFor(m.page);
    const tail = out[out.length - 1];
    if (tail && tail.label === label) tail.matches.push(m);
    else out.push({ label, page: m.page, matches: [m] });
  }
  return out;
}

/**
 * PDF.js searches a NORMALIZED copy of each page's text (`_pageContents`: NFD, line ends as
 * spaces, hyphenated line breaks joined, ligatures expanded) and reports each match in the
 * ORIGINAL text layer's offsets (`pageMatches`), because those are what it highlights. The two
 * differ wherever normalization added or removed a character, and it records how in
 * `_pageDiffs[page] = [starts, shifts]`: from normalized index `starts[i]` on,
 * original = normalized + `shifts[i]`.
 *
 * A snippet is cut from the normalized text, so a match's offsets must be taken BACK through
 * that table first. Cutting at the original offsets drifted a character per ligature or
 * joined hyphen: by mid-page the highlighted letters in the Search pane were the wrong ones
 * ("rns of c" for "cortical"; owner, 2026-11-18).
 */
export type PdfPageDiffs = readonly [ArrayLike<number>, ArrayLike<number>] | null | undefined;
/** The segment a scan should start near: the last one whose first original index is ≤ `original`. */
function segmentNear(starts: ArrayLike<number>, shifts: ArrayLike<number>, original: number): number {
  let lo = 0, hi = starts.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] + shifts[mid] <= original) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
/** The normalized index where the text at original offset `original` begins. */
export function normalizedStart(diffs: PdfPageDiffs, original: number): number {
  if (!diffs || !diffs[0].length) return original;
  const [starts, shifts] = diffs;
  // Several normalized characters can stand for one original one (an expanded ligature): the
  // start is the FIRST of them, so look from a little before the segment the search lands in.
  for (let i = Math.max(0, segmentNear(starts, shifts, original) - 2); i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const n = Math.max(original - shifts[i], starts[i]);
    if (n < end) return n;
  }
  return original - shifts[shifts.length - 1];
}
/** The normalized index of the LAST character of text ending at original offset `original`. */
export function normalizedEnd(diffs: PdfPageDiffs, original: number): number {
  if (!diffs || !diffs[0].length) return original;
  const [starts, shifts] = diffs;
  for (let i = Math.min(starts.length - 1, segmentNear(starts, shifts, original) + 2); i >= 0; i--) {
    const end = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const n = Math.min(original - shifts[i], end - 1);
    if (n >= starts[i]) return n;
  }
  return original;
}

/** Version-isolated adapter for PDF.js's match arrays. Descriptors are rebuilt
 * only for changed pages; snippet strings are lazy so invisible hits cost no
 * slicing/regex work. A query change invalidates all page identities. */
export interface PdfFindSnapshot { pageMatches?: number[][]; pageMatchesLength?: number[][]; _pageContents?: string[]; _pageDiffs?: PdfPageDiffs[] }
/** Characters of context on each side of a hit. */
export const FIND_CONTEXT = 44;
export function createFindMatchCollector() {
  const noMatches: number[] = [];
  let query: unknown;
  let cached: { offsets: number[]; lengths: number[] | undefined; text: string; diffs: PdfPageDiffs; rows: FindMatch[] }[] = [];
  let result: FindMatch[] = [];
  return (snapshot: PdfFindSnapshot | null, queryIdentity: unknown): FindMatch[] => {
    if (queryIdentity !== query) { query = queryIdentity; cached = []; result = []; }
    if (!snapshot?.pageMatches || !snapshot._pageContents) return [];
    // The FIRST page whose descriptors changed. Everything before it keeps both
    // its rows and its indices, so only the tail is rebuilt: pdf.js reports its
    // scan page by page, and rebuilding the whole list on every report made the
    // cost quadratic in page count (300 pages × 305 hits: 13.8M row visits,
    // 1.05s here and 2.9s on a CI runner, against a 2s budget). Appending only
    // the new page's rows makes the same scan linear.
    let firstDirty = cached.length === snapshot.pageMatches.length ? -1 : Math.min(cached.length, snapshot.pageMatches.length);
    for (let page = 0; page < snapshot.pageMatches.length; page++) {
      const offsets = snapshot.pageMatches[page] ?? noMatches;
      const lengths = snapshot.pageMatchesLength?.[page];
      const text = snapshot._pageContents[page] ?? "";
      const diffs = snapshot._pageDiffs?.[page];
      const prior = cached[page];
      if (prior && prior.offsets === offsets && prior.lengths === lengths && prior.text === text && prior.diffs === diffs) continue;
      if (firstDirty < 0 || page < firstDirty) firstDirty = page;
      const rows = offsets.map((start, matchInPage) => {
        const length = lengths?.[matchInPage] ?? 0;
        let snippets: { before: string; hit: string; after: string } | undefined;
        const snippet = () => snippets ??= (() => {
          // The match, in the text the snippet is cut from (see PdfPageDiffs).
          const b = length > 0 ? normalizedEnd(diffs, start + length - 1) + 1 : normalizedStart(diffs, start);
          let a = Math.min(normalizedStart(diffs, start), b);
          // A match that begins on a joined line break can map onto the space before it.
          while (a < b && /\s/.test(text[a])) a++;
          return { before: text.slice(Math.max(0, a - FIND_CONTEXT), a).replace(/\s+/g, " "), hit: text.slice(a, b), after: text.slice(b, b + FIND_CONTEXT).replace(/\s+/g, " ") };
        })();
        return { index: 0, page: page + 1, matchInPage, get before() { return snippet().before; }, get hit() { return snippet().hit; }, get after() { return snippet().after; } };
      });
      cached[page] = { offsets, lengths, text, diffs, rows };
    }
    cached.length = snapshot.pageMatches.length;
    if (firstDirty >= 0) {
      // Rows of the untouched prefix keep the indices they already have; the
      // array is reused, which callers already rely on (an unchanged scan has
      // always returned the same instance).
      let head = 0;
      for (let page = 0; page < firstDirty; page++) head += cached[page].rows.length;
      result.length = head;
      for (let page = firstDirty; page < cached.length; page++) {
        const rows = cached[page].rows;
        for (let i = 0; i < rows.length; i++) { rows[i].index = result.length; result.push(rows[i]); }
      }
    }
    return result;
  };
}
