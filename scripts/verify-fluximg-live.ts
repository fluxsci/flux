// fluximg live view, the pure half: rail geometry and playback (live/rail.ts), the channel histogram's geometry,
// the histogram of the pixels on screen, Auto ladder and wheel steps (live/histogram.ts), where the control board
// stands round the image (live/boardLayout.ts), where new panels go (panelLayout.ts), and the viewOps properties
// the board relies on (a patch that restores a default leaves no key behind).
//
// Pure tier. Hermetic: no files, no browser; stats are synthetic. Properties are checked over seeded random
// inputs as well as at the edges, so a regression shows as a counter-example with its numbers.
// Run: node --import tsx scripts/verify-fluximg-live.ts
import { harness } from "./lib/harness.mjs";
import {
  axisValue, framePeriod, niceStep, niceStride, playStep, profileLevel, profileShape, railIndex, railPos, railSpan, railTicks, resizeRun, slideRun, stepIndex,
  type PlayMode, type PlayState,
} from "../src/lib/fluximg/live/rail";
import { BOARD, boardLayout, type Box } from "../src/lib/fluximg/live/boardLayout";
import {
  AUTO_STEPS, autoStepOf, autoWindow, clippedShares, formatShare, histDomain, histogramPath, moveWindow, nextAutoStep, nudgeStep, shareBelow, snapValue, transferPath, valueToX, viewHistogram, xToValue,
} from "../src/lib/fluximg/live/histogram";
import { gridCells, insetLayout, splitLayout, type PanelBox } from "../src/lib/fluximg/panelLayout";
import { roundNeighbour } from "../src/lib/fluximg/furniture";
import { patchView, resolveView } from "../src/lib/fluximg/viewOps";
import type { FluximgManifest, FluximgStats } from "../src/lib/fluximg/types";
import type { FluximgView } from "../src/lib/fluximg/view";

const h = harness("verify-fluximg-live");

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = rng(20261119);
const int = (lo: number, hi: number): number => lo + Math.floor(R() * (hi - lo + 1));
/** Every number in an SVG path string. */
const numbers = (d: string): number[] => (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);
/** Path coordinates as [x, y] pairs (the paths here use absolute M / L only, plus a closing Z or a tiny relative l). */
function pairs(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}
/** The first counter-example of a property, or null. */
function find<T>(cases: Iterable<T>, bad: (c: T) => boolean): T | null { for (const c of cases) if (bad(c)) return c; return null; }
const show = (v: unknown): string => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------
h.section("rail: index <-> position along the track");
{
  // Each index owns an equal band; its centre maps back to it, and the ends are never cut off.
  const bad = find(Array.from({ length: 400 }, () => ({ n: int(1, 3000), extent: int(20, 1600) })), ({ n, extent }) => {
    for (const i of [0, 1, n - 2, n - 1, Math.floor(n / 2)]) {
      if (i < 0 || i >= n) continue;
      const p = railPos(i, n, extent);
      if (!(p > 0 && p < extent)) return true;
      if (railIndex(p, n, extent) !== i) return true;
    }
    return false;
  });
  h.ok(!bad, `railIndex(railPos(i)) = i, and every playhead is strictly inside the track${bad ? ` (counter-example ${show(bad)})` : ""}`);
  h.eq([railIndex(-50, 10, 200), railIndex(0, 10, 200), railIndex(200, 10, 200), railIndex(10_000, 10, 200)], [0, 0, 9, 9], "positions before / after the track clamp to the first / last index");
  h.eq([railIndex(80, 1, 200), railIndex(80, 0, 200), railIndex(80, 10, 0)], [0, 0, 0], "one plane, no planes or no track: index 0");
  h.eq(railPos(0, 0, 200), 0, "railPos with no planes is 0 (not NaN)");
  h.eq(railPos(0, 7, 280), 20, "first plane of 7 on 280 px: centre of its 40 px band");
  h.eq(railPos(6, 7, 280), 260, "last plane of 7 on 280 px: centre of its band");
  h.eq(railSpan(2, 5, 10, 200), { start: 40, end: 100 }, "a run's band covers its planes' bands exactly");
  h.eq(railSpan(5, 2, 10, 200), { start: 40, end: 100 }, "a reversed run spans the same band");
  h.eq(railSpan(-3, 40, 10, 200), { start: 0, end: 200 }, "a run past the ends is clamped to the track");
  h.eq([stepIndex(0, -1, 7), stepIndex(6, 1, 7), stepIndex(3, 10, 7), stepIndex(3, -10, 7), stepIndex(2.6, 0, 7), stepIndex(0, 1, 0)], [0, 6, 6, 0, 3, 0], "stepIndex stays inside the dimension (and rounds)");
}

