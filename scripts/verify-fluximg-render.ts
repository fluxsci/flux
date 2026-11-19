// fluximg reference renderer: the view recipe resolved and edited, the planes it needs, its pixel key, the
// colour law (against plot/colorscale.ts), the geometry (nearest, minifying mean, bilinear), compositing,
// projections and their block summaries, histograms and the automatic window.
//
// Pure tier. Hermetic: bundles are written from deterministic synthetic data into a scratch directory.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harness } from "./lib/harness.mjs";
import { fixtures, rng, writeFixture, type Fixture } from "./lib/fluximgFixtures";
import { nodeBundleReader, nodeZstd } from "../flux-core/fluximgIo";
import { openFluximg, type FluximgReader } from "../src/lib/fluximg/reader";
import { toValues, valueMaps, type ValueMap } from "../src/lib/fluximg/encoding";
import type { FluximgManifest, FluximgTypedArray } from "../src/lib/fluximg/types";
import type { FluximgProjectionMode, FluximgView, ResolvedChannel, ResolvedView } from "../src/lib/fluximg/view";
import {
  describePosition, describeProjection, formatNumber, patchView, pixelKey, planeRequests, resolveView,
} from "../src/lib/fluximg/viewOps";
import { channelTable, codeTable, hexToRgb, makeNormalizer, normalizeValue, packTable, slotOf } from "../src/lib/fluximg/lut";
import { renderView, type RenderChannelInput, type RenderInput, type RenderLayerInput, type RenderPlane } from "../src/lib/fluximg/render";
import { buildBlocks, projectPlanes, projectRange } from "../src/lib/fluximg/project";
import { autoRange, histogram, valueAt } from "../src/lib/fluximg/stats";
import { normalize, slotFor } from "../src/lib/plot/colorscale";

