// fluximg view tween (stage 2, viewTween.ts): THE LAW of what every frame between two states of an image shows.
// Each rule on hand-written cases (walks, projections, windows, colours, switches that fade, two pictures, furniture,
// the crop, what steps at raw 0.5, exact ends, the plan's flags), then properties over seeded random pairs of views
// (exact ends, determinism, no input mutation, every frame a valid resolved view, continuous fields monotone under
// linear time), `upcoming`, the sparse recipe form agreeing with the resolved one, the words, the natural pace, and
// the cost of one frame.
//
// Pure tier. Hermetic: manifests are built in memory, plus two synthetic bundles written to a scratch directory.
// Run: npx tsx scripts/verify-fluximg-view-tween.ts
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harness } from "./lib/harness.mjs";
import { fixtures, rng, writeFixture } from "./lib/fluximgFixtures";
import { nodeBundleReader, nodeZstd } from "../flux-core/fluximgIo";
import { openFluximg } from "../src/lib/fluximg/reader";
import type { FluximgLayer, FluximgManifest, FluximgStats } from "../src/lib/fluximg/types";
import type { FluximgChannelView, FluximgFurnitureView, FluximgLayerView, FluximgView, PixelRect, ResolvedLayer, ResolvedView } from "../src/lib/fluximg/view";
import { explicitView, isEmptyViewPatch, patchView, positionDims, resolveView, viewPatch } from "../src/lib/fluximg/viewOps";
import { checkViewPatch } from "../src/lib/fluximg/viewCheck";
import { clampCrop, fullCrop } from "../src/lib/fluximg/still";
import { prepareColorLerp } from "../src/lib/color/interp";
import { naturalRate } from "../src/lib/fluximg/live/rail";
import {
  describeViewChange, framePicture, lerpFluximgView, lerpResolvedLayer, naturalDurationMs, planViewTween,
  type TweenPicture, type ViewEnd, type ViewTweenFrame, type ViewTweenPlan,
} from "../src/lib/fluximg/viewTween";

const h = harness("verify-fluximg-view-tween");
const show = (v: unknown): string => JSON.stringify(v);
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
function find<T>(cases: Iterable<T>, bad: (c: T) => boolean): T | null { for (const c of cases) if (bad(c)) return c; return null; }
const lin = (u: number): number => u;
const easeInOut = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); Object.freeze(v); }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------------------------

const stats = (min: number, max: number): FluximgStats => ({ count: 100, min, max, percentiles: {}, hist: { lo: min, hi: max, counts: new Array(256).fill(0) } } as FluximgStats);
const ENC = { kind: "exact" } as const;
function mk(o: { dims: string[]; shape: number[]; axes?: FluximgManifest["axes"]; channels?: FluximgManifest["channels"]; layers?: FluximgLayer[]; defaults?: FluximgManifest["defaults"] }): FluximgManifest {
  return {
    spec: "fluximg/1", name: "synthetic",
    pixels: { path: "pixels", dims: o.dims, shape: o.shape, dtype: "uint16", levels: [{ path: "0", shape: o.shape, downsample: 1 }], encoding: ENC, ome: false },
    axes: o.axes ?? {}, channels: o.channels ?? [{ name: "gray", lut: "gray", range: [0, 255], stats: stats(0, 255) }],
    layers: o.layers ?? [], regions: [], ...(o.defaults ? { defaults: o.defaults } : {}),
  } as FluximgManifest;
}
const LAYERS: FluximgLayer[] = [
  { kind: "intensity", id: "activity", name: "activity", path: "layers/activity", dtype: "float32", encoding: ENC, color: "#ff2bd6", range: [0, 0.02], opacity: 1, stats: stats(0, 0.02) },
  { kind: "intensity", id: "weights", name: "weights", path: "layers/weights", dtype: "float32", encoding: ENC, lut: "viridis", range: [0, 0.1], opacity: 0.8, stats: stats(0, 0.1) },
  { kind: "labels", id: "footprints", name: "footprints", path: "layers/footprints", dtype: "uint16", outlines: "layers/footprints.svg", table: "layers/footprints.table.json", key: "label", count: 4, visible: true },
  { kind: "vector", id: "lines", name: "lines", path: "layers/lines.svg", count: 2, color: "#ffffff" },
  { kind: "vector", id: "discs", name: "discs", path: "layers/discs.svg", count: 3 },
];
/** Two channels, five layers, time (seconds), depth (µm): the image the timing budget is stated for. */
const M = mk({
  dims: ["t", "c", "z", "y", "x"], shape: [401, 2, 7, 60, 90],
  axes: { t: { unit: "s", scale: 0.0125 }, z: { unit: "µm", scale: 0.5 }, y: { unit: "µm", scale: 0.25 }, x: { unit: "µm", scale: 0.25 } },
  channels: [{ name: "channel 1", color: "#ff2bd6", range: [0, 1000], stats: stats(0, 4000) }, { name: "signal", lut: "gray", range: [10, 5000], stats: stats(1, 9000) }],
  layers: LAYERS, defaults: { index: { t: 0, z: 3 } },
});
const FULL = fullCrop(M);

const plan = (pre: ViewEnd, end: ViewEnd, blend = false, m: FluximgManifest = M): ViewTweenPlan => planViewTween(m, pre, end, { blend });
const v = (view: FluximgView, crop?: PixelRect): ViewEnd => ({ view, ...(crop ? { crop } : {}) });
const ch = (f: ViewTweenFrame, i: number, which: "a" | "b" = "a") => (f[which] as TweenPicture).view.channels[i];
const layer = (p: TweenPicture, id: string): ResolvedLayer => p.view.layers.find((l) => l.id === id)!;

// ---------------------------------------------------------------------------------------------
h.section("law 2: plane positions step");
{
  const p = plan(v({ index: { t: 0 } }), v({ index: { t: 10 } }));
  const seq: number[] = [], counts = new Array(11).fill(0);
  for (let k = 0; k <= 1000; k++) {
    const i = p.frame(k / 1000, k / 1000).a.view.index.t;
    counts[i]++;
    if (seq[seq.length - 1] !== i) seq.push(i);
  }
  h.eq(seq, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "a walk 0 → 10 under linear t visits every plane in order exactly once");
  h.eq(counts, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 1], "planes 0..9 each get an equal share of the time; the end's plane arrives at the end");
  const back = plan(v({ index: { t: 10 } }), v({ index: { t: 3 } })), bseq: number[] = [];
  for (let k = 0; k <= 700; k++) { const i = back.frame(k / 700, k / 700).a.view.index.t; if (bseq[bseq.length - 1] !== i) bseq.push(i); }
  h.eq(bseq, [10, 9, 8, 7, 6, 5, 4, 3], "a backward walk 10 → 3 visits every plane in order exactly once");
  const one = plan(v({ index: { z: 4 } }), v({ index: { z: 5 } }));
  h.eq([one.frame(0.5, 0.5).a.view.index.z, one.frame(0.999, 0.999).a.view.index.z, one.frame(1, 0.99).a.view.index.z, one.frame(1, 1).a.view.index.z], [4, 4, 5, 5], "N = 1: the start's plane until t reaches 1, then the end's");
  h.eq([p.frame(1.2, 0.9).a.view.index.t, p.frame(-0.2, 0.1).a.view.index.t], [10, 0], "overshoot: t = 1.2 shows the end's plane, t = −0.2 the start's (raw inside 0..1)");
  h.ok([0.3, 0.7, 0.1].every((c) => p.frame(c, 0.5).a.view.index.t === Math.floor(c * 10 + 1e-9)), "the plane is floor(c·N) for exact fractions k/N (no rounding loss)");
  // Several dims at once: each steps by its own N.
  const two = plan(v({ index: { t: 0, z: 0 } }), v({ index: { t: 100, z: 4 } }), true);
  const f2 = two.frame(0.5, 0.5);
  h.eq([f2.a.view.index.t, f2.a.view.index.z], [50, 2], "two dims walking at once each step by their own N");
  h.eq(two.frame(0.255, 0.3).blend?.dim, "t", "…and blend reports the dim with the larger N");
}

