// fluximg WebGL2 live renderer held to the reference renderer, pixel for pixel.
//
// One headless page (scripts/lib/driver.mjs launch(), whatever GPU it gives: a software rasterizer is a valid
// check) bundles gl/liveRenderer.ts with render.ts + lut.ts, and for every case of a matrix draws the SAME
// RenderInput with `renderView` and with `FluximgLiveRenderer.draw(frameFromRenderInput(...))` + `readPixels`,
// comparing all four components of every pixel. Only a per-case summary crosses the protocol: max |difference|
// per component, how many pixels differ by more than 1, and the first few offending pixels with both values.
//
// Tolerance: 1 (of 255) on every component of every pixel. Two kinds of case carry a stated, different
// tolerance, and say so in their output line:
//   - "float32 limit": float64 planes (uploaded as float32) and mean on uint32 / int32 planes beyond 2^24
//     (summed in float32). They use ramp tables, where a sample within float32 rounding of a slot edge moves one
//     slot = one step, so the bound stays 1; the label records that the data is not bit-identical on the GPU.
//   - "beyond bound": a minifying footprint larger than 8 x 8 samples, where the shader averages a regular
//     8 x 8 subset (liveRenderer.ts header). Loose tolerance on smooth data; the crop runs off the plane, so a
//     read outside the plane (zeros) would pull the mean far below the window and fail it.
//
// Also measured (printed, generous ceiling only): drawing a 1024 x 1024 two-channel uint16 frame after upload,
// and uploading one such plane, both bracketed by gl.finish().
//
// Pure tier, prerequisite "chrome". Hermetic: synthetic data generated in the page from fixed seeds; the bundle
// lives in a scratch directory that is removed; the server listens on an ephemeral port.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { build } from "esbuild";
import { launch, errors } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { linear16Params } from "../src/lib/fluximg/encoding";
import type { FluximgDtype } from "../src/lib/fluximg/types";

const h = harness("verify-fluximg-gl");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------
// The matrix (plain JSON: the page generates the data from it)
// ---------------------------------------------------------------------------------------------

interface PlaneSpec {
  dtype: FluximgDtype;
  lo: number; hi: number; seed: number;
  /** "random" (uniform) or "gradient" (smooth, plus `noise`). */
  pattern?: "random" | "gradient";
  noise?: number;
  /** Fraction of samples without data: the nodata code for integers, NaN for floats. */
  holes?: number;
  /** "identity" (default), "values" (map === null) or an explicit value map. */
  map?: "identity" | "values" | { mul: number; add: number; sub: number; nodata: number | null };
  nodata?: number | null;
}
interface ChannelSpec { plane: PlaneSpec; range: [number, number]; norm?: "linear" | "log" | "gamma"; gamma?: number; color?: string | null; lut?: string | null; invert?: boolean; visible?: boolean }
interface LayerSpec { plane: PlaneSpec; range: [number, number]; color?: string | null; lut?: string | null; opacity: number; fromValue: boolean }
interface Case {
  name: string; width: number; height: number;
  channels: ChannelSpec[]; layers?: LayerSpec[];
  composite?: "blend" | "single"; solo?: number; background?: string; smooth?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  out?: [number, number];
  /** Stated tolerance other than 1, and why. */
  tol?: number; why?: string;
}

/**
 * A "tie": the reference VALUE lies within this many slot units (x · 256) of a slot edge. Nearest never needs
 * this (it compares stored keys exactly). Mean and bilinear results are float32 on the GPU, computed relative
 * to an integer origin at the window's centre for 8/16-bit planes, so their error is ~1e-5 slot at worst; the
 * ties seen in practice sit within float64 noise (~1e-12) of an edge, where the reference itself is decided by
 * the rounding of its own float64 sum, which no float32 pipeline can reproduce.
 */
const TIE = 1e-4;
/**
 * A rounding tie (intensity layers): a quantity the law rounds to 8 bits lies within this distance of .5. The
 * shader's float32 composite carries ~1e-4 of error at 255 (a few ulps over ~6 operations); 1e-3 bounds it.
 */
const ROUND = 1e-3;
/** At most this fraction of a case's pixels may be ties (of either kind) that flipped. */
const TIE_SHARE = 0.01;
const modeOf = (c: Case): "nearest" | "mean" | "bilinear" => {
  const crop = c.crop ?? { x: 0, y: 0, width: c.width, height: c.height }, out = c.out ?? [c.width, c.height];
  return crop.width / out[0] > 1 || crop.height / out[1] > 1 ? "mean" : c.smooth ? "bilinear" : "nearest";
};

const W = 48, H = 40;
let seed = 1;
const P = (dtype: FluximgDtype, lo: number, hi: number, extra: Partial<PlaneSpec> = {}): PlaneSpec => ({ dtype, lo, hi, seed: seed++, ...extra });
const one = (name: string, c: ChannelSpec, extra: Partial<Case> = {}): Case => ({ name, width: W, height: H, channels: [c], ...extra });
const MULTI = { color: null, lut: "multi" } as const; // a table whose neighbouring slots differ a lot: any slot error shows

