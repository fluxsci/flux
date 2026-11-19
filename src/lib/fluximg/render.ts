/**
 * The reference renderer of a fluximg view (pure: no DOM, no Node, no Svelte).
 *
 * `renderView` defines the pixels of a view. The still shown at rest, exports, Paper and flux-core all call it;
 * the WebGL live view is a fast path held to it. Everything below is THE LAW, written so a shader can follow it
 * line by line:
 *
 * 1. VALUES. A stored sample s of a plane is "no data" when s equals the plane's `map.nodata` or is NaN;
 *    otherwise value = map.add + map.mul · (s − map.sub) in float64 (`encoding.ts`). `map === null` means the
 *    plane already holds values (NaN = no data).
 *
 * 2. GEOMETRY. Output pixel (ox, oy) covers the source rectangle [crop.x + ox·sx, crop.x + (ox+1)·sx) ×
 *    [crop.y + oy·sy, crop.y + (oy+1)·sy) with sx = crop.width / outWidth, sy = crop.height / outHeight. Source
 *    sample (i, j) has its centre at (i + 0.5, j + 0.5). Samples outside the plane are no data. Per output pixel,
 *    a channel's value is:
 *    - nearest (sx ≤ 1 and sy ≤ 1, magnifying or 1:1): the sample at floor(crop.x + (ox + 0.5)·sx),
 *      floor(crop.y + (oy + 0.5)·sy);
 *    - mean (sx > 1 or sy > 1, minifying): the mean of the VALUES of the valid samples whose centres fall in the
 *      footprint (along an axis that is not minified, the footprint is the nearest sample), no data if none;
 *    - bilinear (`smooth`, and sx ≤ 1 and sy ≤ 1): at u = crop.x + (ox + 0.5)·sx − 0.5 (same in y) between the
 *      four surrounding sample centres, on VALUES; a no-data or outside neighbour is ignored and the remaining
 *      weights renormalized; no data when the nearest sample is outside the plane or no weight remains.
 *      Evaluated as ref + Σ w·(v − ref) / Σ w with ref the first valid neighbour (row-major), so a flat
 *      neighbourhood gives exactly its value (w·v / w is not always v in floating point).
 *
 * 3. COLOUR. Each channel maps its value through `lut.ts`'s law (normalize by range / norm / gamma, clamp to
 *    [0, 1], slot = min(255, trunc(x · 256)), its 256-entry table). `blend` adds the RGB of every VISIBLE channel
 *    and clamps each component to 255; `single` shows only the channel whose index is `solo` (visible or not).
 *    Where no contributing channel has data the pixel is `background` (alpha 255), or fully transparent
 *    (alpha 0, RGB 0) when background is "transparent". Elsewhere alpha is 255. Channel tables' alpha is ignored.
 *
 * 4. INTENSITY LAYERS, in order, only where the layer has data (its value through its own linear `range` and
 *    table): a = opacity · (opacityFromValue ? x : 1) · tableAlpha / 255, and the layer colour is laid "over" the
 *    pixel in straight alpha: A' = a + A·(1 − a), C' = (c·a + C·A·(1 − a)) / A' (which is C·(1 − a) + c·a over an
 *    opaque pixel). Each layer's result is stored as 8 bits (Uint8ClampedArray rounding) before the next.
 *
 * Speed: integer-stored planes (uint8, int8, uint16, int16) drawn nearest go through a per-code table (one
 * lookup per pixel, colour precomputed from exactly the float path's arithmetic; the last few tables are kept,
 * see `lut.cachedCodeTable`), so the 1:1 still is one pass per channel plus one to write the RGBA. Other planes
 * drawn nearest are decoded and coloured in one pass; minified and smooth draws first sample VALUES into a
 * float64 scratch image, then colour it. No per-pixel allocation anywhere.
 */
import type { FluximgTypedArray } from "./types";
import { dtypeOf } from "./types";
import type { ValueMap } from "./encoding";
import type { ResolvedChannel } from "./view";
import {
  PACK_LANES, PACK_VALID, cachedCodeTable, codeTableSize, hexToRgb, makeNormalizer, normalizeValue, packTable, slotOf,
  type Normalizer,
} from "./lut";

export interface RenderPlane { data: FluximgTypedArray; map: ValueMap | null /* null = already VALUES */ }