const h = harness("verify-fluximg-render");
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "fluximg-render-"));
const codec = await nodeZstd();
const fx = fixtures();
const byName: Record<string, Fixture> = Object.fromEntries(fx.map((f) => [f.name, f]));
const NAMES = ["gray2d_u8", "rgb_u8", "stack_u16", "masked_i16", "movie_f32", "movie_f32_lossless", "mean_f64_layers", "trials_f32"];
const readers: Record<string, FluximgReader> = {};
for (const name of NAMES) {
  await writeFixture(tmp, byName[name]);
  readers[name] = await openFluximg(nodeBundleReader(path.join(tmp, `${name}.fluximg`)), codec);
}
const M = (name: string): FluximgManifest => readers[name].manifest;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// A colour-map resolver for tests: "gray" (256 entries), "duo" (2 entries), "fire8" (8 entries with alpha).
const GRAY = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, "0").repeat(3)}`);
const resolver = (name: string): string[] | null =>
  name === "gray" ? GRAY : name === "duo" ? ["#000000", "#ffffff"] : name === "fire8" ? ["#000000ff", "#200000ff", "#400000ff", "#600000ff", "#800000ff", "#a00000ff", "#c00000ff", "#e0e000ff"] : null;

/** Render a resolved view straight from a bundle: what the wave-2 still service will do. */
async function renderBundle(reader: FluximgReader, rv: ResolvedView, crop: { x: number; y: number; width: number; height: number }, outWidth: number, outHeight: number): Promise<Uint8ClampedArray> {
  const m = reader.manifest, p = m.pixels, nd = p.dims.length;
  const maps = valueMaps(p.dtype, p.encoding, m.channels.length, p.nodata);
  const a = await reader.level(0);
  const H = p.shape[nd - 2], W = p.shape[nd - 1];
  const channels: RenderChannelInput[] = [];
  for (const r of planeRequests(m, rv)) {
    const map = maps[r.channel];
    let plane: RenderPlane;
    if ("dim" in r) {
      const di = p.dims.indexOf(r.dim), planes: RenderPlane[] = [];
      for (let i = r.from; i < r.to; i++) { const lead = r.leading.slice(); lead[di] = i; planes.push({ data: await reader.readPlane(a, lead), map }); }
      plane = { data: projectPlanes(planes, W * H, r.mode), map: null };
    } else plane = { data: await reader.readPlane(a, r.leading), map };
    const view = rv.channels[r.channel];
    channels.push({ plane, view, table: channelTable(view, resolver) });
  }
  const layers: RenderLayerInput[] = [];
  for (const l of rv.layers) {
    if (l.kind !== "intensity" || !l.visible) continue;
    const ml = m.layers.find((x) => x.id === l.id)!;
    if (ml.kind !== "intensity") continue;
    const arr = await reader.array(ml.path);
    layers.push({ plane: { data: await reader.readPlane(arr, []), map: valueMaps(ml.dtype, ml.encoding, 1, null)[0] }, range: l.range!, table: channelTable({ color: l.color, lut: l.lut, invert: false }, resolver), opacity: l.opacity, opacityFromValue: l.opacityFromValue });
  }
  return renderView({ width: W, height: H, channels, layers, composite: rv.composite, solo: rv.solo, background: rv.background, smooth: rv.smooth, crop, outWidth, outHeight });
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
};
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };

/** A resolved channel for synthetic inputs. */
const rch = (index: number, o: Partial<ResolvedChannel> = {}): ResolvedChannel => ({ index, name: `c${index}`, visible: true, color: "#ffffff", lut: null, range: [0, 255], norm: "linear", gamma: 1, invert: false, ...o });
const chIn = (data: FluximgTypedArray, view: ResolvedChannel, map: ValueMap | null = null): RenderChannelInput => ({ plane: { data, map }, view, table: channelTable(view, resolver) });
const input = (width: number, height: number, channels: RenderChannelInput[], o: Partial<RenderInput> = {}): RenderInput => ({
  width, height, channels, layers: [], composite: "blend", solo: 0, background: "#000000", smooth: false, crop: { x: 0, y: 0, width, height }, outWidth: width, outHeight: height, ...o,
});
const px = (out: Uint8ClampedArray, width: number, x: number, y: number): number[] => Array.from(out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));

// =============================================================================================
h.section("A. resolveView: defaults and overrides");
{
  const stack = M("stack_u16"), movie = M("movie_f32"), layers = M("mean_f64_layers"), trials = M("trials_f32");
  const d = resolveView(movie);
  h.eq(d.index, { t: 0 }, "a time axis opens at frame 0");
  h.eq(resolveView(stack).index, { z: 3 }, "the manifest's default index is used");
  const noDefault = copy(stack); delete noDefault.defaults; noDefault.pixels.shape[1] = 8;
  h.eq(resolveView(noDefault).index, { z: 4 }, "without one, z opens at floor(n / 2)");
  h.eq(resolveView(trials).index, { trial: 0, t: 0 }, "extra dimensions open at 0");
  h.eq([resolveView(movie, { index: { t: 5 } }).index.t, resolveView(movie, { index: { t: 99 } }).index.t, resolveView(movie, { index: { t: -3 } }).index.t, resolveView(movie, { index: { t: 2.6 } }).index.t, resolveView(movie, { index: { t: NaN } }).index.t], [5, 23, 0, 3, 0], "an index is rounded and clamped; a non-number falls back");
  const c0 = d.channels[0], c1 = d.channels[1];
  h.eq([c0.index, c0.name, c0.visible, c0.color, c0.lut, c0.norm, c0.gamma, c0.invert], [0, "channel 1", true, "#ff2bd6", null, "linear", 1, false], "channel defaults: visible, linear, gamma 1, not inverted, the manifest's colour");
  h.eq([c1.color, c1.lut], [null, "gray"], "a manifest lut is kept");
  h.eq(c0.range, movie.channels[0].range, "the manifest's window");
  const o = resolveView(movie, { channels: [{ lut: "viridis", range: [1, 2], norm: "log", gamma: 2, invert: true, visible: false }, { color: "#00ff00", range: [5, 5], norm: "bogus" as never, gamma: -1 }] });
  h.eq([o.channels[0].color, o.channels[0].lut, o.channels[0].range, o.channels[0].norm, o.channels[0].gamma, o.channels[0].invert, o.channels[0].visible], [null, "viridis", [1, 2], "log", 2, true, false], "every channel field can be overridden; a lut clears the manifest colour");
  h.eq([o.channels[1].color, o.channels[1].lut, o.channels[1].range, o.channels[1].norm, o.channels[1].gamma], ["#00ff00", null, movie.channels[1].range, "linear", 1], "a colour clears the manifest lut; an empty window, an unknown norm, a bad gamma fall back");
  h.eq(resolveView(movie, { channels: [{ range: [NaN, 3] }] }).channels[0].range, movie.channels[0].range, "a non-finite window falls back");
  h.eq(resolveView(movie, { channels: [null, { visible: false }] }).channels.map((c) => c.visible), [true, false], "a null entry keeps the defaults");
  h.eq([d.composite, d.solo, d.smooth, d.background, d.projection, d.insetOf], ["blend", 0, false, "#000000", null, null], "blend, solo 0, true pixels, black background, no projection");
  h.eq([resolveView(movie, { solo: 9 }).solo, resolveView(movie, { solo: -2 }).solo, resolveView(movie, { composite: "single", solo: 1 }).composite], [1, 0, "single"], "solo is clamped to the channels");
  h.eq([resolveView(movie, { background: "transparent" }).background, resolveView(movie, { background: "#123456" }).background, resolveView(movie, { background: "red" }).background], ["transparent", "#123456", "#000000"], "background: a hex colour or transparent");
  h.eq(resolveView(movie, { insetOf: "el1", smooth: true }).insetOf, "el1", "insetOf is carried");

  const L = resolveView(layers);
  h.eq(L.layers.map((l) => l.id), layers.layers.map((l) => l.id), "layers in manifest order");
  h.eq(resolveView(layers, { layerOrder: ["discs", "bogus", "activity", "discs"] }).layers.map((l) => l.id), ["discs", "activity", "footprint_weights", "footprints", "prox_lines"], "layerOrder: unknown and repeated ids dropped, missing ones appended in manifest order");
  const lid = Object.fromEntries(L.layers.map((l) => [l.id, l]));
  h.eq(L.layers.map((l) => l.visible), [false, false, true, false, false], "visible = manifest visible, else hidden");
  h.eq([lid.activity.opacity, lid.activity.opacityFromValue, lid.footprint_weights.opacityFromValue], [1, true, false], "opacity \"value\": opacity 1 and opacity from value");
  h.eq([lid.activity.range, lid.footprints.range, lid.discs.range], [(layers.layers[0] as { range: [number, number] }).range, null, null], "intensity layers have a window, others none");
  h.eq([lid.footprints.fillOpacity, lid.discs.fillOpacity, lid.discs.strokeWidth], [0.12, 0, 1], "fill 0.12 for labels, 0 for vectors; stroke 1");
  h.eq([lid.activity.color, lid.activity.lut], ["#ff2bd6", null], "an intensity layer's own colour");
  const LO = resolveView(layers, { layers: { activity: { lut: "gray", opacity: 2, visible: true }, discs: { color: "#00ff00", strokeWidth: 3, fillOpacity: 0.5 }, footprints: { visible: false } } });
  const lo = Object.fromEntries(LO.layers.map((l) => [l.id, l]));
  h.eq([lo.activity.lut, lo.activity.color, lo.activity.opacity, lo.activity.visible], ["gray", null, 1, true], "layer overrides: lut clears colour, opacity clamped to 1");
  h.eq([lo.discs.color, lo.discs.lut, lo.discs.strokeWidth, lo.discs.fillOpacity, lo.footprints.visible], ["#00ff00", null, 3, 0.5, false], "vector stroke, width, fill; a shown layer hidden");

  h.eq(d.furniture, { scalebar: false, stamp: false, channelLabels: false, names: false, colorbar: false }, "no furniture unless asked");
  const F = resolveView(trials, { furniture: { scalebar: {}, stamp: {}, channelLabels: {}, names: {} } }).furniture;
  h.eq(F.scalebar, { length: null, corner: "bottom-right", color: "#ffffff", label: true, thickness: 1.5, fontSize: 7 }, "scale bar defaults: automatic length, bottom right, white, labelled, 1.5 pt, 7 pt");
  h.eq(F.stamp, { dims: ["trial", "t"], corner: "top-left", color: "#ffffff", fontSize: 7 }, "stamp defaults: every position dimension, top left");
  h.eq(F.channelLabels, { corner: "top-right", fontSize: 7 }, "channel labels: top right, 7 pt");
  h.eq(resolveView(layers, { furniture: { names: {} } }).furniture.names, { layers: ["footprints", "prox_lines", "discs"], fontSize: 6 }, "names: every label and vector layer, 6 pt");
  h.eq(resolveView(layers, { furniture: { names: { layers: ["discs", "activity", "nope"] } } }).furniture.names, { layers: ["discs"], fontSize: 6 }, "names: only object layers that exist");
  h.eq(resolveView(trials, { furniture: { scalebar: { length: 20, corner: "top-left", label: false, thickness: 3 }, stamp: { dims: ["t", "c", "z"] } } }).furniture.scalebar, { length: 20, corner: "top-left", color: "#ffffff", label: false, thickness: 3, fontSize: 7 }, "scale bar fields override");
  h.eq((resolveView(trials, { furniture: { stamp: { dims: ["t", "c", "q"] } } }).furniture.stamp as { dims: string[] }).dims, ["t"], "stamp dims limited to position dimensions");

  const P = (p: unknown) => resolveView(movie, { projection: p as never }).projection;
  h.eq(P({ dim: "t", mode: "max", from: 2, to: 9 }), { dim: "t", mode: "max", from: 2, to: 9 }, "a projection is kept");
  h.eq(P({ dim: "t", mode: "mean", from: -5, to: 100 }), { dim: "t", mode: "mean", from: 0, to: 24 }, "its range is clamped to the dimension");
  h.eq([P({ dim: "c", mode: "max", from: 0, to: 2 }), P({ dim: "y", mode: "max", from: 0, to: 2 }), P({ dim: "z", mode: "max", from: 0, to: 2 }), P({ dim: "t", mode: "median", from: 0, to: 2 }), P({ dim: "t", mode: "max", from: 5, to: 5 }), P({ dim: "t", mode: "max", from: 30, to: 40 })], [null, null, null, null, null, null], "no projection over c / y / x, an absent dim, an unknown mode or an empty range");
}

// =============================================================================================
h.section("B. patchView laws");
{
  const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  const base: FluximgView = deepFreeze({ index: { t: 3 }, channels: [{ range: [1, 2], color: "#ff0000" }, null, { lut: "gray" }], layers: { activity: { opacity: 0.5 } }, furniture: { scalebar: { corner: "top-left" } }, projection: { dim: "t", mode: "max", from: 1, to: 4 }, smooth: true } as FluximgView);
  const before = JSON.stringify(base);
  const patches: FluximgView[] = [
    { index: { t: 5 } },
    { channels: [null, { visible: false }] },
    { channels: [{ lut: "viridis" }] },
    { channels: [{ range: null as never }, null, { color: "#00ff00" }] },
    { layers: { activity: { visible: true }, discs: { color: "#fff000" } } },
    { furniture: { scalebar: { color: "#000000" }, stamp: {} } },
    { furniture: { scalebar: false } },
    { projection: null },
    { projection: { mode: "std" } as never },
    { composite: "single", solo: 1, smooth: undefined },
    { layerOrder: ["discs"] },
  ];
  let mutated = false, idem = true;
  for (const p of patches) {
    const fp = deepFreeze(copy(p));
    const pb = JSON.stringify(fp);
    let once: FluximgView;
    try { once = patchView(base, fp); } catch { mutated = true; continue; }
    if (JSON.stringify(base) !== before || JSON.stringify(fp) !== pb) mutated = true;
    if (JSON.stringify(patchView(once, fp)) !== JSON.stringify(once)) idem = false;
  }
  h.ok(!mutated, "never mutates the view or the patch (both deep-frozen)");
  h.ok(idem, "idempotent: applying a patch twice equals applying it once");
  h.eq(patchView(base, { index: { t: 5 } }).index, { t: 5 }, "index merges per key");
  h.eq(patchView({ index: { t: 3, trial: 1 } }, { index: { t: null as never } }).index, { trial: 1 }, "a null index entry clears it");
  h.eq(patchView({ index: { t: 3 } }, { index: { t: null as never } }), {}, "and an empty index is dropped");
  const ch = patchView(base, { channels: [null, { visible: false }] }).channels!;
  h.eq(ch, [{ range: [1, 2], color: "#ff0000" }, { visible: false }, { lut: "gray" }], "channels merge per index; a null entry keeps the old one");
  h.eq(patchView(base, { channels: [{ lut: "viridis" }] }).channels![0], { range: [1, 2], lut: "viridis" }, "a lut clears the colour");
  h.eq(patchView(base, { channels: [null, null, { color: "#00ff00" }] }).channels![2], { color: "#00ff00" }, "a colour clears the lut");
  h.eq(patchView({ channels: [{ range: [1, 2] }] }, { channels: [{ range: null as never }] }), {}, "clearing the last field of the last entry drops channels");
  h.eq(patchView(base, { projection: null }).projection, undefined, "projection: null clears it");
  h.eq(patchView(base, { projection: { mode: "std" } as never }).projection, { dim: "t", mode: "std", from: 1, to: 4 }, "a projection merges field by field");
  h.eq(patchView(base, { furniture: { scalebar: false } }).furniture, undefined, "furniture false is the default: cleared, and the empty furniture dropped");
  h.eq(patchView(base, { furniture: { scalebar: { color: "#000000" }, stamp: {} } }).furniture, { scalebar: { corner: "top-left", color: "#000000" }, stamp: {} }, "furniture merges per key; {} means on with defaults and is kept");
  h.eq(patchView(base, { layers: { activity: { visible: true } } }).layers, { activity: { opacity: 0.5, visible: true } }, "layers merge per id and per field");
  h.eq(patchView(base, { layers: { activity: null as never } }).layers, undefined, "a null layer entry clears it");
  h.eq(patchView(base, { smooth: undefined }).smooth, true, "undefined is ignored");
  h.eq(patchView(base, { smooth: null as never }).smooth, undefined, "null clears a scalar");
  h.eq(patchView(undefined, {}), {}, "no view, no patch: {}");
  h.eq(patchView(undefined, { index: {}, channels: [null, {}], layers: { a: {} }, layerOrder: [] }), {}, "a patch of empties serializes as {}");
  const m = M("movie_f32");
  h.eq(resolveView(m, patchView({ channels: [{ color: "#ff0000" }] }, { channels: [{ lut: "gray" }] })).channels[0].lut, "gray", "resolve after patch: the later of colour / lut wins");
}

// =============================================================================================
h.section("C. planeRequests");
{
  h.eq(planeRequests(M("gray2d_u8"), resolveView(M("gray2d_u8"))), [{ channel: 0, leading: [] }], "2-D: one request, no leading index");
  const rgb = M("rgb_u8");
  h.eq(planeRequests(rgb, resolveView(rgb)), [{ channel: 0, leading: [0] }, { channel: 1, leading: [1] }, { channel: 2, leading: [2] }], "c only: one request per visible channel, c at its position");
  h.eq(planeRequests(rgb, resolveView(rgb, { channels: [null, { visible: false }] })).map((r) => r.channel), [0, 2], "hidden channels are not read");
  h.eq(planeRequests(rgb, resolveView(rgb, { composite: "single", solo: 1, channels: [null, { visible: false }] })), [{ channel: 1, leading: [1] }], "single: only solo, even when hidden");
  const stack = M("stack_u16");
  h.eq(planeRequests(stack, resolveView(stack, { index: { z: 5 } })), [{ channel: 0, leading: [0, 5] }, { channel: 1, leading: [1, 5] }], "z-stack (c, z, y, x): [c, z]");
  const movie = M("movie_f32");
  h.eq(planeRequests(movie, resolveView(movie, { index: { t: 7 }, projection: { dim: "t", mode: "max", from: 2, to: 9 } })), [{ channel: 0, leading: [0, 0], dim: "t", from: 2, to: 9, mode: "max" }, { channel: 1, leading: [0, 1], dim: "t", from: 2, to: 9, mode: "max" }], "t-stack with projection: placeholder 0 at t, the run carried");
  const trials = M("trials_f32");
  h.eq(planeRequests(trials, resolveView(trials, { index: { trial: 2, t: 4 }, channels: [{ visible: false }] })), [{ channel: 1, leading: [2, 4, 1] }], "an extra dimension: [trial, t, c]");
  h.eq(planeRequests(trials, resolveView(trials, { index: { trial: 1 }, projection: { dim: "trial", mode: "mean", from: 0, to: 3 }, composite: "single", solo: 0 })), [{ channel: 0, leading: [0, 0, 0], dim: "trial", from: 0, to: 3, mode: "mean" }], "projection over the extra dimension");
}

// =============================================================================================
h.section("D. pixelKey changes exactly when the pixels do");
{
  const name = "mean_f64_layers", m = M(name), reader = readers[name];
  const crop = { x: 4, y: 3, width: 80, height: 50 };
  const baseView: FluximgView = { layers: { activity: { visible: true, opacity: 0.6 } }, channels: [null, { visible: false }] };
  type Case = [string, FluximgView, { x: number; y: number; width: number; height: number }?, number?, number?];
  const cases: Case[] = [
    ["a scale bar", { furniture: { scalebar: {}, stamp: {} } }],
    ["a hidden channel's colour", { channels: [null, { color: "#00ff00", range: [0, 1] }] }],
    ["a vector layer shown", { layers: { discs: { visible: true, color: "#ffffff" } } }],
    ["a label layer restyled", { layers: { footprints: { color: "#00ffff", strokeWidth: 3 } } }],
    ["insetOf", { insetOf: "other" }],
    ["smooth at 1:1", { smooth: true }],
    ["single solo 0 instead of blend of channel 0", { composite: "single", solo: 0 }],
    ["gamma norm with gamma 1", { channels: [{ norm: "gamma", gamma: 1 }] }],
    ["log norm with a black point <= 0 (drawn linear)", { channels: [{ norm: "log", range: [-1, 30] }] }],
    ["the same colour written differently", { channels: [{ color: "#FF2BD6" }] }],
    ["a channel window", { channels: [{ range: [5, 20] }] }],
    ["a channel colour", { channels: [{ color: "#00ff00" }] }],
    ["invert", { channels: [{ invert: true }] }],
    ["log norm", { channels: [{ norm: "log", range: [1, 40] }] }],
    ["gamma 2", { channels: [{ norm: "gamma", gamma: 2 }] }],
    ["a second channel shown", { channels: [null, { visible: true }] }],
    ["the background", { background: "#202020" }],
    ["transparent background", { background: "transparent" }],
    ["the intensity layer hidden", { layers: { activity: { visible: false } } }],
    ["the intensity layer's opacity", { layers: { activity: { opacity: 0.3 } } }],
    ["another intensity layer shown", { layers: { footprint_weights: { visible: true } } }],
    ["intensity layer order", { layers: { footprint_weights: { visible: true } }, layerOrder: ["footprint_weights", "activity"] }],
    ["the crop", {}, { x: 5, y: 3, width: 80, height: 50 }],
    ["the output size", {}, crop, 40, 25],
    ["smooth when magnified", { smooth: true }, crop, 160, 100],
    ["smooth when minified", { smooth: true }, crop, 40, 25],
  ];
  const ref = (o: FluximgView) => resolveView(m, patchView(baseView, o));
  let agree = 0;
  const wrong: string[] = [];
  for (const [label, o, c = crop, w = 80, hh = 50] of cases) {
    // Compare against the base view rendered at the SAME geometry, except for the geometry cases themselves.
    const geometryCase = c !== crop || w !== 80;
    const rvA = ref({}), rvB = ref(o);
    const [cA, wA, hA] = geometryCase && (label === "the crop" || label === "the output size") ? [crop, 80, 50] : [c, w, hh];
    const keyA = pixelKey(m, rvA, cA, wA, hA), keyB = pixelKey(m, rvB, c, w, hh);
    const pixA = await renderBundle(reader, rvA, cA, wA, hA), pixB = await renderBundle(reader, rvB, c, w, hh);
    const keySame = keyA === keyB, pixSame = same(pixA, pixB);
    if (keySame === pixSame) agree++; else wrong.push(`${label} (key ${keySame ? "same" : "differs"}, pixels ${pixSame ? "same" : "differ"})`);
  }
  h.ok(wrong.length === 0, `key and rendered pixels agree on all ${cases.length} edits (${agree} agree)${wrong.length ? ": " + wrong.join("; ") : ""}`);
  const movie = M("movie_f32");
  const k = (v: FluximgView) => pixelKey(movie, resolveView(movie, v), { x: 0, y: 0, width: 60, height: 40 }, 60, 40);
  h.ok(k({ index: { t: 1 } }) !== k({ index: { t: 2 } }), "the frame is in the key");
  h.ok(k({ index: { t: 1 }, projection: { dim: "t", mode: "max", from: 0, to: 5 } }) === k({ index: { t: 2 }, projection: { dim: "t", mode: "max", from: 0, to: 5 } }), "a projected dimension's index is not");
  h.ok(k({ projection: { dim: "t", mode: "max", from: 0, to: 5 } }) !== k({ projection: { dim: "t", mode: "mean", from: 0, to: 5 } }), "the projection mode is");
  h.ok(k({ projection: { dim: "t", mode: "max", from: 0, to: 5 } }) !== k({ projection: { dim: "t", mode: "max", from: 0, to: 6 } }), "and its range");
}

// =============================================================================================
h.section("E. the colour law equals plot/colorscale.ts");
{
  const r = rng(42);
  const csSlot = (norm: object, v: number): number => {
    const s = slotFor(256, normalize(norm as never, v), false);
    return s === 256 || s === 258 ? 0 : s === 257 ? 255 : s; // under → first, bad (log of v <= 0) → first, over → last
  };
  let n = 0, bad = 0;
  const check = (kind: "linear" | "log" | "gamma", lo: number, hi: number, g: number, v: number): void => {
    const mine = slotOf(normalizeValue(makeNormalizer([lo, hi], kind, g), v));
    const norm = kind === "log" ? { kind: "log", vmin: lo, vmax: hi, base: 10 } : kind === "gamma" ? { kind: "power", vmin: lo, vmax: hi, gamma: g } : { kind: "linear", vmin: lo, vmax: hi };
    n++;
    if (mine !== csSlot(norm, v)) bad++;
  };
  for (let t = 0; t < 300; t++) {
    const lo = (r() - 0.5) * 200, hi = lo + 10 ** (r() * 6 - 3);
    const llo = 10 ** (r() * 4 - 3), lhi = llo * (1 + 10 ** (r() * 4 - 1)), g = 0.2 + 4.8 * r();
    for (let k = 0; k <= 256; k++) {
      // the slot edges, where a last-bit difference would show
      check("linear", lo, hi, 1, lo + ((hi - lo) * k) / 256);
      check("gamma", lo, hi, g, lo + ((hi - lo) * k) / 256);
      check("log", llo, lhi, 1, llo * (lhi / llo) ** (k / 256));
    }
    for (let k = 0; k < 40; k++) {
      check("linear", lo, hi, 1, lo + (hi - lo) * (r() * 1.4 - 0.2));
      check("gamma", lo, hi, g, lo + (hi - lo) * (r() * 1.4 - 0.2));
      check("log", llo, lhi, 1, llo * (lhi / llo) ** (r() * 1.4 - 0.2));
      check("log", llo, lhi, 1, -r() * 5);
    }
  }
  h.ok(bad === 0, `${n} values over linear, log and gamma windows land in colorscale's slot (${bad} differ)`);
  h.eq([slotOf(normalizeValue(makeNormalizer([0, 1]), 1)), slotOf(normalizeValue(makeNormalizer([0, 1]), 2)), slotOf(normalizeValue(makeNormalizer([0, 1]), -1)), slotOf(normalizeValue(makeNormalizer([0, 1]), 0.5))], [255, 255, 0, 128], "x = 1 and above → the last slot, below → the first, 0.5 → 128");
  h.eq(slotOf(normalizeValue(makeNormalizer([-5, 5], "log"), 2)), slotOf(normalizeValue(makeNormalizer([-5, 5], "linear"), 2)), "log over a window with black point <= 0 is linear");
  // Through the renderer: a gray table gives the slot back as the colour.
  const vals = Float64Array.from({ length: 512 }, (_, i) => -3 + (i / 511) * 16);
  const out = renderView(input(512, 1, [chIn(vals, rch(0, { lut: "gray", color: null, range: [0, 10], norm: "gamma", gamma: 0.7 }))]));
  let ok = true;
  const nz = makeNormalizer([0, 10], "gamma", 0.7);
  for (let i = 0; i < 512; i++) if (out[i * 4] !== slotOf(normalizeValue(nz, vals[i])) || out[i * 4 + 3] !== 255) ok = false;
  h.ok(ok, "the renderer paints exactly that slot");
}

