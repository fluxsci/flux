// The pdf.js worker entry, bundled by Vite (?worker → ES-module worker). It applies the
// Uint8Array base64/hex polyfill FIRST — so it patches the worker's global before the
// pdf.js worker code runs — then loads the stock worker. Wired via
// GlobalWorkerOptions.workerPort in PdfView.svelte. Fixes "a.toHex is not a function"
// on Electron 33 (Chromium 130 lacks those methods; the worker is where toHex is called).
import "./uint8Polyfill";
import "pdfjs-dist/build/pdf.worker.min.mjs";