h.section("rail: ticks");
{
  h.eq([niceStride(0), niceStride(1), niceStride(1.01), niceStride(2), niceStride(3), niceStride(7), niceStride(11), niceStride(260)], [1, 1, 2, 2, 5, 10, 20, 500], "niceStride is the smallest 1-2-5 x 10^n at least the minimum");
  const bad = find(Array.from({ length: 300 }, () => ({ n: int(1, 20000), extent: int(30, 1400), gap: [30, 54][int(0, 1)] })), ({ n, extent, gap }) => {
    const t = railTicks(undefined, n, extent, String, gap);
    if (!t.length || t[0].index !== 0) return true;
    for (let i = 1; i < t.length; i++) if (t[i].pos - t[i - 1].pos < gap - 1e-6 || t[i].index <= t[i - 1].index) return true;
    return t.some((k) => k.index >= n || k.pos <= 0 || k.pos >= extent);
  });
  h.ok(!bad, `ticks start at the first plane, are evenly strided, at least minGap apart and inside the track${bad ? ` (counter-example ${show(bad)})` : ""}`);
  const t7 = railTicks(undefined, 7, 330, String, 30);
  h.eq(t7.map((k) => k.label), ["1", "2", "3", "4", "5", "6", "7"], "a count axis labels planes 1-based");
  const zAxis = { unit: "µm", coords: [-61.5, -60.5, -59.5, -58.5, -57.5, -56.5, -55.5] };
  h.eq(railTicks(zAxis, 7, 330, (v) => String(v), 30).map((k) => k.label), zAxis.coords.map(String), "explicit coordinates label the ticks (the unit is printed once, not per tick)");
  h.eq(railTicks({ unit: "s", scale: 0.0125 }, 24, 120, (v) => v.toFixed(3), 54).map((k) => k.label), ["0.000", "0.200"], "an evenly spaced axis is ticked at round values (0.2 s apart here, never every 20th frame = 0.25 s)");
  h.eq(railTicks({ unit: "s", scale: 0.0125 }, 816, 574, String, 58).map((k) => k.label), ["0", "2", "4", "6", "8", "10"], "an 80 Hz movie of 10.2 s reads 0, 2, 4 … 10 s");
  h.eq(railTicks({ unit: "µm", scale: 1.5, offset: -50.5 }, 21, 400, String, 30).map((k) => k.label), ["-50", "-45", "-40", "-35", "-30", "-25"], "an offset axis is ticked at round VALUES, not at the first plane");
  h.eq(railTicks({ unit: "µm", scale: -2, offset: 10 }, 6, 300, String, 54).map((k) => k.label), ["0", "5", "10"], "a descending axis is ticked at round values too");
  h.eq([niceStep(0.135), niceStep(1), niceStep(1.01), niceStep(0.0049), niceStep(37), niceStep(0)], [0.2, 1, 2, 0.005, 50, 1], "niceStep is the smallest 1-2-5 x 10^n at least the minimum, at any magnitude");
  {
    const bad = find(Array.from({ length: 300 }, () => ({ n: int(2, 5000), extent: int(60, 1400), scale: (R() < 0.2 ? -1 : 1) * Math.pow(10, R() * 6 - 4), offset: (R() - 0.5) * 100, gap: [30, 58][int(0, 1)] })), ({ n, extent, scale, offset, gap }) => {
      const t = railTicks({ unit: "u", scale, offset }, n, extent, String, gap);
      if (!t.length) return true;
      const sorted = t.map((k) => k.pos).sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] < gap - 1e-6) return true;
      return sorted[0] < -1e-6 || sorted[sorted.length - 1] > extent + 1e-6;
    });
    h.ok(!bad, `round-value ticks are at least minGap apart and inside the track, for any scale, offset and direction${bad ? ` (counter-example ${show(bad)})` : ""}`);
  }
  h.eq(railTicks({ labels: ["ctrl", "drug", "wash"] }, 3, 300, String, 54).map((k) => k.label), ["ctrl", "drug", "wash"], "a categorical dimension labels by name");
  h.eq([axisValue(undefined, 2), axisValue({ unit: "s", scale: 2, offset: 1 }, 3), axisValue({ coords: [5, 9] }, 1), axisValue({ labels: ["a"] }, 0)], [null, 7, 9, null], "axisValue: none, scale + offset, coords, categorical");
  h.eq(railTicks(undefined, 0, 300, String), [], "no planes, no ticks");
  h.eq(railTicks(undefined, 10, 0, String), [], "no track, no ticks");
}

h.section("rail: the profile plot");
{
  const inside = (d: string, extent: number, across: number, vertical: boolean): boolean => pairs(d).every(([x, y]) => {
    const [a, c] = vertical ? [y, x] : [x, y];
    return a >= -1e-9 && a <= extent + 1e-9 && c >= -1e-9 && c <= across + 1e-9;
  });
  const bad = find(Array.from({ length: 200 }, () => {
    const n = int(1, 5000), extent = int(20, 900), vertical = R() < 0.5;
    const values = Array.from({ length: n }, (_, i) => (R() < 0.05 ? null : Math.sin(i / 7) * 1000 + R() * 50 - 3000));
    return { n, extent, vertical, values };
  }), ({ extent, vertical, values }) => !inside(profileShape(values, extent, 26, vertical).d, extent, 26, vertical));
  h.ok(!bad, `every profile point lies inside the track box, both orientations${bad ? ` (counter-example n=${bad.n} extent=${bad.extent} vertical=${bad.vertical})` : ""}`);
  const few = profileShape([1, 2, 3, 4], 200, 26, false);
  h.ok(!few.envelope && /^M/.test(few.d) && (few.d.match(/L/g) ?? []).length === 3, "fewer planes than pixels: one polyline point per plane");
  const many = profileShape(Array.from({ length: 10_000 }, (_, i) => (i === 7777 ? 100 : 0)), 300, 26, false);
  h.ok(many.envelope, "more planes than pixels: a min/max envelope");
  h.ok(pairs(many.d).some(([, y]) => y < 5), "a single spike in 10,000 frames still reaches the top of the envelope");
  h.ok((many.d.match(/Z/g) ?? []).length === 1, "one band per run of columns with data");
  const gapped = profileShape(Array.from({ length: 3000 }, (_, i) => (i >= 1000 && i < 1500 ? null : i)), 300, 26, false);
  h.eq((gapped.d.match(/Z/g) ?? []).length, 2, "a stretch of planes without data splits the envelope in two");
  const broken = profileShape([1, 2, null, 4, 5], 200, 26, false);
  h.eq((broken.d.match(/M/g) ?? []).length, 2, "a plane without data breaks the line");
  // The dot that rides a trace at the playhead sits exactly on the trace.
  {
    const values = [3, 9, null, 5, 1], d = pairs(profileShape(values, 200, 30, false).d), dv = pairs(profileShape(values, 200, 30, true).d);
    h.eq([0, 1, 3, 4].map((i) => profileLevel(values, i, 30, false)), d.map((q) => q[1]), "a lying rail's dot is at the trace's own height for that plane");
    h.eq([0, 1, 3, 4].map((i) => profileLevel(values, i, 30, true)), dv.map((q) => q[0]), "a standing rail's dot is at the trace's own distance across the well");
    h.eq([profileLevel(values, 2, 30, false), profileLevel([], 0, 30, false), profileLevel([null], 0, 30, false)], [null, null, null], "a plane without data has no dot");
  }
  h.eq(profileShape([null, null], 200, 26, false).d, "", "no data at all: nothing drawn");
  h.eq(profileShape([], 200, 26, false).d, "", "no planes: nothing drawn");
  const one = profileShape([42], 200, 26, true);
  h.ok(one.d.startsWith("M") && one.d.includes("l"), "a single plane draws a short tick, not an empty path");
  const flat = profileShape([5, 5, 5], 90, 26, false);
  h.ok(pairs(flat.d).every(([, y]) => y === 23), "constant values sit on the baseline (no division by zero)");
  const v = profileShape([0, 10], 100, 26, true);
  const [[x0], [x1]] = pairs(v.d);
  h.ok(x1 > x0, "vertical rails grow their values to the right");
  const hz = profileShape([0, 10], 100, 26, false);
  const [[, y0], [, y1]] = pairs(hz.d);
  h.ok(y1 < y0, "horizontal rails grow their values upward");
}

