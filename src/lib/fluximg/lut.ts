/**
 * Colour tables and the value → colour law of a fluximg channel (pure: no DOM, no Node).
 *
 * THE LAW (binding for every renderer of a fluximg, the WebGL live view included):
 *
 *   x = normalize(value)            linear: (v − lo) / (hi − lo)
 *                                   log:    (log10 v − log10 lo) / (log10 hi − log10 lo), v ≤ 0 → 0;
 *                                           a window with lo ≤ 0 is treated as linear
 *                                   gamma:  linear ^ gamma
 *   x = clamp(x, 0, 1)              (NaN → 0)
 *   slot = min(255, trunc(x · 256))
 *   colour = table[slot]            a 256-entry RGBA table (`channelTable`)
 *
 * This is `src/lib/plot/colorscale.ts`'s law (`normalize` + `lookupIndex` with N = 256, under → the first
 * entry, over → the last) written with the SAME floating-point expressions (the log form uses log10 and a
 * division by the window, the linear form divides by (hi − lo) rather than multiplying by a reciprocal), so
 * the two agree bit for bit; `verify-fluximg-render` pins that over many values. The one deliberate
 * difference: a value ≤ 0 under a log window is black (slot 0), not matplotlib's "bad" colour, because in an
 * image it is a valid sample that is simply below the window.
 */
import type { FluximgDtype } from "./types";
import type { ValueMap } from "./encoding";

export const TABLE_SIZE = 256;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → [r, g, b] (alpha ignored); anything else → null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const c = hexToRgba(hex);
  return c ? [c[0], c[1], c[2]] : null;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → [r, g, b, a] with a in 0..255; anything else → null. */
