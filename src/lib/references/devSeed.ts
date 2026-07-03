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

export const seededItem = (key: string): SeededItem | undefined => seeded.get(key);

export function seedReaderItem(key: string, pdfBase64: string, annotations?: AnnotationFile): void {
  const bin = atob(pdfBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  seeded.set(key, { pdf: bytes, annotations: annotations ?? emptyAnnotationFile() });
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__fluxSeedReaderItem = seedReaderItem;
}
