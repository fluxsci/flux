// The shape of an OPTIONAL GROBID enrichment, and the pure helpers over it.
//
// GROBID is never required. A default Flux install has none of this: no service, no artifacts, no
// mention of it anywhere in the UI. When a user opts in (see docs/integrations/grobid.qmd) `flux grobid` writes
// items/<key>/grobid.tei.xml and items/<key>/grobid.json, and features that CAN use the extra
// structure light up. Nothing degrades when it is absent — every consumer must treat a missing
// projection as "no extra information", never as an error.
//
// Two artifacts on purpose:
//   · grobid.tei.xml — GROBID's own output, verbatim. Never parsed outside flux-core/grobid.ts.
//     Kept so a richer projection can be re-derived later WITHOUT re-running the service.
//   · grobid.json   — this projection. Versioned, flat, boring, and the only thing Flux reads.
//
// Pure: no I/O, no XML, no pdf.js. Imports cleanly in Node and the renderer.

/** Bump when this projection's SHAPE changes. `flux grobid --reproject` then re-derives every
 *  grobid.json from the stored TEI, which needs no service and takes seconds. Distinct from the
 *  GROBID version that produced the TEI, which is recorded per item and only changes on a re-run. */
export const GROBID_SCHEMA_VERSION = 1;

export interface GrobidAuthor {
  name: string;
  affiliation?: string;
}

export interface GrobidReference {
  /** 1-based position in the bibliography, matching GROBID's own ordering. */
  index: number;
  authors: string[];
  title?: string;
  journal?: string;
  year?: string;
  doi?: string;
  /** The entry as printed, when GROBID was asked for raw citations. */
  raw?: string;
}

export interface GrobidSection {
  heading?: string;
  /** Character offset into `body` where this section's text starts. */
  start: number;
  end: number;
}

/** One in-text citation, resolved to the bibliography entry it points at. This is the piece with
 *  no cheaper substitute: it is what a citation graph over the user's own PDFs would be built on. */
export interface GrobidCitation {
  /** Offset into `body`. */
  at: number;
  /** 1-based index into `references`, or undefined when GROBID could not resolve it. */
  ref?: number;
  text: string;
}

export interface GrobidDoc {
  schemaVersion: number;
  /** Version string reported by the service that produced the TEI (e.g. "0.9.1"). */
  grobidVersion: string;
  extractedAt: string;
  title?: string;
  authors: GrobidAuthor[];
  abstract?: string;
  doi?: string;
  /** Body text assembled from the TEI, in reading order: paragraphs, then figure/table captions,
   *  then any supplementary annex and the structured statements GROBID files under <back>.
   *  Section/citation offsets index into THIS string. */
  body: string;
  sections: GrobidSection[];
  references: GrobidReference[];
  citations: GrobidCitation[];
  counts: {
    references: number;
    referencesWithDoi: number;
    citations: number;
    citationsLinked: number;
    figures: number;
    tables: number;
  };
}

/** Per-key record in the library-level coverage ledger (.fluxlib/grobid.json). Lets `flux grobid`
 *  be incremental and resumable, and lets `status` answer "what is stale" without reading TEI. */
export interface GrobidCoverageEntry {
  ok: boolean;
  schemaVersion: number;
  grobidVersion: string;
  extractedAt: string;
  /** mtime of paper.pdf when it was processed — a re-fetched PDF invalidates the enrichment. */
  pdfMtimeMs: number;
  references?: number;
  citationsLinked?: number;
  error?: string;
}

export interface GrobidCoverage {
  schemaVersion: number;
  updatedAt: string;
  items: Record<string, GrobidCoverageEntry>;
}

export function emptyCoverage(): GrobidCoverage {
  return { schemaVersion: GROBID_SCHEMA_VERSION, updatedAt: new Date().toISOString(), items: {} };
}

/** Is this item's enrichment current? False means `flux grobid` should (re)do it. Separating the
 *  two version stamps matters: a projection-only bump is re-derived from stored TEI in seconds,
 *  whereas a PDF that changed on disk genuinely needs the service again. */
export function isCurrent(entry: GrobidCoverageEntry | undefined, pdfMtimeMs: number): boolean {
  if (!entry || !entry.ok) return false;
  if (entry.schemaVersion !== GROBID_SCHEMA_VERSION) return false;
  return entry.pdfMtimeMs === pdfMtimeMs;
}

/** Where the bibliography sits inside `doc.body`. GROBID's own segmentation supersedes the
 *  heuristic boundary in paperStructure.ts when an enrichment exists — its references live in a
 *  separate part of the TEI entirely, so the body it returns simply contains no bibliography. */
export function bodyHasNoBibliography(doc: GrobidDoc): boolean {
  return doc.references.length > 0;
}

/** Human one-liner for the CLI/GUI. Kept here so the two surfaces can never drift. */
export function summarizeGrobid(doc: GrobidDoc): string {
  const c = doc.counts;
  return (
    `${c.references} references (${c.referencesWithDoi} with a DOI), ` +
    `${c.citationsLinked}/${c.citations} in-text citations linked, ` +
    `${doc.sections.length} sections`
  );
}
