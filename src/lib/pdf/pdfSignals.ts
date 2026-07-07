// Renderer twin of flux-core/fulltext.ts extractPdfSignals — extracts identification signals
// from a PDF's bytes using the app's pdf.js (src/lib/pdf/pdfjs.ts). Same PdfSignals shape + the
// same shared pure helpers as the Node path, so the GUI and CLI identify a PDF identically.
import { getDocument, PDFWorker } from "./pdfjs";
import PdfWorkerPort from "./pdfjsWorker?worker";
import { joinTextItems, guessTitleFromItems, firstDoiIn, type PdfSignals, type TextItem } from "../references/pdfIdentify";

export async function extractPdfSignals(bytes: Uint8Array): Promise<PdfSignals> {
  // Same worker + asset wiring as PdfView (no global workerSrc in this app; each open gets its
  // own PDFWorker via the Vite ?worker port) so extracted text matches what the reader renders.
  const base = new URL("pdfjs/", document.baseURI).href;
  const worker = PDFWorker.create({ port: new PdfWorkerPort() });
  const task = getDocument({ data: bytes, worker, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/", useSystemFonts: false });
  const doc = await task.promise;
  try {
    const n = doc.numPages;
    let xmpDoi: string | undefined;
    let infoDoi: string | undefined;
    let xmpTitle: string | undefined;
    let infoTitle: string | undefined;
    try {
      const md = await doc.getMetadata();
      const info = (md?.info || {}) as Record<string, unknown>;
      infoTitle = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
      infoDoi = firstDoiIn(info);
      const xmp = md?.metadata as { get?: (k: string) => unknown; getAll?: () => Record<string, unknown> } | null;
      if (xmp) {
        const all = typeof xmp.getAll === "function" ? xmp.getAll() : {};
        const get = (k: string): string | undefined => {
          try {
            const v = typeof xmp.get === "function" ? xmp.get(k) : all?.[k];
            return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
          } catch {
            return undefined;
          }
        };
        xmpTitle = get("dc:title");
        xmpDoi = firstDoiIn({ a: get("prism:doi"), b: get("dc:identifier"), c: get("crossmark:doi"), d: get("pdfx:doi") }) ?? firstDoiIn(all);
      }
    } catch {
      /* no metadata */
    }

    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    const items1 = (await p1.getTextContent()).items as TextItem[];
    const page1Text = joinTextItems(items1);
    const titleGuess = guessTitleFromItems(items1, vp.height);
    p1.cleanup();

    const tailStart = Math.max(2, n - 1);
    const tailParts: string[] = [];
    for (let i = tailStart; i <= n; i++) {
      const pg = await doc.getPage(i);
      tailParts.push(joinTextItems((await pg.getTextContent()).items as TextItem[]));
      pg.cleanup();
    }

    const arxivId = (page1Text.match(/arxiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/i) || [])[1];
    return { xmpDoi, infoDoi, xmpTitle, infoTitle, titleGuess, arxivId, page1Text, tailText: tailParts.join("\n"), numPages: n };
  } finally {
    await task.destroy();
    worker.destroy();
  }
}
