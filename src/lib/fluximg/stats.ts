/**
 * Statistics of planes for the contrast UI (pure): a histogram over a window, an automatic window, and the
 * value under the pointer. All on VALUES ("no data" excluded), with the reference writer's rules so a window
 * chosen here matches the one a fresh bundle opens with.
 */
import { decoderOf, type RenderPlane } from "./render";

/**
 * Counts of valid values in `bins` equal bins spanning [lo, hi]: bin = floor((v − lo) · bins / (hi − lo)); a value
 * equal to `hi` goes in the last bin; values outside are not counted (the writer's `hist` rule).
 */
export function histogram(plane: RenderPlane, lo: number, hi: number, bins = 256): Uint32Array {
  const nb = Math.max(1, Math.floor(bins));
  const out = new Uint32Array(nb);
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return out;
  const d = plane.data, dec = decoderOf(plane.map);
  const { mul, add, sub, ident } = dec;
  const nd = dec.nodata === null ? NaN : dec.nodata;
  const k = nb / (hi - lo);
  for (let i = 0; i < d.length; i++) {
    const s = d[i];
    if (s === nd || s !== s) continue;
    const v = ident ? s : add + mul * (s - sub);
    const b = Math.floor((v - lo) * k);
    if (b >= 0 && b < nb) out[b]++;
    else if (v === hi) out[nb - 1]++;
  }
  return out;
}

/** Linear interpolation between closest ranks (numpy's default), as the writer computes its percentiles. */
function percentile(sorted: Float64Array, p: number): number {
  const r = (p / 100) * (sorted.length - 1), lo = Math.floor(r), hi = Math.ceil(r);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (r - lo);
}

/** At most about this many values are sorted for the percentiles. */
export const AUTO_RANGE_SAMPLE = 1_000_000;

/**
 * A display window for planes: the 1st and 99.8th percentiles of their valid values, from a deterministic stride
 * sample (every k-th valid value, k = ceil(total samples / 1e6)), falling back to the exact min / max when the
 * percentiles coincide and to [lo, lo + 1] when the values are constant. No valid value at all: [0, 1].
 */
export function autoRange(planes: Iterable<RenderPlane>): [number, number] {
  const list = Array.from(planes);
  let total = 0;
  for (const p of list) total += p.data.length;
  const stride = Math.max(1, Math.ceil(total / AUTO_RANGE_SAMPLE));
  const sample: number[] = [];
  let seen = 0, min = Infinity, max = -Infinity;
  for (const p of list) {
    const d = p.data, dec = decoderOf(p.map);
    const { mul, add, sub, ident } = dec;
    const nd = dec.nodata === null ? NaN : dec.nodata;
    for (let i = 0; i < d.length; i++) {
      const s = d[i];
      if (s === nd || s !== s) continue;
      const v = ident ? s : add + mul * (s - sub);
      if (v < min) min = v;
      if (v > max) max = v;
      if (seen++ % stride === 0) sample.push(v);
    }
  }
  if (!sample.length) return [0, 1];
  const s = Float64Array.from(sample).sort();
  let lo = percentile(s, 1), hi = percentile(s, 99.8);
  if (!(hi > lo)) { lo = min; hi = max; }
  if (!(hi > lo)) hi = lo + 1;
  return [lo, hi];
}

/** The value at integer pixel (x, y) of a plane `width` wide, or NaN (no data, or outside the plane). */
export function valueAt(plane: RenderPlane, width: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (!(width > 0) || xi < 0 || yi < 0 || xi >= width) return NaN;
  const i = yi * width + xi;
  if (i >= plane.data.length) return NaN;
  const dec = decoderOf(plane.map), s = plane.data[i];
  return s === dec.nodata || s !== s ? NaN : dec.ident ? s : dec.add + dec.mul * (s - dec.sub);
}
