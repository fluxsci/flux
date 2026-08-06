// Web-capture file rules — the contract between the bookmarklet (which writes the files) and
// the watcher/intake (which consumes them). ONE definition, because a second copy is exactly
// how the supplement filter rotted: main.cjs classified downloads with its own regex while the
// renderer used another, and nothing would have caught them drifting apart.
//
// Dependency-free ESM under electron/, because the Electron main process runs unbundled and
// `src/` is excluded from the packaged app, so main can only load from here — and it must be
// ESM rather than .cjs since the renderer imports it too (Vite serves a source .cjs verbatim,
// so `module.exports` never runs in a browser).

/** Filenames the bookmarklet produces. The watcher acts on this prefix ONLY, so an ordinary
 *  download can never be mistaken for a capture and nothing of the user's is touched. */
export const CAPTURE_PREFIX = "flux-";
export const CAPTURE_EXT = ".fluxcap";

/** True if `name` is a file the bookmarklet produced (either shape). Bare `flux-.pdf` does
 *  not count — there must be a slug between the prefix and the extension. */
export function isCaptureFile(name) {
  return /^flux-.+\.(pdf|fluxcap)$/i.test(String(name || ""));
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
