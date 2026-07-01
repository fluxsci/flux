// flux-core/fulltext.ts — extract a PDF's text (pdf.js legacy build, no worker) into a
// flat string. Backs items/<key>/fulltext.txt: full-text search + the get_paper_text
// MCP tool (agent reading context). Page texts are joined with form-feeds so downstream
// tools can recover page boundaries. The renderer reuses the text it already lays out.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { hasPdf, readPdf, readFulltext, writeFulltext } from "./items";

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

/** Join one page's text-content items, re-inserting line breaks on large Y jumps. */
function pageText(items: any[]): string {
  let out = "";
  let lastY: number | null = null;
  for (const it of items) {
    if (!("str" in it)) continue;
    const y = it.transform?.[5];
    if (lastY !== null && typeof y === "number" && Math.abs(y - lastY) > 4) out += "\n";
    else if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (typeof y === "number") lastY = y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