// linear16: value = offset + scale · (code − 1), code 0 = no data, with a window whose slot edges fall exactly
// on codes in exact arithmetic (every 4th code), which float32 normalization gets wrong on some of them.
const l16 = linear16Params(-1.2, 2.5);
const L16 = { mul: l16.scale, add: l16.offset, sub: 1, nodata: 0 };
const K0 = 20000;
const L16_RANGE: [number, number] = [l16.offset + l16.scale * K0, l16.offset + l16.scale * (K0 + 1024)];
const l16Plane = (extra: Partial<PlaneSpec> = {}): PlaneSpec => P("uint16", K0 - 100, K0 + 1150, { map: L16, holes: 0.1, ...extra });

const T31 = 2 ** 31;
const cases: Case[] = [];

// Stored types, 1:1 nearest.
cases.push(
  one("uint8", { plane: P("uint8", 0, 255), range: [20, 230], ...MULTI }),
  one("uint8 window on slot edges", { plane: P("uint8", 0, 255), range: [0, 256], ...MULTI }),
  one("int8 + nodata", { plane: P("int8", -127, 127, { holes: 0.1, nodata: -128 }), range: [-100, 100], ...MULTI }),
  one("uint16 window on slot edges", { plane: P("uint16", 900, 1300), range: [1000, 1256], ...MULTI }),
  one("uint16 full range", { plane: P("uint16", 0, 65535), range: [100, 60000], ...MULTI }),
  one("int16 + nodata", { plane: P("int16", -3000, 3000, { holes: 0.15, nodata: -32768 }), range: [-2000, 2500], ...MULTI }),
  one("uint32 beyond 2^24", { plane: P("uint32", T31, 2 ** 32 - 1), range: [T31 + 2 ** 29, 2 ** 32 - 2 ** 28], ...MULTI }),
  one("uint32 edges 1 apart at 2^31", { plane: P("uint32", T31 - 10, T31 + 270, { holes: 0.05, nodata: T31 + 7 }), range: [T31, T31 + 256], ...MULTI }),
  one("int32 full range", { plane: P("int32", -T31, T31 - 1), range: [-1e9, 1e9], ...MULTI }),
  one("int32 edges 1 apart at -2^30", { plane: P("int32", -(2 ** 30) - 10, -(2 ** 30) + 270), range: [-(2 ** 30), -(2 ** 30) + 256], ...MULTI }),
  one("float32 + NaN", { plane: P("float32", -1, 2, { holes: 0.1 }), range: [0, 1], ...MULTI }),
  one("float32 + nodata code", { plane: P("float32", -1, 2, { holes: 0.1, nodata: -9999 }), range: [0, 1], ...MULTI }),
  one("float64 + NaN [float32 limit]", { plane: P("float64", 0, 1, { holes: 0.1 }), range: [0.1, 0.9], color: "#ffffff" }),
  one("linear16 (window edges on codes)", { plane: l16Plane(), range: L16_RANGE, ...MULTI }),
  one("values plane (map null)", { plane: P("float32", 0, 10, { holes: 0.1, map: "values" }), range: [2, 8], ...MULTI }),
);
// Norms.
cases.push(
  one("log", { plane: P("uint16", 0, 4000), range: [10, 3000], norm: "log", ...MULTI }),
  one("log, edges on integers", { plane: P("uint16", 0, 300), range: [1, 256], norm: "log", ...MULTI }),
  one("log, black point 0 = linear", { plane: P("uint16", 0, 4000), range: [0, 3000], norm: "log", ...MULTI }),
  one("log, black point < 0 = linear", { plane: P("int16", -100, 4000), range: [-50, 3000], norm: "log", ...MULTI }),
  one("log, values <= 0", { plane: P("int16", -500, 2000), range: [1, 2000], norm: "log", ...MULTI }),
  one("log, float32 values <= 0", { plane: P("float32", -2, 50, { holes: 0.05 }), range: [0.01, 40], norm: "log", ...MULTI }),
  one("gamma 0.5", { plane: P("uint16", 0, 4000), range: [100, 3500], norm: "gamma", gamma: 0.5, ...MULTI }),
  one("gamma 2.2", { plane: P("uint16", 0, 4000), range: [100, 3500], norm: "gamma", gamma: 2.2, ...MULTI }),
  one("gamma 2.2 float32", { plane: P("float32", -0.5, 1.5), range: [0, 1], norm: "gamma", gamma: 2.2, ...MULTI }),
  one("degenerate window hi = lo", { plane: P("uint16", 0, 4000), range: [2000, 2000], ...MULTI }),
  one("degenerate window hi < lo", { plane: P("float32", 0, 4000), range: [3000, 1000], ...MULTI }),
);
// Tables.
cases.push(
  one("colour ramp", { plane: P("uint16", 0, 4000), range: [100, 3500], color: "#ff8000" }),
  one("colour ramp inverted", { plane: P("uint16", 0, 4000), range: [100, 3500], color: "#40c0ff", invert: true }),
  one("multi-colour inverted", { plane: P("uint16", 0, 4000), range: [100, 3500], ...MULTI, invert: true }),
  one("8-entry table", { plane: P("uint8", 0, 255), range: [0, 255], color: null, lut: "fire8" }),
);
// Blend and composite: mixed sampler kinds in one program.
const bl = (color: string, plane: PlaneSpec, range: [number, number], visible = true): ChannelSpec => ({ plane, range, color, visible });
cases.push(
  { name: "blend 2", width: W, height: H, channels: [bl("#ff0000", P("uint16", 0, 4000), [0, 4000]), bl("#00ff00", P("int16", -100, 3000), [0, 3000])] },
  { name: "blend 3", width: W, height: H, channels: [bl("#ff0000", P("uint8", 0, 255), [0, 255]), bl("#00ff00", P("float32", 0, 1), [0, 1]), bl("#0000ff", P("uint16", 0, 4000), [0, 4000])] },
  { name: "blend 5, clamping at 255", width: W, height: H, channels: [
    bl("#ff8040", P("uint8", 100, 255), [0, 255]), bl("#ffff00", P("int16", 0, 3000), [0, 3000]), bl("#80ffff", P("float32", 0.3, 1, { holes: 0.2 }), [0, 1]),
    bl("#ff00ff", P("uint16", 0, 4000, { holes: 0.2, nodata: 0 }), [0, 4000]), bl("#ffffff", P("int8", -100, 100), [-100, 100])] },
  { name: "blend skips invisible", width: W, height: H, channels: [bl("#ff0000", P("uint16", 0, 4000), [0, 4000]), bl("#00ff00", P("uint16", 0, 4000), [0, 4000], false), bl("#0000ff", P("uint16", 0, 4000), [0, 4000])] },
  { name: "single (solo 2)", width: W, height: H, composite: "single", solo: 2, channels: [{ plane: P("uint16", 0, 4000), range: [0, 4000], color: "#ff0000" }, { plane: P("uint16", 0, 4000), range: [0, 4000], color: "#00ff00" }, { plane: P("int16", -100, 3000, { holes: 0.2, nodata: -1 }), range: [0, 3000], ...MULTI }] },
  { name: "single, solo channel invisible", width: W, height: H, composite: "single", solo: 0, channels: [{ plane: P("uint16", 0, 4000), range: [0, 4000], ...MULTI, visible: false }, { plane: P("uint16", 0, 4000), range: [0, 4000], color: "#00ff00" }] },
);
// Background.
const holey = (): ChannelSpec => ({ plane: P("uint16", 0, 4000, { holes: 0.3, nodata: 0 }), range: [100, 3900], ...MULTI });
cases.push(
  one("background colour", holey(), { background: "#204060" }),
  one("background transparent", holey(), { background: "transparent" }),
  one("background #rgb", holey(), { background: "#a5c" }),
  one("background unusable = black", holey(), { background: "nonsense" }),
);
// Intensity layers.
const base = (): ChannelSpec => ({ plane: P("uint16", 0, 4000, { holes: 0.15, nodata: 0 }), range: [0, 4000], color: "#00ffff" });
cases.push(
  one("layer, constant opacity", base(), { layers: [{ plane: P("uint8", 0, 255), range: [50, 200], color: "#ff0000", opacity: 0.6, fromValue: false }] }),
  one("layer, opacity from value", base(), { layers: [{ plane: P("float32", -0.2, 1.2, { holes: 0.2 }), range: [0, 1], color: "#ffff00", opacity: 0.8, fromValue: true }] }),
  one("layer, table alpha < 255", base(), { layers: [{ plane: P("uint16", 0, 1000, { holes: 0.1, nodata: 0 }), range: [0, 1000], color: null, lut: "alpha", opacity: 1, fromValue: false }] }),
  one("layer, 8-entry table with alpha", base(), { layers: [{ plane: P("int16", -10, 300), range: [0, 255], color: null, lut: "fire8", opacity: 0.9, fromValue: true }] }),
  one("two layers in order", base(), { layers: [
    { plane: P("uint8", 0, 255), range: [0, 255], color: "#ff0000", opacity: 0.5, fromValue: false },
    { plane: P("float32", 0, 1, { holes: 0.3 }), range: [0.2, 0.8], color: null, lut: "alpha", opacity: 0.7, fromValue: true }] }),
  one("layers over a transparent background", { plane: P("uint16", 0, 4000, { holes: 0.4, nodata: 0 }), range: [0, 4000], color: "#00ff00" }, { background: "transparent", layers: [
    { plane: P("uint8", 0, 255, { holes: 0.3, nodata: 0 }), range: [0, 255], color: "#ff00ff", opacity: 0.55, fromValue: true },
    { plane: P("uint16", 0, 1000), range: [0, 1000], color: null, lut: "alpha", opacity: 1, fromValue: false }] }),
  { name: "layer only, no channels, transparent", width: W, height: H, channels: [], background: "transparent", layers: [{ plane: P("float32", 0, 1, { holes: 0.2 }), range: [0, 1], color: "#ff8000", opacity: 0.75, fromValue: true }] },
  one("layer opacity 0 and > 1 (clamped)", base(), { layers: [
    { plane: P("uint8", 0, 255), range: [0, 255], color: "#ff0000", opacity: 0, fromValue: false },
    { plane: P("uint8", 0, 255), range: [0, 255], color: "#0000ff", opacity: 1.7, fromValue: true }] }),
  one("layer, linear16", base(), { layers: [{ plane: l16Plane(), range: L16_RANGE, color: "#ff00ff", opacity: 0.9, fromValue: true }] }),
);
// Geometry. Two channels of different kinds, holes, a jumpy table: every sampling decision shows.
const geo = (extra: Partial<Case>, kinds: [FluximgDtype, FluximgDtype] = ["uint16", "int16"]): Case => ({
  name: "", width: W, height: H, ...extra,
  channels: [
    { plane: P(kinds[0], 0, 4000, { holes: 0.1, nodata: 0 }), range: [200, 3800], ...MULTI },
    { plane: P(kinds[1], 0, 3000, { holes: 0.1, nodata: kinds[1] === "int16" ? -1 : null }), range: [100, 2900], color: "#3060ff" },
  ],
});
const G = (name: string, extra: Partial<Case>, kinds?: [FluximgDtype, FluximgDtype]): Case => ({ ...geo(extra, kinds), name });
cases.push(
  G("magnify 3x", { crop: { x: 10, y: 8, width: 20, height: 15 }, out: [60, 45] }),
  G("magnify fractional, fractional origin", { crop: { x: 3.3, y: 2.7, width: 17.4, height: 13.1 }, out: [50, 37] }),
  G("crop partly outside, 1:1", { crop: { x: -5.5, y: -3.25, width: 40, height: 30 }, out: [40, 30] }),
  G("crop partly outside, magnified", { crop: { x: 30.5, y: 25.2, width: 30, height: 20 }, out: [71, 47] }),
  G("smooth magnify 3x", { smooth: true, crop: { x: 10, y: 8, width: 20, height: 15 }, out: [60, 45] }),
  G("smooth fractional, fractional origin", { smooth: true, crop: { x: 3.3, y: 2.7, width: 17.4, height: 13.1 }, out: [50, 37] }),
  G("smooth crop partly outside", { smooth: true, crop: { x: -4.4, y: 30.1, width: 25, height: 18 }, out: [61, 43] }),
  G("smooth float32 + linear16", { smooth: true, crop: { x: 5.5, y: 5.5, width: 12, height: 10 }, out: [53, 41] }, ["float32", "uint16"]),
  G("smooth 1:1 (= nearest)", { smooth: true }),
  G("minify 2x", { out: [24, 20] }),
  G("minify 3.7x", { crop: { x: 0, y: 0, width: 44.4, height: 37 }, out: [12, 10] }),
  G("minify 3.7x, fractional origin, partly outside", { crop: { x: -6.3, y: 2.9, width: 59.2, height: 40.7 }, out: [16, 11] }),
  G("non-uniform: x minified, y magnified", { crop: { x: 0, y: 5, width: 48, height: 10 }, out: [19, 33] }),
  G("non-uniform + smooth (mean wins)", { smooth: true, crop: { x: 2, y: 0, width: 10, height: 40 }, out: [31, 13] }),
  G("minify float32 + int8", { crop: { x: 1.5, y: 0, width: 45, height: 40 }, out: [17, 15] }, ["float32", "int8"]),
  G("minify uint8 + linear16 (as uint16)", { out: [20, 13] }, ["uint8", "uint16"]),
  one("minify linear16", { plane: l16Plane(), range: L16_RANGE, ...MULTI }, { out: [21, 17] }),
  one("smooth linear16", { plane: l16Plane(), range: L16_RANGE, ...MULTI }, { smooth: true, crop: { x: 7.25, y: 3.5, width: 9, height: 7 }, out: [40, 31] }),
  one("minify 2x, window on slot edges", { plane: P("uint16", 900, 1300), range: [1000, 1256], ...MULTI }, { out: [24, 20] }),
  one("minify log + gamma channels", { plane: P("uint16", 0, 4000), range: [10, 3000], norm: "log", ...MULTI }, { out: [17, 13] }),
  G("1x1 output", { width: 6, height: 5, out: [1, 1] }),
  G("1x1 output from a 7x7 footprint", { width: 7, height: 7, out: [1, 1] }),
  G("1x1 source, magnified", { width: 1, height: 1, out: [7, 5] }),
  G("1x1 source, smooth", { width: 1, height: 1, smooth: true, out: [7, 5] }),
  G("1x1 source, 1x1 output", { width: 1, height: 1, out: [1, 1] }),
  G("crop entirely outside", { crop: { x: 100, y: 100, width: 10, height: 10 }, out: [10, 10], background: "#123456" }),
);
// The float32 limit: ramp tables (one slot = one step), stated in the case name.
cases.push(
  one("mean uint32 beyond 2^24 [float32 limit]", { plane: P("uint32", T31, 2 ** 32 - 1), range: [T31, 2 ** 32 - 1], color: "#ffffff" }, { out: [16, 13] }),
  one("mean int32 beyond 2^24 [float32 limit]", { plane: P("int32", -T31, T31 - 1), range: [-T31, T31 - 1], color: "#ff8000" }, { out: [19, 11] }),
  one("smooth uint32 beyond 2^24 [float32 limit]", { plane: P("uint32", T31, 2 ** 32 - 1), range: [T31, 2 ** 32 - 1], color: "#ffffff" }, { smooth: true, crop: { x: 3.5, y: 2.25, width: 11, height: 9 }, out: [40, 33] }),
  one("mean float64 [float32 limit]", { plane: P("float64", 0, 1, { holes: 0.1 }), range: [0.1, 0.9], color: "#ffffff" }, { out: [16, 13] }),
  one("smooth float64 [float32 limit]", { plane: P("float64", 0, 1, { holes: 0.1 }), range: [0.1, 0.9], color: "#ffffff" }, { smooth: true, crop: { x: 3.5, y: 2.25, width: 11, height: 9 }, out: [40, 33] }),
);
// Beyond the 8 x 8 bound: a regular subset; smooth data; the crop runs off the plane on two sides.
const BIG = { width: 240, height: 180 };
const grad = (): ChannelSpec => ({ plane: P("uint16", 50000, 60000, { pattern: "gradient", noise: 40 }), range: [50000, 60000], color: "#ffffff" });
cases.push(
  one("beyond bound: 20x minify", grad(), { ...BIG, out: [12, 9], tol: 6, why: "regular 8x8 subset of a 20x20 footprint on a smooth gradient" }),
  one("beyond bound: 13.3x, crop off the plane", grad(), { ...BIG, crop: { x: -40, y: 60.5, width: 320, height: 160 }, out: [24, 12], tol: 6, why: "subset of a 13x13 footprint; reading outside (zeros) would miss by ~255" }),
  one("beyond bound: x only (12x), y nearest", grad(), { ...BIG, crop: { x: 0, y: 0, width: 240, height: 20 }, out: [20, 30], tol: 6, why: "subset of a 12-sample footprint along x" }),
);