h.section("law 2: crossfade (options.blend)");
{
  const p = plan(v({ index: { t: 0 } }), v({ index: { t: 10 } }), true);
  h.eq(p.frame(0.25, 0.25).blend, { dim: "t", other: 3, weight: 0.5 }, "at c = 0.25 of 0 → 10: plane 2, the next plane 3 at weight 0.5");
  h.eq(p.frame(0.25, 0.25).a.view.index.t, 2, "…the picture itself still shows a whole plane");
  h.eq(p.frame(0.2, 0.2).blend, null, "a whole position has no blend");
  h.eq(p.frame(1.3, 0.95).blend, null, "the walk is over (overshoot): no blend");
  const back = plan(v({ index: { t: 10 } }), v({ index: { t: 3 } }), true);
  h.eq(back.frame(0.5, 0.5).blend, { dim: "t", other: 6, weight: 0.5 }, "a backward walk blends toward the end (plane 7 with 6)");
  h.eq(plan(v({ index: { t: 0 } }), v({ index: { t: 10 } })).frame(0.25, 0.25).blend, null, "without the option planes step: no blend");
  const ws = Array.from({ length: 999 }, (_, k) => p.frame((k + 1) / 1000, (k + 1) / 1000).blend?.weight ?? 0);
  h.ok(ws.every((w) => w >= 0 && w <= 1), "blend weights stay in 0..1");
}

h.section("law 2: projection runs");
{
  const p = plan(v({ projection: { dim: "z", mode: "max", from: 0, to: 2 } }), v({ projection: { dim: "z", mode: "max", from: 3, to: 6 } }), true);
  const f = p.frame(0.5, 0.5);
  h.eq(f.a.view.projection, { dim: "z", mode: "max", from: 1, to: 4 }, "same dim and mode: from and to step like positions (from 0→3, to 2→6 at c = 0.5)");
  h.eq([p.twoPictures, f.b], [false, null], "…one picture");
  const pb = p.frame(0.3, 0.3).blend;
  h.ok(!!pb && pb.dim === "z" && pb.other === 4 && pb.end === "to" && near(pb.weight, 0.2), `…blend names the run end with the larger N (${show(pb)})`);
  const shrink = plan(v({ projection: { dim: "z", mode: "max", from: 0, to: 7 } }), v({ projection: { dim: "z", mode: "max", from: 5, to: 6 } }));
  const bad = find(Array.from({ length: 401 }, (_, k) => k / 400), (c) => { const pr = shrink.frame(c, Math.min(0.999, Math.max(0.001, c))).a.view.projection!; return !(pr.to > pr.from && pr.from >= 0 && pr.to <= 7); });
  h.ok(bad === null, `a run never empties (to > from) while it walks${bad !== null ? ` (at c = ${bad})` : ""}`);
  const on = plan(v({}), v({ projection: { dim: "z", mode: "max", from: 1, to: 5 } }));
  const fo = on.frame(0.4, 0.4);
  h.eq([on.twoPictures, fo.a.view.projection, fo.b?.view.projection, fo.mix], [true, null, { dim: "z", mode: "max", from: 1, to: 5 }, 0.4], "a projection switched on: two pictures (start's off, end's on), mixed by t");
  const mode = plan(v({ projection: { dim: "z", mode: "max", from: 1, to: 5 } }), v({ projection: { dim: "z", mode: "mean", from: 1, to: 5 } }));
  h.eq([mode.twoPictures, mode.frame(0.5, 0.5).a.view.projection?.mode, mode.frame(0.5, 0.5).b?.view.projection?.mode], [true, "max", "mean"], "another mode is a discrete pixel setting: two pictures");
}

h.section("law 1: channel windows, gamma, colours");
{
  const p = plan(v({ channels: [{ range: [0, 1000] }] }), v({ channels: [{ range: [200, 600] }] }));
  h.eq(ch(p.frame(0.5, 0.5), 0).range, [100, 800], "a window lerps on t");
  h.eq([p.twoPictures, p.frame(0.5, 0.5).b], [false, null], "…one picture");
  const lg = plan(v({ channels: [{ range: [10, 1000], norm: "log" }] }), v({ channels: [{ range: [100, 10000], norm: "log" }] }));
  const r = ch(lg.frame(0.5, 0.5), 0).range;
  h.ok(near(r[0], Math.sqrt(1000)) && near(r[1], Math.sqrt(1e7)), `both ends log: the window lerps in log space (${show(r)})`);
  const mixed = plan(v({ channels: [{ range: [10, 1000], norm: "log" }] }), v({ channels: [{ range: [100, 10000] }] }));
  h.eq(ch(mixed.frame(0.5, 0.5), 0).range, [55, 5500], "one end log, the other linear: the window lerps linearly");
  const neg = plan(v({ channels: [{ range: [-10, 1000], norm: "log" }] }), v({ channels: [{ range: [100, 10000], norm: "log" }] }));
  h.eq(ch(neg.frame(0.5, 0.5), 0).range, [45, 5500], "a log window with a black point <= 0 lerps linearly");
  const inv = plan(v({ channels: [{ range: [0, 100] }] }), v({ channels: [{ range: [90, 95] }] }));
  const ro = ch(inv.frame(1.4, 0.8), 0).range;
  h.eq(ro, [90, 95], "an overshoot that would invert the window falls back to the clamped time (ordered)");
  const pass = ch(plan(v({ channels: [{ range: [0, 100] }] }), v({ channels: [{ range: [10, 200] }] })).frame(1.1, 0.8), 0).range;
  h.ok(near(pass[0], 11) && near(pass[1], 210), `an overshoot that keeps the window ordered passes the end (${show(pass)})`);
  const g = plan(v({ channels: [{ gamma: 1, norm: "gamma" }] }), v({ channels: [{ gamma: 2, norm: "gamma" }] }));
  h.eq(ch(g.frame(0.25, 0.25), 0).gamma, 1.25, "gamma lerps");
  h.ok(ch(plan(v({ channels: [{ gamma: 0.2, norm: "gamma" }] }), v({ channels: [{ gamma: 3, norm: "gamma" }] })).frame(-0.5, 0.2), 0).gamma > 0, "gamma stays > 0 under an undershoot");
  const c = plan(v({ channels: [{ color: "#ff0000" }] }), v({ channels: [{ color: "#0000ff" }] }));
  const fc = c.frame(0.5, 0.5);
  h.eq([ch(fc, 0).color, fc.b], [prepareColorLerp("#ff0000", "#0000ff")(0.5), null], "two ramp colours lerp in OKLab, one picture");
  h.eq([ch(c.frame(1.3, 0.9), 0).color, ch(c.frame(-0.3, 0.1), 0).color], ["#0000ff", "#ff0000"], "colours never overshoot");
}

h.section("law 3: channel switches make two pictures");
{
  const p = plan(v({ channels: [{ range: [0, 1000] }, null] }), v({ channels: [{ range: [0, 500] }, { visible: false }] }));
  const f = p.frame(0.3, 0.4);
  h.eq([p.twoPictures, p.pixels, f.mix], [true, true, 0.3], "a channel hidden: two pictures, mixed by clamp(t)");
  h.eq([ch(f, 1, "a").visible, ch(f, 1, "b").visible], [true, false], "…a keeps the start's setting, b has the end's");
  h.eq([ch(f, 0, "a").range, ch(f, 0, "b").range], [[0, 850], [0, 850]], "…continuous values are identical in both");
  h.ok(f.a.crop === f.b!.crop && show(f.a.view.index) === show(f.b!.view.index), "…as are the frame and the positions");
  h.eq([p.frame(1.4, 0.9).mix, p.frame(-0.4, 0.1).mix], [1, 0], "mix is clamped to 0..1 on an overshoot");
  const lut = plan(v({ channels: [null, { lut: "gray" }] }), v({ channels: [null, { lut: "viridis" }] }));
  h.eq([lut.twoPictures, ch(lut.frame(0.5, 0.5), 1, "a").lut, ch(lut.frame(0.5, 0.5), 1, "b").lut], [true, "gray", "viridis"], "a colour map swapped: two pictures");
  const ramp2lut = plan(v({ channels: [{ color: "#ff0000" }] }), v({ channels: [{ lut: "magma" }] }));
  h.eq([ramp2lut.twoPictures, ch(ramp2lut.frame(0.5, 0.5), 0, "b").color, ch(ramp2lut.frame(0.5, 0.5), 0, "b").lut], [true, null, "magma"], "a ramp colour becoming a colour map: two pictures");
  h.eq(plan(v({}), v({ channels: [{ norm: "log" }] })).twoPictures, true, "the norm kind is discrete");
  h.eq(plan(v({}), v({ channels: [{ invert: true }] })).twoPictures, true, "invert is discrete");
  const single = plan(v({}), v({ composite: "single", solo: 1 }));
  const fs = single.frame(0.5, 0.5);
  h.eq([single.twoPictures, fs.a.view.composite, fs.b?.view.composite, fs.b?.view.solo], [true, "blend", "single", 1], "composite → single: two pictures");
  const hidden = plan(v({ channels: [null, { visible: false, lut: "gray" }] }), v({ channels: [null, { visible: false, lut: "viridis" }] }));
  h.eq([hidden.twoPictures, hidden.pixels, ch(hidden.frame(0.4, 0.49), 1).lut, ch(hidden.frame(0.6, 0.51), 1).lut], [false, false, "gray", "viridis"], "a hidden channel's colour map is not pixels: one picture, steps at raw 0.5");
  const soloBlend = plan(v({ solo: 0 }), v({ solo: 1 }));
  h.eq([soloBlend.twoPictures, soloBlend.frame(0.5, 0.49).a.view.solo, soloBlend.frame(0.5, 0.51).a.view.solo], [false, 0, 1], "solo while blending changes no pixels: steps at raw 0.5");
}