h.section("E2. colour tables");
{
  const t = channelTable({ color: "#ff8000", lut: null, invert: false }, resolver);
  h.eq([px(t as never, 256, 0, 0), px(t as never, 256, 255, 0), px(t as never, 256, 128, 0)], [[0, 0, 0, 255], [255, 128, 0, 255], [128, 64, 0, 255]], "a colour is the ramp from black: round(colour · i / 255)");
  const inv = channelTable({ color: "#ff8000", lut: null, invert: true }, resolver);
  h.eq([px(inv as never, 256, 0, 0), px(inv as never, 256, 255, 0)], [[255, 128, 0, 255], [0, 0, 0, 255]], "invert reverses it");
  const duo = channelTable({ color: null, lut: "duo", invert: false }, resolver);
  h.eq([px(duo as never, 256, 0, 0), px(duo as never, 256, 127, 0), px(duo as never, 256, 128, 0), px(duo as never, 256, 255, 0)], [[0, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255], [255, 255, 255, 255]], "a short table is resampled by nearest, endpoints to endpoints");
  const fire = channelTable({ color: null, lut: "fire8", invert: false }, resolver);
  h.eq(px(fire as never, 256, 255, 0), [224, 224, 0, 255], "#rrggbbaa entries are read");
  const unk = channelTable({ color: null, lut: "nope", invert: false }, resolver);
  h.eq([px(unk as never, 256, 0, 0), px(unk as never, 256, 200, 0)], [[0, 0, 0, 255], [200, 200, 200, 255]], "an unknown name is the gray ramp");
  h.eq([hexToRgb("#0a0B0c"), hexToRgb("#abc"), hexToRgb("#11223344"), hexToRgb("blue")], [[10, 11, 12], [170, 187, 204], [17, 34, 51], null], "hexToRgb");
}

