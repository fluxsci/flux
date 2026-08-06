// The web-capture payload — what the Flux bookmarklet hands back from a paper page.
//
// The bookmarklet's whole job is to put BYTES on disk from inside your logged-in browser,
// because that browser is the most capable acquisition engine available: it is already past
// the paywall, already holds the session cookies, and is indistinguishable from a human to
// the anti-bot walls (Cloudflare, PerimeterX) that Flux's own headless capture cannot pass.
// Re-fetching a URL server-side throws all of that away.
//
// Two shapes come out of a capture, and the file EXTENSION says which:
//   flux-<slug>.pdf      the article itself, fetched in-page with credentials. Routed into
//                        pdfs_to_assign/, where the existing identifier matches it to a
//                        reference from its own content (measured 92% attach, 0 misassign).
//   flux-<slug>.fluxcap  this JSON, when the page exposes no PDF or the page's CSP blocked
//                        the fetch. Flux resolves it by DOI, falling back to the URL.

/** A metadata-only capture (the `.fluxcap` sidecar). */
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
  /** Why we fell back to metadata: "no-pdf-on-page" | "pdf-fetch-blocked". */
  reason: string;
  capturedAt: string;
}

/** Filenames the capture flow produces. Flux watches the download folder for this prefix
 *  ONLY, so an ordinary download can never be mistaken for a capture. */
export const CAPTURE_PREFIX = "flux-";
export const CAPTURE_EXT = ".fluxcap";

/** True if `name` is a file the bookmarklet produced (either shape). */
export function isCaptureFile(name: string): boolean {
  const n = String(name || "");
  return n.startsWith(CAPTURE_PREFIX) && (/\.pdf$/i.test(n) || n.endsWith(CAPTURE_EXT));
}

/** Parse a `.fluxcap`, tolerating anything malformed — a stray file in the watched folder
 *  must never throw into the watcher. Returns null when it isn't a usable capture. */
export function parseFluxCapture(text: string | null | undefined): FluxCapture | null {
  try {
    const j = JSON.parse(String(text ?? "")) as Partial<FluxCapture>;
    if (!j || typeof j !== "object") return null;
    const url = typeof j.url === "string" ? j.url : "";
    const doi = typeof j.doi === "string" ? j.doi : "";
    if (!url && !doi) return null; // nothing to resolve
    return {
      v: 1,
      url,
      doi,
      title: typeof j.title === "string" ? j.title : "",
      pdfUrl: typeof j.pdfUrl === "string" ? j.pdfUrl : "",
      reason: typeof j.reason === "string" ? j.reason : "",
      capturedAt: typeof j.capturedAt === "string" ? j.capturedAt : "",
    };
  } catch {
    return null;
  }
}
