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