h.section("rail: projection runs (resize about the middle, slide, clamps)");
{
  h.eq(resizeRun(3, 4, 1, 7), [2, 5], "grow one plane each side");
  h.eq(resizeRun(2, 5, -1, 7), [3, 4], "shrink one plane each side");
  h.eq(resizeRun(3, 4, -5, 7), [3, 4], "never below one plane");
  h.eq(resizeRun(0, 7, 3, 7), [0, 7], "never outside the dimension");
  h.eq(resizeRun(0, 2, 2, 7), [0, 4], "at the start the run grows only where there is room");
  const badR = find(Array.from({ length: 2000 }, () => { const n = int(1, 60), f = int(0, n - 1), t = int(f + 1, n); return { n, f, t, s: int(-80, 80) }; }), ({ n, f, t, s }) => {
    const [a, b] = resizeRun(f, t, s, n);
    return !(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b <= n && b - a >= 1);
  });
  h.ok(!badR, `resizeRun always returns a valid run of at least one plane${badR ? ` (counter-example ${show(badR)})` : ""}`);
  const badS = find(Array.from({ length: 2000 }, () => { const n = int(1, 60), f = int(0, n - 1), t = int(f + 1, n); return { n, f, t, s: int(-80, 80) }; }), ({ n, f, t, s }) => {
    const [a, b] = slideRun(f, t, s, n);
    return !(a >= 0 && b <= n && b - a === t - f);
  });
  h.ok(!badS, `slideRun keeps the run's length and stays inside${badS ? ` (counter-example ${show(badS)})` : ""}`);
  h.eq(slideRun(5, 7, 10, 7), [5, 7], "a run at the end does not slide further");
  h.eq(slideRun(1, 3, -5, 7), [0, 2], "a run slides to the start and stops");
}

h.section("rail: playback over long advances");
{
  const single = (s: PlayState, n: number, mode: PlayMode, k: number): PlayState => { let x = s; for (let i = 0; i < k && !x.done; i++) x = playStep(x, 1, n, mode); return x; };
  for (const mode of ["loop", "bounce", "once"] as const) {
    const bad = find(Array.from({ length: 600 }, () => { const n = int(2, 40); return { n, i: int(0, n - 1), dir: (mode === "bounce" && R() < 0.5 ? -1 : 1) as 1 | -1, k: int(1, 500) }; }), ({ n, i, dir, k }) => {
      const s: PlayState = { index: i, direction: dir, done: false };
      const a = playStep(s, k, n, mode), b = single(s, n, mode, k);
      return a.index !== b.index || (mode !== "once" && a.direction !== b.direction) || a.done !== b.done || a.index < 0 || a.index >= n;
    });
    h.ok(!bad, `${mode}: one long advance lands where that many single steps do${bad ? ` (counter-example ${show(bad)})` : ""}`);
  }
  h.eq(playStep({ index: 6, direction: 1, done: false }, 1, 7, "loop").index, 0, "loop wraps to the first plane");
  h.eq(playStep({ index: 6, direction: 1, done: false }, 1, 7, "bounce"), { index: 5, direction: -1, done: false }, "bounce turns at the last plane");
  h.eq(playStep({ index: 0, direction: -1, done: false }, 1, 7, "bounce"), { index: 1, direction: 1, done: false }, "bounce turns at the first plane");
  h.eq(playStep({ index: 5, direction: 1, done: false }, 9, 7, "once"), { index: 6, direction: 1, done: true }, "once stops on the last plane and says so");
  h.eq(playStep({ index: 0, direction: 1, done: false }, 3, 1, "loop").done, true, "one plane: nothing to play");
  h.eq(playStep({ index: 2, direction: 1, done: false }, 0, 7, "loop"), { index: 2, direction: 1, done: false }, "no advance, no change");
}

h.section("rail: frame period of a time axis");
{
  h.eq(framePeriod({ unit: "s", scale: 0.0125 }), 0.0125, "seconds with a scale");
  h.eq(framePeriod({ unit: "ms", scale: 40 }), 0.04, "milliseconds convert to seconds");
  h.eq(framePeriod({ unit: "min", scale: 0.5 }), 30, "minutes convert to seconds");
  h.eq(framePeriod({ unit: "h", scale: 1 }), 3600, "hours convert to seconds");
  h.eq(framePeriod({ unit: "s", coords: [0, 0.5, 1, 1.5] }), 0.5, "coordinates give their mean spacing");
  h.eq([framePeriod({ unit: "µm", scale: 0.5 }), framePeriod({ scale: 1 }), framePeriod(undefined), framePeriod({ unit: "s", scale: 0 }), framePeriod({ unit: "s", coords: [3, 2, 1] }), framePeriod({ unit: "s" })], [null, null, null, null, null, null], "not time, no unit, no axis, zero or decreasing spacing, no spacing: null");
}

// ---------------------------------------------------------------------------------------------
function stats(lo: number, hi: number, over: Partial<FluximgStats> = {}): FluximgStats {
  const counts = Array.from({ length: 256 }, (_, i) => Math.round(1000 * Math.exp(-i / 30)) + int(0, 5));
  return { count: 1e5, min: lo - (hi - lo) * 0.1, max: hi + (hi - lo) * 0.2, percentiles: { "0.1": lo, "1": lo + (hi - lo) * 0.02, "50": (lo + hi) / 2, "99": lo + (hi - lo) * 0.9, "99.8": lo + (hi - lo) * 0.97, "99.9": hi }, hist: { lo, hi, counts }, ...over };
}

h.section("histogram: the control's domain holds both handles");
{
  const bad = find(Array.from({ length: 3000 }, () => {
    const lo = (R() - 0.5) * 10 ** int(-3, 6), span = 10 ** int(-4, 6) * (0.1 + R());
    const s = stats(lo, lo + span);
    const a = lo + (R() * 6 - 2.5) * span, b = lo + (R() * 6 - 2.5) * span;
    return { s, range: [a, b] as [number, number] };
  }), ({ s, range }) => {
    const d = histDomain(s, range);
    const a = Math.min(...range), b = Math.max(...range);
    return !(d.hi > d.lo && d.lo <= a && d.hi >= b && d.lo <= s.hist.lo && d.hi >= s.hist.hi);
  });
  h.ok(!bad, `histDomain always contains both handles and the histogram, and is never empty${bad ? ` (counter-example range ${show(bad.range)} hist ${bad.s.hist.lo}..${bad.s.hist.hi})` : ""}`);
  const d = histDomain(stats(0, 100), [-50, 400]);
  h.ok(d.lo < -50 && d.hi > 400, "a handle outside the histogram gets room past it (it can still be dragged outward)");
  h.eq(histDomain(stats(0, 100), [10, 90]), { lo: 0, hi: 100 }, "handles inside: the histogram's own range");
  h.eq(histDomain({ count: 0, min: NaN, max: NaN, percentiles: {}, hist: undefined as never }, [0.2, 0.8]), { lo: 0, hi: 1 }, "no statistics at all: 0..1");
  const flat = histDomain({ count: 9, min: 7, max: 7, percentiles: {}, hist: { lo: 7, hi: 7, counts: [9] } }, [7, 8]);
  h.ok(flat.hi > flat.lo && flat.lo <= 7 && flat.hi >= 8, "a constant channel still gets a non-empty domain holding its window");
  const badX = find(Array.from({ length: 500 }, () => ({ lo: R() * 100 - 50, span: R() * 1000 + 1e-3, v: R() * 2000 - 1000, w: int(10, 800) })), ({ lo, span, v, w }) => {
    const dd = { lo, hi: lo + span };
    return Math.abs(xToValue(valueToX(v, dd, w), dd, w) - v) > 1e-9 * Math.max(1, Math.abs(v), span);
  });
  h.ok(!badX, "valueToX and xToValue are inverses");
}

