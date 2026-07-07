// flux-core/fulltext.ts — extract a PDF's text (pdf.js legacy build, no worker) into a
// flat string. Backs items/<key>/fulltext.txt: full-text search + the get_paper_text
// MCP tool (agent reading context). Page texts are joined with form-feeds so downstream
// tools can recover page boundaries. The renderer reuses the text it already lays out.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { hasPdf, readPdf, readFulltext, writeFulltext } from "./items";
import { joinTextItems, guessTitleFromItems, firstDoiIn, type PdfSignals } from "../src/lib/references/pdfIdentify";

// pdf.js is imported lazily: its legacy build runs `new DOMMatrix()` at module
// load, which needs a native canvas polyfill (@napi-rs/canvas) that can't ship in
// the packaged CLI bundle. A static import would crash the bundle at load for
// EVERY verb (incl. slide export). Loading it on first use keeps the bundle inert
// until an actual fulltext extraction runs. Marked external in scripts/build-cli.mjs.
let _getDocument: any = null;
async function getDocument(opts: any): Promise<any> {
  if (!_getDocument) {
    ({ getDocument: _getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"));
  }
  return _getDocument(opts);
}

// Page text + title/DOI-from-metadata helpers now live in the shared pure module
// (src/lib/references/pdfIdentify.ts) so the Node + renderer signal extractors stay identical.
const pageText = joinTextItems;

export interface Fulltext {
  text: string; // all pages, \f-separated
  pages: number;
  chars: number;
}

/** Extract the full text of a PDF (Uint8Array) using pdf.js in Node (fake worker). */
export async function extractFulltext(bytes: Uint8Array): Promise<Fulltext> {
  // getDocument is a lazy async wrapper (see above) → it resolves to the pdf.js
  // loading task; await it before touching .promise/.destroy().
  const task = await getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    // keep Node quiet + dependency-free (no canvas / standard-font network fetches)
    verbosity: 0,
  } as any);
  const doc = await task.promise;
  const parts: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(pageText(tc.items as any[]));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  const text = parts.join("\n\f\n");
  return { text, pages: parts.length, chars: text.length };
}

/** Extract identification signals from a PDF (one pdf.js open): embedded DOI/title (Info + XMP),
 *  page-1 text + a font-size title guess, and the last ~2 pages' text (to locate — and distrust —
 *  reference-section DOIs). Feeds pdfIdentify.identify(). Hand it a fresh Uint8Array (pdf.js
 *  detaches the buffer). Throws only on a hard pdf.js failure (scanned image PDFs still return
 *  their empty text). */
export async function extractPdfSignals(bytes: Uint8Array): Promise<PdfSignals> {
  const task = await getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, verbosity: 0 } as any);
  const doc = await task.promise;
  try {
    const n = doc.numPages;
    // Metadata (Info dict + XMP). Both optional; scan for a DOI + a title.
    let xmpDoi: string | undefined;
    let infoDoi: string | undefined;
    let xmpTitle: string | undefined;
    let infoTitle: string | undefined;
    try {
      const md: any = await doc.getMetadata();
      const info = md?.info || {};
      infoTitle = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
      infoDoi = firstDoiIn(info);
      const xmp = md?.metadata;
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
      /* no metadata — signals fall back to text */
    }

    // Page 1 text + title guess.
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    const tc1 = await p1.getTextContent();
    const page1Text = pageText(tc1.items as any[]);
    const titleGuess = guessTitleFromItems(tc1.items as any[], vp.height);
    p1.cleanup();

    // Tail (last ~2 pages, never page 1) — where a references-section DOI lives.
    const tailStart = Math.max(2, n - 1);
    const tailParts: string[] = [];
    for (let i = tailStart; i <= n; i++) {
      const pg = await doc.getPage(i);
      tailParts.push(pageText((await pg.getTextContent()).items as any[]));
      pg.cleanup();
    }

    const arxivId = (page1Text.match(/arxiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/i) || [])[1];
    return { xmpDoi, infoDoi, xmpTitle, infoTitle, titleGuess, arxivId, page1Text, tailText: tailParts.join("\n"), numPages: n };
  } finally {
    await task.destroy();
  }
}

/** Return a paper's full text — the cached fulltext.txt, or extract-on-demand from the
 *  stored PDF (caching the result). Used by the get_paper_text MCP tool + full-text
 *  search so GUI-fetched PDFs (which skip Node extraction) are still searchable. */
export async function getOrExtractFulltext(key: string, libPath?: string): Promise<string | null> {
  const cached = await readFulltext(key, libPath);
  if (cached && cached.trim()) return cached;
  if (!(await hasPdf(key, libPath))) return null;
  const bytes = await readPdf(key, libPath);
  if (!bytes) return null;
  try {
    // Copy into a standalone Uint8Array — a Node Buffer's ArrayBuffer is pooled/shared,
    // and pdf.js detaches the buffer it's handed.
    const ft = await extractFulltext(new Uint8Array(bytes));
    if (ft.chars > 0) {
      await writeFulltext(key, ft.text, libPath);
      return ft.text;
    }
  } catch {
    /* unextractable (scanned/image PDF) */
  }
  return null;
}
