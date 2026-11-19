/**
 * fluximg — the on-disk contract (spec "fluximg/1").
 *
 * Pure types only: no DOM, no Node, no Svelte. Every engine (the renderer, its workers, flux-core, the
 * scripts) reads these. The prose contract is docs/fluximg/SPEC.md; `validate.ts` is its machine-checkable
 * half (the manifest, the arrays, their cross-references and every stored chunk).
 */

/** Stored sample types. Little-endian on disk. */
export type FluximgDtype = "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64";
export type FluximgTypedArray =
  | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** The five dimensions OME-Zarr knows, in the only order it allows. Extra dimensions come before them. */
export const CORE_DIMS = ["t", "c", "z", "y", "x"] as const;
export type CoreDim = (typeof CORE_DIMS)[number];

/** One physical axis: evenly spaced (`scale`, `offset`) or explicit positions (`coords`). */
export interface FluximgAxis {
  unit?: string | null;
  /** Physical size of one step. Required for x and y. */
  scale?: number;
  offset?: number;
  /** One position per index along the dimension (z planes, frame times). Never for x or y. */
  coords?: number[];
  /** Names for the positions of a categorical extra dimension (trial, condition). */
  labels?: string[];
}

export interface FluximgHistogram { lo: number; hi: number; counts: number[] }
export interface FluximgStats {
  /** Number of valid samples the statistics describe (after any subsampling). */
  count: number;
  min: number;
  max: number;
  /** Percentile → value, keys "0.1", "1", "50", "99", "99.8", "99.9". */
  percentiles: Record<string, number>;
  /** 256 bins between `lo` and `hi` (the 0.1 and 99.9 percentiles). */
  hist: FluximgHistogram;
}

export interface FluximgChannel {
  name: string;
  /** A colour means the ramp black → colour. Exactly one of `color` / `lut` is set. */
  color?: string | null;
  /** A named colour map (`gray`, `viridis`, `cmasher.ember`, …). */
  lut?: string | null;
  /** Default display window, in VALUE units: black point, white point. */
  range: [number, number];
  stats: FluximgStats;
}

/** How stored numbers map to values. */
export type FluximgEncoding =
  | { kind: "exact"; sourceDtype?: string; fallback?: "guard" | null; guard?: FluximgGuard }
  | {
      kind: "linear16";
      /** One entry per channel (one entry when there is no `c` dimension): value = offset + scale * (code - 1). */
      channels: Array<{ scale: number; offset: number }>;
      /** Code 0 means "no data". */
      nodataCode: 0;
      sourceDtype?: string;
      guard?: FluximgGuard;
    };

/** The save-time check that licensed (or refused) the compact encoding. */
export interface FluximgGuard {
  /** Per channel: rounding step / median absolute difference between horizontally adjacent valid pixels. */
  stepOverNeighbour: Array<number | null>;
  threshold: number;
}

export interface FluximgLevel {
  /** Path of the Zarr array inside `pixels.path` ("0", "1", …). */
  path: string;
  shape: number[];
  /** Linear downsampling of y and x relative to level 0 (1, 4, 8, …). */
  downsample: number;
}

export interface FluximgPixels {
  /** The Zarr group, relative to the bundle root. Always "pixels" in fluximg/1. */
  path: string;
  dims: string[];
  shape: number[];
  dtype: FluximgDtype;
  levels: FluximgLevel[];
  encoding: FluximgEncoding;
  /** For `exact` integer data: the stored value that means "no data" (floats use NaN). */
  nodata?: number | null;
  /** True when `dims` are all core dimensions, so the group also carries OME-Zarr 0.5 metadata. */
  ome: boolean;
}

export interface FluximgRect { x: number; y: number; width: number; height: number }
export interface FluximgRegion { id: string; name: string; rect: FluximgRect }

interface LayerBase {
  /** Lower-case identifier, unique in the bundle: `[a-z][a-z0-9_]*`. */
  id: string;
  name: string;
  /** Whether the layer starts shown when the image is placed. */
  visible?: boolean;
  /** Informational: the bundle these layers were borrowed from. */
  from?: string;
}
export interface FluximgIntensityLayer extends LayerBase {
  kind: "intensity";
  /** Zarr array with dims ["y", "x"] on the image's pixel grid. */
  path: string;
  dtype: FluximgDtype;
  encoding: FluximgEncoding;
  color?: string | null;
  lut?: string | null;
  range: [number, number];
  /** A constant 0..1, or "value": opacity follows the normalized value. */
  opacity?: number | "value";
  stats: FluximgStats;
}
export interface FluximgLabelLayer extends LayerBase {
  kind: "labels";
  /** Zarr array (uint16 / uint32) with dims ["y", "x"]; 0 = no object. */
  path: string;
  dtype: "uint16" | "uint32";
  /** One exact pixel-edge outline per object. */
  outlines: string;
  /** One row per object; must have an integer `label` column. */
  table: string;
  /** The table column that names an object. Defaults to "label". */
  key: string;
  count: number;
  color?: string | null;
  /** Id of an intensity layer holding per-pixel weights for these objects. */
  weights?: string | null;
}
export interface FluximgVectorLayer extends LayerBase {
  kind: "vector";
  /** SVG in image-pixel coordinates. */
  path: string;
  table?: string | null;
  key?: string | null;
  count: number;
  color?: string | null;
}
export type FluximgLayer = FluximgIntensityLayer | FluximgLabelLayer | FluximgVectorLayer;