// =============================================================================================
h.section("F. the integer table path equals the float path");
{
  const r = rng(7), W = 37, H = 23;
  const u16 = new Uint16Array(W * H).map(() => (r() < 0.1 ? 0 : 1 + Math.floor(r() * 65535)));
  const i16 = new Int16Array(W * H).map(() => (r() < 0.1 ? -7 : Math.floor((r() - 0.5) * 60000)));
  const u8 = new Uint8Array(W * H).map(() => Math.floor(r() * 256));
  const lin: ValueMap = { mul: 0.0123, add: -40.5, sub: 1, nodata: 0, float: false };
  const exactI: ValueMap = { mul: 1, add: 0, sub: 0, nodata: -7, float: false };
  const exactU8: ValueMap = { mul: 1, add: 0, sub: 0, nodata: null, float: false };
  const views: Array<[string, Partial<ResolvedChannel>]> = [
    ["linear", { range: [-20, 600] }], ["log", { range: [0.5, 700], norm: "log" }], ["gamma", { range: [-30, 500], norm: "gamma", gamma: 0.45 }], ["inverted lut", { range: [0, 300], lut: "fire8", color: null, invert: true }],
  ];
  const geoms: Array<[string, Partial<RenderInput>]> = [
    ["1:1", {}], ["magnified with an offset", { crop: { x: 3.3, y: 2.7, width: 10, height: 7 }, outWidth: 33, outHeight: 21 }], ["minified", { outWidth: 11, outHeight: 7 }], ["smooth", { smooth: true, crop: { x: 1, y: 1, width: 12, height: 9 }, outWidth: 50, outHeight: 37 }],
  ];
  const sets: Array<[string, FluximgTypedArray, ValueMap, [number, number] | null]> = [["uint16 linear16", u16, lin, null], ["int16 with nodata", i16, exactI, [-30000, 30000]], ["uint8", u8, exactU8, [10, 240]]];
  let total = 0;
  const bad: string[] = [];
  for (const [sname, data, map, rangeOverride] of sets) {
    const values = toValues(data, map, new Float64Array(data.length)) as Float64Array;
    for (const [vname, v] of views) for (const [gname, g] of geoms) {
      const view = rch(0, { ...v, ...(rangeOverride && !v.norm ? { range: rangeOverride } : {}) });
      const a = renderView(input(W, H, [chIn(data, view, map)], g));
      const b = renderView(input(W, H, [chIn(values, view, null)], g));
      total++;
      if (!same(a, b)) bad.push(`${sname} / ${vname} / ${gname}`);
    }
  }
  h.ok(bad.length === 0, `${total} renders: stored integers through their code table == float64 values${bad.length ? " — differ: " + bad.join(", ") : ""}`);
  const ct = codeTable("int16", exactI, makeNormalizer([0, 10]), packTable(channelTable({ color: "#ffffff", lut: null, invert: false }, resolver)));
  h.eq([ct.length, ct[(-7) & 0xffff], ct[5] & 255], [65536, 0, 128], "the int16 table wraps signed codes; the nodata code is empty");
}

