// Renderer twin of flux-core/fulltext.ts extractFulltext — extracts a PDF's full text
// (all pages, form-feed-joined) with the app's pdf.js so GUI-acquired PDFs get the same
// items/<key>/fulltext.txt the Node engine writes (full-text search + get_paper_text
// parity; before this hook, only CLI/agent fetches were text-searchable). Same worker
// wiring as pdfSignals.ts; same page-join format as the Node path.
import { getDocument, PDFWorker } from "./pdfjs";
import PdfWorkerPort from "./pdfjsWorker?worker";
import { joinTextItems, type TextItem } from "../references/pdfIdentify";

export interface Fulltext {
  text: string; // all pages, \f-separated (matches flux-core/fulltext.ts)
  pages: number;
  chars: number;
}

export async function extractFulltextText(bytes: Uint8Array): Promise<Fulltext> {
  const base = new URL("pdfjs/", document.baseURI).href;
  const worker = PDFWorker.create({ port: new PdfWorkerPort() });
  const task = getDocument({
    data: bytes,
    worker,
    cMapUrl: base + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: base + "standard_fonts/",
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const parts: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      parts.push(joinTextItems((await page.getTextContent()).items as TextItem[]));
      page.cleanup();
    }
  } finally {
    await task.destroy();
    worker.destroy();
  }
  const text = parts.join("\n\f\n");
  return { text, pages: parts.length, chars: text.length };
}