export interface FluximgManifest {
  spec: "fluximg/1";
  name: string;
  pixels: FluximgPixels;
  /** Keyed by dimension name. `c` has no entry. */
  axes: Record<string, FluximgAxis>;
  /** One per channel, in stored order (a single entry when there is no `c` dimension). */
  channels: FluximgChannel[];
  /** RGB photographs: three channels shown as true colour and adjusted together. */
  photometric?: "rgb" | null;
  /** Mean value per position along each non-spatial, non-channel dimension: profiles[dim].mean[channel][i]. */
  profiles?: Record<string, { mean: Array<Array<number | null>> }>;
  /** Where the image opens: an index per non-spatial, non-channel dimension. */
  defaults?: { index?: Record<string, number> };
  layers: FluximgLayer[];
  regions: FluximgRegion[];
  /** Kept verbatim. Flux does not interpret it in fluximg/1. */
  world?: { matrix: number[][]; unit?: string | null; note?: string | null } | null;
  provenance?: {
    writer?: string;
    created?: string;
    source?: Array<{ path: string; bytes?: number; mtime?: string }>;
    meta?: Record<string, unknown>;
    recipe?: string | null;
  };
}

/** A table sidecar: equal-length columns. */
export interface FluximgTable {
  key: string;
  columns: Record<string, Array<number | string | boolean | null>>;
}

export const FLUXIMG_SPEC = "fluximg/1" as const;
export const FLUXIMG_MANIFEST = "fluximg.json";
export const FLUXIMG_SUFFIX = ".fluximg";
/** A plane larger than this on either side is stored as tiles and gets overview levels. */
export const TILE_THRESHOLD = 2048;
export const TILE_SIZE = 512;
/** Overview levels stop once the longer side is at most this. */
export const OVERVIEW_FLOOR = 512;
export const FIRST_OVERVIEW = 4;
export const MAX_SHARD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ZSTD_LEVEL = 5;
/** Compact encoding is allowed only while one rounding step stays under this fraction of the neighbour difference. */
export const GUARD_THRESHOLD = 0.1;
export const PERCENTILE_KEYS = ["0.1", "1", "50", "99", "99.8", "99.9"] as const;

export const DTYPE_BYTES: Record<FluximgDtype, number> = {
  uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8,
};

export function typedArrayFor(dtype: FluximgDtype, buffer: ArrayBufferLike, byteOffset: number, length: number): FluximgTypedArray {
  switch (dtype) {
    case "uint8": return new Uint8Array(buffer, byteOffset, length);
    case "int8": return new Int8Array(buffer, byteOffset, length);
    case "uint16": return new Uint16Array(buffer, byteOffset, length);
    case "int16": return new Int16Array(buffer, byteOffset, length);
    case "uint32": return new Uint32Array(buffer, byteOffset, length);
    case "int32": return new Int32Array(buffer, byteOffset, length);
    case "float32": return new Float32Array(buffer, byteOffset, length);
    case "float64": return new Float64Array(buffer, byteOffset, length);
  }
}

export function allocTyped(dtype: FluximgDtype, length: number): FluximgTypedArray {
  return typedArrayFor(dtype, new ArrayBuffer(length * DTYPE_BYTES[dtype]), 0, length);
}

export function dtypeOf(a: FluximgTypedArray): FluximgDtype {
  if (a instanceof Uint8Array) return "uint8";
  if (a instanceof Int8Array) return "int8";
  if (a instanceof Uint16Array) return "uint16";
  if (a instanceof Int16Array) return "int16";
  if (a instanceof Uint32Array) return "uint32";
  if (a instanceof Int32Array) return "int32";
  if (a instanceof Float32Array) return "float32";
  return "float64";
}

export const isFloatDtype = (d: FluximgDtype): boolean => d === "float32" || d === "float64";

/** Extra dimensions first (in the order given), then t, c, z, y, x. */
export function canonicalDims(dims: readonly string[]): string[] {
  const core = CORE_DIMS as readonly string[];
  return [...dims.filter((d) => !core.includes(d)), ...core.filter((d) => dims.includes(d))];
}
