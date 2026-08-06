// Type surface of electron/captureRules.js. Keep in sync with its exports.

/** A metadata-only capture (the `.fluxcap` sidecar the bookmarklet writes when no PDF was
 *  reachable — see src/shell/modes/library/bookmarklet.ts). */
export interface FluxCapture {
  v: 1;
  /** The page the capture was taken from. */
  url: string;
  /** Bare DOI ("10.1126/science.aah5982"), or "" when the page exposed none. */
  doi: string;
  /** citation_title / dc.title / document.title — the fallback identification signal. */
  title: string;
  /** The PDF the page advertised, if any: Flux can still try it through the proxy engine. */
  pdfUrl: string;
  /** Why it fell back to metadata: "no-pdf-on-page" | "pdf-fetch-blocked". */
  reason: string;
  capturedAt: string;
}

export const CAPTURE_PREFIX: string;
export const CAPTURE_EXT: string;
export const SUPP_PREFIX: string;
export const SUPP_SEP: string;
export function captureSlug(s: string): string;
export function isCaptureFile(name: string): boolean;
export function isSupplementCapture(name: string): boolean;
/** `flux-supp-<slug>@@<name>` → { slug, name }, or null. */
export function parseSupplementCapture(fileName: string): { slug: string; name: string } | null;
/** Best-effort inverse of captureSlug for DOI-shaped slugs ("" when not DOI-shaped). */
export function doiFromSlug(slug: string): string;
export function parseFluxCapture(text: string | null | undefined): FluxCapture | null;
