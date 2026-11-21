/**
 * The live view's renderer: WebGL2, raw stored samples as integer or float textures, and the whole view
 * (value map, display window, norm, colour table, blend, background, crop, intensity layers) applied in the
 * fragment shader. Changing contrast, a colour map or the crop is a few uniforms / tiny table uploads and one draw.
 *
 * It is a FAST PATH for `render.ts`, never a second definition of the picture. `verify-fluximg-gl` draws a matrix
 * of inputs both ways in one page and holds every component of every pixel to within 1/255 of `renderView`.
 * How it gets there, law section by law section (render.ts header):
 *
 * 1. VALUES. Samples stay in their stored type on the GPU. Every comparison that decides a colour is made in
 *    STORED space: the value map is affine and monotone, so decoding commutes with nearest, mean and bilinear
 *    sampling, and nothing needs decoding on the GPU at all (except an intensity layer's continuous x, below).
 *    Mean and bilinear on 8/16-bit planes run on (sample − origin), an exact integer subtraction with the origin
 *    at the stored sample nearest the window's centre, so their float32 result is precise relative to the
 *    window rather than to the absolute code (linear16 codes near 2·10^4 at a few codes per slot need this).
 * 2. GEOMETRY. Where every output column / row reads from (the nearest sample, the footprint, the bilinear base
 *    and weights) is computed on the CPU in float64 with render.ts's own expressions, one texel per output
 *    column and row (`uGeom`, 2 rows). In float32 on the GPU, `floor(crop.x + (ox + 0.5) * sx)` lands on the
 *    other side of an integer for fractional crops; with the table there is no geometry error at all.
 * 3. COLOUR. The window, norm and gamma are reduced on the CPU, with lut.ts's exact float64 law, to the 255 slot
 *    EDGES of each channel: edge k = the smallest stored key whose slot is >= k (`computeEdges`, a binary search
 *    over a monotone function). The shader only compares keys and looks the slot up (8 texel fetches, a binary
 *    search). So GLSL's loose `log`, `pow` and division never touch a slot boundary, and a window that puts
 *    samples exactly on slot edges (very common: integer data, round windows) is exact.
 *    Keys are uint32 and order-preserving: uint samples as they are, int samples with the sign bit flipped, and
 *    floats by their IEEE bits (negative: all bits flipped, positive: sign bit set). Nearest on integer
 *    planes compares the integer itself, so uint32 / int32 planes are exact at any magnitude; mean and bilinear
 *    compare the float32 key of the stored-space result.
 *    Blend adds 8-bit table entries as integers and clamps at 255; the canvas holds STRAIGHT alpha
 *    (`premultipliedAlpha: false`), so what the shader writes is exactly the law's 8-bit RGBA and `readPixels`
 *    returns it unchanged (premultiplying would lose up to 255/alpha steps on the way back).
 * 4. INTENSITY LAYERS: slot from the edges as for channels; a = opacity · (fromValue ? x : 1) · tableAlpha / 255
 *    with x computed in float32 (it only scales alpha); "over" in straight alpha, each layer rounded half to even
 *    to 8 bits as Uint8ClampedArray does.
 *
 * Mean (minifying): the law averages every valid sample whose centre falls in the footprint. The shader does
 * that exactly up to 8 x 8 samples; along an axis with a longer footprint it takes the regular subset of 8
 * samples at lo + floor((2k + 1) · n / 16), k = 0..7 (always inside the footprint, hence inside the plane). The
 * still that replaces the live view at rest averages everything; beyond the bound the live view is an estimate.
 * 8- and 16-bit planes are summed as integers, so a mean is exact before its one final float32 rounding.
 *
 * Ties. Where the reference's own float64 result sits ON a slot edge (x · 256 = k up to ~1e-12) after a mean or a
 * bilinear blend, or ON a .5 boundary when a layer is rounded to 8 bits, the reference is decided by its float64
 * rounding noise, which a float32 pipeline cannot reproduce; such a pixel may take the neighbouring slot / the
 * other 8-bit step (at low alpha a 1-step alpha moves the next layer's straight colour by a few steps). The gate
 * classifies these pixels explicitly and bounds their number; nearest sampling has no such ties.
 *
 * Float32 limits (documented, measured by the gate): float64 planes are uploaded as float32 (a sample within
 * float32 rounding of a slot edge, or of the nodata code, can land on the other side); mean and bilinear on
 * uint32 / int32 planes sum in float32 (beyond 2^24 low bits are lost); mean and bilinear results are float32
 * (a result within ~1e-7 relative of a slot edge can fall one slot off; on a ramp table that is one step).
 *
 * Cap: at most MAX_LIVE_CHANNELS contributing channels and MAX_LIVE_LAYERS intensity layers; further entries
 * are left out of the frame (the live view must fall back to the still for such a view).
 *
 * Browser-only (needs a canvas). No Svelte, no stores: the live view component owns one instance.
 */
import type { ValueMap } from "../encoding";
import { dtypeOf, type FluximgDtype, type FluximgTypedArray } from "../types";
import type { PixelRect } from "../view";
import { makeNormalizer, normalizeValue, slotOf, type Normalizer } from "../lut";
import { contributingChannels, parseBackground, type RenderInput } from "../render";

