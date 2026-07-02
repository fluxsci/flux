// Pure find-in-document core for the PDF reader (LR-6). No pdf.js / DOM here so it unit-tests
// cleanly; PdfView.svelte supplies per-page plain text (from pdf.js getTextContent) and turns
// the returned char ranges into on-page highlights via the same quote-anchor machinery used for
// annotations (makeQuoteAnchor + locateQuote), which bridges the small differences between the
// extracted text and the rendered text layer.

export interface PageText {
  page: number; // 1-based
  text: string;
}
export interface SearchMatch {
  page: number;
  start: number; // char offset into that page's text
  end: number;
}

/** Minimum query length — single characters match almost everything and flood the overlay. */
export const MIN_QUERY = 2;

/** Case-insensitive, length-preserving fold so match offsets map back onto the raw page text
 *  (which is what the highlight anchoring needs). Locale-lowercasing can change length for a few
 *  code points; we accept that rare skew because the highlight locator (locateQuote) is fuzzy. */
const fold = (s: string) => s.toLowerCase();

/** All occurrences of `query` across the given pages, ordered by page then position. Overlapping
 *  matches are not produced (search resumes past each hit). Returns [] for a too-short/blank query. */
export function findMatchesInPages(pages: PageText[], query: string): SearchMatch[] {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];
  const needle = fold(q);
  const out: SearchMatch[] = [];
  const ordered = [...pages].sort((a, b) => a.page - b.page);
  for (const { page, text } of ordered) {
    if (!text) continue;
    const hay = fold(text);
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      out.push({ page, start: at, end: at + q.length });
      from = at + q.length; // non-overlapping
    }
  }
  return out;
}

/** Next active-match index given a navigation step. `total` 0 → -1 (nothing to point at). */
export function stepIndex(total: number, current: number, dir: "first" | "next" | "prev"): number {
  if (total <= 0) return -1;
  if (dir === "first" || current < 0) return 0;
  if (dir === "next") return (current + 1) % total;
  return (current - 1 + total) % total; // prev, wrapping
}
