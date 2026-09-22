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

/** Version-isolated adapter for PDF.js's match arrays. Descriptors are rebuilt
 * only for changed pages; snippet strings are lazy so invisible hits cost no
 * slicing/regex work. A query change invalidates all page identities. */
export interface PdfFindSnapshot { pageMatches?: number[][]; pageMatchesLength?: number[][]; _pageContents?: string[] }
export function createFindMatchCollector() {
  const noMatches: number[] = [];
  let query: unknown;
  let cached: { offsets: number[]; lengths: number[] | undefined; text: string; rows: FindMatch[] }[] = [];
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
      const prior = cached[page];
      if (prior && prior.offsets === offsets && prior.lengths === lengths && prior.text === text) continue;
      if (firstDirty < 0 || page < firstDirty) firstDirty = page;
      const rows = offsets.map((start, matchInPage) => {
        const length = lengths?.[matchInPage] ?? 0;
        let snippets: { before: string; hit: string; after: string } | undefined;
        const snippet = () => snippets ??= { before: text.slice(Math.max(0, start - 44), start).replace(/\s+/g, " "), hit: text.slice(start, start + length), after: text.slice(start + length, start + length + 44).replace(/\s+/g, " ") };
        return { index: 0, page: page + 1, matchInPage, get before() { return snippet().before; }, get hit() { return snippet().hit; }, get after() { return snippet().after; } };
      });
      cached[page] = { offsets, lengths, text, rows };
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