h.section("histogram: path geometry stays inside the box");
{
  const bad = find(Array.from({ length: 400 }, () => {
    const lo = R() * 1000, s = stats(lo, lo + R() * 5000 + 1);
    const width = int(40, 600), height = int(20, 200), scale = (R() < 0.5 ? "log" : "linear") as "log" | "linear";
    const range: [number, number] = [lo + (R() - 0.5) * 8000, lo + R() * 8000];
    return { s, width, height, scale, range };
  }), ({ s, width, height, scale, range }) => {
    const d = histDomain(s, range);
    const area = histogramPath(s.hist, d, width, height, scale);
    const curve = range[1] > range[0] ? transferPath(range, "gamma", 0.6, d, width, height) : "";
    const ok = (p: string): boolean => pairs(p).every(([x, y]) => x >= -0.01 && x <= width + 0.01 && y >= -0.01 && y <= height + 0.01);
    return !area || !ok(area) || !ok(curve) || !pairs(area).every(([, y]) => y >= 2 - 0.01);
  });
  h.ok(!bad, `histogram and transfer paths lie inside width x height, the area leaves 2 px headroom${bad ? ` (counter-example width=${bad.width} height=${bad.height} range=${show(bad.range)})` : ""}`);
  const s = stats(0, 255);
  h.eq(histogramPath({ lo: 0, hi: 0, counts: [1] }, { lo: 0, hi: 1 }, 100, 50), "", "an empty histogram range draws nothing");
  h.eq(histogramPath({ lo: 0, hi: 1, counts: [0, 0] }, { lo: 0, hi: 1 }, 100, 50), "", "all-zero counts draw nothing");
  h.eq(histogramPath(s.hist, { lo: 0, hi: 255 }, 0, 50), "", "no width draws nothing");
  const narrow = histogramPath(s.hist, { lo: 0, hi: 255 }, 64, 50);
  h.ok(pairs(narrow).length <= 2 * 64 + 4, "bins narrower than a pixel merge (no more than two points per pixel column)");
  h.eq(transferPath([5, 5], "linear", 1, { lo: 0, hi: 10 }, 100, 50), "", "an empty window draws no curve");
  const lin = pairs(transferPath([2, 8], "linear", 1, { lo: 0, hi: 10 }, 100, 50));
  h.ok(lin[0][1] === 50 && lin[lin.length - 1][1] === 0 && lin[lin.length - 1][0] === 100, "the curve starts at black and ends at white across the whole control");
  const logBad = pairs(transferPath([0, 8], "log", 1, { lo: 0, hi: 10 }, 100, 50));
  h.ok(logBad.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), "a log window touching zero falls back to linear (no NaN in the curve)");
}

h.section("histogram: Auto ladder");
{
  const s = stats(100, 4000);
  const w = AUTO_STEPS.map((_, i) => autoWindow(s, i));
  h.eq(w[0], [s.percentiles["0.1"], s.percentiles["99.9"]], "Auto step 1: 0.1 .. 99.9 %");
  h.eq(w[1], [s.percentiles["1"], s.percentiles["99.8"]], "Auto step 2: 1 .. 99.8 %");
  h.eq(w[2], [s.percentiles["1"], s.percentiles["99"]], "Auto step 3: 1 .. 99 %");
  h.eq(w[3], [s.min, s.max], "Auto step 4: the full data range");
  h.eq(autoWindow(s, 4), w[0], "the ladder wraps");
  h.eq(autoWindow(s, -1), w[3], "negative steps wrap too");
  h.eq(w.map((r) => autoStepOf(s, r)), [0, 1, 2, 3], "autoStepOf finds each rung");
  h.eq(autoStepOf(s, [1, 2]), -1, "a hand-set window is no rung");
  h.eq(autoWindow({ ...s, percentiles: {} }, 0), [s.min, s.max], "missing percentiles fall back to the full range");
  h.eq(autoWindow({ ...s, min: 5, max: 5, percentiles: {} }, 3), [5, 6], "a constant channel gets a one-unit window");
  // The ladder must always MOVE: pressing Auto again changes the window until the full range, then starts over, even
  // when two rungs give the same window (common for 8-bit data: 1 % and 0.1 % are both 0).
  const ladder = (st: FluximgStats, start: [number, number], presses: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let r = start;
    for (let i = 0; i < presses; i++) { r = autoWindow(st, nextAutoStep(st, r)); out.push(r); }
    return out;
  };
  const seq = ladder(s, [0, 1], 5);
  h.eq(seq, [w[0], w[1], w[2], w[3], w[0]], "from a hand-set window, Auto walks the ladder in order and wraps");
  const dup = { ...stats(0, 255), min: 0, max: 255, percentiles: { "0.1": 0, "1": 3, "50": 40, "99": 200, "99.8": 200, "99.9": 255 } };
  const dupSeq = ladder(dup, [0, 255], 4);
  const moved = dupSeq.every((r, i) => JSON.stringify(r) !== JSON.stringify(i ? dupSeq[i - 1] : [0, 255]));
  h.ok(moved, `rungs that coincide are skipped: every press changes the window (8-bit ladder ${show(dupSeq)})`);
  h.ok(dupSeq.some((r) => r[0] === 3 && r[1] === 200), "the tight rung is still reached when its neighbours coincide");
  const allSame = { ...stats(0, 255), min: 0, max: 255, percentiles: { "0.1": 0, "1": 0, "99": 255, "99.8": 255, "99.9": 255 } };
  h.eq(autoWindow(allSame, nextAutoStep(allSame, [0, 255])), [0, 255], "when every rung is the same window, Auto keeps it (and does not loop forever)");
}