h.section("law 1 / 3: background");
{
  const p = plan(v({ background: "#000000" }), v({ background: "#ffffff" }));
  h.eq([p.frame(0.5, 0.5).a.view.background, p.twoPictures], [prepareColorLerp("#000000", "#ffffff")(0.5), false], "two hex backgrounds lerp in OKLab");
  const tr = plan(v({}), v({ background: "transparent" }));
  h.eq([tr.twoPictures, tr.frame(0.5, 0.5).a.view.background, tr.frame(0.5, 0.5).b?.view.background], [true, "#000000", "transparent"], "transparent on one side: two pictures");
}

h.section("intensity layers: fades, windows, colours");
{
  const on = plan(v({}), v({ layers: { activity: { visible: true } } }));
  const f = on.frame(0.3, 0.3), L = layer(f.a, "activity");
  h.eq([L.visible, L.opacity, on.twoPictures, f.b], [true, 0.3, false, null], "switched on: drawn, its opacity lerped from 0 (a fade, one picture)");
  h.ok(on.pixels, "…and it is pixels");
  const off = plan(v({ layers: { weights: { visible: true } } }), v({}));
  h.ok(near(layer(off.frame(0.25, 0.25).a, "weights").opacity, 0.6), "switched off: its opacity lerped to 0 (0.8 → 0 at 0.25 = 0.6)");
  h.eq(layer(off.frame(1, 1).a, "weights").visible, false, "…and hidden exactly at the end");
  const both = plan(v({ layers: { activity: { visible: true, opacity: 0.2, range: [0, 1] } } }), v({ layers: { activity: { visible: true, opacity: 0.6, range: [0.5, 2] } } }));
  const fb = layer(both.frame(0.5, 0.5).a, "activity");
  h.ok(near(fb.opacity, 0.4) && show(fb.range) === show([0.25, 1.5]), `opacity and window lerp (${show([fb.opacity, fb.range])})`);
  h.eq(layer(both.frame(3, 0.9).a, "activity").opacity, 1, "an overshooting opacity is clamped to 1");
  const col = plan(v({ layers: { activity: { visible: true, color: "#ff0000" } } }), v({ layers: { activity: { visible: true, color: "#00ff00" } } }));
  h.eq([layer(col.frame(0.5, 0.5).a, "activity").color, col.twoPictures], [prepareColorLerp("#ff0000", "#00ff00")(0.5), false], "two ramp colours lerp");
  const lut = plan(v({ layers: { activity: { visible: true } } }), v({ layers: { activity: { visible: true, lut: "magma" } } }));
  const fl = lut.frame(0.5, 0.5);
  h.eq([lut.twoPictures, layer(fl.a, "activity").lut, layer(fl.b!, "activity").lut, layer(fl.b!, "activity").color], [true, null, "magma", null], "a colour-map change: two pictures");
}

h.section("vector and label layers: overlay only");
{
  const p = plan(v({ layers: { footprints: { opacity: 1, strokeWidth: 1, fillOpacity: 0 } } }), v({ layers: { footprints: { opacity: 0.5, strokeWidth: 3, fillOpacity: 0.4 } } }));
  const L = layer(p.frame(0.5, 0.5).overlay, "footprints");
  h.eq([L.opacity, L.strokeWidth, L.fillOpacity], [0.75, 2, 0.2], "opacity, stroke width and fill opacity lerp");
  h.eq([p.pixels, p.overlay, p.twoPictures], [false, true, false], "…no pixels change, the overlay does");
  const fade = plan(v({}), v({ layers: { lines: { visible: true } } }));
  const fl = layer(fade.frame(0.25, 0.25).overlay, "lines");
  h.eq([fl.visible, fl.opacity, fade.pixels], [true, 0.25, false], "switched on: a fade of its opacity");
  const out = plan(v({ layers: { lines: { visible: true } } }), v({}));
  h.eq(layer(out.frame(0.75, 0.75).overlay, "lines").opacity, 0.25, "switched off: fades out");
  const col = plan(v({ layers: { lines: { color: "#ff0000" } } }), v({ layers: { lines: { color: "#0000ff" } } }));
  h.eq(layer(col.frame(0.5, 0.5).overlay, "lines").color, prepareColorLerp("#ff0000", "#0000ff")(0.5), "colours at both ends lerp");
  const own = plan(v({ layers: { discs: { color: "#ff0000" } } }), v({}));
  h.eq([layer(own.frame(0.9, 0.49).overlay, "discs").color, layer(own.frame(0.1, 0.51).overlay, "discs").color], ["#ff0000", null], "one end keeps its own colours (null): steps at raw 0.5");
  // A field this module does not know (another work package adds `styleBy`): carried, steps at raw 0.5.
  const la = { ...resolveView(M).layers[2], styleBy: { color: "dendrite" } } as ResolvedLayer & { styleBy: unknown };
  const lb = { ...la, opacity: 0.5, styleBy: { color: "pixels", opacity: "pixels" } };
  const mid0 = lerpResolvedLayer(la, lb, 0.5, 0.49) as ResolvedLayer & { styleBy?: unknown }, mid1 = lerpResolvedLayer(la, lb, 0.5, 0.51) as ResolvedLayer & { styleBy?: unknown };
  h.eq([mid0.styleBy, mid1.styleBy, mid0.opacity], [{ color: "dendrite" }, { color: "pixels", opacity: "pixels" }, 0.75], "an unknown layer field is carried and steps at raw 0.5 while known ones lerp");
  const only = { ...la, styleBy: undefined } as ResolvedLayer;
  delete (only as { styleBy?: unknown }).styleBy;
  h.eq([(lerpResolvedLayer(only, lb, 0.5, 0.3) as { styleBy?: unknown }).styleBy, (lerpResolvedLayer(only, lb, 0.5, 0.7) as { styleBy?: unknown }).styleBy], [undefined, { color: "pixels", opacity: "pixels" }], "…present at one end only, it appears at raw 0.5");
  h.eq([lerpResolvedLayer(la, lb, 0.3, 0), lerpResolvedLayer(la, lb, 0.3, 1)], [la, lb], "…exact ends");
}

h.section("furniture: fades, sizes, colours, steps");
{
  const on = plan(v({}), v({ furniture: { scalebar: { thickness: 3 } } }));
  const f = on.frame(0.3, 0.3);
  h.eq([f.furnitureOpacity.scalebar, (f.overlay.view.furniture.scalebar as { thickness: number }).thickness], [0.3, 3], "switched on: it fades in with the end's settings");
  h.eq([on.pixels, on.overlay], [false, true], "…overlay only");
  const off = plan(v({ furniture: { stamp: {} } }), v({}));
  h.eq([off.frame(0.25, 0.25).furnitureOpacity.stamp, !!off.frame(0.25, 0.25).overlay.view.furniture.stamp, off.frame(1, 1).overlay.view.furniture.stamp], [0.75, true, false], "switched off: it fades out and is gone at the end");
  const sb = plan(v({ furniture: { scalebar: { thickness: 1, fontSize: 6, color: "#ffffff", corner: "bottom-right", length: 10 } } }), v({ furniture: { scalebar: { thickness: 3, fontSize: 10, color: "#000000", corner: "top-left", length: 20, label: false } } }));
  const s0 = sb.frame(0.5, 0.49).overlay.view.furniture.scalebar as Record<string, unknown>, s1 = sb.frame(0.5, 0.51).overlay.view.furniture.scalebar as Record<string, unknown>;
  h.eq([s0.thickness, s0.fontSize, s0.length, s0.color], [2, 8, 15, prepareColorLerp("#ffffff", "#000000")(0.5)], "sizes, the bar's length and its colour lerp");
  h.eq([s0.corner, s0.label, s1.corner, s1.label], ["bottom-right", true, "top-left", false], "corner and label step at raw 0.5");
  h.eq(sb.frame(0.5, 0.5).furnitureOpacity, {}, "a piece on at both ends does not fade");
  const auto = plan(v({ furniture: { scalebar: {} } }), v({ furniture: { scalebar: { length: 20 } } }));
  h.eq([(auto.frame(0.5, 0.5).overlay.view.furniture.scalebar as { length: unknown }).length, (auto.frame(1, 1).overlay.view.furniture.scalebar as { length: unknown }).length], [null, 20], "an automatic length on one side stays automatic (null) until the end");
  const stamp = plan(v({ furniture: { stamp: { dims: ["t"] } } }), v({ furniture: { stamp: { dims: ["z"] } } }));
  h.eq([(stamp.frame(0.5, 0.4).overlay.view.furniture.stamp as { dims: string[] }).dims, (stamp.frame(0.5, 0.6).overlay.view.furniture.stamp as { dims: string[] }).dims], [["t"], ["z"]], "a stamp's dims step at raw 0.5");
}