// =============================================================================================
h.section("G. geometry: replication, minification mean, smooth");
{
  const r = rng(11), W = 9, H = 7;
  const vals = Float64Array.from({ length: W * H }, () => r() * 100);
  vals[10] = NaN;
  const view = rch(0, { range: [0, 100] });
  const one = renderView(input(W, H, [chIn(vals, view)]));
  let rep = true;
  for (const f of [2, 3, 5]) {
    const crop = { x: 2, y: 1, width: 5, height: 4 };
    const big = renderView(input(W, H, [chIn(vals, view)], { crop, outWidth: 5 * f, outHeight: 4 * f }));
    for (let oy = 0; oy < 4 * f; oy++) for (let ox = 0; ox < 5 * f; ox++) if (!same(px(big, 5 * f, ox, oy), px(one, W, 2 + Math.floor(ox / f), 1 + Math.floor(oy / f)))) rep = false;
  }
  h.ok(rep, "integer magnification (2x, 3x, 5x, offset crop) replicates every source pixel exactly");

  // Minification against a brute-force oracle of the footprint rule.
  const S = 41, src = Float64Array.from({ length: S * S }, (_, i) => ((i * 7919) % 101) + (i % 3));
  for (let i = 0; i < src.length; i += 13) src[i] = NaN;
  let minOk = true;
  const nz = makeNormalizer([0, 103]);
  for (const [crop, ow, oh] of [[{ x: 0, y: 0, width: 41, height: 41 }, 20, 20], [{ x: 0, y: 0, width: 41, height: 41 }, 7, 13], [{ x: 3.5, y: 1.25, width: 30, height: 33 }, 9, 10], [{ x: -6, y: -3, width: 50, height: 47 }, 12, 11]] as const) {
    const out = renderView(input(S, S, [chIn(src, rch(0, { range: [0, 103] }))], { crop, outWidth: ow, outHeight: oh }));
    const sx = crop.width / ow, sy = crop.height / oh;
    for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
      const x0 = crop.x + ox * sx, x1 = x0 + sx, y0 = crop.y + oy * sy, y1 = y0 + sy;
      let sum = 0, cnt = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        if (i + 0.5 >= x0 && i + 0.5 < x1 && j + 0.5 >= y0 && j + 0.5 < y1 && !Number.isNaN(src[j * S + i])) { sum += src[j * S + i]; cnt++; }
      }
      const want = cnt ? [slotOf(normalizeValue(nz, sum / cnt)), 255] : [0, 255];
      const got = px(out, ow, ox, oy);
      if (got[0] !== want[0] || got[3] !== want[1]) minOk = false;
    }
  }
  h.ok(minOk, "minifying (2x, uneven factors, offset crops, crops past the edge): the mean of the valid values whose centres fall in the footprint");
  // The mean is of VALUES, then coloured: two samples 0 and 100 under a gamma window give gamma(0.5), not the mean of two colours.
  const two = renderView(input(2, 1, [chIn(Float64Array.from([0, 100]), rch(0, { range: [0, 100], norm: "gamma", gamma: 2 }))], { outWidth: 1, outHeight: 1 }));
  h.eq(two[0], 64, "minification averages values before the colour law (gamma 2 of 0.5 → slot 64)");

  // smooth: bilinear on values between pixel centres.
  const ramp = Float64Array.from([0, 100, 200, 300]);
  const sm = renderView(input(4, 1, [chIn(ramp, rch(0, { range: [0, 300] }))], { smooth: true, outWidth: 16, outHeight: 1 }));
  const expect = Array.from({ length: 16 }, (_, ox) => { const u = Math.min(3, Math.max(0, (ox + 0.5) / 4 - 0.5)); return slotOf(normalizeValue(makeNormalizer([0, 300]), u * 100)); });
  h.eq(Array.from({ length: 16 }, (_, i) => sm[i * 4]), expect, "smooth 4x on a ramp interpolates the values linearly (edges hold the end value)");
  const hole = Float64Array.from([0, NaN, 200, 300]);
  const smh = renderView(input(4, 1, [chIn(hole, rch(0, { range: [0, 300] }))], { smooth: true, outWidth: 16, outHeight: 1 }));
  h.eq([smh[4 * 4], smh[5 * 4], smh[5 * 4 + 3], smh[6 * 4]], [0, 0, 255, slotOf(normalizeValue(makeNormalizer([0, 300]), 200))], "a no-data neighbour is ignored and the weights renormalized (the valid neighbour's value carries)");
  const smOne = renderView(input(W, H, [chIn(vals, view)], { smooth: true }));
  h.ok(same(smOne, one), "smooth at 1:1 on whole pixels changes nothing");
  const smMin = renderView(input(S, S, [chIn(src, rch(0, { range: [0, 103] }))], { smooth: true, outWidth: 20, outHeight: 20 }));
  const plainMin = renderView(input(S, S, [chIn(src, rch(0, { range: [0, 103] }))], { outWidth: 20, outHeight: 20 }));
  h.ok(same(smMin, plainMin), "smooth does nothing when minifying");
}