export interface LivePlane {
  /** Identity of the pixels (asset, level, plane, or a projection's recipe): the texture cache key. */
  key: string;
  width: number;
  height: number;
  dtype: FluximgDtype;
  data: FluximgTypedArray;
  /** null = the samples already are values (a projection), with NaN for no data. */
  map: ValueMap | null;
}

export interface LiveChannel {
  plane: LivePlane | null;
  /** 256 RGBA entries. Treated as immutable: a row is re-uploaded only when a different array is passed. */
  table: Uint8Array;
  range: [number, number];
  norm: "linear" | "log" | "gamma";
  gamma: number;
}

/** An intensity layer. The law normalizes layers linearly: `norm` and `gamma` are ignored here. */
export interface LiveLayer extends LiveChannel {
  opacity: number;
  opacityFromValue: boolean;
}

export interface LiveFrame {
  /** Size of the source planes (whichever level they come from). */
  width: number;
  height: number;
  /** Only the channels that contribute (visible ones, or the solo channel): `frameFromRenderInput` picks them. */
  channels: LiveChannel[];
  layers: LiveLayer[];
  /** "#rrggbb" (also "#rgb", "#rrggbbaa" with alpha ignored) or "transparent"; anything else is black. */
  background: string;
  smooth: boolean;
  /** The visible rectangle, in source-plane pixels. */
  crop: PixelRect;
  /** Drawing-buffer size in device pixels. */
  outWidth: number;
  outHeight: number;
}

export const MAX_LIVE_CHANNELS = 6;
export const MAX_LIVE_LAYERS = 3;
const LUT_ROWS = MAX_LIVE_CHANNELS + MAX_LIVE_LAYERS;

/** Texture units: planes take 0..LUT_ROWS-1; the rest are fixed. */
const UNIT_GEOM = 12, UNIT_EDGES = 13, UNIT_UPLOAD = 14, UNIT_LUT = 15;

/**
 * The live frame of a reference render input: the SAME picture `renderView(input)` defines. The live view and
 * the gate both build their frames here, so composite / solo / visibility, the layer opacity clamp and the
 * output size are decided once. `keys` gives the texture-cache key of each entry of `input.channels` and
 * `input.layers` (same indices).
 */
export function frameFromRenderInput(input: RenderInput, keys: { channels: readonly string[]; layers: readonly string[] }): LiveFrame {
  const plane = (data: FluximgTypedArray, map: ValueMap | null, key: string): LivePlane =>
    ({ key, width: input.width, height: input.height, dtype: dtypeOf(data), data, map });
  const channels: LiveChannel[] = contributingChannels(input).map((c) => ({
    plane: plane(c.plane.data, c.plane.map, keys.channels[input.channels.indexOf(c)]),
    table: c.table, range: c.view.range, norm: c.view.norm, gamma: c.view.gamma,
  }));
  const layers: LiveLayer[] = input.layers.map((l, i) => ({
    plane: plane(l.plane.data, l.plane.map, keys.layers[i]),
    table: l.table, range: l.range, norm: "linear" as const, gamma: 1,
    // render.ts: a non-finite opacity is 1, otherwise clamped to [0, 1].
    opacity: Number.isFinite(l.opacity) ? Math.min(1, Math.max(0, l.opacity)) : 1,
    opacityFromValue: l.opacityFromValue,
  }));
  return {
    width: input.width, height: input.height, channels, layers, background: input.background, smooth: input.smooth,
    crop: { x: input.crop.x, y: input.crop.y, width: input.crop.width, height: input.crop.height },
    outWidth: Math.max(0, Math.floor(input.outWidth)), outHeight: Math.max(0, Math.floor(input.outHeight)),
  };
}

// ---------------------------------------------------------------------------------------------
// Keys and slot edges (CPU side of law section 3)
// ---------------------------------------------------------------------------------------------

type Kind = "u" | "i" | "f";
const kindCode = (k: Kind): number => (k === "u" ? 1 : k === "i" ? 2 : 3);
const kindOf = (d: FluximgDtype): Kind => (d === "float32" || d === "float64" ? "f" : d === "int8" || d === "int16" || d === "int32" ? "i" : "u");
const bitsOf = (d: FluximgDtype): number => (d === "uint8" || d === "int8" ? 8 : d === "uint16" || d === "int16" ? 16 : 32);

const NEAREST = 0, MEAN = 1, BILINEAR = 2;
/** Key domains: unsigned integers, signed integers (sign bit flipped), float32 bits (order-preserving). */
const DOMAIN_UINT = 0, DOMAIN_INT = 1, DOMAIN_FLOAT = 2;
const TWO31 = 2147483648, KEY_MAX = 4294967295;

const keyF32 = new Float32Array(1), keyU32 = new Uint32Array(keyF32.buffer);

/** The stored sample a key stands for. */
function sampleOfKey(domain: number, k: number): number {
  if (domain === DOMAIN_UINT) return k;
  if (domain === DOMAIN_INT) return k - TWO31;
  keyU32[0] = k >= TWO31 ? k - TWO31 : KEY_MAX - k;
  return keyF32[0];
}

