/**
 * Stored numbers ⇄ values.
 *
 * `exact` stores what it was given. `linear16` stores a float image at 16 bits across each channel's own range:
 * code 0 means "no data", and value = offset + scale * (code - 1). It is only chosen when a check on the image
 * itself shows the rounding step is small next to the pixel-to-pixel variation that is really there.
 */
import { GUARD_THRESHOLD, isFloatDtype, type FluximgDtype, type FluximgEncoding, type FluximgTypedArray } from "./types";

/**
 * value = add + mul * (stored - sub), evaluated in exactly that order in float64, so that every implementation
 * returns the same bits. `nodata` is the stored number that means "no data" (floats also treat NaN so).
 */
export interface ValueMap { mul: number; add: number; sub: number; nodata: number | null; float: boolean }

/** One map per channel (a single map when the array has no channel dimension). */
export function valueMaps(dtype: FluximgDtype, encoding: FluximgEncoding, nChannels: number, nodata?: number | null): ValueMap[] {
  if (encoding.kind === "linear16") {
    return encoding.channels.map((c) => ({ mul: c.scale, add: c.offset, sub: 1, nodata: 0, float: false }));
  }
  const m: ValueMap = { mul: 1, add: 0, sub: 0, nodata: nodata ?? null, float: isFloatDtype(dtype) };
  return Array.from({ length: Math.max(1, nChannels) }, () => m);
}

/** Decode stored samples to float values, NaN where there is no data. */
export function toValues(stored: FluximgTypedArray, map: ValueMap, out?: Float32Array | Float64Array): Float32Array | Float64Array {
  const o = out ?? (stored instanceof Float64Array ? new Float64Array(stored.length) : new Float32Array(stored.length));
  const { mul, add, sub, nodata } = map;
  if (mul === 1 && add === 0 && sub === 0) {
    for (let i = 0; i < stored.length; i++) { const s = stored[i]; o[i] = s === nodata || s !== s ? NaN : s; }
    return o;
  }
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    o[i] = s === nodata || s !== s ? NaN : add + mul * (s - sub);
  }
  return o;
}

/** The linear16 parameters for one channel's finite range. A constant channel gets scale 1. */
export function linear16Params(lo: number, hi: number): { scale: number; offset: number } {
  const span = hi - lo;
  return { scale: span > 0 ? span / 65534 : 1, offset: lo };
}

export function encodeLinear16(values: ArrayLike<number>, scale: number, offset: number, out: Uint16Array, outStart = 0): void {
  const inv = 1 / scale;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== v || v === Infinity || v === -Infinity) { out[outStart + i] = 0; continue; }
    let c = 1 + Math.round((v - offset) * inv);
    if (c < 1) c = 1; else if (c > 65535) c = 65535;
    out[outStart + i] = c;
  }
}

/**
 * Median absolute difference between horizontally adjacent valid samples of one plane, appended to `sink`
 * (subsampled by `stride` pairs so a caller can bound the total).
 */
export function collectNeighbourDiffs(plane: ArrayLike<number>, width: number, height: number, stride: number, sink: number[]): void {
  let k = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x + 1 < width; x++) {
      const a = plane[row + x], b = plane[row + x + 1];
      if (a !== a || b !== b || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (k++ % stride === 0) sink.push(Math.abs(b - a));
    }
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The guard: compact storage is allowed for a channel when one rounding step is below `threshold` times the
 * median difference between neighbouring pixels. A channel with no variation between neighbours (a constant
 * or piecewise-constant image) refuses: there is nothing to hide a step behind.
 */
export function guardRatio(scale: number, medianNeighbourDiff: number): number | null {
  if (!(medianNeighbourDiff > 0)) return null;
  return scale / medianNeighbourDiff;
}

export const guardPasses = (ratios: Array<number | null>, threshold = GUARD_THRESHOLD): boolean =>
  ratios.length > 0 && ratios.every((r) => r !== null && r < threshold);