h.section("the crop (zoom and pan)");
{
  const c1 = { x: 10, y: 10, width: 40, height: 30 };
  const p = plan(v({}), v({}, c1));
  h.eq(p.start.crop, FULL, "an absent crop is the whole image");
  h.eq(p.frame(0.5, 0.5).a.crop, { x: 5, y: 5, width: 65, height: 45 }, "a one-sided crop glides from the whole image");
  const pan = plan(v({}, { x: 0, y: 0, width: 40, height: 30 }), v({}, { x: 50, y: 30, width: 40, height: 30 }));
  const o = pan.frame(1.3, 0.9).a.crop;
  h.ok(o.x >= 0 && o.y >= 0 && o.x + o.width <= FULL.width + 1e-9 && o.y + o.height <= FULL.height + 1e-9 && o.width > 0 && o.height > 0, `an overshooting pan is clamped inside the image (${show(o)})`);
  const o2 = pan.frame(1.1, 0.9).a.crop;
  h.ok(near(o2.x, 55) && near(o2.y, 33) && near(o2.width, 35) && near(o2.height, 27), `…a modest overshoot passes the end and is clipped at the image's edge (${show(o2)})`);
  const zoom = plan(v({}, { x: 10, y: 10, width: 60, height: 40 }), v({}, { x: 30, y: 20, width: 20, height: 10 }));
  const z = zoom.frame(1.5, 0.9).a.crop;
  h.ok(z.width > 0 && z.height > 0 && z.x >= 0 && z.y >= 0, `an overshooting zoom never collapses the frame (${show(z)})`);
  h.eq([zoom.pixels, zoom.overlay], [true, true], "a crop change is pixels; with an object layer shown it is overlay too");
  h.eq(plan(v({ layers: { footprints: { visible: false } } }), v({ layers: { footprints: { visible: false } } }, c1)).overlay, false, "…and not overlay when nothing is drawn over the image");
}

h.section("law 6: what steps at raw 0.5");
{
  const p = plan(v({ smooth: false, layerOrder: ["activity", "weights"], insetOf: "a", link: "x" }), v({ smooth: true, layerOrder: ["weights", "activity"], insetOf: "b", link: "y" }));
  const f0 = p.frame(0.9, 0.49).a.view, f1 = p.frame(0.1, 0.51).a.view;
  h.eq([f0.smooth, f0.insetOf, f0.link, f0.layers.slice(0, 2).map((l) => l.id)], [false, "a", "x", ["activity", "weights"]], "before raw 0.5: the start's smooth, inset, link, layer order");
  h.eq([f1.smooth, f1.insetOf, f1.link, f1.layers.slice(0, 2).map((l) => l.id)], [true, "b", "y", ["weights", "activity"]], "from raw 0.5: the end's (eased t does not matter)");
  h.eq(p.twoPictures, false, "smooth is not a two-picture setting");
}

h.section("law 4: exact ends");
{
  const p = plan(v({ index: { t: 3 }, channels: [{ visible: false }], furniture: { scalebar: {} } }, { x: 1, y: 2, width: 30, height: 20 }), v({ index: { t: 40 }, layers: { lines: { visible: true } } }), true);
  const s = p.frame(0.4, 0), e = p.frame(0.6, 1);
  h.ok(s.a === p.start && s.b === null && s.mix === 0 && s.blend === null && Object.keys(s.furnitureOpacity).length === 0 && s.overlay === p.start, "raw <= 0: exactly the start (b null, mix 0, no blend, no furniture opacity), whatever t is");
  h.ok(e.a === p.end && e.b === null && e.mix === 0 && e.blend === null && Object.keys(e.furnitureOpacity).length === 0 && e.overlay === p.end, "raw >= 1: exactly the end");
  h.eq([p.start.view, p.start.crop, p.end.view, p.end.crop], [resolveView(M, { index: { t: 3 }, channels: [{ visible: false }], furniture: { scalebar: {} } }), clampCrop(M, { x: 1, y: 2, width: 30, height: 20 }), resolveView(M, { index: { t: 40 }, layers: { lines: { visible: true } } }), FULL], "the plan's start and end are the ends resolved");
  h.ok(p.frame(-0.1, -0.5).a === p.start && p.frame(2, 1.5).a === p.end, "raw outside 0..1 is an end too");
}

h.section("the plan's flags");
{
  const contrast = plan(v({ channels: [{ range: [0, 100] }] }), v({ channels: [{ range: [0, 200] }] }));
  h.eq([contrast.pixels, contrast.overlay, contrast.twoPictures], [true, false, false], "a pure contrast change: pixels, no overlay, one picture");
  h.eq(plan(v({ channels: [{ range: [0, 100] }], furniture: { channelLabels: {} } }), v({ channels: [{ range: [0, 200] }], furniture: { channelLabels: {} } })).overlay, false, "…still no overlay with channel names shown (they do not show the window)");
  h.eq(plan(v({ channels: [{ range: [0, 100] }], furniture: { colorbar: {} } }), v({ channels: [{ range: [0, 200] }], furniture: { colorbar: {} } })).overlay, true, "…overlay when a colour bar shows the window");
  h.eq(plan(v({ index: { t: 0 }, furniture: { stamp: {} } }), v({ index: { t: 5 }, furniture: { stamp: {} } })).overlay, true, "a walk with a stamp shown: overlay");
  h.eq(plan(v({ index: { t: 0 } }), v({ index: { t: 5 } })).overlay, false, "a walk with nothing drawn over the image: no overlay");
  h.eq(plan(v({}), v({})).pixels || plan(v({}), v({})).overlay || plan(v({}), v({})).twoPictures, false, "no change: nothing");
  h.eq(plan(v({ layers: { weights: { visible: false, opacity: 0.2 } } }), v({ layers: { weights: { visible: false, opacity: 0.9 } } })).pixels, false, "a hidden intensity layer's opacity is not pixels");
}

// ---------------------------------------------------------------------------------------------
// Random views
// ---------------------------------------------------------------------------------------------

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "fluximg-tween-"));
const codec = await nodeZstd();
const fx = fixtures();
const real: FluximgManifest[] = [];
for (const name of ["mean_f64_layers", "movie_f32", "stack_u16", "trials_f32"]) {
  await writeFixture(tmp, fx.find((f) => f.name === name)!);
  real.push((await openFluximg(nodeBundleReader(path.join(tmp, `${name}.fluximg`)), codec)).manifest);
}
const MANIFESTS = [M, ...real];

const R = rng(20261120);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(R() * xs.length)];
const chance = (p: number): boolean => R() < p;
const dimN = (m: FluximgManifest, d: string): number => m.pixels.shape[m.pixels.dims.indexOf(d)];
const COLOURS = ["#ff0000", "#00ff00", "#2040ff", "#ffffff", "#ff2bd6", "#123456"];
const LUTS = ["gray", "viridis", "magma"];