h.section("histogram: wheel steps and handle moves");
{
  const bad = find(Array.from({ length: 3000 }, () => { const lo = (R() - 0.5) * 10 ** int(-2, 6); return { d: { lo, hi: lo + 10 ** int(-6, 7) * (0.1 + R() * 9.9) } }; }), ({ d }) => {
    const s = nudgeStep(d, false), p = Math.pow(10, Math.floor(Math.log10(s) + 1e-9)), m = Math.round((s / p) * 1e6) / 1e6;
    const raw = (d.hi - d.lo) / 100;
    return ![1, 2, 5].includes(m) || s < raw / 2.5 || s > raw * 2.5;
  });
  h.ok(!bad, `a float notch is 1, 2 or 5 x 10^n, within a factor 2.5 of a hundredth of the span${bad ? ` (counter-example ${show(bad.d)} -> ${nudgeStep(bad.d, false)})` : ""}`);
  h.eq([nudgeStep({ lo: 0, hi: 10 }, true), nudgeStep({ lo: 0, hi: 65535 }, true), nudgeStep({ lo: 0, hi: 255 }, true), nudgeStep({ lo: 0, hi: 0.5 }, true)], [1, 500, 2, 1], "integer data: a notch is a whole number, never below 1");
  h.eq(nudgeStep({ lo: 0, hi: 0 }, false), 0.01, "an empty span still steps");
  h.eq(nudgeStep({ lo: 0, hi: 0.3 }, false), 0.002, "0.3 span: 0.002 per notch, not 0.0030000000000000005");
  const badW = find(Array.from({ length: 4000 }, () => { const a = R() * 100, b = a + R() * 100 + 1e-3; return { r: [a, b] as [number, number], which: int(0, 1) as 0 | 1, delta: (R() - 0.5) * 400, gap: R() < 0.5 ? 1 : 1e-3 }; }), ({ r, which, delta, gap }) => {
    const [b, w] = moveWindow(r, which, delta, gap);
    return !(w - b >= gap - 1e-9) || (which === 0 ? w !== r[1] : b !== r[0]);
  });
  h.ok(!badW, `moving one handle never crosses the other (and leaves it where it was)${badW ? ` (counter-example ${show(badW)})` : ""}`);
  h.eq(moveWindow([10, 20], 2, 5, 1), [15, 25], "sliding the window keeps its width");
  h.eq([snapValue(12.6, { lo: 0, hi: 100 }, true), snapValue(0.123456, { lo: 0, hi: 1 }, false), snapValue(1234.5678, { lo: 0, hi: 5000 }, false)], [13, 0.123, 1235], "snapValue: integers, or 4 significant steps of the span");
}

// ---------------------------------------------------------------------------------------------
h.section("viewOps: a patch that restores a default leaves no key");
{
  const manifest: FluximgManifest = {
    fluximg: 1, name: "t",
    pixels: { dims: ["t", "c", "z", "y", "x"], shape: [5, 2, 7, 8, 8], dtype: "uint16", encoding: { kind: "exact" }, chunks: [1, 1, 1, 8, 8], levels: [{ path: "0", downsample: 1, shape: [5, 2, 7, 8, 8] }] },
    channels: [0, 1].map((i) => ({ name: `c${i}`, color: i ? "#00ff00" : "#ff00ff", range: [0, 100] as [number, number], stats: stats(0, 100) })),
    layers: [{ kind: "vector", id: "v", name: "v", count: 1, path: "layers/v.svg", visible: true }],
  } as unknown as FluximgManifest;
  const set: Array<[string, FluximgView, FluximgView]> = [
    ["smooth", { smooth: true }, { smooth: null as never }],
    ["composite + solo", { composite: "single", solo: 1 }, { composite: null as never, solo: null as never }],
    ["index", { index: { z: 2, t: 4 } }, { index: { z: null as never, t: null as never } }],
    ["projection", { projection: { dim: "z", mode: "max", from: 0, to: 7 } }, { projection: null }],
    ["a channel's window", { channels: [null, { range: [3, 40] }] as never }, { channels: [null, { range: null }] as never }],
    ["a channel's whole override (reset)", { channels: [{ range: [1, 2], color: "#123456", norm: "gamma", gamma: 0.5, invert: true, visible: false }] }, { channels: [{ range: null, color: null, lut: null, norm: null, gamma: null, invert: null, visible: null }] as never }],
    ["gamma back to 1", { channels: [{ norm: "gamma", gamma: 0.7 }] }, { channels: [{ gamma: null, norm: null }] as never }],
    ["scale bar", { furniture: { scalebar: {} } }, { furniture: { scalebar: null } as never }],
    ["every annotation", { furniture: { scalebar: {}, stamp: {}, channelLabels: {}, colorbar: {} } }, { furniture: { scalebar: null, stamp: null, channelLabels: null, colorbar: null } as never }],
    ["names", { furniture: { names: { layers: ["v"] } } }, { furniture: { names: null } as never }],
    ["a layer's override", { layers: { v: { opacity: 0.4, color: "#ffffff" } } }, { layers: { v: null } as never }],
    ["the layer order", { layerOrder: ["v"] }, { layerOrder: [] }],
  ];
  for (const [what, on, off] of set) {
    const v1 = patchView({}, on), v2 = patchView(v1, off);
    h.ok(Object.keys(v1).length > 0 && JSON.stringify(v2) === "{}", `${what}: set, then cleared, is {} (got ${show(v2)})`);
  }
  const before: FluximgView = { smooth: true, index: { z: 2 } };
  const copy = structuredClone(before);
  patchView(before, { index: { z: 5 }, smooth: null as never });
  h.eq(before, copy, "patchView never mutates its input");
  h.eq(patchView({ channels: [{ range: [1, 2] }, { range: [3, 4] }] }, { channels: [{ range: null }] as never }), { channels: [null, { range: [3, 4] }] }, "clearing channel 1 keeps channel 2 (a hole stays a hole)");
  h.eq(patchView({ channels: [{ color: "#ff0000" }] }, { channels: [{ lut: "viridis" }] }), { channels: [{ lut: "viridis" }] }, "a colour map replaces a colour (they exclude each other)");
  const rv = resolveView(manifest, patchView({}, { furniture: { scalebar: {} } }));
  h.ok(rv.furniture.scalebar !== false, "an empty furniture object means 'on, with defaults'");
  h.eq(resolveView(manifest, {}).index, { t: 0, z: 3 }, "z defaults to the middle plane, other dimensions to the first");
  h.eq(resolveView(manifest, { channels: [{ range: [5, 5] }] }).channels[0].range, [0, 100], "an empty window is invalid and falls back to the default (callers must never write one)");
}