// =============================================================================================
h.section("H. background, alpha, blend and single");
{
  const W = 4, H = 2;
  const a = Float64Array.from([0, 255, NaN, 100, NaN, NaN, 50, 255]);
  const b = Float64Array.from([255, NaN, NaN, 100, 10, NaN, 50, 255]);
  const ca = rch(0, { color: "#ff0000" }), cb = rch(1, { color: "#808080" });
  const blend = renderView(input(W, H, [chIn(a, ca), chIn(b, cb)], { background: "#102030" }));
  h.eq(px(blend, W, 0, 0), [128, 128, 128, 255], "blend adds colours: red 0 + gray full");
  h.eq(px(blend, W, 1, 0), [255, 0, 0, 255], "a channel without data here contributes nothing; the other still shows");
  h.eq(px(blend, W, 2, 0), [16, 32, 48, 255], "no channel has data: the background, opaque");
  h.eq(px(blend, W, 3, 1), [255, 128, 128, 255], "sums clamp at 255 per component (255 + 128 → 255)");
  const tr = renderView(input(W, H, [chIn(a, ca), chIn(b, cb)], { background: "transparent" }));
  h.eq([px(tr, W, 2, 0), px(tr, W, 1, 1), tr[3]], [[0, 0, 0, 0], [0, 0, 0, 0], 255], "transparent background: alpha 0 (and RGB 0) where nothing has data, 255 elsewhere");
  const hidden = renderView(input(W, H, [chIn(a, ca), chIn(b, { ...cb, visible: false })]));
  const onlyA = renderView(input(W, H, [chIn(a, ca)]));
  h.ok(same(hidden, onlyA), "blend ignores hidden channels");
  const single = renderView(input(W, H, [chIn(a, ca), chIn(b, { ...cb, visible: false })], { composite: "single", solo: 1 }));
  const onlyB = renderView(input(W, H, [chIn(b, cb)]));
  h.ok(same(single, onlyB), "single shows only channel solo, hidden or not");
  const soloMissing = renderView(input(W, H, [chIn(a, ca)], { composite: "single", solo: 3 }));
  h.eq(px(soloMissing, W, 0, 0), [0, 0, 0, 255], "single with no such channel: background");
  const outside = renderView(input(W, H, [chIn(a, ca)], { crop: { x: -2, y: 0, width: 4, height: 2 }, outWidth: 4, outHeight: 2, background: "#0000ff" }));
  h.eq([px(outside, 4, 0, 0), px(outside, 4, 1, 1), px(outside, 4, 3, 0)], [[0, 0, 255, 255], [0, 0, 255, 255], [255, 0, 0, 255]], "outside the plane is no data");
  // More than four channels: the lanes are clamped between batches without losing the sum.
  const full = Float64Array.from([255]);
  const six = (c: string, k: number) => renderView(input(1, 1, Array.from({ length: k }, (_, i) => chIn(full, rch(i, { color: c })))));
  h.eq([Array.from(six("#2a0000", 6)), Array.from(six("#404040", 6)), Array.from(six("#100804", 9))], [[252, 0, 0, 255], [255, 255, 255, 255], [144, 72, 36, 255]], "5+ channels add exactly (6 × 42 = 252, 9 × 16 = 144) and clamp (6 × 64 → 255)");
}

// =============================================================================================
h.section("I. the RGB fixture renders its colours");
{
  const reader = readers.rgb_u8, f = byName.rgb_u8, W = 56, H = 40;
  const out = await renderBundle(reader, resolveView(reader.manifest), { x: 0, y: 0, width: W, height: H }, W, H);
  let ok = true;
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) if (out[i * 4 + c] !== f.data[c * W * H + i]) ok = false;
  h.ok(ok, "red, green and blue channels over [0, 255] reproduce the stored bytes exactly");
}

// =============================================================================================
h.section("J. intensity layers");
{
  const W = 3, H = 1;
  const base = Float64Array.from([0, 255, 128]);
  const lay = Float64Array.from([NaN, 10, 5]);
  const red = channelTable({ color: "#ff0000", lut: null, invert: false }, resolver);
  const layer = (o: Partial<RenderLayerInput>): RenderLayerInput => ({ plane: { data: lay, map: null }, range: [0, 10], table: red, opacity: 0.5, opacityFromValue: false, ...o });
  const ch = [chIn(base, rch(0, { color: "#ffffff" }))];
  const round8 = (v: number): number => Uint8ClampedArray.of(v)[0];
  const o1 = renderView(input(W, H, ch, { layers: [layer({})] }));
  h.eq(px(o1, W, 0, 0), [0, 0, 0, 255], "no layer data: the pixel is untouched");
  h.eq(px(o1, W, 1, 0), [255, round8(255 * 0.5), round8(255 * 0.5), 255], "constant opacity 0.5: out = out · (1 − a) + colour · a");
  const x = normalizeValue(makeNormalizer([0, 10]), 5), slot = slotOf(x);
  h.eq(px(o1, W, 2, 0), [round8(128 * 0.5 + red[slot * 4] * 0.5), round8(128 * 0.5), round8(128 * 0.5), 255], "the layer colour comes through its own window");
  const o2 = renderView(input(W, H, ch, { layers: [layer({ opacity: 0.8, opacityFromValue: true })] }));
  const a = 0.8 * x;
  h.eq(px(o2, W, 2, 0), [round8(128 * (1 - a) + red[slot * 4] * a), round8(128 * (1 - a)), round8(128 * (1 - a)), 255], "opacity from value: a = opacity · x");
  h.eq(px(o2, W, 1, 0), [255, round8(255 * 0.2), round8(255 * 0.2), 255], "x = 1 → a = opacity");
  const nothing = Float64Array.from([NaN, NaN, NaN]);
  const o3 = renderView(input(W, H, [chIn(nothing, rch(0))], { background: "transparent", layers: [layer({ opacity: 0.5 })] }));
  h.eq([px(o3, W, 0, 0), px(o3, W, 1, 0)], [[0, 0, 0, 0], [255, 0, 0, round8(127.5)]], "over a transparent background the layer keeps its own colour at alpha a");
  const o4 = renderView(input(W, H, ch, { layers: [layer({ opacity: 0 })] }));
  h.ok(same(o4, renderView(input(W, H, ch))), "opacity 0 changes nothing");
  // Through a bundle: the activity layer of the layered fixture, shown over its channels.
  const m = M("mean_f64_layers");
  const on = await renderBundle(readers.mean_f64_layers, resolveView(m, { layers: { activity: { visible: true } } }), { x: 0, y: 0, width: 90, height: 60 }, 90, 60);
  const off = await renderBundle(readers.mean_f64_layers, resolveView(m), { x: 0, y: 0, width: 90, height: 60 }, 90, 60);
  let changedInside = 0, changedOutside = 0;
  for (let y = 0; y < 60; y++) for (let x2 = 0; x2 < 90; x2++) {
    const i = (y * 90 + x2) * 4, inMask = y >= 8 && y < 52 && x2 >= 10 && x2 < 80;
    const d = on[i] !== off[i] || on[i + 1] !== off[i + 1] || on[i + 2] !== off[i + 2];
    if (d && inMask) changedInside++;
    if (d && !inMask) changedOutside++;
  }
  h.ok(changedInside > 500 && changedOutside === 0, `a bundle's intensity layer tints only where it has data (${changedInside} pixels inside, ${changedOutside} outside)`);
}