// ---------------------------------------------------------------------------------------------
// The page side (serialized into the page; runs against window.FX)
// ---------------------------------------------------------------------------------------------

function pageRun(list: Case[], TIE: number, ROUND: number): unknown {
  const FX = (window as any).FX;
  const rng = (s: number): (() => number) => {
    let a = s >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };
  const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
  const R = rng(4242);
  const MULTI = Array.from({ length: 256 }, () => `#${hex2((R() * 256) | 0)}${hex2((R() * 256) | 0)}${hex2((R() * 256) | 0)}`);
  const ALPHA = Array.from({ length: 256 }, (_, i) => `#ffcc00${hex2(i)}`);
  const FIRE8 = ["#00000000", "#20000040", "#40100060", "#602000a0", "#803000c0", "#a04000e0", "#c06000f0", "#e0e000ff"];
  const resolve = (name: string): string[] | null => (name === "multi" ? MULTI : name === "alpha" ? ALPHA : name === "fire8" ? FIRE8 : null);
  const isFloat = (d: string): boolean => d === "float32" || d === "float64";
  const makePlane = (p: PlaneSpec, w: number, h: number) => {
    const n = w * h, data = FX.allocTyped(p.dtype, n), r = rng(p.seed), float = isFloat(p.dtype);
    for (let i = 0; i < n; i++) {
      let v: number;
      if (p.pattern === "gradient") {
        const x = i % w, y = Math.floor(i / w);
        v = p.lo + (p.hi - p.lo) * (0.7 * x / Math.max(1, w - 1) + 0.3 * y / Math.max(1, h - 1)) + (p.noise ?? 0) * (r() - 0.5);
        v = Math.min(p.hi, Math.max(p.lo, v));
      } else v = p.lo + (p.hi - p.lo) * r();
      if (!float) v = Math.round(v);
      if (p.holes && r() < p.holes) v = float ? (p.nodata ?? NaN) : (typeof p.map === "object" ? p.map.nodata : p.nodata) as number;
      data[i] = v;
    }
    const map = p.map === "values" ? null : typeof p.map === "object" ? { ...p.map, float: false } : { mul: 1, add: 0, sub: 0, nodata: p.nodata ?? null, float: isFloat(p.dtype) };
    return { data, map };
  };
  const canvas = document.createElement("canvas");
  const live = new FX.FluximgLiveRenderer(canvas);
  const gl = live.gl as WebGL2RenderingContext;
  const results: unknown[] = [];
  for (let ci = 0; ci < list.length; ci++) {
    const c = list[ci];
    const out = c.out ?? [c.width, c.height];
    const input = {
      width: c.width, height: c.height,
      channels: c.channels.map((ch, i) => ({
        plane: makePlane(ch.plane, c.width, c.height),
        view: { index: i, name: `c${i}`, visible: ch.visible ?? true, color: ch.color ?? null, lut: ch.lut ?? null, range: ch.range, norm: ch.norm ?? "linear", gamma: ch.gamma ?? 1, invert: ch.invert ?? false },
        table: FX.channelTable({ color: ch.color ?? null, lut: ch.lut ?? null, invert: ch.invert ?? false }, resolve),
      })),
      layers: (c.layers ?? []).map((l) => ({
        plane: makePlane(l.plane, c.width, c.height), range: l.range, opacity: l.opacity, opacityFromValue: l.fromValue,
        table: FX.channelTable({ color: l.color ?? null, lut: l.lut ?? null, invert: false }, resolve),
      })),
      composite: c.composite ?? "blend", solo: c.solo ?? 0, background: c.background ?? "#000000", smooth: c.smooth ?? false,
      crop: c.crop ?? { x: 0, y: 0, width: c.width, height: c.height }, outWidth: out[0], outHeight: out[1],
    };
    const ref: Uint8ClampedArray = FX.renderView(input);
    const frame = FX.frameFromRenderInput(input, { channels: input.channels.map((_: unknown, i: number) => `case${ci}:c${i}`), layers: input.layers.map((_: unknown, i: number) => `case${ci}:l${i}`) });
    live.draw(frame);
    const got: Uint8ClampedArray = live.readPixels();
    const glError = gl.getError();
    if (got.length !== ref.length) { results.push({ name: c.name, lengthMismatch: [got.length, ref.length] }); continue; }
    // A pixel off by more than 1 is classified before it counts as a divergence:
    //  - a SLOT tie: some channel / layer's reference value lies within TIE slot of a slot edge (x · 256 ≈ k);
    //  - a ROUNDING tie: replaying the layer composite in float64 (law section 4), some quantity rounded to 8 bits
    //    lies within ROUND of a .5 boundary; at low alpha a 1-step alpha flip moves the next layer's straight
    //    colour by several steps.
    // Both are decided by rounding noise in the reference itself; anything else is a real divergence.
    let xs: Float64Array[] | null = null, nCh = 0, pre: Uint8ClampedArray | null = null;
    const ensure = (): Float64Array[] => {
      if (xs) return xs;
      const g = FX.renderGeometry(input.width, input.height, input.crop, out[0], out[1], input.smooth);
      const contributing = FX.contributingChannels(input);
      nCh = contributing.length;
      const sources = [...contributing.map((ch: any) => ({ plane: ch.plane, n: FX.makeNormalizer(ch.view.range, ch.view.norm, ch.view.gamma) })),
        ...input.layers.map((l: any) => ({ plane: l.plane, n: FX.makeNormalizer(l.range, "linear", 1) }))];
      xs = sources.map((s) => {
        const vals = new Float64Array(out[0] * out[1]);
        FX.sampleValues(s.plane, input.width, input.height, g, vals, out[0], out[1]);
        return vals.map((v) => (v !== v ? NaN : FX.normalizeValue(s.n, v)));
      });
      pre = FX.renderView({ ...input, layers: [] });
      return xs;
    };
    const u8 = new Uint8ClampedArray(1);
    const roundingDistance = (o: number): number => {
      const x = ensure();
      let C = Array.from(pre!.subarray(o * 4, o * 4 + 4)), d = Infinity;
      input.layers.forEach((l: any, li: number) => {
        const opacity = Number.isFinite(l.opacity) ? Math.min(1, Math.max(0, l.opacity)) : 1;
        const xv = x[nCh + li][o];
        if (opacity <= 0 || xv !== xv) return;
        const s = FX.slotOf(xv) * 4, t = l.table;
        const a = opacity * (l.opacityFromValue ? xv : 1) * (t[s + 3] / 255);
        if (a <= 0) return;
        const keep = (C[3] / 255) * (1 - a), A = a + keep;
        const q = [(t[s] * a + C[0] * keep) / A, (t[s + 1] * a + C[1] * keep) / A, (t[s + 2] * a + C[2] * keep) / A, A * 255];
        for (const v of q) d = Math.min(d, Math.abs(v - Math.floor(v) - 0.5));
        C = q.map((v) => { u8[0] = v; return u8[0]; });
      });
      return d;
    };
    const onEdge = (q: number): boolean => q >= 0.5 && q <= 255.5 && Math.abs(q - Math.round(q)) < TIE;
    const max = [0, 0, 0, 0], bad: unknown[] = [];
    let over = 0, ties = 0, tieMax = 0, tieDist = 0, roundTies = 0, roundMax = 0, roundDist = 0;
    for (let p = 0; p < ref.length; p += 4) {
      let worst = 0;
      for (let k = 0; k < 4; k++) { const d = Math.abs(got[p + k] - ref[p + k]); if (worst < d) worst = d; }
      const pos = worst > 1 ? ensure().map((a) => a[p / 4] * 256) : null;
      if (pos && pos.some(onEdge)) {
        ties++; tieMax = Math.max(tieMax, worst);
        for (const q of pos) if (onEdge(q)) tieDist = Math.max(tieDist, Math.abs(q - Math.round(q)));
        continue;
      }
      const rd = pos ? roundingDistance(p / 4) : Infinity;
      if (rd < ROUND) { roundTies++; roundMax = Math.max(roundMax, worst); roundDist = Math.max(roundDist, rd); continue; }
      for (let k = 0; k < 4; k++) { const d = Math.abs(got[p + k] - ref[p + k]); if (d > max[k]) max[k] = d; }
      if (worst > 1) {
        over++;
        if (bad.length < 4) bad.push({ x: (p / 4) % out[0], y: Math.floor(p / 4 / out[0]), gl: Array.from(got.subarray(p, p + 4)), ref: Array.from(ref.subarray(p, p + 4)), slotPos: pos!.map((q) => +q.toFixed(6)), roundingDistance: rd });
      }
    }
    results.push({ name: c.name, pixels: ref.length / 4, max, over, bad, ties, tieMax, tieDist, roundTies, roundMax, roundDist, glError });
  }
  const rendererName = live.rendererName();

  // Timing: a 1024 x 1024 two-channel uint16 frame.
  const N = 1024, r = rng(99);
  const planeData = () => { const d = new Uint16Array(N * N); for (let i = 0; i < d.length; i++) d[i] = (r() * 4096) | 0; return d; };
  const a = planeData(), b = planeData();
  const view = (i: number) => ({ index: i, name: `t${i}`, visible: true, color: i ? "#00ff00" : "#ff00ff", lut: null, range: [100, 4000] as [number, number], norm: "linear", gamma: 1, invert: false });
  const map = { mul: 1, add: 0, sub: 0, nodata: null, float: false };
  const big = {
    width: N, height: N, layers: [], composite: "blend", solo: 0, background: "#000000", smooth: false, crop: { x: 0, y: 0, width: N, height: N }, outWidth: N, outHeight: N,
    channels: [0, 1].map((i) => ({ plane: { data: i ? b : a, map }, view: view(i), table: FX.channelTable(view(i), resolve) })),
  };
  const bigFrame = FX.frameFromRenderInput(big, { channels: ["timing:a", "timing:b"], layers: [] });
  // gl.finish() returns before the GPU is done in Chrome; a 1-pixel readPixels is a real fence (it waits for every
  // command before it, costs one round trip, and is the same for both measurements).
  const px = new Uint8Array(4);
  const fence = (): void => { gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  live.draw(bigFrame); fence(); // compile + upload the frame's planes outside the measurement
  const uploads: number[] = [];
  for (let i = 0; i < 3; i++) {
    fence();
    const t = performance.now();
    live.upload({ ...bigFrame.channels[0].plane, key: `timing:upload${i}` });
    fence();
    uploads.push(performance.now() - t);
  }
  const fences: number[] = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); fence(); fences.push(performance.now() - t); }
  const draws: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    live.draw(bigFrame);
    fence();
    draws.push(performance.now() - t);
  }
  // Timer resolution is coarse (0.1 ms without cross-origin isolation): also a batch of draws behind one fence.
  const BATCH = 20;
  let t0 = performance.now();
  for (let i = 0; i < BATCH; i++) live.draw(bigFrame);
  fence();
  const batchMs = (performance.now() - t0) / BATCH;
  // A contrast drag: every draw has a new window, so the slot edges of both channels are recomputed on the CPU.
  const dragFrames = Array.from({ length: BATCH }, (_, i) => ({ ...bigFrame, channels: bigFrame.channels.map((c: any) => ({ ...c, range: [100 + i * 7, 4000 - i * 5] })) }));
  t0 = performance.now();
  for (const f of dragFrames) live.draw(f);
  fence();
  const dragMs = (performance.now() - t0) / BATCH;
  const refStart = performance.now();
  const bigRef: Uint8ClampedArray = FX.renderView(big);
  const refMs = performance.now() - refStart;
  // Back to the first window after the drag: the cached slot edges must follow.
  live.draw(bigFrame);
  const bigGot: Uint8ClampedArray = live.readPixels();
  let bigMax = 0;
  for (let i = 0; i < bigRef.length; i++) bigMax = Math.max(bigMax, Math.abs(bigRef[i] - bigGot[i]));
  const median = (v: number[]) => v.slice().sort((x, y) => x - y)[v.length >> 1];
  live.dispose();
  return { rendererName, results, timing: { uploadMs: median(uploads), uploads, drawMs: median(draws), draws, batchMs, dragMs, fenceMs: median(fences), refMs, bigMax } };
}