// ---------------------------------------------------------------------------------------------
// What a window clips (the share each point's field prints), from the manifest's histogram
// ---------------------------------------------------------------------------------------------
{
  // A flat histogram over 100 .. 1100 (the 0.1 and 99.9 percentiles), true extremes 0 and 4095.
  const flat: FluximgStats = { count: 1e6, min: 0, max: 4095, percentiles: { "0.1": 100, "99.9": 1100 }, hist: { lo: 100, hi: 1100, counts: new Array(256).fill(1000) } };
  const near = (a: number | null, b: number, tol = 1e-9): boolean => a !== null && Math.abs(a - b) <= tol;
  h.ok(near(shareBelow(flat, 100), 0.001), "at the histogram's foot a tenth of a percent lies below (the lower tail)");
  h.ok(near(shareBelow(flat, 1100), 0.999), "at its head a tenth of a percent lies above (the upper tail)");
  h.ok(near(shareBelow(flat, 600), 0.5), "the middle of a flat histogram is the median");
  h.ok(near(shareBelow(flat, 0), 0) && near(shareBelow(flat, -50), 0), "nothing lies below the data's minimum");
  h.ok(near(shareBelow(flat, 4095), 1) && near(shareBelow(flat, 1e6), 1), "everything lies at or below the data's maximum");
  h.ok(near(shareBelow(flat, 50), 0.0005), "the lower tail is spread evenly out to the minimum");
  const bad = find(Array.from({ length: 400 }, () => [R() * 5000 - 400, R() * 5000 - 400] as [number, number]), ([a, b]) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), sa = shareBelow(flat, lo), sb = shareBelow(flat, hi);
    return sa === null || sb === null || sa < 0 || sb > 1 || sa > sb + 1e-12;
  });
  h.ok(bad === null, `the share below a value is within 0 .. 1 and never falls as the value rises${bad ? ` (counter-example ${show(bad)})` : ""}`);
  const c = clippedShares(flat, [350, 850]);
  h.ok(!!c && near(c.black, 0.001 + 0.998 * 0.25) && near(c.white, 0.001 + 0.998 * 0.25), "a window over the middle half of a flat histogram clips a quarter at each end");
  h.eq(clippedShares(flat, [0, 4095]), { black: 0, white: 0 }, "the full data range clips nothing");
  h.eq(clippedShares({ ...flat, hist: { lo: 0, hi: 0, counts: [] } }, [0, 1]), null, "no histogram: no share is claimed");
  h.eq([0, 0.0004, 0.004, 0.0149, 0.1234, 0.9995, 1].map(formatShare), ["0 %", "<0.1 %", "0.4 %", "1.5 %", "12 %", ">99.9 %", "100 %"], "shares print short: one decimal under ten percent, a bound at the extremes");
  // The default scale spans the rarest occupied bin to the commonest: an image whose every bin holds thousands of
  // pixels still has a shape (a plain log scale, measured from a count of 1, draws it as a block).
  const dense: FluximgStats = { ...flat, hist: { lo: 100, hi: 1100, counts: Array.from({ length: 256 }, (_, i) => Math.round(400000 * Math.exp(-i / 90)) + 20000) } };
  const tail = (scale: "span" | "log"): number => { const ys = pairs(histogramPath(dense.hist, histDomain(dense, [100, 1100]), 256, 100, scale)).map((q) => q[1]); return ys[ys.length - 3]; };
  h.ok(tail("log") < 30 && tail("span") > 60, `a dense, decaying histogram keeps its shape: its tail stands ${(100 - tail("span")).toFixed(0)} px high of 100, where a plain log scale draws ${(100 - tail("log")).toFixed(0)} px`);
  const flatTop = pairs(histogramPath(flat.hist, histDomain(flat, [100, 1100]), 256, 100)).map((q) => q[1]).slice(1, -1);
  h.ok(flatTop.every((y) => Math.abs(y - flatTop[0]) < 1e-9) && flatTop[0] <= 2, "a flat histogram is drawn flat, at full height");
  const holes = pairs(histogramPath({ lo: 0, hi: 4, counts: [1000, 0, 10, 0] }, { lo: 0, hi: 4 }, 4, 100)).map((q) => q[1]);
  h.ok(holes[3] === 100 && holes[5] < 100 && holes[5] > 60, "an empty bin has no height; the rarest occupied bin still shows");
}

// ---------------------------------------------------------------------------------------------
// Where new panels go (panelLayout.ts): beside the image when the figure has room, else inside its footprint
// ---------------------------------------------------------------------------------------------
{
  const within = (f: { width: number; height: number }, b: PanelBox): boolean => b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= f.width + 0.5 && b.y + b.height <= f.height + 0.5;
  const overlap = (a: PanelBox, b: PanelBox): boolean => a.x < b.x + b.width - 1e-6 && b.x < a.x + a.width - 1e-6 && a.y < b.y + b.height - 1e-6 && b.y < a.y + a.height - 1e-6;
  const page = { width: 680, height: 850 };
  // The default case: a large image fitted to a blank figure's width.
  const fitted = { x: 16, y: 101, width: 648, height: 648 };
  const sp = splitLayout(page, fitted, 3);
  h.eq(sp.place, "inPlace", "three channels of an image as wide as its figure share the image's place");
  h.eq([sp.source, ...sp.channels].map((b) => [b.x, b.y, b.width, b.height]), [[16, 101, 321, 321], [343, 101, 321, 321], [16, 428, 321, 321], [343, 428, 321, 321]], "a square image and three channels make a 2 x 2 grid in the image's own box, the image first");
  const small = { x: 20, y: 20, width: 120, height: 90 };
  const sb = splitLayout(page, small, 3);
  h.eq([sb.place, sb.source, sb.channels.map((b) => b.x)], ["beside", small, [146, 272, 398]], "with room in the figure the channels stand to the image's right and the image does not move");
  const cases = Array.from({ length: 300 }, () => {
    const f = { width: int(200, 1400), height: int(200, 1400) }, w = int(30, f.width - 10), hgt = int(30, f.height - 10);
    return { f, src: { x: int(0, f.width - w), y: int(0, f.height - hgt), width: w, height: hgt }, n: int(1, 6) };
  });
  const lost = find(cases, ({ f, src, n }) => { const l = splitLayout(f, src, n); return l.channels.length !== n || ![l.source, ...l.channels].every((b) => within(f, b) && b.width > 0 && b.height > 0); });
  h.ok(lost === null, `Split never puts a panel outside the figure${lost ? ` (counter-example ${show(lost)})` : ""}`);
  const piled = find(cases, ({ f, src, n }) => { const l = splitLayout(f, src, n), all = [l.source, ...l.channels]; return all.some((a, i) => all.some((b, k) => k > i && overlap(a, b))); });
  h.ok(piled === null, `Split panels never overlap each other${piled ? ` (counter-example ${show(piled)})` : ""}`);
  const bent = find(cases, ({ f, src, n }) => { const l = splitLayout(f, src, n), a = src.width / src.height; return [l.source, ...l.channels].some((b) => Math.abs(b.width / b.height - a) > 1e-6 * a); });
  h.ok(bent === null, `every Split panel keeps the image's aspect${bent ? ` (counter-example ${show(bent)})` : ""}`);
  const spilled = find(cases, ({ f, src, n }) => { const l = splitLayout(f, src, n); return l.place === "inPlace" && ![l.source, ...l.channels].every((b) => b.x >= src.x - 1e-6 && b.y >= src.y - 1e-6 && b.x + b.width <= src.x + src.width + 1e-6 && b.y + b.height <= src.y + src.height + 1e-6); });
  h.ok(spilled === null, `a Split in place stays inside the image's own box${spilled ? ` (counter-example ${show(spilled)})` : ""}`);
  h.eq(gridCells({ x: 0, y: 0, width: 300, height: 100 }, 3, 1, 0).map((b) => [b.x, b.width]), [[0, 100], [100, 100], [200, 100]], "a wide box takes its cells in one row");
  h.eq(gridCells({ x: 0, y: 0, width: 100, height: 100 }, 0, 1, 6), [], "no cells asked for: none given");

  h.eq(insetLayout(page, small, 1), { place: "right", box: { x: 148, y: 20, width: 90, height: 90 } }, "an inset stands to its image's right at the image's height when the figure has room");
  h.eq(insetLayout({ width: 150, height: 850 }, small, 2).place, "below", "no room to the right: below the image");
  const corner = insetLayout(page, fitted, 1);
  h.eq([corner.place, corner.box], ["inside", { x: 16 + 648 - 259.2 - 8, y: 109, width: 259.2, height: 259.2 }], "no room beside an image as wide as its figure: the inset stands in the image's top-right corner at two fifths of its height");
  const out = find(cases, ({ f, src }) => { const a = 0.2 + R() * 4, l = insetLayout(f, src, a); return !within(f, l.box) || Math.abs(l.box.width / l.box.height - a) > 1e-6 * a || (l.place !== "inside" && overlap(l.box, src)); });
  h.ok(out === null, `an inset is always inside the figure, keeps its region's aspect, and covers its image only when it stands on it${out ? ` (counter-example ${show(out)})` : ""}`);
  h.ok(insetLayout(page, fitted, 6).box.width <= 324 + 1e-9, "a very wide inset on its image is never more than half the image's width");
}