export function hexToRgba(hex: string): [number, number, number, number] | null {
  if (typeof hex !== "string") return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

function grayRamp(out: Uint8Array): void {
  for (let i = 0; i < TABLE_SIZE; i++) { out[i * 4] = i; out[i * 4 + 1] = i; out[i * 4 + 2] = i; out[i * 4 + 3] = 255; }
}

/**
 * The 256-entry RGBA table of a channel (or an intensity layer): `Uint8Array(1024)`.
 *
 * - `color` `#rrggbb`: the ramp from black, entry i = round(colour · i / 255), opaque.
 * - `lut`: the resolver's entries (`#rrggbb` or `#rrggbbaa`), resampled by nearest index when the table does not
 *   have exactly 256 entries (endpoints map to endpoints). An unknown name (resolver returns null) or an unusable
 *   colour falls back to the gray ramp, so a still is never blank because a colour map is not loaded yet.
 * - `invert` reverses the table.
 */
export function channelTable(
  ch: { color: string | null; lut: string | null; invert: boolean },
  resolve: (name: string) => string[] | null,
): Uint8Array {
  const out = new Uint8Array(TABLE_SIZE * 4);
  const rgb = ch.color ? hexToRgb(ch.color) : null;
  const entries = !rgb && ch.lut ? resolve(ch.lut) : null;
  if (rgb) {
    for (let i = 0; i < TABLE_SIZE; i++) {
      out[i * 4] = Math.round((rgb[0] * i) / 255);
      out[i * 4 + 1] = Math.round((rgb[1] * i) / 255);
      out[i * 4 + 2] = Math.round((rgb[2] * i) / 255);
      out[i * 4 + 3] = 255;
    }
  } else if (entries && entries.length > 0) {
    const n = entries.length;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const src = n === TABLE_SIZE ? i : Math.round((i * (n - 1)) / (TABLE_SIZE - 1));
      const c = hexToRgba(entries[src]) ?? [0, 0, 0, 255];
      out.set(c, i * 4);
    }
  } else {
    grayRamp(out);
  }
  if (ch.invert) {
    for (let i = 0, j = TABLE_SIZE - 1; i < j; i++, j--) {
      for (let k = 0; k < 4; k++) { const t = out[i * 4 + k]; out[i * 4 + k] = out[j * 4 + k]; out[j * 4 + k] = t; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Normalization: the fast form of (range, norm, gamma).
// ---------------------------------------------------------------------------------------------

export const NORM_LINEAR = 0, NORM_LOG = 1, NORM_GAMMA = 2;

/** Precomputed (range, norm, gamma). Plain numbers so the hot loops see one monomorphic shape. */
export interface Normalizer {
  kind: number;
  lo: number;
  /** hi − lo (linear and gamma). 0 or less: every value maps to 0 (colorscale's vmin === vmax rule). */
  den: number;
  /** log10(lo) and log10(hi) − log10(lo) (log). */
  llo: number;
  lden: number;
  gamma: number;
}

export function makeNormalizer(range: readonly [number, number], norm: "linear" | "log" | "gamma" = "linear", gamma = 1): Normalizer {
  const lo = range[0], hi = range[1];
  // log needs a positive black point; gamma 1 is linear (same pixels, cheaper loop).
  const g = Number.isFinite(gamma) && gamma > 0 ? gamma : 1;
  const kind = norm === "log" && lo > 0 && hi > lo ? NORM_LOG : norm === "gamma" && g !== 1 ? NORM_GAMMA : NORM_LINEAR;
  const llo = kind === NORM_LOG ? Math.log10(lo) : 0;
  return { kind, lo, den: hi - lo, llo, lden: kind === NORM_LOG ? Math.log10(hi) - llo : 0, gamma: g };
}

/** x in [0, 1] for a VALUE (the caller has already excluded "no data"). */
export function normalizeValue(n: Normalizer, v: number): number {
  let x: number;
  if (n.kind === NORM_LOG) x = v > 0 ? (Math.log10(v) - n.llo) / n.lden : 0;
  else x = n.den > 0 ? (v - n.lo) / n.den : 0;
  if (!(x > 0)) return 0; // also NaN (Infinity − Infinity)
  if (x >= 1) return 1;
  return n.kind === NORM_GAMMA ? Math.pow(x, n.gamma) : x;
}

/** The table slot of a normalized x in [0, 1]: min(255, trunc(x · 256)). */
export function slotOf(x: number): number {
  const s = (x * TABLE_SIZE) | 0;
  return s > TABLE_SIZE - 1 ? TABLE_SIZE - 1 : s;
}

// ---------------------------------------------------------------------------------------------
// Packed colours: the renderer's accumulator format.
//
// A colour is packed as r | g << 10 | b << 20 with bit 30 meaning "this channel has data here". Ten-bit lanes
// let up to four channels be ADDED as one integer before any lane can carry into the next (4 · 255 = 1020 <
// 1024); the renderer clamps the lanes back to 255 before a fifth. Bit 30 survives addition because it is OR-ed
// in, never added.
// ---------------------------------------------------------------------------------------------

export const PACK_VALID = 1 << 30;
export const PACK_LANES = (1 << 30) - 1;

/** The 256 packed colours of a table (every entry carries the valid bit). */
export function packTable(table: Uint8Array): Uint32Array {
  const out = new Uint32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) out[i] = (table[i * 4] | (table[i * 4 + 1] << 10) | (table[i * 4 + 2] << 20) | PACK_VALID) >>> 0;
  return out;
}

/** Stored integer types small enough for a per-code table (the hot path: one lookup per pixel). */
export function codeTableSize(dtype: FluximgDtype): number {
  return dtype === "uint8" || dtype === "int8" ? 256 : dtype === "uint16" || dtype === "int16" ? 65536 : 0;
}

/** The stored number a table index stands for: index = stored & (size − 1), so signed codes wrap. */
const codeOf = (dtype: FluximgDtype, k: number): number =>
  dtype === "int8" ? (k >= 128 ? k - 256 : k) : dtype === "int16" ? (k >= 32768 ? k - 65536 : k) : k;

/**
 * The 256- or 65,536-entry lookup for 8/16-bit stored data: index (stored & (size − 1)) → packed colour, 0 where
 * the code means "no data". Every entry is computed with exactly the arithmetic of the float path (decode in
 * float64, `normalizeValue`, `slotOf`), which is why the two paths give identical pixels.
 */
export function codeTable(dtype: FluximgDtype, map: ValueMap | null, n: Normalizer, packed: Uint32Array): Uint32Array {
  const size = codeTableSize(dtype);
  if (!size) throw new Error(`fluximg: no code table for ${dtype}`);
  const out = new Uint32Array(size);
  const mul = map ? map.mul : 1, add = map ? map.add : 0, sub = map ? map.sub : 0, nodata = map ? map.nodata : null;
  const ident = mul === 1 && add === 0 && sub === 0;
  for (let k = 0; k < size; k++) {
    const s = codeOf(dtype, k);
    if (s === nodata) continue;
    const v = ident ? s : add + mul * (s - sub);
    out[k] = packed[slotOf(normalizeValue(n, v))];
  }
  return out;
}

/**
 * `codeTable(dtype, map, n, packTable(table))`, remembered: the last few tables are kept, keyed by every input
 * (the colour table byte for byte), so redrawing with an unchanged window (a pan, a zoom, another plane) skips
 * the 65,536 evaluations. Bounded: at most CODE_CACHE_SIZE tables (256 KiB each).
 */
const CODE_CACHE_SIZE = 8;
const codeCache = new Map<string, Uint32Array>();
export function cachedCodeTable(dtype: FluximgDtype, map: ValueMap | null, n: Normalizer, table: Uint8Array): Uint32Array {
  let tableKey = "";
  for (let i = 0; i < table.length; i += 256) tableKey += String.fromCharCode.apply(null, Array.from(table.subarray(i, i + 256)));
  const key = `${dtype}|${map ? `${map.mul},${map.add},${map.sub},${map.nodata}` : "values"}|${n.kind},${n.lo},${n.den},${n.llo},${n.lden},${n.gamma}|${tableKey}`;
  const hit = codeCache.get(key);
  if (hit) { codeCache.delete(key); codeCache.set(key, hit); return hit; }
  const t = codeTable(dtype, map, n, packTable(table));
  codeCache.set(key, t);
  if (codeCache.size > CODE_CACHE_SIZE) codeCache.delete(codeCache.keys().next().value as string);
  return t;
}

/** The same lookup returning the normalized x per code (NaN where the code means "no data"): intensity layers. */
export function codeXTable(dtype: FluximgDtype, map: ValueMap | null, n: Normalizer): Float64Array {
  const size = codeTableSize(dtype);
  if (!size) throw new Error(`fluximg: no code table for ${dtype}`);
  const out = new Float64Array(size);
  const mul = map ? map.mul : 1, add = map ? map.add : 0, sub = map ? map.sub : 0, nodata = map ? map.nodata : null;
  const ident = mul === 1 && add === 0 && sub === 0;
  for (let k = 0; k < size; k++) {
    const s = codeOf(dtype, k);
    out[k] = s === nodata ? NaN : normalizeValue(n, ident ? s : add + mul * (s - sub));
  }
  return out;
}