// ---------------------------------------------------------------------------------------------
// Bundle, serve, run
// ---------------------------------------------------------------------------------------------

const scratch = await mkdtemp(path.join(tmpdir(), "fluximg-gl-"));
const server = createServer(async (req, res) => {
  try {
    const js = req.url === "/fx.js";
    res.setHeader("Content-Type", js ? "text/javascript" : "text/html");
    res.end(js ? await readFile(path.join(scratch, "fx.js")) : '<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>');
  } catch { res.statusCode = 404; res.end(); }
});
let browser: Awaited<ReturnType<typeof launch>>["browser"] | null = null;
try {
  await build({
    absWorkingDir: root, bundle: true, format: "iife", globalName: "FX", platform: "browser", target: "es2022", outfile: path.join(scratch, "fx.js"), logLevel: "silent",
    stdin: {
      resolveDir: root, loader: "ts", sourcefile: "fluximg-gl-entry.ts",
      contents: [
        `export { FluximgLiveRenderer, frameFromRenderInput, MAX_LIVE_CHANNELS, MAX_LIVE_LAYERS } from "./src/lib/fluximg/gl/liveRenderer";`,
        `export { renderView, renderGeometry, sampleValues, contributingChannels } from "./src/lib/fluximg/render";`,
        `export { channelTable, makeNormalizer, normalizeValue, slotOf } from "./src/lib/fluximg/lut";`,
        `export { allocTyped } from "./src/lib/fluximg/types";`,
      ].join("\n"),
    },
  });
  // An ephemeral port: this pure-tier gate may run in parallel with others.
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`;
  const launched = await launch({ width: 400, height: 300 });
  browser = launched.browser;
  const page = launched.page;
  await page.goto(origin);
  await page.evaluate("window.__name = (value) => value");
  await page.addScriptTag({ url: `${origin}fx.js` });
  const run = await page.evaluate(pageRun as (list: Case[], tie: number, round: number) => any, cases, TIE, ROUND) as {
    rendererName: string;
    results: Array<{ name: string; pixels: number; max: number[]; over: number; bad: unknown[]; ties: number; tieMax: number; tieDist: number; roundTies: number; roundMax: number; roundDist: number; glError: number; lengthMismatch?: number[] }>;
    timing: { uploadMs: number; uploads: number[]; drawMs: number; draws: number[]; batchMs: number; dragMs: number; fenceMs: number; refMs: number; bigMax: number };
  };

  h.section(`renderer: ${run.rendererName}`);
  h.ok(run.rendererName.length > 0, `WebGL2 renderer: ${run.rendererName}`);
  h.section(`${cases.length} cases, every component of every pixel against renderView`);
  let worst = 0, tiePixels = 0, tieCases = 0;
  run.results.forEach((r, i) => {
    const c = cases[i], mode = modeOf(c);
    if (r.lengthMismatch) { h.fail(`${r.name}: output size ${r.lengthMismatch[0]} != reference ${r.lengthMismatch[1]}`); return; }
    const tol = c.tol ?? 1;
    const m = Math.max(...r.max);
    if (tol === 1) worst = Math.max(worst, m);
    const limit = tol === 1 ? "" : ` [stated tolerance ${tol}: ${c.why}]`;
    const detail = r.over ? `; ${r.over} px > 1, e.g. ${JSON.stringify(r.bad)}` : "";
    // Nearest compares stored keys exactly: no slot tie may flip there. Mean / bilinear: a few, on slot edges only.
    // Rounding ties (layers) can flip in any mode. Neither may be more than TIE_SHARE of the pixels.
    const allowed = Math.max(1, Math.floor(r.pixels * TIE_SHARE));
    const tieOk = (mode === "nearest" ? r.ties === 0 : r.ties <= allowed) && r.roundTies <= allowed;
    const tieNote = (r.ties ? `; ${r.ties} px whose reference value is on a slot edge (|x·256 − k| ≤ ${r.tieDist.toExponential(1)}) fell in the other slot, |d| ≤ ${r.tieMax}` : "")
      + (r.roundTies ? `; ${r.roundTies} px with a layer 8-bit rounding tie (|q − (n + .5)| ≤ ${r.roundDist.toExponential(1)}) rounded the other way, |d| ≤ ${r.roundMax}` : "");
    if (r.ties || r.roundTies) { tiePixels += r.ties + r.roundTies; tieCases++; }
    h.ok(m <= tol && tieOk && r.glError === 0, `${r.name} [${mode}]: max |d| rgba ${r.max.join("/")} over ${r.pixels} px${limit}${detail}${tieNote}${r.glError ? `; GL error ${r.glError}` : ""}`);
  });
  h.ok(worst <= 1, `every pixel that is not a tie within 1 step: worst ${worst}`);
  console.log(`  ties that went the other way (slot edges under float32 mean / bilinear, 8-bit rounding in layers): ${tiePixels} px in ${tieCases} case(s)`);

  h.section("timing (1024 x 1024, two uint16 channels)");
  const t = run.timing;
  console.log(`  upload one plane: ${t.uploadMs.toFixed(2)} ms (median of ${t.uploads.map((v) => v.toFixed(1)).join(", ")})`);
  console.log(`  fence alone (empty 1-pixel readPixels): ${t.fenceMs.toFixed(2)} ms, included in both`);
  console.log(`  draw after upload: ${t.drawMs.toFixed(2)} ms (median of ${t.draws.map((v) => v.toFixed(1)).join(", ")}); renderView: ${t.refMs.toFixed(1)} ms`);
  console.log(`  ${20} draws behind one fence: ${t.batchMs.toFixed(3)} ms per draw; with a new window every draw (slot edges recomputed): ${t.dragMs.toFixed(3)} ms per draw`);
  h.ok(t.bigMax <= 1, `1024 x 1024 frame, redrawn after the window drag, matches renderView (max |d| ${t.bigMax})`);
  h.ok(t.drawMs < 2000, `draw under a generous 2 s ceiling (${t.drawMs.toFixed(2)} ms on ${run.rendererName})`);
  h.ok(t.uploadMs < 2000, `upload under a generous 2 s ceiling (${t.uploadMs.toFixed(2)} ms)`);
  h.eq(errors(page), [], "browser console is clean");
} catch (error) {
  h.fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
await h.done(async () => {
  if (browser) await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});
