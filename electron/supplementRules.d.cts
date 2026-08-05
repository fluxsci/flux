// Type surface of electron/supplementRules.cjs for the TypeScript consumers
// (flux-core/items.ts, src/lib/references/supplement.ts, verify scripts).
// Keep in sync with the .cjs exports.

/** A scraped PDF affordance from a publisher article page. */
export interface PdfCandidate {
  /** Absolute URL, already EZProxy host-rewritten. Absent for click-only buttons. */
  url?: string;
  /** CSS selector for a click-only affordance (a button with no href). */
  sel?: string;
  /** How it was found: citation_pdf_url | link-pdf | elsevier-json | anchor-href | anchor-text | button | … */
  kind: string;
  /** Human-readable label from the page (used to name captured supplements). */
  label?: string;
}

/** Signals extracted from an already-downloaded PDF, for the content-level check. */
export interface SupplementDocInput {
  /** Embedded Title (XMP dc:title or Info /Title). */
  title?: string;
  /** Extracted text of page 1. */
  page1Text?: string;
  /** The URL the bytes actually came from, AFTER redirects. */
  finalUrl?: string;
}

/** True if `u` looks like a supplementary/supporting file rather than the article itself. */
export function isSupplementUrl(u: string | null | undefined): boolean;

/**
 * Decide whether an already-downloaded PDF is supplementary material.
 * Returns a short machine-readable reason (e.g. "supplement-url",
 * "supplementary-material-for", "mdar-checklist"), or null if it looks like an article.
 */
export function supplementDocSignal(input?: SupplementDocInput): string | null;

/** Score a candidate — higher is more likely to be the article. */
export function scoreCandidate(c: PdfCandidate, doi?: string): number;

/** True if `url` is the canonical main-text PDF endpoint for `doi`. */
export function isMainPdfUrl(url: string | null | undefined, doi?: string): boolean;

/** Split candidates into best-first main-PDF attempts and the supplements. */
export function partitionCandidates(
  candidates: PdfCandidate[],
  doi?: string,
): { main: PdfCandidate[]; supplements: PdfCandidate[] };

/** A readable filename derived from a supplement URL ("" if nothing usable). */
export function supplementNameFromUrl(u: string | null | undefined): string;

export const SUPPLEMENT_URL_PATTERNS: RegExp[];
export const SUPPLEMENT_DOC_PATTERNS: Array<{ rx: RegExp; why: string }>;
