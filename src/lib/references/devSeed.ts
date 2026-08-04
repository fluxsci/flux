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
/** Seeded items stand in for items/<key>/paper.pdf, so PDF-presence sweeps must see them. */
export const seededKeys = (): string[] => [...seeded.keys()];

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

/** Scale fixture (1.2): write a SYNTHETIC n-entry library.bib + enrichment sidecar
 *  through the real bridge into the resolved FluxLib, so the Library exercises its
 *  REAL load/parse/query paths at 5k-paper scale headlessly. Returns the lib path. */
export async function seedScaleLibrary(n: number): Promise<{ lib: string | null; entries: number }> {
  const { ensureFluxLib } = await import("./fluxlibBridge");
  const { fileBridge, joinPath } = await import("../project/types");
  const { bumpFluxLib } = await import("./revision");
  const fb = fileBridge();
  const lib = await ensureFluxLib();
  if (!fb || !lib) return { lib: null, entries: 0 };
  const FAMS = ["cortex", "sleep", "vision", "memory", "synapse", "retina", "thalamus", "spike"];
  const bib: string[] = ["% synthetic scale fixture\n"];
  const enrich: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const fam = FAMS[i % FAMS.length];
    const year = 2000 + (i % 25);
    const key = `author${i}${fam}${year}`;
    bib.push(
      `@article{${key},\n  title = {Synthetic ${fam} study number ${i} of cortical dynamics},\n` +
        `  author = {Author${i % 97}, A. and Coauthor, B.},\n  year = {${year}},\n` +
        `  journal = {Journal of ${fam[0].toUpperCase()}${fam.slice(1)} Research},\n  doi = {10.5555/scale.${i}},\n}\n`,
    );
    enrich[key] = {
      key,
      doi: `10.5555/scale.${i}`,
      abstract: `Synthetic abstract ${i}: ${fam} circuits were probed under condition ${i % 12}. `.repeat(6),
      topics: [fam, "neuroscience"],
      keywords: [fam],
      citedByCount: (i * 7) % 900,
      sources: ["openalex"],
      fetchedAt: "2026-01-01T00:00:00Z",
    };
  }
  await fb.writeText(joinPath(lib, "library.bib"), bib.join("\n"));
  await fb.writeText(joinPath(lib, ".fluxlib", "enrich.json"), JSON.stringify(enrich));
  bumpFluxLib();
  return { lib, entries: n };
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  w.__fluxSeedReaderItem = seedReaderItem;
  w.__fluxSeedReaderSupplement = seedReaderSupplement;
  w.__fluxSeedScaleLibrary = seedScaleLibrary;
  // Prime the forward-citation cache so the reader's Cited-by tab is drivable
  // headlessly (it is otherwise a live OpenAlex query).
  w.__fluxSeedCiters = async (key: string, sort: string, briefs: unknown[]) => {
    const { seedCitersCache } = await import("./citersCache");
    seedCitersCache(key, sort as "cited" | "recent", briefs as never[]);
  };
  // Verify hook: run the renderer's real pdf.js signal extraction over a base64 PDF and
  // return a serializable summary, so scripts/verify-assign.mjs can prove the in-browser
  // extractPdfSignals path (getMetadata + text) works — the one piece the Node CLI run can't cover.
  w.__fluxExtractSignals = async (b64: string) => {
    const { extractPdfSignals } = await import("../pdf/pdfSignals");
    const s = await extractPdfSignals(b64ToBytes(b64));
    return {
      xmpDoi: s.xmpDoi,
      infoDoi: s.infoDoi,
      xmpTitle: s.xmpTitle,
      infoTitle: s.infoTitle,
      titleGuess: s.titleGuess,
      arxivId: s.arxivId,
      numPages: s.numPages,
      page1Len: s.page1Text.length,
      tailLen: s.tailText.length,
      page1Head: s.page1Text.slice(0, 300),
    };
  };
}