// ---------------------------------------------------------------------------------------------
// Round lengths (the wheel over a scale bar)
// ---------------------------------------------------------------------------------------------
h.section("furniture: the next round length");
{
  h.eq([1, 2, 5, 10, 20, 50, 0.5, 0.02].map((v) => roundNeighbour(v, 1)), [2, 5, 10, 20, 50, 100, 1, 0.05], "up the 1, 2, 5 × 10ⁿ series");
  h.eq([1, 2, 5, 10, 20, 50, 0.5, 0.02].map((v) => roundNeighbour(v, -1)), [0.5, 1, 2, 5, 10, 20, 0.2, 0.01], "and down it");
  h.eq([roundNeighbour(30, 1), roundNeighbour(30, -1), roundNeighbour(7.5, 1), roundNeighbour(7.5, -1)], [50, 20, 10, 5], "a length off the series goes to its neighbours on it");
  h.eq([roundNeighbour(1000, -1), roundNeighbour(0.001, 1)], [500, 0.002], "powers of ten are read exactly (no 999.99…)");
  h.eq([roundNeighbour(0, 1), roundNeighbour(-3, 1), roundNeighbour(NaN, 1)].map((v) => (Number.isNaN(v) ? "NaN" : v)), [0, -3, "NaN"], "what is not a length is handed back");
  let v = 1;
  for (let i = 0; i < 9; i++) v = roundNeighbour(v, 1);
  for (let i = 0; i < 9; i++) v = roundNeighbour(v, -1);
  h.eq(v, 1, "nine steps up and nine down come home");
}

// ---------------------------------------------------------------------------------------------
// The histogram of the pixels on screen (what a channel strip draws in its colours)
// ---------------------------------------------------------------------------------------------
h.section("histogram: the pixels on screen");
{
  const W = 40, H = 30, data = new Float32Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = i % 100; // every value 0 .. 99 twelve times
  const id = (v: number): number => v, whole = { x: 0, y: 0, width: W, height: H };
  const all = viewHistogram(data, W, H, whole, id, { lo: 0, hi: 100 }, 10)!;
  h.eq(all.counts, new Array(10).fill(120), "ten bins over 0 .. 100 hold a tenth of the pixels each");
  h.eq([all.lo, all.hi], [0, 100], "the histogram spans the control's own span (so it lines up with the handles)");
  const part = viewHistogram(data, W, H, { x: 0, y: 0, width: W, height: 5 }, id, { lo: 0, hi: 100 }, 10)!;
  h.eq(part.counts.reduce((a, b) => a + b, 0), 200, "only the pixels inside the frame are counted");
  const top = viewHistogram(data, W, H, whole, id, { lo: 0, hi: 99 }, 10)!;
  h.eq(top.counts.reduce((a, b) => a + b, 0), 1200, "a value exactly at the span's end is counted (in the last bin), never dropped");
  const narrow = viewHistogram(data, W, H, whole, id, { lo: 20, hi: 30 }, 5)!;
  h.eq(narrow.counts.reduce((a, b) => a + b, 0), 132, "values outside the span are left out, not piled onto its ends");
  const holes = Float32Array.from(data, (v, i) => (i % 2 ? NaN : v));
  h.eq(viewHistogram(holes, W, H, whole, id, { lo: 0, hi: 100 }, 10)!.counts.reduce((a, b) => a + b, 0), 600, "pixels without data are not counted");
  h.eq(viewHistogram(data, W, H, whole, (v) => v * 2 + 1000, { lo: 1000, hi: 1200 }, 10)!.counts, new Array(10).fill(120), "stored samples are decoded to values before they are binned");
  h.eq(viewHistogram(data, W, H, { x: 500, y: 500, width: 10, height: 10 }, id, { lo: 0, hi: 100 }), null, "a frame outside the plane has no histogram");
  h.eq(viewHistogram(data, W, H, whole, id, { lo: 5, hi: 5 }), null, "an empty span has no histogram");
  h.eq(viewHistogram(data, W, H, whole, id, { lo: 500, hi: 600 }), null, "nothing in view inside the span: no histogram (the strip falls back to the whole image's)");
  const big = new Uint16Array(2048 * 2048).fill(7);
  const thin = viewHistogram(big, 2048, 2048, { x: 0, y: 0, width: 2048, height: 2048 }, id, { lo: 0, hi: 10 }, 10, 120_000)!;
  const seen = thin.counts.reduce((a, b) => a + b, 0);
  h.ok(seen > 60_000 && seen <= 120_000 && thin.counts[7] === seen, `a 4-megapixel plane is thinned to at most the cap (${seen.toLocaleString("en-US")} samples), evenly`);
}