export interface RenderChannelInput { plane: RenderPlane; view: ResolvedChannel; table: Uint8Array }
export interface RenderLayerInput { plane: RenderPlane; range: [number, number]; table: Uint8Array; opacity: number; opacityFromValue: boolean }

export interface RenderInput {
  /** Size of the source planes (any level). */
  width: number;
  height: number;
  /**
   * The channels to draw from. May be every channel of the image or only those `planeRequests` asked for: `blend`
   * uses the entries whose `view.visible` is true, `single` the entry whose `view.index` is `solo`.
   */
  channels: RenderChannelInput[];
  layers: RenderLayerInput[];
  composite: "blend" | "single";
  solo: number;
  background: string;
  smooth: boolean;
  /** In source-plane pixels. */
  crop: { x: number; y: number; width: number; height: number };
  outWidth: number;
  outHeight: number;
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** A plane's ValueMap as plain numbers (identity = no arithmetic needed). */
export interface Decoder { mul: number; add: number; sub: number; nodata: number | null; ident: boolean }
export function decoderOf(map: ValueMap | null): Decoder {
  if (!map) return { mul: 1, add: 0, sub: 0, nodata: null, ident: true };
  return { mul: map.mul, add: map.add, sub: map.sub, nodata: map.nodata, ident: map.mul === 1 && map.add === 0 && map.sub === 0 };
}
/** One stored sample → value, NaN for no data. */
export function decodeSample(d: Decoder, s: number): number {
  return s === d.nodata || s !== s ? NaN : d.ident ? s : d.add + d.mul * (s - d.sub);
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

const NEAREST = 0, MEAN = 1, BILINEAR = 2;

/** Where every output column / row reads from. Per axis, per output coordinate. */
export interface RenderGeometry {
  mode: number;
  /** nearest: the source index, −1 outside the plane. mean: [lo, hi) source range (lo >= hi: none). */
  x0: Int32Array; x1: Int32Array; y0: Int32Array; y1: Int32Array;
  /** bilinear: first neighbour and the weight of the second. */
  bx: Int32Array; tx: Float64Array; by: Int32Array; ty: Float64Array;
}

function axisNearest(c0: number, s: number, n: number, size: number, lo: Int32Array, hi: Int32Array): void {
  for (let o = 0; o < n; o++) {
    const j = Math.floor(c0 + (o + 0.5) * s);
    if (j >= 0 && j < size) { lo[o] = j; hi[o] = j + 1; } else { lo[o] = -1; hi[o] = -1; }
  }
}

/** Sample centres j + 0.5 inside [a0, a1): j from ceil(a0 − 0.5) to ceil(a1 − 0.5) − 1. */
function axisFootprint(c0: number, s: number, n: number, size: number, lo: Int32Array, hi: Int32Array): void {
  for (let o = 0; o < n; o++) {
    const a0 = c0 + o * s, a1 = a0 + s;
    const l = Math.max(0, Math.ceil(a0 - 0.5)), h = Math.min(size, Math.ceil(a1 - 0.5));
    if (h > l) { lo[o] = l; hi[o] = h; } else { lo[o] = 0; hi[o] = 0; }
  }
}

function axisBilinear(c0: number, s: number, n: number, b: Int32Array, t: Float64Array): void {
  for (let o = 0; o < n; o++) {
    const u = c0 + (o + 0.5) * s - 0.5, j = Math.floor(u);
    b[o] = j; t[o] = u - j;
  }
}

export function renderGeometry(width: number, height: number, crop: RenderInput["crop"], outWidth: number, outHeight: number, smooth: boolean): RenderGeometry {
  const sx = crop.width / outWidth, sy = crop.height / outHeight;
  const g: RenderGeometry = {
    mode: sx > 1 || sy > 1 ? MEAN : smooth ? BILINEAR : NEAREST,
    x0: new Int32Array(outWidth), x1: new Int32Array(outWidth), y0: new Int32Array(outHeight), y1: new Int32Array(outHeight),
    bx: new Int32Array(0), tx: new Float64Array(0), by: new Int32Array(0), ty: new Float64Array(0),
  };
  if (g.mode === MEAN) {
    (sx > 1 ? axisFootprint : axisNearest)(crop.x, sx, outWidth, width, g.x0, g.x1);
    (sy > 1 ? axisFootprint : axisNearest)(crop.y, sy, outHeight, height, g.y0, g.y1);
    // axisNearest marks "outside" as −1/−1, which is an empty range for the mean loops too.
  } else {
    axisNearest(crop.x, sx, outWidth, width, g.x0, g.x1);
    axisNearest(crop.y, sy, outHeight, height, g.y0, g.y1);
    if (g.mode === BILINEAR) {
      g.bx = new Int32Array(outWidth); g.tx = new Float64Array(outWidth); g.by = new Int32Array(outHeight); g.ty = new Float64Array(outHeight);
      axisBilinear(crop.x, sx, outWidth, g.bx, g.tx);
      axisBilinear(crop.y, sy, outHeight, g.by, g.ty);
    }
  }
  return g;
}

/** The values a plane shows at every output pixel (NaN = no data), row-major outWidth × outHeight. */
export function sampleValues(p: RenderPlane, width: number, height: number, g: RenderGeometry, out: Float64Array, outWidth: number, outHeight: number): void {
  const d = p.data, dec = decoderOf(p.map);
  const { mul, add, sub, ident } = dec;
  const nd = dec.nodata === null ? NaN : dec.nodata; // NaN never equals anything: "no nodata code"
  if (g.mode === NEAREST) {
    for (let oy = 0; oy < outHeight; oy++) {
      const y = g.y0[oy], row = oy * outWidth;
      if (y < 0) { out.fill(NaN, row, row + outWidth); continue; }
      const base = y * width;
      for (let ox = 0; ox < outWidth; ox++) {
        const x = g.x0[ox];
        if (x < 0) { out[row + ox] = NaN; continue; }
        const s = d[base + x];
        out[row + ox] = s === nd || s !== s ? NaN : ident ? s : add + mul * (s - sub);
      }
    }
  } else if (g.mode === MEAN) {
    for (let oy = 0; oy < outHeight; oy++) {
      const ya = g.y0[oy], yb = g.y1[oy], row = oy * outWidth;
      for (let ox = 0; ox < outWidth; ox++) {
        const xa = g.x0[ox], xb = g.x1[ox];
        let sum = 0, cnt = 0;
        for (let y = ya; y < yb; y++) {
          const base = y * width;
          for (let x = xa; x < xb; x++) {
            const s = d[base + x];
            if (s === nd || s !== s) continue;
            sum += ident ? s : add + mul * (s - sub);
            cnt++;
          }
        }
        out[row + ox] = cnt > 0 ? sum / cnt : NaN;
      }
    }
  } else {
    for (let oy = 0; oy < outHeight; oy++) {
      const row = oy * outWidth;
      if (g.y0[oy] < 0) { out.fill(NaN, row, row + outWidth); continue; }
      const j0 = g.by[oy], ty = g.ty[oy];
      for (let ox = 0; ox < outWidth; ox++) {
        if (g.x0[ox] < 0) { out[row + ox] = NaN; continue; }
        const i0 = g.bx[ox], tx = g.tx[ox];
        // Deviations from the first valid neighbour, so a flat neighbourhood returns its value bit-exactly
        // (w·v / w is not always v in floating point, and a value on a slot edge would drop a slot).
        let acc = 0, wsum = 0, ref = NaN;
        for (let dy = 0; dy < 2; dy++) {
          const y = j0 + dy, wy = dy === 0 ? 1 - ty : ty;
          if (y < 0 || y >= height || wy === 0) continue;
          const base = y * width;
          for (let dx = 0; dx < 2; dx++) {
            const x = i0 + dx, wx = dx === 0 ? 1 - tx : tx;
            if (x < 0 || x >= width || wx === 0) continue;
            const s = d[base + x];
            if (s === nd || s !== s) continue;
            const w = wx * wy, v = ident ? s : add + mul * (s - sub);
            if (ref !== ref) ref = v;
            acc += w * (v - ref);
            wsum += w;
          }
        }
        out[row + ox] = wsum > 0 ? ref + acc / wsum : NaN;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scratch (module-level, grown on demand: the renderer is synchronous, so one set is enough per thread)
// ---------------------------------------------------------------------------------------------

const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

let accScratch = new Uint32Array(0);
let valScratch = new Float64Array(0);
function accBuffer(n: number): Uint32Array {
  if (accScratch.length < n) accScratch = new Uint32Array(n);
  const a = accScratch.subarray(0, n);
  a.fill(0);
  return a;
}
function valBuffer(n: number): Float64Array {
  if (valScratch.length < n) valScratch = new Float64Array(n);
  return valScratch.subarray(0, n);
}

// ---------------------------------------------------------------------------------------------
// Channel accumulation (packed 10-bit lanes, see lut.ts)
// ---------------------------------------------------------------------------------------------

/** Nearest + integer plane: one table lookup per pixel. */
function accumulateCodes(d: FluximgTypedArray, mask: number, lut: Uint32Array, g: RenderGeometry, width: number, acc: Uint32Array, outWidth: number, outHeight: number): void {
  // A 1:1 window over the plane (the common still) reads a contiguous run per row: no column indirection.
  const first = g.x0[0], last = g.x0[outWidth - 1];
  const contiguous = first >= 0 && last === first + outWidth - 1;
  for (let oy = 0; oy < outHeight; oy++) {
    const y = g.y0[oy];
    if (y < 0) continue;
    const row = oy * outWidth;
    if (contiguous) {
      const base = y * width + first;
      for (let ox = 0; ox < outWidth; ox++) {
        const p = lut[d[base + ox] & mask];
        acc[row + ox] = (acc[row + ox] + (p & PACK_LANES)) | (p & PACK_VALID);
      }
    } else {
      const base = y * width;
      for (let ox = 0; ox < outWidth; ox++) {
        const x = g.x0[ox];
        if (x < 0) continue;
        const p = lut[d[base + x] & mask];
        acc[row + ox] = (acc[row + ox] + (p & PACK_LANES)) | (p & PACK_VALID);
      }
    }
  }
}

/** Nearest, any plane: decode and colour in one pass (no scratch image). */
function accumulateNearest(p: RenderPlane, n: Normalizer, packed: Uint32Array, g: RenderGeometry, width: number, acc: Uint32Array, outWidth: number, outHeight: number): void {
  const d = p.data, dec = decoderOf(p.map);
  const { mul, add, sub, ident } = dec;
  const nd = dec.nodata === null ? NaN : dec.nodata;
  for (let oy = 0; oy < outHeight; oy++) {
    const y = g.y0[oy];
    if (y < 0) continue;
    const base = y * width, row = oy * outWidth;
    for (let ox = 0; ox < outWidth; ox++) {
      const x = g.x0[ox];
      if (x < 0) continue;
      const s = d[base + x];
      if (s === nd || s !== s) continue;
      const pk = packed[slotOf(normalizeValue(n, ident ? s : add + mul * (s - sub)))];
      acc[row + ox] = (acc[row + ox] + (pk & PACK_LANES)) | PACK_VALID;
    }
  }
}

/** Any plane, any geometry: values first, then colour. */
function accumulateValues(vals: Float64Array, n: Normalizer, packed: Uint32Array, acc: Uint32Array): void {
  for (let o = 0; o < vals.length; o++) {
    const v = vals[o];
    if (v !== v) continue;
    const p = packed[slotOf(normalizeValue(n, v))];
    acc[o] = (acc[o] + (p & PACK_LANES)) | PACK_VALID;
  }
}

/** Clamp every lane back to 255 so four more channels can be added without a carry. */
function clampLanes(acc: Uint32Array): void {
  for (let o = 0; o < acc.length; o++) {
    const a = acc[o];
    if (a === 0) continue;
    let r = a & 1023, g = (a >> 10) & 1023, b = (a >> 20) & 1023;
    if (r > 255) r = 255;
    if (g > 255) g = 255;
    if (b > 255) b = 255;
    acc[o] = r | (g << 10) | (b << 20) | (a & PACK_VALID);
  }
}

/** The contributing channels of an input, in input order. */
export function contributingChannels(input: Pick<RenderInput, "channels" | "composite" | "solo">): RenderChannelInput[] {
  if (input.composite === "single") {
    const c = input.channels.find((ch) => ch.view.index === input.solo);
    return c ? [c] : [];
  }
  return input.channels.filter((ch) => ch.view.visible);
}

/** "transparent" → null; a colour → [r, g, b]; anything unusable → black. */
export function parseBackground(bg: string): [number, number, number] | null {
  if (bg === "transparent") return null;
  return hexToRgb(bg) ?? [0, 0, 0];
}

export function renderView(input: RenderInput): Uint8ClampedArray {
  const { width, height, outWidth, outHeight, crop } = input;
  const W = Math.max(0, Math.floor(outWidth)), H = Math.max(0, Math.floor(outHeight));
  const out = new Uint8ClampedArray(W * H * 4);
  if (W === 0 || H === 0) return out;
  const total = width * height;
  for (const c of input.channels) if (c.plane.data.length < total) throw new Error(`fluximg render: a channel plane has ${c.plane.data.length} samples, expected ${total}`);
  for (const l of input.layers) if (l.plane.data.length < total) throw new Error(`fluximg render: a layer plane has ${l.plane.data.length} samples, expected ${total}`);

  const g = renderGeometry(width, height, crop, W, H, input.smooth);
  const n = W * H;
  const acc = accBuffer(n);
  let added = 0;
  for (const ch of contributingChannels(input)) {
    if (added === 4) { clampLanes(acc); added = 1; }
    const norm = makeNormalizer(ch.view.range, ch.view.norm, ch.view.gamma);
    const dtype = dtypeOf(ch.plane.data);
    const size = codeTableSize(dtype);
    if (g.mode === NEAREST && size > 0) {
      accumulateCodes(ch.plane.data, size - 1, cachedCodeTable(dtype, ch.plane.map, norm, ch.table), g, width, acc, W, H);
    } else if (g.mode === NEAREST) {
      accumulateNearest(ch.plane, norm, packTable(ch.table), g, width, acc, W, H);
    } else {
      const packed = packTable(ch.table);
      const vals = valBuffer(n);
      sampleValues(ch.plane, width, height, g, vals, W, H);
      accumulateValues(vals, norm, packed, acc);
    }
    added++;
  }

  const bg = parseBackground(input.background);
  const br = bg ? bg[0] : 0, bgG = bg ? bg[1] : 0, bb = bg ? bg[2] : 0, ba = bg ? 255 : 0;
  if (LITTLE_ENDIAN) {
    // One 32-bit store per pixel (RGBA in memory order) instead of four clamped byte stores.
    const out32 = new Uint32Array(out.buffer, out.byteOffset, n);
    const bgWord = (br | (bgG << 8) | (bb << 16) | (ba << 24)) >>> 0;
    for (let o = 0; o < n; o++) {
      const a = acc[o];
      if (a & PACK_VALID) {
        let r = a & 1023, gg = (a >> 10) & 1023, b = (a >> 20) & 1023;
        if (r > 255) r = 255;
        if (gg > 255) gg = 255;
        if (b > 255) b = 255;
        out32[o] = (r | (gg << 8) | (b << 16) | 0xff000000) >>> 0;
      } else out32[o] = bgWord;
    }
  } else {
    for (let o = 0, k = 0; o < n; o++, k += 4) {
      const a = acc[o];
      if (a & PACK_VALID) {
        const r = a & 1023, gg = (a >> 10) & 1023, b = (a >> 20) & 1023;
        out[k] = r > 255 ? 255 : r; out[k + 1] = gg > 255 ? 255 : gg; out[k + 2] = b > 255 ? 255 : b; out[k + 3] = 255;
      } else {
        out[k] = br; out[k + 1] = bgG; out[k + 2] = bb; out[k + 3] = ba;
      }
    }
  }

  for (const layer of input.layers) {
    const opacity = Number.isFinite(layer.opacity) ? Math.min(1, Math.max(0, layer.opacity)) : 1;
    if (opacity <= 0) continue;
    const vals = valBuffer(n);
    sampleValues(layer.plane, width, height, g, vals, W, H);
    const norm = makeNormalizer(layer.range, "linear", 1);
    const t = layer.table, fromValue = layer.opacityFromValue;
    for (let o = 0, k = 0; o < n; o++, k += 4) {
      const v = vals[o];
      if (v !== v) continue;
      const x = normalizeValue(norm, v), s = slotOf(x) * 4;
      const a = opacity * (fromValue ? x : 1) * (t[s + 3] / 255);
      if (a <= 0) continue;
      const A0 = out[k + 3] / 255;
      const keep = A0 * (1 - a), A = a + keep;
      out[k] = (t[s] * a + out[k] * keep) / A;
      out[k + 1] = (t[s + 1] * a + out[k + 1] * keep) / A;
      out[k + 2] = (t[s + 2] * a + out[k + 2] * keep) / A;
      out[k + 3] = A * 255;
    }
  }
  return out;
}
