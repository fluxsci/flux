// A PDF.js task owns both its explicitly created worker wrapper and native port.
// Creation and rejected load are inside the same cleanup boundary as page work.
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
export function createOwnedPdfTask(bytes: Uint8Array, base: string, deps: {
  createPort: () => { terminate(): unknown };
  createWorker: (port: any) => { destroy(): unknown };
  getDocument: (options: any) => PDFDocumentLoadingTask;
}) {
  let port: ReturnType<typeof deps.createPort> | undefined;
  let worker: ReturnType<typeof deps.createWorker> | undefined;
  let task: PDFDocumentLoadingTask | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    try { await task?.destroy(); } catch { /* cleanup must not replace the load error */ }
    finally { try { worker?.destroy(); } finally { port?.terminate(); } }
  })().catch(() => {});
  let promise: Promise<PDFDocumentProxy>;
  try {
    port=deps.createPort();worker=deps.createWorker(port);
    // The false legacy option is a compatibility pin. PDF.js6 removed its PDF eval
    // compiler and ignores this option; the paired build guard and native inert
    // PDF fixture verify the installed implementation rather than this flag.
    task=deps.getDocument({data:bytes.slice(),worker,cMapUrl:base+'cmaps/',cMapPacked:true,standardFontDataUrl:base+'standard_fonts/',wasmUrl:base+'wasm/',iccUrl:base+'iccs/',useSystemFonts:false,isEvalSupported:false});
    promise=task.promise.catch(async error=>{await dispose();throw error;});
  } catch(error) { promise=dispose().then(()=>{throw error;}); }
  return {task,promise,dispose};
}