/** A random sparse view (and crop). `explicit`: every field written; `base`: copy its discrete settings (agreement cases). */
function randomEnd(m: FluximgManifest, explicit = false, base?: FluximgView): ViewEnd {
  const view: FluximgView = {};
  const pd = positionDims(m);
  if (explicit || chance(0.7)) { view.index = {}; for (const d of pd) if (explicit || chance(0.7)) view.index[d] = Math.floor(R() * dimN(m, d)); }
  if (base) { if (base.projection) { const n = dimN(m, base.projection.dim), f = Math.floor(R() * n); view.projection = { ...base.projection, from: f, to: f + 1 + Math.floor(R() * (n - f)) }; } else view.projection = null; }
  else if (pd.length && chance(0.3)) { const d = pick(pd), n = dimN(m, d), f = Math.floor(R() * n); view.projection = { dim: d, mode: pick(["max", "mean"] as const), from: f, to: f + 1 + Math.floor(R() * (n - f)) }; }
  view.channels = m.channels.map((c, i): FluximgChannelView | null => {
    if (!explicit && chance(0.4)) return null;
    const bc = base?.channels?.[i] ?? undefined;
    const lo = (c.stats.min ?? 0) + R() * 50, hi = lo + 1 + R() * 3000;
    const o: FluximgChannelView = { range: [lo, hi] };
    if (base) { o.visible = bc!.visible; o.norm = bc!.norm; o.invert = bc!.invert; if (bc!.lut) o.lut = bc!.lut; else o.color = pick(COLOURS); o.gamma = 0.3 + 2 * R(); return o; }
    if (explicit || chance(0.5)) o.visible = explicit ? true : chance(0.7);
    if (explicit || chance(0.4)) { if (chance(0.6)) o.color = pick(COLOURS); else o.lut = pick(LUTS); }
    if (explicit || chance(0.3)) o.norm = explicit ? pick(["linear", "log", "gamma"] as const) : pick(["linear", "log", "gamma"] as const);
    if (explicit || chance(0.3)) o.gamma = 0.3 + 2 * R();
    if (explicit || chance(0.2)) o.invert = explicit ? false : chance(0.5);
    return o;
  });
  if (base) { view.composite = base.composite; view.solo = base.solo; view.smooth = base.smooth; view.background = base.background === "transparent" ? "transparent" : pick(COLOURS); }
  else {
    if (explicit || chance(0.2)) { view.composite = chance(0.5) ? "single" : "blend"; view.solo = Math.floor(R() * m.channels.length); }
    if (explicit || chance(0.2)) view.smooth = chance(0.5);
    if (explicit || chance(0.3)) view.background = chance(0.8) ? pick(COLOURS) : "transparent";
  }
  if (m.layers.length) {
    view.layers = {};
    for (const l of m.layers) {
      if (!explicit && chance(0.4)) continue;
      const bl = base?.layers?.[l.id];
      const o: FluximgLayerView = {};
      o.visible = bl ? bl.visible : chance(0.6);
      o.opacity = R();
      o.strokeWidth = 4 * R(); o.fillOpacity = R();
      if (l.kind === "intensity") { const r0 = R() * 0.01; o.range = [r0, r0 + 0.001 + R() * 0.05]; if (bl ? !!bl.color : chance(0.6) || explicit) o.color = pick(COLOURS); else o.lut = bl?.lut ?? pick(LUTS); }
      else if (bl ? !!bl.color : explicit || chance(0.6)) o.color = pick(COLOURS);
      view.layers[l.id] = o;
    }
    if (!base && !explicit && chance(0.3)) view.layerOrder = m.layers.map((l) => l.id).sort(() => R() - 0.5);
    if (base?.layerOrder) view.layerOrder = base.layerOrder;
  }
  const fur: FluximgFurnitureView = {};
  const pieceOn = (k: keyof FluximgFurnitureView): boolean => (base ? !!base.furniture?.[k] : explicit ? chance(0.7) : chance(0.35));
  if (pieceOn("scalebar")) fur.scalebar = { length: 1 + 30 * R(), thickness: 0.5 + 3 * R(), fontSize: 4 + 8 * R(), color: pick(COLOURS), corner: base ? (base.furniture!.scalebar as { corner: never }).corner : pick(["bottom-right", "top-left"] as const), label: base ? (base.furniture!.scalebar as { label: boolean }).label : chance(0.5) };
  if (pieceOn("stamp")) fur.stamp = { fontSize: 4 + 8 * R(), color: pick(COLOURS), corner: base ? (base.furniture!.stamp as { corner: never }).corner : "top-left", dims: base ? (base.furniture!.stamp as { dims: string[] }).dims : pd.slice(0, 1) };
  if (pieceOn("colorbar")) fur.colorbar = { fontSize: 4 + 8 * R(), color: pick(COLOURS), corner: base ? (base.furniture!.colorbar as { corner: never }).corner : "bottom-left" };
  if (pieceOn("channelLabels")) fur.channelLabels = { fontSize: 4 + 8 * R(), corner: base ? (base.furniture!.channelLabels as { corner: never }).corner : "top-right" };
  view.furniture = fur;
  const full = fullCrop(m);
  let crop: PixelRect | undefined;
  if (explicit || chance(0.6)) { const w = 1 + R() * (full.width - 1), hh = 1 + R() * (full.height - 1); crop = { x: R() * (full.width - w), y: R() * (full.height - hh), width: w, height: hh }; }
  return { view, ...(crop ? { crop } : {}) };
}

/** Problems that make a picture an invalid resolved view of `m`. */
function invalid(m: FluximgManifest, p: TweenPicture): string | null {
  const rv = p.view;
  for (const d of positionDims(m)) { const i = rv.index[d]; if (!Number.isInteger(i) || i < 0 || i >= dimN(m, d)) return `index ${d}=${i}`; }
  const pr = rv.projection;
  if (pr && !(Number.isInteger(pr.from) && Number.isInteger(pr.to) && pr.from >= 0 && pr.to > pr.from && pr.to <= dimN(m, pr.dim))) return `projection ${show(pr)}`;
  for (const c of rv.channels) if (!(c.range[1] > c.range[0]) || !(c.gamma > 0)) return `channel ${show(c)}`;
  for (const l of rv.layers) {
    if (!(l.opacity >= 0 && l.opacity <= 1 && l.fillOpacity >= 0 && l.fillOpacity <= 1 && l.strokeWidth >= 0)) return `layer ${show(l)}`;
    if (l.range && !(l.range[1] > l.range[0])) return `layer range ${show(l)}`;
  }
  for (const piece of Object.values(rv.furniture)) if (piece) for (const [k, x] of Object.entries(piece)) if (typeof x === "number" && !(x > 0)) return `furniture ${k}=${x}`;
  const full = fullCrop(m), c = p.crop;
  if (!(c.width > 0 && c.height > 0 && c.x >= 0 && c.y >= 0 && c.x + c.width <= full.width + 1e-6 && c.y + c.height <= full.height + 1e-6)) return `crop ${show(c)}`;
  return null;
}

/** Every continuous number of a picture by path (layers by id, so a reorder does not mix them up). */
function numbers(p: TweenPicture): Map<string, number> {
  const out = new Map<string, number>();
  const rv = p.view;
  for (const [d, i] of Object.entries(rv.index)) out.set(`index.${d}`, i);
  rv.channels.forEach((c, i) => { out.set(`c${i}.lo`, c.range[0]); out.set(`c${i}.hi`, c.range[1]); out.set(`c${i}.gamma`, c.gamma); });
  for (const l of rv.layers) {
    out.set(`${l.id}.strokeWidth`, l.strokeWidth); out.set(`${l.id}.fillOpacity`, l.fillOpacity);
    out.set(`${l.id}.opacity`, l.visible ? l.opacity : 0);
    if (l.range) { out.set(`${l.id}.lo`, l.range[0]); out.set(`${l.id}.hi`, l.range[1]); }
  }
  for (const [k, piece] of Object.entries(rv.furniture)) if (piece) for (const [f, x] of Object.entries(piece)) if (typeof x === "number") out.set(`f.${k}.${f}`, x);
  for (const k of ["x", "y", "width", "height"] as const) out.set(`crop.${k}`, p.crop[k]);
  return out;
}

