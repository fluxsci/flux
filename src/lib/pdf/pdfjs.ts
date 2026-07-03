// Central pdf.js import point — the ONLY module that may import from pdfjs-dist.
// We use the LEGACY build throughout: pdf.js 6.x targets ~Chrome 140 while Electron 33
// ships Chromium 130, and the legacy build bundles every needed shim (Uint8Array
// toBase64/toHex, Map.getOrInsertComputed, Blob/Response.bytes, Math.sumPrecise…) that
// src/lib/pdf/uint8Polyfill.ts used to hand-roll. Main-thread core + viewer both come
// from legacy/ so their versions can never skew; the worker twin is pdfjsWorker.ts.
export {
  getDocument,
  PDFWorker,
  version as pdfjsVersion,
} from "pdfjs-dist/legacy/build/pdf.mjs";

export {
  EventBus,
  PDFViewer,
  PDFLinkService,
  PDFFindController,
  LinkTarget,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

export type { PDFDocumentProxy, PDFPageProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