/**
 * Slot edges of one channel: `out[k]` (k = 1..255) = the smallest key whose slot is >= k under lut.ts's float64
 * law, 0xffffffff when no key reaches k; `out[0]` = the highest slot any key reaches (the shader clamps to it,
 * because a key can BE 0xffffffff). Keys are flipped (bitwise not) when the value map decreases, so the slot
 * is always non-decreasing in the key the shader compares. The float domain spans −Inf..+Inf (NaN is no data).
 */
function computeEdges(out: Uint32Array, domain: number, bits: number, origin: number, mul: number, add: number, sub: number, ident: boolean, n: Normalizer, flip: boolean): void {
  let kmin: number, kmax: number;
  if (domain === DOMAIN_UINT) { kmin = 0; kmax = 2 ** bits - 1; }
  else if (domain === DOMAIN_INT) { kmin = TWO31 - 2 ** (bits - 1); kmax = TWO31 + 2 ** (bits - 1) - 1; }
  else { kmin = 0x007fffff; kmax = 0xff800000; }
  if (flip) { const a = KEY_MAX - kmax; kmax = KEY_MAX - kmin; kmin = a; }
  const slotAt = (kp: number): number => {
    // Float keys are origin-relative (m − origin); the sum is exact in float64 (a float32 plus a 17-bit integer).
    const s = sampleOfKey(domain, flip ? KEY_MAX - kp : kp) + (domain === DOMAIN_FLOAT ? origin : 0);
    // Exactly render.ts's decode, then lut.ts's normalize + slot.
    return slotOf(normalizeValue(n, ident ? s : add + mul * (s - sub)));
  };
  const top = slotAt(kmax);
  out[0] = top;
  let lo = kmin;
  for (let k = 1; k < 256; k++) {
    if (k > top) { out[k] = KEY_MAX; continue; }
    // Smallest key in [lo, kmax] with slot >= k (it exists: slot(kmax) = top >= k).
    let a = lo, b = kmax;
    while (a < b) {
      const m = Math.floor((a + b) / 2);
      if (slotAt(m) >= k) b = m; else a = m + 1;
    }
    out[k] = a;
    lo = a;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry (CPU side of law section 2): one RGBA32F texel per output column (row 0) and row (row 1)
// ---------------------------------------------------------------------------------------------

/**
 * how 0 (nearest): r = sample index or −1 outside, g = r + 1 (a one-sample "footprint", −1 outside).
 * how 1 (footprint): [r, g) = the samples whose centres fall in the output pixel, clipped to the plane.
 * how 2 (bilinear): r = nearest index or −1, g = floor(u), b = t, a = 1 − t (both weights rounded from float64).
 * Every expression is render.ts's (axisNearest, axisFootprint, axisBilinear).
 */
function fillAxis(out: Float32Array, base: number, c0: number, s: number, n: number, size: number, how: number): void {
  for (let o = 0, k = base; o < n; o++, k += 4) {
    if (how === 1) {
      const a0 = c0 + o * s, a1 = a0 + s;
      const l = Math.max(0, Math.ceil(a0 - 0.5)), h = Math.min(size, Math.ceil(a1 - 0.5));
      out[k] = h > l ? l : 0; out[k + 1] = h > l ? h : 0; out[k + 2] = 0; out[k + 3] = 0;
      continue;
    }
    const j = Math.floor(c0 + (o + 0.5) * s), inside = j >= 0 && j < size;
    out[k] = inside ? j : -1; out[k + 1] = inside ? j + 1 : -1; out[k + 2] = 0; out[k + 3] = 0;
    if (how === 2) {
      const u = c0 + (o + 0.5) * s - 0.5, b = Math.floor(u), t = u - b;
      out[k + 1] = b; out[k + 2] = t; out[k + 3] = 1 - t;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const SAMPLER: Record<Kind, string> = { u: "usampler2D", i: "isampler2D", f: "sampler2D" };

/**
 * Per sampler kind: `raw` reads one stored sample (key, float value, valid?), and one sampler per geometry mode
 * gives the key the slot is looked up with plus the stored-space value m (for a layer's x).
 * `nd` = (nodata key, has nodata, 32-bit plane, flip mask); `ndF` = the float nodata.
 */
function kindFns(k: Kind, mode: number): string {
  const S = SAMPLER[k];
  const raw = k === "u"
    ? `uint r = texelFetch(t, p, 0).r; key = r; v = nd.z != 0u ? float(r) : float(int(r) - org); return nd.y == 0u || r != nd.x;`
    : k === "i"
      ? `int r = texelFetch(t, p, 0).r; key = uint(r) ^ 0x80000000u; v = float(r - org); return nd.y == 0u || key != nd.x;`
      : `float r = texelFetch(t, p, 0).r; key = fkey(r); v = r; return isNum(r) && (nd.y == 0u || r != ndF);`;
  let body: string;
  if (mode === NEAREST) {
    // Integer planes keep their integer key (exact at any magnitude); floats already have their float key.
    body = `
  if (gx.x < 0.0 || gy.x < 0.0) return false;
  return raw_${k}(t, ivec2(gx.x, gy.x), nd, ndF, org, key, m);`;
  } else if (mode === MEAN) {
    // 8/16-bit: an exact integer sum (biased to unsigned; at most 64 samples of < 2^16), then q + r / n with one
    // rounding. 32-bit and float planes: a float32 sum.
    const bias = k === "i" ? "0x7FFF8000u" : "0u", biasI = k === "i" ? "32768" : "0";
    const acc = k === "f" ? "fsum += v;" : "isum += kk - " + bias + "; fsum += v;";
    const fin = k === "f"
      ? "m = fsum / float(cnt);"
      : `if (nd.z != 0u) m = fsum / float(cnt);
  else { uint c = uint(cnt), q = isum / c; m = float(int(q) - ${biasI} - org) + float(isum - q * c) / float(cnt); }`;
    body = `
  int x0 = int(gx.x), y0 = int(gy.x), nx = int(gx.y) - x0, ny = int(gy.y) - y0;
  if (nx <= 0 || ny <= 0) return false;
  uint isum = 0u; float fsum = 0.0; int cnt = 0;
  for (int jy = 0; jy < 8; jy++) {
    if (jy >= ny) break;
    int y = y0 + (ny <= 8 ? jy : ((2 * jy + 1) * ny) / 16);
    for (int jx = 0; jx < 8; jx++) {
      if (jx >= nx) break;
      int x = x0 + (nx <= 8 ? jx : ((2 * jx + 1) * nx) / 16);
      uint kk; float v;
      if (!raw_${k}(t, ivec2(x, y), nd, ndF, org, kk, v)) continue;
      ${acc}
      cnt++;
    }
  }
  if (cnt == 0) return false;
  ${fin}
  key = fkey(m);
  return isNum(m);`;
  } else {
    // render.ts: deviations from the first valid neighbour (row-major), so a flat neighbourhood is exact; a
    // neighbour with weight 0, outside, or without data is left out.
    body = `
  if (gx.x < 0.0 || gy.x < 0.0) return false;
  int i0 = int(gx.y), j0 = int(gy.y);
  float acc = 0.0, wsum = 0.0, ref = 0.0; bool have = false;
  for (int dy = 0; dy < 2; dy++) {
    int y = j0 + dy; float wy = dy == 0 ? gy.w : gy.z;
    if (y < 0 || y >= uSrc.y || wy == 0.0) continue;
    for (int dx = 0; dx < 2; dx++) {
      int x = i0 + dx; float wx = dx == 0 ? gx.w : gx.z;
      if (x < 0 || x >= uSrc.x || wx == 0.0) continue;
      uint kk; float v;
      if (!raw_${k}(t, ivec2(x, y), nd, ndF, org, kk, v)) continue;
      float w = wx * wy;
      if (!have) { ref = v; have = true; }
      acc += w * (v - ref); wsum += w;
    }
  }
  if (!have) return false;
  m = ref + acc / wsum;
  key = fkey(m);
  return isNum(m);`;
  }
  return `
bool raw_${k}(${S} t, ivec2 p, uvec4 nd, float ndF, int org, out uint key, out float v) { ${raw} }
bool sample_${k}(${S} t, vec4 gx, vec4 gy, uvec4 nd, float ndF, int org, out uint key, out float m) {${body}
}`;
}

function fragmentSource(mode: number, channels: Kind[], layers: Kind[]): string {
  const kinds = [...new Set([...channels, ...layers])];
  const lines: string[] = [];
  channels.forEach((k, i) => lines.push(
    `  if (sample_${k}(cT${i}, gx, gy, uNd[${i}], uNdF[${i}], uOrg[${i}], key, m)) { rgb += texelFetch(uLut, ivec2(slotAt(key ^ uNd[${i}].w, ${i}), ${i}), 0).rgb; hit = true; }`));
  lines.push(`  vec4 c = hit ? vec4(vec3(min(rgb, uvec3(255u))), 255.0) : uBackground;`);
  layers.forEach((k, i) => {
    const row = MAX_LIVE_CHANNELS + i;
    lines.push(`  if (sample_${k}(lT${i}, gx, gy, uNd[${row}], uNdF[${row}], uOrg[${row}], key, m)) c = over(c, texelFetch(uLut, ivec2(slotAt(key ^ uNd[${row}].w, ${row}), ${row}), 0), m, uLM[${i}], uLW[${i}]);`);
  });
  return `#version 300 es
precision highp float; precision highp int;
precision highp sampler2D; precision highp usampler2D; precision highp isampler2D;
uniform ivec2 uOut;            // output size
uniform ivec2 uSrc;            // source plane size
uniform vec4 uBackground;      // 0..255 rgb, alpha 255 or 0 (transparent: all 0)
uniform sampler2D uGeom;       // row 0: per output column, row 1: per output row (see fillAxis)
uniform usampler2D uEdges;     // ${LUT_ROWS} rows of slot edges (see computeEdges)
uniform usampler2D uLut;       // ${LUT_ROWS} rows of 256 RGBA8 entries
uniform uvec4 uNd[${LUT_ROWS}];        // nodata key, has nodata, 32-bit plane, flip mask
uniform float uNdF[${LUT_ROWS}];       // float nodata
uniform int uOrg[${LUT_ROWS}];         // stored-space origin of 8/16-bit planes (see setRow)
uniform vec4 uLM[${MAX_LIVE_LAYERS}];         // layer value map: mul, add, sub − origin, identity
uniform vec4 uLW[${MAX_LIVE_LAYERS}];         // layer window: lo, hi − lo, opacity, opacityFromValue
${channels.map((k, i) => `uniform highp ${SAMPLER[k]} cT${i};`).join("\n")}
${layers.map((k, i) => `uniform highp ${SAMPLER[k]} lT${i};`).join("\n")}
out vec4 outColor;
// Order-preserving uint key of a float (negative: all bits flipped; positive: sign bit set).
uint fkey(float f) { uint b = floatBitsToUint(f); return (b & 0x80000000u) != 0u ? ~b : (b | 0x80000000u); }
// Not NaN, tested on the bits: isnan() may be optimized away.
bool isNum(float f) { return (floatBitsToUint(f) & 0x7fffffffu) <= 0x7f800000u; }
// The table slot of a key: the largest k with edge[k] <= key (binary search), clamped to the highest reachable slot.
uint slotAt(uint key, int row) {
  int s = 0;
  for (int step = 128; step > 0; step >>= 1) if (key >= texelFetch(uEdges, ivec2(s + step, row), 0).r) s += step;
  return min(uint(s), texelFetch(uEdges, ivec2(0, row), 0).r);
}
// An intensity layer laid over c (straight alpha, 0..255), rounded half to even like Uint8ClampedArray.
vec4 over(vec4 c, uvec4 tc, float m, vec4 lm, vec4 lw) {
  float v = lm.w > 0.5 ? m : lm.y + lm.x * (m - lm.z);
  float x = lw.y > 0.0 ? clamp((v - lw.x) / lw.y, 0.0, 1.0) : 0.0;
  float a = lw.z * (lw.w > 0.5 ? x : 1.0) * (float(tc.a) / 255.0);
  if (!(a > 0.0)) return c;
  float keep = c.a / 255.0 * (1.0 - a), A = a + keep;
  return vec4(roundEven(clamp((vec3(tc.rgb) * a + c.rgb * keep) / A, 0.0, 255.0)), roundEven(clamp(A * 255.0, 0.0, 255.0)));
}
${kinds.map((k) => kindFns(k, mode)).join("\n")}
void main() {
  // Output pixel (ox, oy), counted from the top-left.
  ivec2 o = ivec2(int(gl_FragCoord.x), uOut.y - 1 - int(gl_FragCoord.y));
  vec4 gx = texelFetch(uGeom, ivec2(o.x, 0), 0), gy = texelFetch(uGeom, ivec2(o.y, 1), 0);
  uvec3 rgb = uvec3(0u); bool hit = false; uint key; float m;
${lines.join("\n")}
  outColor = c / 255.0;
}`;
}

interface Tex { tex: WebGLTexture; bytes: number; used: number; width: number; height: number; kind: Kind; data: FluximgTypedArray }
interface Program { program: WebGLProgram; uOut: WebGLUniformLocation | null; uSrc: WebGLUniformLocation | null; uBackground: WebGLUniformLocation | null; uNd: WebGLUniformLocation | null; uNdF: WebGLUniformLocation | null; uOrg: WebGLUniformLocation | null; uLM: WebGLUniformLocation | null; uLW: WebGLUniformLocation | null }

/** What a row's edges were computed from (so a frame with an unchanged window reuses them). */
const EDGE_PARAMS = 11;

export class FluximgLiveRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs = new Map<number, Program>();
  private textures = new Map<string, Tex>();
  private lutTex: WebGLTexture;
  private edgeTex: WebGLTexture;
  private geomTex: WebGLTexture;
  private geomCap = 0;
  private geomData = new Float32Array(0);
  /** crop x, y, w, h, outW, outH, srcW, srcH, mode of the geometry on the GPU. */
  private geomKey = new Float64Array(9).fill(NaN);
  private lutRows: Array<Uint8Array | null> = new Array(LUT_ROWS).fill(null);
  private edgeKeys: Float64Array[] = Array.from({ length: LUT_ROWS }, () => new Float64Array(EDGE_PARAMS).fill(NaN));
  private edgeScratch = new Uint32Array(256);
  private quad: WebGLBuffer;
  private tick = 0;
  private residentBytes = 0;
  // Per-frame scratch, reused so a frame allocates nothing it can avoid.
  private chList: LiveChannel[] = [];
  private lyList: LiveLayer[] = [];
  private keep = new Set<string>();
  private nd = new Uint32Array(LUT_ROWS * 4);
  private ndF = new Float32Array(LUT_ROWS);
  private org = new Int32Array(LUT_ROWS);
  private lm = new Float32Array(MAX_LIVE_LAYERS * 4);
  private lw = new Float32Array(MAX_LIVE_LAYERS * 4);
  private bgString: string | null = null;
  private bg = new Float32Array(4);
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, private budgetBytes = 384 * 1024 * 1024) {
    // premultipliedAlpha: false: the drawing buffer holds the law's straight-alpha RGBA exactly (the compositor
    // premultiplies on present). preserveDrawingBuffer: readPixels after the frame was presented still works.
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "high-performance" }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("fluximg: WebGL2 is not available");
    this.gl = gl;
    (canvas as HTMLCanvasElement).addEventListener?.("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.lutTex = this.fixedTexture(UNIT_LUT, gl.RGBA8UI, 256, LUT_ROWS);
    this.edgeTex = this.fixedTexture(UNIT_EDGES, gl.R32UI, 256, LUT_ROWS);
    this.geomTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + UNIT_GEOM);
    gl.bindTexture(gl.TEXTURE_2D, this.geomTex);
    this.nearest(gl.TEXTURE_2D);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  }

  private fixedTexture(unit: number, internal: number, width: number, height: number): WebGLTexture {
    const gl = this.gl, tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
    this.nearest(gl.TEXTURE_2D);
    return tex;
  }

  /** The renderer string of the GPU actually in use (gates record it; a software rasterizer is still correct). */
  rendererName(): string {
    const ext = this.gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : this.gl.getParameter(this.gl.RENDERER));
  }

  private nearest(target: number): void {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** One program per (geometry mode, channel kinds, layer kinds): no dynamic branching on either. */
  private program(mode: number, channels: LiveChannel[], layers: LiveChannel[]): Program {
    let sig = (mode * 8 + channels.length) * 4 + layers.length;
    for (const c of channels) sig = sig * 4 + kindCode(kindOf(c.plane!.dtype));
    for (const l of layers) sig = sig * 4 + kindCode(kindOf(l.plane!.dtype));
    const cached = this.programs.get(sig);
    if (cached) return cached;
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`fluximg: shader failed to compile: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, VERTEX), fs = compile(gl.FRAGMENT_SHADER, fragmentSource(mode, channels.map((c) => kindOf(c.plane!.dtype)), layers.map((l) => kindOf(l.plane!.dtype))));
    gl.attachShader(program, vs); gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`fluximg: shader failed to link: ${gl.getProgramInfoLog(program)}`);
    const loc = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    // Sampler units never change for a program: set them once.
    gl.useProgram(program);
    gl.uniform1i(loc("uGeom"), UNIT_GEOM); gl.uniform1i(loc("uEdges"), UNIT_EDGES); gl.uniform1i(loc("uLut"), UNIT_LUT);
    channels.forEach((_, i) => gl.uniform1i(loc(`cT${i}`), i));
    layers.forEach((_, i) => gl.uniform1i(loc(`lT${i}`), MAX_LIVE_CHANNELS + i));
    const p: Program = { program, uOut: loc("uOut"), uSrc: loc("uSrc"), uBackground: loc("uBackground"), uNd: loc("uNd"), uNdF: loc("uNdF"), uOrg: loc("uOrg"), uLM: loc("uLM"), uLW: loc("uLW") };
    this.programs.set(sig, p);
    return p;
  }

  /** True when the plane's samples are already on the GPU. */
  has(key: string): boolean { return this.textures.has(key); }

  /** Put a plane on the GPU ahead of the frame that needs it (decode-ahead calls this). */
  upload(plane: LivePlane): void {
    const gl = this.gl;
    const cached = this.textures.get(plane.key);
    if (cached && cached.data === plane.data) { cached.used = ++this.tick; return; }
    if (cached) this.drop(plane.key);
    const kind = kindOf(plane.dtype);
    let data: ArrayBufferView = plane.data, internal: number, format: number, type: number, bytes: number;
    switch (plane.dtype) {
      case "uint8": internal = gl.R8UI; format = gl.RED_INTEGER; type = gl.UNSIGNED_BYTE; bytes = 1; break;
      case "int8": internal = gl.R8I; format = gl.RED_INTEGER; type = gl.BYTE; bytes = 1; break;
      case "uint16": internal = gl.R16UI; format = gl.RED_INTEGER; type = gl.UNSIGNED_SHORT; bytes = 2; break;
      case "int16": internal = gl.R16I; format = gl.RED_INTEGER; type = gl.SHORT; bytes = 2; break;
      case "uint32": internal = gl.R32UI; format = gl.RED_INTEGER; type = gl.UNSIGNED_INT; bytes = 4; break;
      case "int32": internal = gl.R32I; format = gl.RED_INTEGER; type = gl.INT; bytes = 4; break;
      // The float32 limit: WebGL2 has no float64 texture.
      case "float64": data = Float32Array.from(plane.data as Float64Array); internal = gl.R32F; format = gl.RED; type = gl.FLOAT; bytes = 4; break;
      default: internal = gl.R32F; format = gl.RED; type = gl.FLOAT; bytes = 4;
    }
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + UNIT_UPLOAD);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, plane.width, plane.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, plane.width, plane.height, format, type, data);
    this.nearest(gl.TEXTURE_2D);
    const size = plane.width * plane.height * bytes;
    this.textures.set(plane.key, { tex, bytes: size, used: ++this.tick, width: plane.width, height: plane.height, kind, data: plane.data });
    this.residentBytes += size;
  }

  private drop(key: string): void {
    const t = this.textures.get(key);
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.residentBytes -= t.bytes;
    this.textures.delete(key);
  }

  /** Release least-recently-used planes until the cache fits its budget; planes in `keep` stay. */
  trim(keep?: ReadonlySet<string>): void {
    if (this.residentBytes <= this.budgetBytes) return;
    const order = [...this.textures.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key] of order) {
      if (this.residentBytes <= this.budgetBytes) break;
      if (keep?.has(key)) continue;
      this.drop(key);
    }
  }

  get bytes(): number { return this.residentBytes; }

  /** Change the texture budget (the slide player splits one budget over its renderers); trims at once. */
  setBudget(bytes: number): void { this.budgetBytes = Math.max(0, bytes); this.trim(); }

  /** Give back every plane texture (programs and tables stay): nothing on screen needs them any more. */
  clear(): void { for (const key of [...this.textures.keys()]) this.drop(key); }

  /** Planes resident on the GPU (gates count them). */
  get textureCount(): number { return this.textures.size; }

  private setLutRow(row: number, table: Uint8Array): void {
    if (this.lutRows[row] === table) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT_LUT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, 256, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, table.subarray(0, 1024));
    this.lutRows[row] = table;
  }

  /** The slot edges of one row, and its nodata / flip uniforms. Edges are recomputed only when an input changed. */
  private setRow(row: number, c: LiveChannel, mode: number, linear: boolean): void {
    const plane = c.plane!, dtype = plane.dtype, kind = kindOf(dtype), map = plane.map;
    const mul = map ? map.mul : 1, add = map ? map.add : 0, sub = map ? map.sub : 0;
    const ident = mul === 1 && add === 0 && sub === 0;
    const flip = !ident && mul < 0;
    // Nearest on an integer plane compares the integer itself; everything else compares a float32 key.
    const domain = mode === NEAREST && kind !== "f" ? (kind === "u" ? DOMAIN_UINT : DOMAIN_INT) : DOMAIN_FLOAT;
    const bits = bitsOf(dtype);
    // The origin: mean and bilinear on 8/16-bit planes run on (sample − origin), an exact integer subtraction, with
    // the origin at the stored sample nearest the window's centre. A float32 result then carries its precision
    // relative to the window, not to the absolute code: linear16 codes near 2·10^4 with a few codes per slot
    // would otherwise round a quarter of a slot's worth of precision away. 32-bit and float planes: 0.
    let origin = 0;
    if (kind !== "f" && bits < 32) {
      const mid = (c.range[0] + c.range[1]) / 2, t = ident ? mid : sub + (mid - add) / mul;
      const lo = kind === "u" ? 0 : -(2 ** (bits - 1)), hi = kind === "u" ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
      if (Number.isFinite(t)) origin = Math.min(hi, Math.max(lo, Math.round(t)));
    }
    const norm = linear ? 0 : c.norm === "log" ? 1 : c.norm === "gamma" ? 2 : 0, gamma = linear ? 1 : c.gamma;
    const k = this.edgeKeys[row];
    if (k[0] !== domain || k[1] !== bits || k[2] !== mul || k[3] !== add || k[4] !== sub || k[5] !== c.range[0] || k[6] !== c.range[1] || k[7] !== norm || !Object.is(k[8], gamma) || k[9] !== origin) {
      const n = makeNormalizer(c.range, norm === 1 ? "log" : norm === 2 ? "gamma" : "linear", gamma);
      computeEdges(this.edgeScratch, domain, bits, origin, mul, add, sub, ident, n, flip);
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + UNIT_EDGES);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, 256, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, this.edgeScratch);
      k[0] = domain; k[1] = bits; k[2] = mul; k[3] = add; k[4] = sub; k[5] = c.range[0]; k[6] = c.range[1]; k[7] = norm; k[8] = gamma; k[9] = origin;
    }
    this.org[row] = origin;
    // Nodata: integer planes compare the key, float planes the float32 value (so −0 equals a nodata of 0, as in JS).
    const nodata = map ? map.nodata : null, o = row * 4;
    let has = 0, ndKey = 0, ndF = 0;
    if (nodata !== null && nodata === nodata) {
      if (kind === "f") {
        // A float32 sample can only equal a float32-representable code; a float64 plane was rounded on upload.
        if (dtype === "float64" || Math.fround(nodata) === nodata) { has = 1; ndF = nodata; }
      } else if (Number.isInteger(nodata)) {
        const lo = kind === "u" ? 0 : -(2 ** (bits - 1)), hi = kind === "u" ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
        if (nodata >= lo && nodata <= hi) { has = 1; ndKey = kind === "u" ? nodata : nodata + TWO31; }
      }
    }
    this.nd[o] = ndKey; this.nd[o + 1] = has; this.nd[o + 2] = bits === 32 ? 1 : 0; this.nd[o + 3] = flip ? KEY_MAX : 0;
    this.ndF[row] = ndF;
    this.setLutRow(row, c.table);
  }

  /** Fill and upload the per-column / per-row sampling table when the geometry changed; returns the mode. */
  private setGeometry(frame: LiveFrame, W: number, H: number): number {
    const { crop } = frame;
    const sx = crop.width / W, sy = crop.height / H;
    const mode = sx > 1 || sy > 1 ? MEAN : frame.smooth ? BILINEAR : NEAREST;
    const k = this.geomKey;
    if (k[0] === crop.x && k[1] === crop.y && k[2] === crop.width && k[3] === crop.height && k[4] === W && k[5] === H && k[6] === frame.width && k[7] === frame.height && k[8] === mode) return mode;
    k[0] = crop.x; k[1] = crop.y; k[2] = crop.width; k[3] = crop.height; k[4] = W; k[5] = H; k[6] = frame.width; k[7] = frame.height; k[8] = mode;
    const gl = this.gl, need = Math.max(W, H);
    gl.activeTexture(gl.TEXTURE0 + UNIT_GEOM);
    if (need > this.geomCap) {
      // Grow in steps so a resize drag does not reallocate every frame.
      this.geomCap = Math.max(256, 2 ** Math.ceil(Math.log2(need)));
      this.geomData = new Float32Array(this.geomCap * 2 * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.geomCap, 2, 0, gl.RGBA, gl.FLOAT, null);
    }
    const hx = mode === BILINEAR ? 2 : mode === MEAN && sx > 1 ? 1 : 0;
    const hy = mode === BILINEAR ? 2 : mode === MEAN && sy > 1 ? 1 : 0;
    const rowY = this.geomCap * 4;
    fillAxis(this.geomData, 0, crop.x, sx, W, frame.width, hx);
    fillAxis(this.geomData, rowY, crop.y, sy, H, frame.height, hy);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, 1, gl.RGBA, gl.FLOAT, this.geomData, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, H, 1, gl.RGBA, gl.FLOAT, this.geomData, rowY);
    return mode;
  }

  /**
   * Draw one frame. A channel or layer whose plane has not arrived yet is simply left out of this frame; so are
   * channels beyond MAX_LIVE_CHANNELS and layers beyond MAX_LIVE_LAYERS.
   *
   * `over` (the slide player's mixes; the live view never passes it): draw this frame OVER what the buffer holds at
   * that weight, every component straight-lerped (`(1 - over)·old + over·new`), the reference meaning of a mix. The
   * frame must have the buffer's size.
   */
  draw(frame: LiveFrame, over?: number): void {
    const gl = this.gl;
    if (this.lost) return;
    const canvas = this.canvas;
    const W = Math.max(0, Math.floor(frame.outWidth)), H = Math.max(0, Math.floor(frame.outHeight));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    if (W === 0 || H === 0) return;
    const channels = this.chList, layers = this.lyList, keep = this.keep;
    channels.length = 0; layers.length = 0; keep.clear();
    for (const c of frame.channels) if (c.plane && channels.length < MAX_LIVE_CHANNELS) channels.push(c);
    for (const l of frame.layers) if (l.plane && layers.length < MAX_LIVE_LAYERS) layers.push(l);
    for (const c of channels) { this.upload(c.plane!); keep.add(c.plane!.key); }
    for (const l of layers) { this.upload(l.plane!); keep.add(l.plane!.key); }

    const mode = this.setGeometry(frame, W, H);
    const p = this.program(mode, channels, layers);
    gl.viewport(0, 0, W, H);
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2i(p.uOut, W, H);
    gl.uniform2i(p.uSrc, frame.width, frame.height);
    if (frame.background !== this.bgString) {
      const bg = parseBackground(frame.background);
      this.bgString = frame.background;
      if (bg) { this.bg[0] = bg[0]; this.bg[1] = bg[1]; this.bg[2] = bg[2]; this.bg[3] = 255; } else this.bg.fill(0);
    }
    gl.uniform4fv(p.uBackground, this.bg);
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(c.plane!.key)!.tex);
      this.setRow(i, c, mode, false);
    }
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i], row = MAX_LIVE_CHANNELS + i, map = l.plane!.map, o = i * 4;
      gl.activeTexture(gl.TEXTURE0 + row);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(l.plane!.key)!.tex);
      this.setRow(row, l, mode, true);
      // The shader's m is origin-relative: value = add + mul · (m + origin − sub).
      const mul = map ? map.mul : 1, add = map ? map.add : 0, sub = map ? map.sub : 0, origin = this.org[row];
      this.lm[o] = mul; this.lm[o + 1] = add; this.lm[o + 2] = sub - origin; this.lm[o + 3] = mul === 1 && add === 0 && sub === 0 && origin === 0 ? 1 : 0;
      this.lw[o] = l.range[0]; this.lw[o + 1] = l.range[1] - l.range[0];
      this.lw[o + 2] = Number.isFinite(l.opacity) ? Math.min(1, Math.max(0, l.opacity)) : 1;
      this.lw[o + 3] = l.opacityFromValue ? 1 : 0;
    }
    gl.uniform4uiv(p.uNd, this.nd);
    gl.uniform1fv(p.uNdF, this.ndF);
    gl.uniform1iv(p.uOrg, this.org);
    if (layers.length) { gl.uniform4fv(p.uLM, this.lm); gl.uniform4fv(p.uLW, this.lw); }
    const mixing = over !== undefined && over < 1;
    if (mixing) { gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, Math.max(0, over)); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (mixing) gl.disable(gl.BLEND);
    this.trim(keep);
  }

  /** The drawing buffer as straight-alpha RGBA rows from the top (for gates; not on the interactive path). */
  readPixels(): Uint8ClampedArray {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // The buffer is straight alpha already (premultipliedAlpha: false); only the row order flips.
    const out = new Uint8ClampedArray(w * h * 4), row = w * 4;
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const key of [...this.textures.keys()]) this.drop(key);
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    gl.deleteTexture(this.lutTex);
    gl.deleteTexture(this.edgeTex);
    gl.deleteTexture(this.geomTex);
    gl.deleteBuffer(this.quad);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
