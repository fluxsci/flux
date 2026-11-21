/**
 * The TIFF importer's serialisable vocabulary: what a probe found (`TiffProbe`), what metadata suggests (`Hint`),
 * what inference proposes (`DimsProposal`) and what a person or an agent answers (`DimsAnswer`). Plain JSON-able
 * data only, so a probe and an answer cross IPC and are stored as remembered rules. Pure types.
 */
import type { FluximgDtype } from "../fluximg/types";

export type Confidence = "high" | "medium" | "low";

/** One leading dimension over the pages. A list of them is slowest first, fastest last. */
export interface DimSpec {
  /** `t`, `z`, `c` or a free name matching `[a-z][a-z0-9_]*`. */
  name: string;
  /** "rest": whatever the page count leaves (at most one dimension). */
  size: number | "rest";
}

/** What one metadata source says. Every field is optional: a hint says only what its source knows. */
export interface Hint {
  source: "ome" | "imagej" | "pagejson" | "shaped" | "resolution" | "samples" | "periodicity" | "layout";
  confidence: Confidence;
  /** Leading dims over the pages, slowest first. A name "" means "a dimension whose name the file does not say". */
  dims?: DimSpec[];
  /** The pages these dims cover (a series of a multi-series file). Default: every page. */
  pages?: { first: number; count: number };
  samples?: "c" | "rgb";
  pixelSize?: { x: number; y: number; unit: string };
  time?: { interval?: number; t0?: number; coords?: number[]; key?: string; unit: string };
  z?: { step?: number; origin?: number; coords?: number[]; key?: string; unit: string | null };
  channels?: Array<{ name?: string; color?: string | null }>;
  world?: { matrix: number[][]; unit?: string | null; note?: string | null };
  /** In words, for the person choosing. */
  reasons: string[];
  /** Why the hint does not add up (its dims do not cover the pages, a field is out of range, ...). */
  problems?: string[];
  /** Constant metadata worth recording in the bundle's provenance (scalars only). */
  meta?: Record<string, string | number | boolean>;
}

/** Everything the asking surface lets a person set; an agent passes the same object. */
export interface DimsAnswer {
  /** Leading dims over the pages, slowest first, fastest last; [] for a single page. */
  dims: DimSpec[];
  /** Which pages (one series of a multi-series file). Default: all. */
  pages?: { first: number; count: number };
  /** When a pixel has several samples: they are channels ("c") or a true-colour photograph ("rgb", alpha dropped). */
  samples?: "c" | "rgb";
  /** Swap x and y (files written column-major), applied before the flips. */
  transpose?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  /** Physical size of a pixel of the RESULT (after transpose). `y` defaults to `x`. */
  pixelSize?: { x: number; y?: number; unit: string } | null;
  /** The t axis: an interval (or a rate in Hz) and a start, or one time per frame (`coords`, or a page key's values). */
  time?: { interval?: number; rate?: number; t0?: number; unit?: string; coords?: number[]; key?: string } | null;
  /** The z axis: a step and an origin, or one position per plane (`coords`, or a page key's values). */
  z?: { step?: number; origin?: number; unit?: string | null; coords?: number[]; key?: string } | null;
  /** Other dims (extra ones; t and z also accepted here): unit and spacing, coords or labels. */
  axes?: Record<string, { unit?: string | null; scale?: number; offset?: number; coords?: number[]; labels?: string[]; key?: string }>;
  channels?: Array<{ name?: string; color?: string | null; lut?: string | null; visible?: boolean }>;
  /** A value that means "no data": NaN for float images, the integer image's `nodata`. */
  nodata?: number | null;
  /** Store floats exactly (no 16-bit compact copy). */
  lossless?: boolean;
  world?: { matrix: number[][]; unit?: string | null; note?: string | null } | null;
}

export interface DimsProposal {
  answer: DimsAnswer;
  confidence: Confidence;
  /** Which metadata it comes from ("remembered" for a rule). */
  from: string;
  /** A one-line summary, e.g. "t 816 × c 2 (channels fastest), 0.25 µm pixels". */
  summary: string;
  reasons: string[];
  /** What is still unknown and only a person can add (pixel size, frame rate, a dimension's name). */
  missing: string[];
  /** Converting with this answer needs no question: high confidence and nothing in `missing` that blocks it. */
  ready: boolean;
}

/** One page key's behaviour across the pages (the per-page JSON rule). */
export interface PageKey {
  key: string;
  type: "int" | "float" | "string" | "bool" | "matrix" | "list" | "mixed";
  /** constant: the same on every page; index: integers cycling with a period; coordinate: numbers changing in runs; varying: anything else. */
  kind: "constant" | "index" | "coordinate" | "varying";
  distinct: number;
  /** Pages per run of equal values, and how many runs make one cycle (index keys). */
  run?: number;
  period?: number;
  /** The constant value (scalars only). */
  value?: string | number | boolean;
  /** Per page, for numeric non-constant keys (what coords are read from). */
  values?: number[];
}

export interface TiffProbe {
  probe: 1;
  container: { bigTiff: boolean; littleEndian: boolean; bytes: number; ifds: number; skippedReduced: number; skippedMasks: number; subIfds: number; impliedPages: number };
  /** Image pages (reduced-resolution pages and masks excluded). */
  pages: number;
  plane: {
    width: number; height: number; samples: number; dtype: FluximgDtype | null; sampleType: string;
    compression: string; compressionCode: number; predictor: number; planar: 1 | 2; photometric: number;
    tiled: boolean; tileWidth: number | null; tileHeight: number | null; orientation: number; extraSamples: number[];
  };
  /** Runs of consecutive pages that share one shape and type. One run: a uniform file. */
  series: Array<{ first: number; count: number; width: number; height: number; sampleType: string; samples: number }>;
  description: { kind: "none" | "imagej" | "ome" | "shaped" | "json" | "text"; pages: number; twoTags: boolean };
  software: string | null;
  resolution: { x: number; y: number; unit: "inch" | "cm" | "none"; pixelSize: number | null; trusted: boolean; reason: string } | null;
  hints: Hint[];
  /** The per-page JSON key summary (null when pages carry no JSON). */
  keys: { pages: number; keys: PageKey[] } | null;
  /** Structural identity of "files like this one" (never a name or a page count): what remembered rules match. */
  fingerprint: string;
  fingerprintParts: Record<string, unknown>;
  /** Why the file cannot be converted at all (empty: it can). */
  refusals: Array<{ code: string; message: string }>;
  /** A page worth showing as a preview (the middle of the stack). */
  previewPage: number;
}

/** A remembered answer: re-applied to files with the same fingerprint, whatever their page count. */
export interface AnswerRule {
  rule: 1;
  fingerprint: string;
  answer: DimsAnswer;
}
