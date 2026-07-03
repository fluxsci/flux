// The pdf.js worker entry, bundled by Vite (?worker → ES-module worker). LEGACY build:
// it carries its own compatibility shims for Electron 33 / Chromium 130 (toBase64/toHex,
// getOrInsertComputed, Response/Blob.bytes for the WASM font compiler, Math.sumPrecise),
// which is what the hand-rolled uint8Polyfill used to provide. Must stay the legacy
// twin of src/lib/pdf/pdfjs.ts (main thread) so core/worker versions never skew.
// Each PdfView wraps one of these in its own PDFWorker (no shared workerPort — LR-12).
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