// =============================================================================================
h.section("K. linear16 and lossless render the same image");
{
  const ml = M("movie_f32_lossless"), m16 = M("movie_f32");
  h.eq([m16.pixels.encoding.kind, ml.pixels.encoding.kind], ["linear16", "exact"], "one movie stored both ways");
  const view: FluximgView = { index: { t: 5 }, channels: ml.channels.map((c) => ({ range: c.range })) };
  let worst = 0;
  const geoms: Array<[{ x: number; y: number; width: number; height: number }, number, number, boolean]> = [
    [{ x: 0, y: 0, width: 60, height: 40 }, 60, 40, false], [{ x: 0, y: 0, width: 60, height: 40 }, 25, 17, false], [{ x: 5, y: 3, width: 20, height: 12 }, 80, 48, true],
  ];
  for (const [crop, ow, oh, smooth] of geoms) {
    for (const v of [view, { ...view, composite: "single" as const, solo: 0 }, { ...view, composite: "single" as const, solo: 1 }, { ...view, projection: { dim: "t", mode: "mean" as const, from: 2, to: 20 } }]) {
      const s = { ...v, smooth };
      const a = await renderBundle(readers.movie_f32, resolveView(m16, s), crop, ow, oh);
      const b = await renderBundle(readers.movie_f32_lossless, resolveView(ml, s), crop, ow, oh);
      worst = Math.max(worst, maxDiff(a, b));
    }
  }
  h.ok(worst <= 1, `at 1:1, minified, smooth-magnified and projected, every 8-bit sample is within 1 (worst ${worst})`);
}

// =============================================================================================
h.section("L. projections against a brute-force oracle");
{
  const r = rng(5), N = 12, LEN = 300;
  const planesF: RenderPlane[] = [], planesU: RenderPlane[] = [];
  const umap: ValueMap = { mul: 0.37, add: 1000.25, sub: 1, nodata: 0, float: false };
  for (let i = 0; i < N; i++) {
    const f = new Float32Array(LEN), u = new Uint16Array(LEN);
    for (let j = 0; j < LEN; j++) {
      const never = j < 5; // these pixels never have data
      f[j] = never || r() < 0.2 ? NaN : 500 + 40 * r() + (j % 7);
      u[j] = never || r() < 0.2 ? 0 : 1 + Math.floor(r() * 9000);
    }
    planesF.push({ data: f, map: null }); planesU.push({ data: u, map: umap });
  }
  const oracle = (planes: RenderPlane[], mode: FluximgProjectionMode): Float64Array => {
    const out = new Float64Array(LEN);
    for (let j = 0; j < LEN; j++) {
      const vs: number[] = [];
      for (const p of planes) { const s = p.data[j]; if (p.map ? s === p.map.nodata : Number.isNaN(s)) continue; vs.push(p.map ? p.map.add + p.map.mul * (s - p.map.sub) : s); }
      if (!vs.length) { out[j] = NaN; continue; }
      const sum = vs.reduce((a, b) => a + b, 0), mean = sum / vs.length;
      out[j] = mode === "max" ? Math.max(...vs) : mode === "min" ? Math.min(...vs) : mode === "sum" ? sum : mode === "mean" ? mean : Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
    }
    return out;
  };
  const close = (got: Float32Array, want: Float64Array, exact: boolean): boolean => {
    for (let j = 0; j < LEN; j++) {
      const g = got[j], w = want[j];
      if (Number.isNaN(w) || Number.isNaN(g)) { if (Number.isNaN(w) !== Number.isNaN(g)) return false; continue; }
      if (exact ? g !== Math.fround(w) : Math.abs(g - w) > 1e-5 * Math.max(Math.abs(w), 1e-3)) return false;
    }
    return true;
  };
  for (const mode of ["max", "mean", "min", "sum", "std"] as FluximgProjectionMode[]) {
    const okF = close(projectPlanes(planesF, LEN, mode), oracle(planesF, mode), mode === "max" || mode === "min");
    const okU = close(projectPlanes(planesU, LEN, mode), oracle(planesU, mode), mode === "max" || mode === "min");
    h.ok(okF && okU, `${mode}: float planes with NaN and linear16-coded planes match the oracle, NaN where a pixel never has data`);
  }
  const constStd = projectPlanes([{ data: Float32Array.of(1e6 + 0.5), map: null }, { data: Float32Array.of(1e6 + 0.5), map: null }], 1, "std");
  h.eq(constStd[0], 0, "std of a constant with a large offset is exactly 0");
  h.ok(Number.isNaN(projectPlanes([], 3, "max")[0]), "no planes: no data");

  h.section("M. block summaries equal direct projection");
  const n = 50, bigN = 4 * LEN;
  const stack: RenderPlane[] = [];
  for (let i = 0; i < n; i++) {
    const u = new Uint16Array(bigN);
    for (let j = 0; j < bigN; j++) u[j] = j < 3 || r() < 0.15 ? 0 : 1 + Math.floor(20000 + 3000 * Math.sin(i / 4 + j) + 200 * r());
    stack.push({ data: u, map: umap });
  }
  let reads = 0;
  const getPlane = async (i: number): Promise<RenderPlane> => { reads++; await Promise.resolve(); return stack[i]; };
  const blocks = await buildBlocks(getPlane, n, bigN, 8);
  h.eq([blocks.blocks.length, blocks.blocks[6].from, blocks.blocks[6].to, reads], [7, 48, 50, 50], "50 planes in blocks of 8: 7 blocks (the last one short), each plane read once");
  let bad = 0, cases = 0, worstRel = 0;
  reads = 0;
  const ranges: Array<[number, number]> = [[0, 50], [0, 8], [3, 5], [7, 41], [8, 16], [48, 50], [49, 50]];
  for (let k = 0; k < 30; k++) { const a = Math.floor(r() * n), b = a + 1 + Math.floor(r() * (n - a)); ranges.push([a, b]); }
  for (const [from, to] of ranges) for (const mode of ["max", "mean", "min", "sum", "std"] as FluximgProjectionMode[]) {
    const want = projectPlanes(stack.slice(from, to), bigN, mode);
    const got = await projectRange(blocks, getPlane, from, to, mode);
    cases++;
    for (let j = 0; j < bigN; j++) {
      const g = got[j], w = want[j];
      if (Number.isNaN(w) || Number.isNaN(g)) { if (Number.isNaN(w) !== Number.isNaN(g)) { bad++; break; } continue; }
      if (mode === "max" || mode === "min") { if (g !== w) { bad++; break; } continue; }
      const rel = Math.abs(g - w) / Math.max(Math.abs(w), 1e-9);
      worstRel = Math.max(worstRel, rel);
      if (rel > 1e-5) { bad++; break; }
    }
  }
  h.ok(bad === 0, `${cases} range × mode cases: max / min exact, mean / sum / std within 1e-5 relative (worst ${worstRel.toExponential(2)})`);
  const directReads = ranges.reduce((s, [a, b]) => s + (b - a), 0) * 5;
  h.ok(reads < directReads / 2, `projectRange read ${reads} planes where direct projection reads ${directReads}`);
}