h.section("properties over seeded random pairs");
{
  const cases = Array.from({ length: 240 }, (_, i) => { const m = MANIFESTS[i % MANIFESTS.length]; return { m, pre: deepFreeze(randomEnd(m)), end: deepFreeze(randomEnd(m)), blend: chance(0.5) }; });
  deepFreeze(MANIFESTS.map((m) => m));
  const snapshot = show(cases.map((c) => [c.pre, c.end])), mSnap = show(MANIFESTS);
  const ts = [-0.3, -0.05, 0.01, 0.17, 0.33, 0.5, 0.5001, 0.71, 0.99, 1, 1.08, 1.4];
  const raws = [0.001, 0.2, 0.49, 0.5, 0.77, 0.999];
  let threw: unknown = null;
  const plans: ViewTweenPlan[] = [];
  try { for (const c of cases) plans.push(planViewTween(c.m, c.pre, c.end, { blend: c.blend })); } catch (e) { threw = e; }
  h.ok(threw === null, `planning never throws on frozen inputs${threw ? ` (${threw})` : ""}`);
  if (threw === null) {
    const ends = find(cases.keys(), (i) => {
      const { m, pre, end } = cases[i], p = plans[i];
      const s = p.frame(0.6, 0), e = p.frame(0.4, 1);
      return show(s.a) !== show({ view: resolveView(m, pre.view), crop: clampCrop(m, pre.crop) }) || show(e.a) !== show({ view: resolveView(m, end.view), crop: clampCrop(m, end.crop) }) || s.b !== null || e.b !== null || s.mix !== 0 || e.mix !== 0;
    });
    h.ok(ends === null, `exact ends: raw 0 is the start resolved, raw 1 the end resolved${ends !== null ? ` (case ${ends})` : ""}`);
    const det = find(cases.keys(), (i) => {
      const q = planViewTween(cases[i].m, cases[i].pre, cases[i].end, { blend: cases[i].blend });
      return ts.some((t) => raws.some((r) => show(q.frame(t, r)) !== show(plans[i].frame(t, r))));
    });
    h.ok(det === null, `deterministic: a second plan of the same ends gives the same frames${det !== null ? ` (case ${det})` : ""}`);
    let bad: string | null = null;
    for (let i = 0; i < cases.length && !bad; i++) for (const t of ts) for (const r of raws) {
      const f = plans[i].frame(t, r);
      const why = invalid(cases[i].m, f.a) ?? (f.b ? invalid(cases[i].m, f.b) : null) ?? invalid(cases[i].m, f.overlay);
      if (why) { bad = `case ${i} t=${t} raw=${r}: ${why}`; break; }
      if (!(f.mix >= 0 && f.mix <= 1) || (f.b === null && f.mix !== 0)) { bad = `case ${i}: mix ${f.mix}`; break; }
      if (f.blend && !(f.blend.weight > 0 && f.blend.weight <= 1 && Number.isInteger(f.blend.other))) { bad = `case ${i}: blend ${show(f.blend)}`; break; }
      if (Object.values(f.furnitureOpacity).some((o) => !(o! >= 0 && o! <= 1))) { bad = `case ${i}: furniture opacity ${show(f.furnitureOpacity)}`; break; }
      if (f.b && (show(f.a.view.index) !== show(f.b.view.index) || f.a.crop !== f.b.crop)) { bad = `case ${i}: a and b differ in position or frame`; break; }
    }
    h.ok(bad === null, `every frame (t in −0.3..1.4) is a valid resolved view: indices whole and in range, windows ordered, opacities 0..1, crop inside the image; mix and blend weight in 0..1${bad ? ` (${bad})` : ""}`);
    let mono: string | null = null;
    for (let i = 0; i < cases.length && !mono; i++) {
      const seq: Array<Map<string, number>> = [];
      for (let k = 0; k <= 60; k++) seq.push(numbers(plans[i].frame(k / 60, k / 60).a));
      for (const key of seq[0].keys()) {
        const xs = seq.map((s) => s.get(key)).filter((x): x is number => x !== undefined);
        if (xs.length !== seq.length) continue; // a furniture piece present at one end only
        let up = false, down = false;
        for (let k = 1; k < xs.length; k++) { const d = xs[k] - xs[k - 1], eps = 1e-9 * Math.max(1, Math.abs(xs[k])); if (d > eps) up = true; if (d < -eps) down = true; }
        if (up && down) { mono = `case ${i}: ${key} ${show(xs.map((x) => +x.toPrecision(6)))}`; break; }
      }
    }
    h.ok(mono === null, `under linear t every continuous number (positions, windows, gamma, opacities, stroke, fill, crop, furniture sizes) is monotone between its ends${mono ? ` (${mono})` : ""}`);
    h.ok(show(cases.map((c) => [c.pre, c.end])) === snapshot && show(MANIFESTS) === mSnap, "no input is mutated (inputs and manifests deep-frozen and unchanged)");
    const flags = find(cases.keys(), (i) => {
      const p = plans[i], fs = ts.flatMap((t) => raws.map((r) => p.frame(t, r)));
      if (!p.twoPictures && fs.some((f) => f.b !== null)) return true;
      if (p.twoPictures && fs.some((f) => f.b === null)) return true;
      return false;
    });
    h.ok(flags === null, `twoPictures says exactly whether in-between frames carry b${flags !== null ? ` (case ${flags})` : ""}`);
  }
}

h.section("viewPatch: a step's view is a patch over the view before it (B2)");
{
  // Hand cases first: what the patch says in words.
  const m2 = MANIFESTS.find((m) => m.channels.length >= 2) ?? M;
  const design: FluximgView = { channels: [{ color: "#00ffff" }, { range: [0, 900] }], projection: { dim: positionDims(m2)[0], mode: "max", from: 0, to: 2 } };
  const stepEnd: FluximgView = { channels: [{ color: "#00ffff" }, { range: [0, 500] }] };
  h.eq(viewPatch(design, stepEnd), { channels: [null, { range: [0, 500] }], projection: null },
    "a step that changes channel 2's window patches channel 2 only (channel 1's colour is not frozen) and clears a projection with null");
  h.eq(viewPatch(design, design), {}, "viewPatch(v, v) is {}");
  h.eq(viewPatch({ channels: [{ color: "#ff0000", range: [0, 9] }] }, {}), { channels: [{ color: null, range: null }] }, "a channel cleared entirely: a patch of nulls for each field it had");
  h.eq(viewPatch({ projection: { dim: "z", mode: "max", from: 0, to: 4 } }, { projection: { dim: "t", mode: "max", from: 1, to: 3 } }), { projection: { dim: "t", mode: "max", from: 1, to: 3 } }, "a projection is one value: restated whole");
  h.eq(viewPatch({ layers: { a: { lut: "magma" } } }, { layers: { a: { color: "#ff0000" } } }), { layers: { a: { lut: null, color: "#ff0000" } } }, "a layer's colour replacing its colour map");
  h.eq(viewPatch({}, { furniture: { scalebar: {} } }), { furniture: { scalebar: {} } }, "a piece switched on with defaults is stated as {}");
  h.eq(patchView(patchView(design, { channels: [{ color: "#ff00ff" }] }), viewPatch(design, stepEnd)).channels?.[0]?.color, "#ff00ff",
    "a Design edit of something the step does not touch carries through the step");

  // The law over seeded random pairs: patchView(before, viewPatch(before, after)) resolves to what after resolves to.
  const extra = (m: FluximgManifest, e: ViewEnd): FluximgView => {
    const v = structuredClone(e.view ?? {}) as FluximgView;
    const objectLayer = m.layers.find((l) => l.kind === "labels" && l.table);
    if (objectLayer && chance(0.4)) {
      v.layers = { ...(v.layers ?? {}), [objectLayer.id]: { ...(v.layers?.[objectLayer.id] ?? {}), styleBy: chance(0.5) ? { color: { column: pick(["area", "kind"]), ...(chance(0.5) ? { lut: pick(LUTS) } : {}) } } : { opacity: { column: "area", ...(chance(0.5) ? { range: [0, 1 + R() * 9] as [number, number] } : {}) } } } };
    }
    if (chance(0.2)) v.furniture = { ...(v.furniture ?? {}), names: {} };
    if (chance(0.2)) v.smooth = chance(0.5);
    if (chance(0.15)) delete v.channels;
    if (chance(0.15)) delete v.index;
    if (chance(0.1)) delete v.layers;
    return v;
  };
  const pairs = Array.from({ length: 400 }, (_, i) => {
    const m = MANIFESTS[i % MANIFESTS.length];
    return { m, before: extra(m, randomEnd(m)), after: extra(m, randomEnd(m)) };
  });
  const resolvedLaw = find(pairs.keys(), (i) => {
    const { m, before, after } = pairs[i];
    return show(resolveView(m, patchView(before, viewPatch(before, after)))) !== show(resolveView(m, after));
  });
  h.ok(resolvedLaw === null, `patchView(before, viewPatch(before, after)) resolves to exactly what after resolves to (400 seeded pairs over ${MANIFESTS.length} manifests)${resolvedLaw !== null ? ` (pair ${resolvedLaw}: ${show(pairs[resolvedLaw])})` : ""}`);
  const canon = (v: FluximgView): FluximgView => patchView(undefined, v);
  const structural = find(pairs.keys(), (i) => {
    const b = canon(pairs[i].before), a = canon(pairs[i].after);
    return show(sortKeys(patchView(b, viewPatch(b, a)))) !== show(sortKeys(a));
  });
  h.ok(structural === null, `and between stored (canonical) views it is exact, key for key${structural !== null ? ` (pair ${structural})` : ""}`);
  const empty = find(pairs.keys(), (i) => !isEmptyViewPatch(viewPatch(pairs[i].before, structuredClone(pairs[i].before))) || !isEmptyViewPatch(viewPatch(pairs[i].after, pairs[i].after)));
  h.ok(empty === null, `viewPatch(v, v) is empty for every random view${empty !== null ? ` (pair ${empty})` : ""}`);
  const chained = find(pairs.keys(), (i) => {
    if (i + 1 >= pairs.length || pairs[i + 1].m !== pairs[i].m) return false;
    const { m, before: v0, after: v1 } = pairs[i], v2 = pairs[i + 1].after;
    return show(resolveView(m, patchView(patchView(v0, viewPatch(v0, v1)), viewPatch(v1, v2)))) !== show(resolveView(m, v2));
  });
  h.ok(chained === null, `chained steps compose: step 2's patch over step 1's result gives step 2's view${chained !== null ? ` (pair ${chained})` : ""}`);
  const inLanguage = find(pairs.keys(), (i) => {
    const { m, before, after } = pairs[i];
    if (checkViewPatch(m, after).problems.length) return false;
    return checkViewPatch(m, viewPatch(before, after)).problems.length > 0;
  });
  h.ok(inLanguage === null, `the patch is in set-image-view's language: checkViewPatch accepts it whenever it accepts the end${inLanguage !== null ? ` (pair ${inLanguage}: ${show(checkViewPatch(pairs[inLanguage].m, viewPatch(pairs[inLanguage].before, pairs[inLanguage].after)).problems)})` : ""}`);
  const explicit = find(pairs.keys(), (i) => {
    const { m, after } = pairs[i], rv = resolveView(m, after);
    return show(resolveView(m, explicitView(rv))) !== show(rv);
  });
  h.ok(explicit === null, `explicitView: resolveView(m, explicitView(rv)) is rv${explicit !== null ? ` (pair ${explicit})` : ""}`);
}