// ---------------------------------------------------------------------------------------------
// Where the control board stands (boardLayout.ts)
// ---------------------------------------------------------------------------------------------
h.section("the board: where its instruments stand round the image");
{
  const meets = (a: Box, b: Box): boolean => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
  const insideHost = (host: { w: number; h: number }, b: Box): boolean => b.x >= BOARD.pad - 1e-6 && b.y >= BOARD.pad - 1e-6 && b.x + b.w <= host.w - BOARD.pad + 1e-6 && b.y + b.h <= host.h - BOARD.pad + 1e-6;
  const CONSOLE = { w: 252, h: 380 }, LAYERS = { w: 228, h: 200 };
  const host = { w: 1200, h: 900 };
  // The board's own shape: a square stack in the middle of a roomy canvas.
  const roomy = boardLayout({ host, image: { x: 400, y: 150, w: 400, h: 400 }, depth: true, rows: 1, console: CONSOLE, layers: LAYERS });
  h.eq([roomy.depth?.side, roomy.console.side, roomy.layers?.side, roomy.rowsAt, roomy.over], ["left", "right", "left", "below", false], "with room all round: depth at the left like a y axis, time under like an x axis, the console at the right, layers outermost at the left");
  h.eq([roomy.depth!.x + roomy.depth!.w, roomy.depth!.y, roomy.depth!.h], [400 - BOARD.gap, 150, 400], "the depth rail stands a gap from the image and is exactly as tall as it");
  h.eq([roomy.rows[0].x, roomy.rows[0].w, roomy.rows[0].y], [400, 400, 550 + BOARD.gap], "the time rail lies a gap under the image and is exactly as wide as it");
  h.eq([roomy.console.x, roomy.console.y], [800 + BOARD.gap, 150], "the console starts level with the image's top, a gap from its side");
  h.ok(roomy.layers!.x + roomy.layers!.w === roomy.depth!.x - BOARD.gap, "layers stand outside the depth rail");

  const noLeft = boardLayout({ host, image: { x: 20, y: 150, w: 400, h: 400 }, depth: true, rows: 0, console: CONSOLE, layers: null });
  h.eq([noLeft.depth?.side, noLeft.console.side, noLeft.over], ["right", "right", false], "no room at the left: the depth rail stands at the right, between the image and the console");
  h.ok(noLeft.depth!.x < noLeft.console.x, "…nearest the image");
  const noRight = boardLayout({ host, image: { x: 700, y: 150, w: 400, h: 400 }, depth: true, rows: 0, console: CONSOLE, layers: null });
  h.eq([noRight.console.side, noRight.over], ["left", false], "no room at the right: the console stands at the left");
  const stacked = boardLayout({ host, image: { x: 100, y: 150, w: 800, h: 600 }, depth: false, rows: 0, console: CONSOLE, layers: LAYERS });
  h.eq([stacked.console.side, stacked.layers?.under, stacked.over], ["right", true, false], "room for one column only: layers stand under the console");
  h.ok(stacked.layers!.y === stacked.console.y + stacked.console.h + BOARD.gap && stacked.layers!.x === stacked.console.x, "…a gap below it, on its edge nearest the image");
  const wide = boardLayout({ host, image: { x: 300, y: 150, w: 620, h: 143 }, depth: false, rows: 1, console: CONSOLE, layers: LAYERS });
  h.eq([wide.console.side, wide.layers?.side, wide.over], ["below", "below", false], "a wide, low image (a line-scan movie) takes its console and layers under it");
  h.ok(wide.console.y === wide.rows[0].y + wide.rows[0].h + BOARD.gap && wide.console.x === 300 && wide.layers!.x === 300 + CONSOLE.w + BOARD.gap, "…under its rail, from its left edge, side by side");
  const full = boardLayout({ host, image: { x: -400, y: -300, w: 2400, h: 1800 }, depth: true, rows: 1, console: CONSOLE, layers: null });
  h.eq([full.over, full.rowsAt], [true, "over"], "an image that fills the canvas: the instruments stand over its edges");
  h.ok([full.depth!, full.console, ...full.rows].every((b) => insideHost(host, b)), "…wholly inside the canvas");
  h.ok(!full.rows.some((r) => meets(r, full.console) || meets(r, full.depth!)), "…and the rail lying over its foot does not run under the instruments standing at its sides");
  const tiny = boardLayout({ host, image: { x: 500, y: 300, w: 40, h: 30 }, depth: true, rows: 1, console: CONSOLE, layers: null });
  h.eq([tiny.stage.w, tiny.stage.h, tiny.depth!.h, tiny.rows[0].w], [BOARD.rowMinW, BOARD.depthMinH, BOARD.depthMinH, BOARD.rowMinW], "a tiny image still gets rails long enough to use");
  h.ok(tiny.console.x >= 500 + BOARD.rowMinW + BOARD.gap, "…and the console stands clear of the lengthened rail");

  // Properties over random canvases, images and boards.
  const cases = Array.from({ length: 600 }, () => {
    const hw = int(900, 2400), hh = int(620, 1500), w = int(20, 1800), hgt = int(20, 1400);
    return {
      host: { w: hw, h: hh }, image: { x: int(-600, hw), y: int(-400, hh), w, h: hgt }, depth: R() < 0.6, rows: int(0, 2),
      console: { w: 252, h: int(150, 560) }, layers: R() < 0.4 ? { w: 228, h: int(60, 520) } : null,
    };
  });
  const parts = (l: ReturnType<typeof boardLayout>): Box[] => [l.console, ...(l.layers ? [l.layers] : []), ...(l.depth ? [l.depth] : []), ...l.rows];
  const outside = find(cases, (c) => !parts(boardLayout(c)).every((b) => insideHost(c.host, b)));
  h.ok(outside === null, `every instrument is wholly inside the canvas${outside ? ` (counter-example ${show(outside)})` : ""}`);
  const covered = find(cases, (c) => { const l = boardLayout(c); return !l.over && parts(l).some((b) => meets(b, l.stage)); });
  h.ok(covered === null, `no instrument covers the image unless the layout says the canvas had no room${covered ? ` (counter-example ${show(covered)})` : ""}`);
  const piled = find(cases, (c) => { const l = boardLayout(c), all = parts(l); return !l.over && all.some((a, i) => all.some((b, k) => k > i && meets(a, b))); });
  h.ok(piled === null, `instruments never overlap each other while there is room${piled ? ` (counter-example ${show(piled)})` : ""}`);
  const lost = find(cases, (c) => { const l = boardLayout(c); return l.rows.length !== c.rows || !!l.depth !== c.depth || !!l.layers !== !!c.layers || parts(l).some((b) => !(b.w > 0) || !(b.h >= 0)); });
  h.ok(lost === null, `every instrument asked for is given a place${lost ? ` (counter-example ${show(lost)})` : ""}`);
  const same = find(cases, (c) => JSON.stringify(boardLayout(c)) !== JSON.stringify(boardLayout(structuredClone(c))));
  h.ok(same === null, "the layout is a pure function of its inputs");
}

await h.done();
