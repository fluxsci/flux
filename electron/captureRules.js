// Web-capture file rules — the contract between the bookmarklet (which writes the files) and
// the watcher/intake (which consumes them). ONE definition, because a second copy is exactly
// how the supplement filter rotted: main.cjs classified downloads with its own regex while the
// renderer used another, and nothing would have caught them drifting apart.
//
// Dependency-free ESM under electron/, because the Electron main process runs unbundled and
// `src/` is excluded from the packaged app, so main can only load from here — and it must be
// ESM rather than .cjs since the renderer imports it too (Vite serves a source .cjs verbatim,
// so `module.exports` never runs in a browser).

/** Filenames capture produces. The watcher acts on this prefix ONLY, so an ordinary download
 *  can never be mistaken for a capture and nothing of the user's is touched. */
export const CAPTURE_PREFIX = "flux-";
export const CAPTURE_EXT = ".fluxcap";
export const SUPP_PREFIX = "flux-supp-";
/** Separator between a supplement's paper-slug and its own filename. "@@" is safe BY
 *  CONSTRUCTION: captureSlug() maps every character outside [A-Za-z0-9._-] to "_", so neither
 *  side can contain it and splitting on the first occurrence is exact. */
export const SUPP_SEP = "@@";

/** The filename-safe form of a DOI (or fallback id). Shared by every producer so the
 *  receiver can map a captured file back to its paper. */
export function captureSlug(s) {
  return String(s || "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 110);
}

/** True if `name` is a file capture produced (article, sidecar, or supplement). Bare
 *  `flux-.pdf` does not count — there must be a slug between the prefix and the extension. */
export function isCaptureFile(name) {
  const n = String(name || "");
  // A `flux-supp-` name is judged ONLY by the supplement rule. Without this a malformed one
  // ("flux-supp-@@x.pdf") would fall through to the article rule and be filed as a paper.
  if (n.toLowerCase().startsWith(SUPP_PREFIX)) return isSupplementCapture(n);
  return /^flux-.+\.(pdf|fluxcap)$/i.test(n);
}

/** True if `name` is a captured SUPPLEMENT (`flux-supp-<paperSlug>@@<filename>`). Supplements
 *  can be any file type — .pdf, .docx, .xlsx, .mov, .zip — so the extension isn't constrained. */
export function isSupplementCapture(name) {
  const n = String(name || "");
  if (!n.toLowerCase().startsWith(SUPP_PREFIX)) return false;
  const rest = n.slice(SUPP_PREFIX.length);
  const at = rest.indexOf(SUPP_SEP);
  return at > 0 && rest.length > at + SUPP_SEP.length;
}

/** Split a supplement capture into { slug, name }, or null if it isn't one. `slug` is the
 *  filename-safe DOI of the paper it belongs to; `name` is the publisher's own filename. */
export function parseSupplementCapture(fileName) {
  const n = String(fileName || "");
  if (!isSupplementCapture(n)) return null;
  const rest = n.slice(SUPP_PREFIX.length);
  const at = rest.indexOf(SUPP_SEP);
  return { slug: rest.slice(0, at), name: rest.slice(at + SUPP_SEP.length) };
}

/** Recover the DOI a slug was made from, when the slug looks like one. Sanitizing is lossy
 *  ("/" became "_"), so this is a best-effort inverse: DOIs are `10.NNNN/suffix`, and the
 *  FIRST "_" after the registrant prefix is the slash. Returns "" when it isn't DOI-shaped. */
export function doiFromSlug(slug) {
  const m = /^(10\.\d{4,9})_(.+)$/.exec(String(slug || ""));
  return m ? `${m[1]}/${m[2]}` : "";
}

/** Parse a `.fluxcap`, tolerating anything malformed — a stray file in the watched folder
 *  must never throw into the watcher. Returns null when it isn't a usable capture. */
export function parseFluxCapture(text) {
  try {
    const j = JSON.parse(String(text ?? ""));
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