h.section("one definition of the in-between: a slide sample is the player's frame (C1)");
{
  // lerpElement (and through it compile.sample) with the image's manifest gives, at every raw, the view the player draws.
  const { lerpElement } = await import("../src/lib/slide/tween");
  const el = (e: ViewEnd) => ({ type: "fluximg", id: "img", assetId: "a", x: 0, y: 0, width: 10, height: 10, rotation: 0, ...(e.view ? { view: e.view } : {}), ...(e.crop ? { crop: e.crop } : {}) }) as never;
  const cases = Array.from({ length: 200 }, (_, i) => { const m = MANIFESTS[i % MANIFESTS.length]; return { m, pre: randomEnd(m), end: randomEnd(m) }; });
  let bad: string | null = null;
  for (let i = 0; i < cases.length && !bad; i++) {
    const { m, pre, end } = cases[i], plan = planViewTween(m, pre, end);
    for (const raw of [0, 0.25, 0.5, 0.75, 1]) for (const t of [raw, easeInOut(raw)]) {
      const sampled = lerpElement(el(pre), el(end), t, raw, { fluximgManifest: m }) as unknown as { view?: FluximgView; crop?: PixelRect };
      const want = framePicture(plan.frame(t, raw));
      if (show(resolveView(m, sampled.view)) !== show(want.view)) { bad = `case ${i} raw ${raw} t ${t}: view`; break; }
      if (show(clampCrop(m, sampled.crop)) !== show(want.crop)) { bad = `case ${i} raw ${raw} t ${t}: crop ${show(sampled.crop)} vs ${show(want.crop)}`; break; }
    }
  }
  h.ok(bad === null, `200 seeded pairs × raw 0, 0.25, 0.5, 0.75, 1 (linear and eased): the sampled view and crop resolve to framePicture(planViewTween(...).frame(t, raw))${bad ? ` (${bad})` : ""}`);
  // The review's example: a Design view with no index, a step that sets t = 40. The player walks; so does the sample now.
  const mt = MANIFESTS.find((m) => positionDims(m).includes("t") && dimN(m, "t") > 1)!;
  const nT = dimN(mt, "t"), far = nT - 1;
  const walk = [0.1, 0.3, 0.5, 0.7, 0.9].map((r) => (lerpElement(el({}), el({ view: { index: { t: far } } }), r, r, { fluximgManifest: mt }) as unknown as { view: FluximgView }).view.index!.t!);
  h.ok(walk.every((x, k) => k === 0 || x >= walk[k - 1]) && walk[0] > 0 && walk[4] < far && new Set(walk).size >= 4, `a one-sided walk glides plane by plane in the sample, as in the player (${walk.join(", ")} of 0..${far})`);
  const fade = planViewTween(mt, { view: {} }, { view: { furniture: { scalebar: {} } } }).frame(0.3, 0.3);
  h.ok(fade.furnitureOpacity.scalebar !== undefined && framePicture(fade).view.furniture.scalebar === false && framePicture(planViewTween(mt, { view: {} }, { view: { furniture: { scalebar: {} } } }).frame(0.7, 0.7)).view.furniture.scalebar !== false,
    "framePicture: a fading furniture piece is in the one picture from half its opacity on");
}

