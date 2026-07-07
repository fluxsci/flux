// DEV-only in-memory item overrides for the headless verify harness. The browser
// build has no window.fig bridge and the demo FluxLib has no paper.pdf, so reader
// verify scripts seed a fixture PDF (+ optional annotations) here and the bridges
// (itemsBridge.readerPdfBytes, annotationsBridge.load/save) consult this map first.
// Mirrors __fluxSeedBib / __fluxSeedFigures. Annotation writes against a seeded key
// mutate the in-memory file, so the full create/note/delete flow works headlessly.
import { emptyAnnotationFile, type AnnotationFile } from "./annotations";

export interface SeededItem {
  pdf: Uint8Array;
  annotations: AnnotationFile;
}

const seeded = new Map<string, SeededItem>();
// R6: seeded supplements (key → filename → bytes) so the Switch-PDF flow is drivable headlessly.
const seededSupps = new Map<string, Map<string, Uint8Array>>();

export const seededItem = (key: string): SeededItem | undefined => seeded.get(key);
export const seededSupplements = (key: string): Map<string, Uint8Array> | undefined => seededSupps.get(key);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function seedReaderItem(key: string, pdfBase64: string, annotations?: AnnotationFile): void {
  seeded.set(key, { pdf: b64ToBytes(pdfBase64), annotations: annotations ?? emptyAnnotationFile() });
}

export function seedReaderSupplement(key: string, name: string, pdfBase64: string): void {
  let m = seededSupps.get(key);
  if (!m) {
    m = new Map();
    seededSupps.set(key, m);
  }
  m.set(name, b64ToBytes(pdfBase64));
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  w.__fluxSeedReaderItem = seedReaderItem;
  w.__fluxSeedReaderSupplement = seedReaderSupplement;
}