// =============================================================================================
h.section("N. histogram, automatic window, value under the pointer");
{
  const u8 = Uint8Array.from({ length: 256 }, (_, i) => i);
  h.eq(Array.from(histogram({ data: u8, map: null }, 0, 256, 256)).every((c) => c === 1), true, "one value per bin");
  const hist = histogram({ data: Float64Array.from([0, 0.5, 1, 1.5, 2, NaN, -1, 3]), map: null }, 0, 2, 4);
  h.eq(Array.from(hist), [1, 1, 1, 2], "hi lands in the last bin; outside values and no data are not counted");
  h.eq(Array.from(histogram({ data: Uint16Array.from([0, 1, 2, 3]), map: { mul: 10, add: 0, sub: 1, nodata: 0, float: false } }, 0, 40, 4)), [1, 1, 1, 0], "on values, after the encoding");
  for (const name of ["gray2d_u8", "masked_i16"]) {
    const m = M(name), p = m.pixels, reader = readers[name];
    const plane = await reader.readPlane(await reader.level(0), []);
    h.eq(autoRange([{ data: plane, map: valueMaps(p.dtype, p.encoding, 1, p.nodata)[0] }]), m.channels[0].range, `${name}: the automatic window equals the writer's default window`);
  }
  {
    const m = M("stack_u16"), reader = readers.stack_u16, a = await reader.level(0);
    const planes: RenderPlane[] = [];
    for (let z = 0; z < 7; z++) planes.push({ data: await reader.readPlane(a, [1, z]), map: null });
    h.eq(autoRange(planes), m.channels[1].range, "a z-stack channel: the window over all its planes equals the writer's");
  }
  h.eq(autoRange([{ data: Float32Array.of(4, 4, 4), map: null }]), [4, 5], "a constant: [v, v + 1]");
  h.eq(autoRange([{ data: Float32Array.of(NaN, NaN), map: null }]), [0, 1], "no data: [0, 1]");
  const big = new Float32Array(3_000_000).map((_, i) => i % 1000);
  const t0 = performance.now(), ar = autoRange([{ data: big, map: null }]), ms = performance.now() - t0;
  h.ok(ar[0] >= 9 && ar[0] <= 11 && ar[1] >= 996 && ar[1] <= 999, `a 3-megapixel plane is sampled (window [${ar[0]}, ${ar[1]}] in ${ms.toFixed(0)} ms)`);
  const vp: RenderPlane = { data: Int16Array.from([5, -1, 7, 9]), map: { mul: 1, add: 0, sub: 0, nodata: -1, float: false } };
  h.eq([valueAt(vp, 2, 0, 0), valueAt(vp, 2, 1, 0), valueAt(vp, 2, 1, 1), valueAt(vp, 2, 2, 0), valueAt(vp, 2, 0, 2), valueAt(vp, 2, -1, 0)], [5, NaN, 9, NaN, NaN, NaN], "valueAt: the value, NaN for no data and outside");
}

// =============================================================================================
h.section("O. edge cases: 1 x 1, all no data, empty output");
{
  const one = Float64Array.of(42);
  const v = rch(0, { range: [0, 84], color: "#ffffff" });
  h.eq(Array.from(renderView(input(1, 1, [chIn(one, v)]))), [128, 128, 128, 255], "a 1 x 1 image at 1:1");
  const big = renderView(input(1, 1, [chIn(one, v)], { outWidth: 5, outHeight: 3 }));
  h.ok(Array.from({ length: 15 }, (_, i) => big[i * 4]).every((c) => c === 128), "magnified to 5 x 3: every pixel is that pixel");
  const bigSmooth = renderView(input(1, 1, [chIn(one, v)], { outWidth: 5, outHeight: 3, smooth: true }));
  h.ok(same(bigSmooth, big), "smooth too");
  const nd = new Float32Array(16).fill(NaN);
  h.ok(Array.from(renderView(input(4, 4, [chIn(nd, v)], { background: "#ff00ff" }))).every((c, i) => c === [255, 0, 255, 255][i % 4]), "all no data: the background everywhere");
  h.ok(renderView(input(4, 4, [chIn(nd, v)], { background: "transparent", outWidth: 2, outHeight: 2 })).every((c) => c === 0), "all no data, transparent, minified: nothing");
  h.ok(Array.from(renderView(input(4, 4, [])).filter((_, i) => i % 4 === 3)).every((a) => a === 255), "no channels: background");
  h.eq(renderView(input(4, 4, [chIn(nd, v)], { outWidth: 0, outHeight: 3 })).length, 0, "an empty output");
  h.ok(Number.isNaN(projectPlanes([{ data: nd, map: null }, { data: nd, map: null }], 16, "mean")[7]), "projection of no data: no data");
  const u1 = Uint16Array.of(0);
  h.eq(Array.from(renderView(input(1, 1, [chIn(u1, v, { mul: 1, add: 0, sub: 1, nodata: 0, float: false })], { background: "#010203" }))), [1, 2, 3, 255], "a 1 x 1 coded no-data pixel through the table path");
  let threw = false;
  try { renderView(input(4, 4, [chIn(one, v)])); } catch { threw = true; }
  h.ok(threw, "a plane smaller than width x height is refused");
}

// =============================================================================================
h.section("P. words");
{
  const stack = M("stack_u16"), movie = M("movie_f32"), trials = M("trials_f32");
  h.eq(describePosition(stack, "z", 3), "z 4/7 · −58.5 µm", "z: 1-based index / count, then the position with its unit (U+2212 minus)");
  h.eq(describePosition(movie, "t", 3), "t 4/24 · 0.0375 s", "t: evenly spaced");
  h.eq(describePosition(trials, "trial", 1), "trial b (2/3)", "categorical: the label, then index / count");
  h.eq(describePosition(trials, "t", 2), "t 3/5 · 0.2 s", "float noise trimmed (0.1 · 2)");
  h.eq(describeProjection(stack, { dim: "z", mode: "max", from: 1, to: 5 }), "max z 2–5 · −60.5 to −57.5 µm", "projection: inclusive 1-based planes and the span");
  h.eq(describeProjection(trials, { dim: "trial", mode: "mean", from: 0, to: 3 }), "mean trial a–c (1–3)", "a categorical projection");
  const bare = copy(movie); bare.axes.t = { unit: null, scale: 1, offset: 0 };
  h.eq(describePosition(bare, "t", 3), "t 4/24", "an axis without a physical position prints the index only");
  h.eq([formatNumber(-50.5), formatNumber(12.345678), formatNumber(0.30000000000000004), formatNumber(0.000012346), formatNumber(0), formatNumber(-0), formatNumber(3.2)], ["−50.5", "12.3457", "0.3", "0.00001235", "0", "0", "3.2"], "numbers: at most 4 decimals (4 significant below 1), no trailing zeros");
}

// =============================================================================================
h.section("Q. speed (measured, not asserted)");
{
  const W = 1280, H = 800, r = rng(99);
  const c0 = new Uint16Array(W * H), c1 = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) { c0[i] = Math.floor(r() * 4096); c1[i] = Math.floor(r() * 4096); }
  const map: ValueMap = { mul: 1, add: 0, sub: 0, nodata: 0, float: false };
  const views = [rch(0, { color: "#ff00ff", range: [100, 3000] }), rch(1, { color: "#00ff00", range: [100, 3000] })];
  const tables = views.map((v) => channelTable(v, resolver));
  const inp: RenderInput = input(W, H, [{ plane: { data: c0, map }, view: views[0], table: tables[0] }, { plane: { data: c1, map }, view: views[1], table: tables[1] }]);
  const time = (fn: () => void): number => { for (let i = 0; i < 8; i++) fn(); const t: number[] = []; for (let i = 0; i < 30; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return t[15]; };
  const ms = time(() => renderView(inp));
  console.log(`  render 1280 x 800, two uint16 channels, 1:1: median ${ms.toFixed(2)} ms (aim < 6 ms)`);
  const f0 = Float32Array.from(c0), f1 = Float32Array.from(c1);
  const msF = time(() => renderView({ ...inp, channels: [{ ...inp.channels[0], plane: { data: f0, map: null } }, { ...inp.channels[1], plane: { data: f1, map: null } }] }));
  console.log(`  same, float32 planes (float path): median ${msF.toFixed(2)} ms`);
  const msMin = time(() => renderView({ ...inp, outWidth: 640, outHeight: 400 }));
  console.log(`  same planes minified 2x to 640 x 400: median ${msMin.toFixed(2)} ms`);
  h.ok(ms > 0, "timings printed");
}

await h.done(() => fsp.rm(tmp, { recursive: true, force: true }));