h.section("upcoming: the pictures to decode ahead");
{
  const idx = (ps: TweenPicture[], d = "t"): number[] => ps.map((p) => p.view.index[d]);
  const p = plan(v({ index: { t: 0 } }), v({ index: { t: 10 } }));
  h.eq(idx(p.upcoming(0, 1, lin)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "forward, linear: every plane once, in order");
  h.eq(idx(p.upcoming(1, 0, lin)), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], "backward: in order of use");
  h.eq(idx(p.upcoming(0.5, 1, lin)), [5, 6, 7, 8, 9, 10], "from the middle");
  h.eq(idx(p.upcoming(0, 1, easeInOut)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "an eased curve visits the same planes");
  h.eq(idx(p.upcoming(0, 1, lin, 4)), [0, 1, 2, 3], "bounded by the limit");
  h.eq(p.upcoming(0, 1, lin, 0).length, 0, "limit 0: nothing");
  const big = plan(v({ index: { t: 0 } }), v({ index: { t: 400 } }));
  h.eq(big.upcoming(0, 1, lin).length, 64, "the default limit is 64");
  h.eq(idx(big.upcoming(0, 1, lin, 1000)), Array.from({ length: 401 }, (_, i) => i), "a 400-plane walk: all 401 planes, in order, with a large limit");
  const cont = plan(v({ channels: [{ range: [0, 10] }] }, { x: 0, y: 0, width: 20, height: 20 }), v({ channels: [{ range: [0, 99] }] }));
  h.eq(cont.upcoming(0, 1, lin).length, 1, "continuous-only changes yield just the first picture");
  const two = plan(v({ index: { z: 0 } }), v({ index: { z: 3 }, channels: [null, { visible: false }] }));
  const up = two.upcoming(0, 1, lin);
  h.eq(up.map((q) => `${q.view.index.z}${q.view.channels[1].visible ? "a" : "b"}`), ["0a", "0b", "1a", "1b", "2a", "2b", "3b"], "two pictures: both sides of each plane, a before b (the last plane is reached only at the end, which is b's)");
  const bl = plan(v({ index: { t: 0 } }), v({ index: { t: 4 } }), true);
  h.eq(idx(bl.upcoming(0, 1, lin)), [0, 1, 2, 3, 4], "a crossfade's neighbour planes are listed at their first use, deduplicated");
  const keys = big.upcoming(0, 1, lin, 1000).map((q) => q.view.index.t);
  h.ok(new Set(keys).size === keys.length, "no picture is listed twice");
  const proj = plan(v({ projection: { dim: "z", mode: "max", from: 0, to: 2 } }), v({ projection: { dim: "z", mode: "max", from: 3, to: 5 } }));
  h.eq(proj.upcoming(0, 1, lin).map((q) => `${q.view.projection!.from}-${q.view.projection!.to}`), ["0-2", "1-3", "2-4", "3-5"], "a sliding projection run: each run once");
}

h.section("the sparse recipe form (lerpFluximgView)");
{
  h.eq([lerpFluximgView(undefined, undefined, 0.5, 0.5), lerpFluximgView(null, undefined, 0.5, 0.5)], [undefined, undefined], "no view at either end: undefined");
  const a: FluximgView = { index: { t: 2 }, channels: [{ range: [0, 100] }] }, b: FluximgView = { index: { t: 12 }, channels: [{ range: [50, 300] }], smooth: true };
  h.eq([lerpFluximgView(a, b, 0.7, 0), lerpFluximgView(a, b, 0.3, 1)], [a, b], "exact ends (copies of the ends)");
  h.eq(lerpFluximgView(undefined, b, 0.5, 1), b, "…an end with a view, the other without");
  h.eq(lerpFluximgView(b, undefined, 0.5, 1), undefined, "…the end without a view: undefined");
  const mid = lerpFluximgView(a, b, 0.25, 0.4)!;
  h.eq([mid.index, mid.channels![0]!.range, mid.smooth], [{ t: 4 }, [12.5, 150], undefined], "positions step, windows lerp, a one-sided field steps at raw 0.5");
  h.eq(lerpFluximgView(a, b, 0.25, 0.6)!.smooth, true, "…and is the end's from raw 0.5");
  const ab = deepFreeze({ layers: { lines: { opacity: 0.2, styleBy: { color: "x" } } }, furniture: { scalebar: { thickness: 1 } }, background: "#000000" } as FluximgView);
  const bb = deepFreeze({ layers: { lines: { opacity: 0.6, styleBy: { color: "y" } } }, furniture: { scalebar: { thickness: 3 }, stamp: {} }, background: "#ffffff" } as FluximgView);
  const m2 = lerpFluximgView(ab, bb, 0.5, 0.4) as FluximgView & { layers: Record<string, { styleBy?: unknown; opacity?: number }> };
  h.eq([m2.layers.lines.opacity, m2.layers.lines.styleBy, (m2.furniture!.scalebar as { thickness: number }).thickness, m2.furniture!.stamp, m2.background], [0.4, { color: "x" }, 2, undefined, prepareColorLerp("#000000", "#ffffff")(0.5)], "layer numbers and piece sizes lerp, an unknown layer field steps, colours lerp, a one-sided piece steps");
  h.eq((lerpFluximgView({ solo: 0, composite: "single" }, { solo: 2, composite: "single" }, 0.5, 0.4) as FluximgView).solo, 0, "solo is a channel, not a number: it steps");

  // Agreement: both ends fully explicit, no discrete difference.
  let bad: string | null = null;
  for (let i = 0; i < 150 && !bad; i++) {
    const m = MANIFESTS[i % MANIFESTS.length];
    const pre = randomEnd(m, true);
    const end = randomEnd(m, true, pre.view!);
    end.crop = pre.crop;
    const p = planViewTween(m, pre, end);
    if (p.twoPictures) { bad = `case ${i}: the generator made a discrete difference ${show(describeViewChange(m, pre, end))}`; break; }
    for (const [t, raw] of [[0.13, 0.2], [0.5, 0.45], [0.5, 0.55], [0.91, 0.8], [1.2, 0.9], [-0.15, 0.1]]) {
      const sparse = resolveView(m, lerpFluximgView(pre.view, end.view, t, raw));
      const resolved = p.frame(t, raw).a.view;
      if (show(sparse) !== show(resolved)) { bad = `case ${i} t=${t} raw=${raw}: ${show(sparse).slice(0, 300)} vs ${show(resolved).slice(0, 300)}`; break; }
    }
  }
  h.ok(bad === null, `resolveView(lerpFluximgView(a, b)) equals planViewTween's frame for fully explicit ends with no discrete difference (positions, runs, windows, gamma, colours, layers, furniture; overshoot included)${bad ? ` (${bad})` : ""}`);
}

h.section("describeViewChange");
{
  const d = (pre: ViewEnd, end: ViewEnd, m: FluximgManifest | null = M) => describeViewChange(m ?? undefined, pre, end);
  const walk = d(v({ index: { t: 0 } }), v({ index: { t: 400 } }));
  h.eq(walk, [{ kind: "position", dim: "t", from: 0, to: 400, label: "t 0.00 s → 5.00 s" }], "a walk along time, in the axis' own words");
  h.eq(d(v({ index: { t: 0 } }), v({ index: { t: 400 } }), null), [{ kind: "position", dim: "t", from: 0, to: 400, label: "t 1 → 401" }], "…without a manifest: plane numbers");
  h.eq(d(v({}), v({ channels: [{ range: [0, 9] }] })).map((c) => c.label), ["channel 1 contrast"], "a contrast change");
  h.eq(d(v({}), v({}, { x: 10, y: 10, width: 20, height: 20 })).map((c) => c.label), ["zooms in"], "a crop on: zooms in");
  h.eq(d(v({}, { x: 10, y: 10, width: 20, height: 20 }), v({})).map((c) => c.label), ["zooms out"], "a crop off: zooms out");
  h.eq(d(v({}, { x: 0, y: 0, width: 20, height: 20 }), v({}, { x: 30, y: 10, width: 20, height: 20 })).map((c) => c.label), ["pans"], "the same size elsewhere: pans");
  h.eq(d(v({}), v({ layers: { footprints: { visible: false } } })).map((c) => c.label), ["footprints fade out"], "a layer switched off");
  h.eq(d(v({}), v({ layers: { lines: { visible: true } } }), null).map((c) => c.label), ["lines fade in"], "…switched on, without a manifest");
  h.eq(d(v({}), v({ furniture: { scalebar: {} } })).map((c) => c.label), ["scale bar on"], "a scale bar on");
  h.eq(d(v({}), v({ projection: { dim: "z", mode: "max", from: 0, to: 7 } })).map((c) => [c.kind, c.label]), [["projection", "max z on"]], "a projection on");
  h.eq(d(v({}), v({ channels: [null, { visible: false }] })).map((c) => [c.kind, c.label]), [["channel", "signal off"]], "a channel hidden, by its name");
  const many = d(v({ index: { z: 1 }, furniture: { stamp: {} } }), v({ index: { z: 5 }, channels: [{ range: [0, 9] }], layers: { footprints: { opacity: 0.3 } } }, { x: 0, y: 0, width: 30, height: 20 }));
  h.eq(many.map((c) => c.kind), ["position", "frame", "window", "layer", "furniture"], "several changes: one entry each, most telling first");
  h.eq(many[0], { kind: "position", dim: "z", from: 1, to: 5, label: "z 0.5 µm → 2.5 µm" }, "…a depth walk in µm");
  h.eq(d(v({}), v({})), [], "nothing changes: empty");
  h.eq(d(v({ index: { t: 0 } }), v({ index: { t: 0 }, channels: [] })), [], "a view that resolves the same: empty");
}

h.section("naturalDurationMs and the moved naturalRate");
{
  const ms = mk({ dims: ["t", "y", "x"], shape: [100, 4, 4], axes: { t: { unit: "ms", scale: 40 } } });
  h.eq(naturalDurationMs(M, "t", 0, 400), 5000, "time in seconds (12.5 ms frames): 400 planes take 5 s");
  h.eq(naturalDurationMs(M, "t", 400, 0), 5000, "…either direction");
  h.eq(naturalDurationMs(ms, "t", 0, 25), 1000, "time in ms (40 ms frames): 25 planes take 1 s");
  h.eq(naturalDurationMs(M, "z", 0, 6), 500, "depth: 12 planes a second (6 planes = 500 ms)");
  h.eq([naturalDurationMs(M, "z", 0, 6, 2), naturalDurationMs(M, "z", 0, 6, 0)], [250, 500], "speed divides; a non-positive speed is 1");
  h.eq([naturalRate(M, "t"), naturalRate(ms, "t"), naturalRate(M, "z")], [80, 25, 12], "naturalRate (moved to live/rail.ts) is unchanged");
}

h.section("cost of one frame");
{
  const pre: ViewEnd = { view: { index: { t: 0, z: 1 }, channels: [{ range: [0, 1000] }, { range: [10, 5000], norm: "log" }], layers: { activity: { visible: true, opacity: 0.4 }, footprints: { opacity: 1 }, lines: { visible: true, color: "#ff0000" } }, furniture: { scalebar: {}, stamp: {} } }, crop: { x: 0, y: 0, width: 60, height: 40 } };
  const end: ViewEnd = { view: { index: { t: 300, z: 5 }, channels: [{ range: [100, 600], color: "#00ff00" }, { range: [100, 9000], norm: "log", visible: false }], layers: { activity: { visible: true, opacity: 0.9 }, footprints: { opacity: 0.2, strokeWidth: 3 }, lines: { visible: false } }, furniture: { scalebar: { thickness: 3 }, colorbar: {} } }, crop: { x: 20, y: 10, width: 30, height: 20 } };
  const p = planViewTween(M, pre, end, { blend: true });
  h.ok(p.twoPictures && p.pixels && p.overlay, "the measured tween changes everything: positions, windows, colours, a channel switch, layer fades, furniture, the crop");
  let sink = 0;
  for (let i = 0; i < 20000; i++) sink += p.frame((i % 997) / 997, ((i % 997) + 0.5) / 998).mix;
  const N = 100000, t0 = performance.now();
  for (let i = 0; i < N; i++) sink += p.frame((i % 997) / 997, ((i % 997) + 0.5) / 998).mix;
  const us = ((performance.now() - t0) * 1000) / N;
  console.log(`  frame(): ${us.toFixed(2)} µs per call (2 channels, 5 layers, two pictures, blend) [${sink > 0 ? "ok" : ""}]`);
  h.ok(us < 250, `one frame costs well under the 0.25 ms bound (${us.toFixed(2)} µs; target < 50 µs)`);
}

await h.done(() => fsp.rm(tmp, { recursive: true, force: true }));
