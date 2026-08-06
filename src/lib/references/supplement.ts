// The renderer/TypeScript face of the main-text-vs-supplement rules.
//
// The rules themselves live in electron/supplementRules.js — dependency-free ESM, under
// electron/ because the Electron main process runs unbundled and can only load from there
// (src/ is excluded from the packaged app; see electron-builder.yml). Re-exporting them here
// rather than reimplementing them is the whole point: the capture engine and the write-time
// check must never disagree about what a supplement is.
export {
  isSupplementUrl,
  supplementDocSignal,
  scoreCandidate,
  isMainPdfUrl,
  partitionCandidates,
  supplementNameFromUrl,
} from "../../../electron/supplementRules.js";
export type { PdfCandidate, SupplementDocInput } from "../../../electron/supplementRules.js";

/** Provenance sources that Flux chose on the user's behalf, so a wrong PDF is Flux's bug
 *  to catch. Manual routes (a file the user picked, a Zotero attachment they curated) are
 *  trusted: rejecting those would override an explicit human decision. */
const AUTOMATED_SOURCES = new Set(["proxy", "openalex-oa", "unpaywall", "europepmc", "pmc-oa", "arxiv", "biorxiv", "crossref"]);

/** True if `source` is an automated acquisition that should be verified before it becomes paper.pdf. */
export const isAutomatedSource = (source: string | undefined): boolean => AUTOMATED_SOURCES.has(String(source || ""));
