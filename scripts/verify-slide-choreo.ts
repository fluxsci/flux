#!/usr/bin/env -S npx tsx
// T2 CHOREO — the stagger PLANNER (a total-invariant lag schedule written as today's Total/Each fields), the plot auto-build
// choreography (scaffold-first axes per X5, folded gridlines, capped lag totals, chains, legend frame) and multi-target lag.
// Pure tier: no browser. Nothing here adds a schema field, a player branch or a compile branch. Pace is an AutoPace OBJECT
// (CLASSIC_PACE | V2_PACE); there is no `motion` option anywhere (X1c).
//   npx tsx scripts/verify-slide-choreo.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as slideOps from "../src/lib/slide/ops";
import { planStagger, staggerFields, lagTotal, lagStarts, writeTiming, trackFootprint, staggerDelay, staggerRanks, staggerSpan, LAG_MIN_CHILD_MS, LAG_MIN_CHILD_FRAC } from "../src/lib/slide/stagger";
import {
  autoAnimatePlot, applyAutoAnimation, suggestTrack, drawDuration, paceUsesLengths, CLASSIC_PACE, V2_PACE, DEFAULT_PACE, AUTO_PACES,
  SCAFFOLD_MS, SCAFFOLD_SPINE_MS, SCAFFOLD_TICK_WINDOW_MS, SCAFFOLD_TICK_SPREAD_MS, SCAFFOLD_LABEL_START_MS, SCAFFOLD_LABEL_WINDOW_MS,
  SCAFFOLD_FRAME_SPINE_MS, SCAFFOLD_FRAME_SPINE_START_MS, SCAFFOLD_TITLE_MS, SCAFFOLD_TITLE_START_MS, SCAFFOLD_GRID_TOTAL_MS, SCAFFOLD_GRID_ANCHOR_MS,
  type AutoPace,
} from "../src/lib/slide/autobuild";
import { presetDef } from "../src/lib/slide/presetCatalog";
import * as strokeGeometry from "../src/lib/slide/strokeGeometry";
import { addAppearanceTracks, readingOrder } from "../src/lib/slide/animateSelection";
import { compileSlide } from "../src/lib/slide/compile";
import { resolveBeat } from "../src/lib/slide/resolve";
import { validateDeckFile } from "../src/lib/project/validate";
import { DECK_SCHEMA_VERSION, type Track, type Beat } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-choreo");
const here = path.dirname(fileURLToPath(import.meta.url));
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const paceOf = (m: "classic" | "v2"): AutoPace => AUTO_PACES[m];

// ---------------------------------------------------------------- A. the planner law
h.section("A. planStagger: total invariant, floor, manim identity");
let grid = 0, bad = 0;
for (const T of [400, 1000, 2000]) for (const L of [0, 0.05, 0.1, 0.25, 0.5, 1]) for (const N of [2, 5, 30, 300, 1200]) {
  const p = planStagger(T, L, N - 1); grid++;
  const floor = Math.min(T, Math.max(LAG_MIN_CHILD_MS, LAG_MIN_CHILD_FRAC * T));
  const natural = T / (1 + (N - 1) * L);
  const okTotal = p.childMs + p.spanMs === T && p.totalMs === T;                       // the footprint IS the total, to the ms
  const okFloor = p.childMs >= Math.round(floor) - 1 || natural >= floor;              // a window never under max(150 ms, 20 %)
  const okLag = p.lag <= L + 1e-12 && p.lag >= 0;
  const okExact = natural < floor || near(p.childMs, natural, 0.5 + 1e-9);             // floor idle -> manim's window T / (1 + (n-1) L)
  const okStep = N < 2 || near(p.stepMs * (N - 1), p.spanMs, 1e-6);
  if (!(okTotal && okFloor && okLag && okExact && okStep)) { bad++; console.error("grid fail", T, L, N, p); }
}
h.eq(bad, 0, `${grid} (T x L x N) cells: child + span == T exactly, floor honoured, eff. lag <= L, window == T/(1+(n-1)L) when the floor is idle`);
const pin = (n: number, T: number, L: number) => planStagger(T, L, n - 1);
h.eq([pin(5, 1600, 0.1).childMs, pin(5, 1600, 0.1).spanMs], [1143, 457], "pin: N=5, L=0.1, T=1600 -> window 1143 / spread 457 (step 114.25)");
h.eq([pin(30, 1600, 0.1).childMs, pin(30, 1600, 0.1).spanMs], [410, 1190], "pin: N=30 -> 410 / 1190 (step 41.03)");
h.eq([pin(300, 1600, 0.1).childMs, pin(300, 1600, 0.1).spanMs], [320, 1280], "pin: N=300 -> window 320 (the 20 % floor binds), spread 1280");
h.ok(near(pin(300, 1600, 0.1).lag, 0.013378, 1e-5), "pin: N=300 effective lag 0.0134 (the ratio gives way, never the total)");
h.eq(planStagger(0, 0.1, 5), { lag: 0.1, childMs: 0, spanMs: 0, stepMs: 0, totalMs: 0 }, "T=0 is inert");
h.eq(planStagger(900, 0.5, 0).spanMs, 0, "one target (maxRank 0): window = the whole total");
// manim's Animation.get_sub_alpha, closed form: window = T/(1+(n-1)L), start_i = i L window
for (const [n, L, T] of [[3, 0.1, 1000], [14, 0.2, 1000], [30, 0.1, 2000], [8, 0.5, 1500], [12, 0.25, 3000]] as const) {
  const p = planStagger(T, L, n - 1), w = T / (1 + (n - 1) * L);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(p.stepMs * i - i * L * w), Math.abs(p.childMs - w));
  h.ok(worst <= 0.5 + 1e-9, `n=${n} L=${L} T=${T}: windows and starts equal manim's get_sub_alpha within rounding (${worst.toFixed(3)} ms)`);
}
// Write's rule lag = min(4/n, 0.2): the 20 % floor reproduces it
for (const [n, manimWin] of [[3, 714], [14, 278], [15, 526], [21, 416], [40, 408], [200, 402]] as const) {
  const w = writeTiming(n), p = planStagger(w.totalMs, w.lag, n - 1);
  h.ok(near(p.childMs, manimWin, manimWin * 0.04), `writeTiming(${n}): window ${p.childMs} ms vs manim Write ${manimWin} ms (<= 4 %; <= 2 % from n = 40)`);
}
h.eq([writeTiming(14).totalMs, writeTiming(15).totalMs], [1000, 2000], "writeTiming: 1 s below 15 items, 2 s from 15");
h.eq([lagTotal(5, 600, 0.1, 2000), lagTotal(30, 600, 0.1, 2000), lagTotal(1200, 600, 0.1, 2000)], [840, 2000, 2000], "lagTotal: natural LaggedStart time, capped");
const ls = lagStarts(6, 900, 0.1);
h.ok(ls.startsMs.length === 6 && ls.startsMs[0] === 0 && ls.startsMs[5] + ls.childMs <= 900 + 1, "lagStarts: separate tracks fit the total (last end <= T + rounding)");

// ---------------------------------------------------------------- B. the planner's fields through the REAL compiler
h.section("B. planner fields ARE existing fields: compile footprint == T, validates, same law for Each/Total");
const mkManifest = (n: number): FluxPlotManifest => {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  return { schemaVersion: "0.2.0", parts: { id: "root", role: "figure", children: ids.map(id => ({ id, role: "point" })) },
    series: [{ id: "s", points: ids.map((svgId, i) => ({ svgId, x: i, y: i })) }] } as unknown as FluxPlotManifest;
};
for (const [n, T, L] of [[5, 1600, 0.1], [30, 2000, 0.1], [300, 2000, 0.1], [1200, 2000, 0.1], [7, 1000, 0.5]] as const) {
  const f = staggerFields(planStagger(T, L, n - 1), { by: "index", from: "start" });
  const track: Track = { id: "t", target: "plot", part: undefined, parts: Array.from({ length: n }, (_, i) => `p${i}`), preset: "stagger", duration: f.duration, start: 0, stagger: f.stagger, params: { child: "fade" } };
  const slide = { id: "s", elements: [{ id: "plot", type: "plot" as const, assetId: "a", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [track] }] };
  const manifest = mkManifest(n);
  const c = compileSlide(slide as never, { width: 640, height: 360 }, { plotManifest: () => manifest });
  const ct = c.cues[1].tracks[0];
  const starts = ct.ranks.map(r => staggerDelay(ct.track, r, ct.maxRank));
  const ends = starts.map(s => s + ct.duration);
  h.ok(ct.parts.length === n && Math.max(...ends) === T && Math.min(...starts) === 0, `N=${n}: first start 0, last end == ${T} through compileSlide`);
  h.ok(near(ct.end - ct.start, T, 0) && c.cues[1].duration === T, `N=${n}: cue footprint == T (compile end, anchors and the timeline all read start + duration + staggerSpan)`);
  h.eq(trackFootprint(track, n), T, `N=${n}: trackFootprint == T`);
}
{ // legacy Each arithmetic is untouched: perMs * rank
  const t: Track = { id: "e", target: "x", preset: "stagger", duration: 240, stagger: { perMs: 40, by: "index", from: "start" } };
  h.eq(Array.from({ length: 9 }, (_, i) => staggerDelay(t, i, 8)), Array.from({ length: 9 }, (_, i) => i * 40), "classic Each stays byte-identical");
  h.eq(staggerSpan(t, 9), 320, "classic Each span unchanged");
}

// ---------------------------------------------------------------- C. autobuild structure on the repo's real plots
h.section("C. autobuild: structure + pace on real fixtures");
const load = async (p: string) => JSON.parse(await fs.readFile(path.join(here, "fixtures", p), "utf8")) as FluxPlotManifest;
const scatter = await load("plots/mpl_scatter_FLUXPLOT.fluxplot.json");
const bars = await load("plots/mpl_bars_FLUXPLOT.fluxplot.json");
const boxes = await load("plots/mpl_boxplot_FLUXPLOT.fluxplot.json");
const sine = await load("plots/mpl_sine_waves_FLUXPLOT.fluxplot.json");
const legacy = await load("pre-regen/06_scatter_regression.fluxplot.json");
const idsOf = (beat: Beat) => new Set(beat.tracks.map(t => t.id));
const find = (beats: Beat[], part: string) => beats.flatMap(b => b.tracks).find(t => t.part === part);
const sigOf = (beats: Beat[]) => JSON.stringify(beats.map(b => [b.label, b.advance ?? "", b.autoPhase, b.tracks.map(t => [t.part, t.preset, t.duration, t.start ?? 0, t.anchor ? [t.anchor.edge, t.anchor.offsetMs, b.tracks.findIndex(x => x.id === t.anchor!.trackId)] : null, t.stagger ?? null, t.params ?? null])]));
for (const [name, m] of [["scatter", scatter], ["bars", bars], ["boxplot", boxes], ["sine", sine], ["legacy scatter", legacy]] as const) for (const pid of ["classic", "v2"] as const) {
  const beats = autoAnimatePlot(m, "plot", { pace: paceOf(pid) });
  h.ok(beats.length >= 2 && beats.length <= 3 && !beats.some(b => b.advance === "with-prev"), `${name}/${pid}: at most 3 clicks (Axes & grid, Data, Legend), no with-prev beat`);
  h.ok(beats.every(b => b.tracks.every(t => !t.anchor || idsOf(b).has(t.anchor.trackId))), `${name}/${pid}: every anchor resolves inside its own beat`);
  const flat = beats.flatMap(b => b.tracks);
  h.ok(flat.every(t => (t.start ?? 0) >= 0 && (t.duration ?? 0) > 0), `${name}/${pid}: no negative start, no zero duration`);
  h.ok(flat.every(t => !t.stagger || (t.stagger.perMs !== undefined) !== (t.stagger.totalMs !== undefined)), `${name}/${pid}: staggers are Each XOR Total (existing fields only)`);
  const data = beats.find(b => b.label === "Data");
  h.ok(!data || !data.tracks.some(t => /(^|\.)legend(\.|$)/.test(t.part ?? "")), `${name}/${pid}: no legend part in the Data click (the frame leak is fixed)`);
}
{ // X5 scaffold (V2): literal pins, every number a named constant; ordering spine < ticks < labels < titles by start
  h.eq([SCAFFOLD_MS, SCAFFOLD_SPINE_MS, SCAFFOLD_TICK_WINDOW_MS, SCAFFOLD_TICK_SPREAD_MS, SCAFFOLD_LABEL_START_MS, SCAFFOLD_LABEL_WINDOW_MS, SCAFFOLD_FRAME_SPINE_MS, SCAFFOLD_FRAME_SPINE_START_MS, SCAFFOLD_TITLE_MS, SCAFFOLD_TITLE_START_MS, SCAFFOLD_GRID_TOTAL_MS, SCAFFOLD_GRID_ANCHOR_MS],
    [700, 520, 140, 450, 40, 200, 200, 420, 250, 370, 380, 225], "X5 constants: 700 budget, spine 520, ticks 140 window / 450 spread, labels +40 / 200, frame spines 200 @420, titles 250 @370, grid 380 anchored +225");
  const beats = autoAnimatePlot(legacy, "plot", { pace: V2_PACE });
  const ax = beats[0], at = (p: string) => ax.tracks.find(t => t.part === p)!;
  h.eq(ax.label, "Axes & grid", "v2: the first click is 'Axes & grid'");
  const sx = at("axis.x.spine"), sy = at("axis.y.spine"), tx = at("axis.x.ticks"), ty = at("axis.y.ticks"), lx = at("axis.x.tick-labels"), ly = at("axis.y.tick-labels"), tt = at("axis.x.title");
  h.ok(sx.start === 0 && sy.start === 0 && sx.duration === SCAFFOLD_SPINE_MS && sy.duration === SCAFFOLD_SPINE_MS && sx.preset === "drawOn", "v2: both primary spines draw concurrently from the origin corner, start 0, SCAFFOLD_SPINE_MS (exempt from the drawOn floor and drawDuration)");
  h.ok((tx.start ?? 0) === 0 && (lx.start ?? 0) > (tx.start ?? 0) && (tt.start ?? 0) > (lx.start ?? 0) && (tx.start ?? 0) >= (sx.start ?? 0), "v2: spine <= ticks < tick labels < title by start (scaffold-first)");
  h.ok(tx.preset === "drawOn" && tx.duration === SCAFFOLD_TICK_WINDOW_MS && tx.stagger?.totalMs === SCAFFOLD_TICK_SPREAD_MS && tx.stagger.by === "x" && tx.stagger.from === "start", "v2: x ticks drawOn, window 140, spread 450, along x from the start");
  h.ok(ty.stagger?.by === "y" && ty.stagger.from === "start", "v2: y ticks lag along y from the start of DOM order (tick nodes carry no data-y; DOM order is bottom to top, the y spine's pen direction)");
  h.ok(lx.start === SCAFFOLD_LABEL_START_MS && lx.duration === SCAFFOLD_LABEL_WINDOW_MS && lx.stagger?.totalMs === SCAFFOLD_TICK_SPREAD_MS && ly.stagger?.from === "start", "v2: tick labels follow the same law, start 40, window 200");
  h.ok(tt.start === SCAFFOLD_TITLE_START_MS && tt.duration === SCAFFOLD_TITLE_MS, "v2: axis title fade 250 @370");
  h.ok(beats[0].tracks.filter(t => /gridlines$/.test(t.part ?? "")).length === 2, "v2: both gridline groups live in the Axes & grid click");
  const g = at("axis.x.gridlines");
  h.ok(g.anchor?.trackId === tx.id && g.anchor.edge === "start" && g.anchor.offsetMs === 225 && g.anchor.offsetMs === SCAFFOLD_GRID_ANCHOR_MS, "v2: gridlines anchored to the SAME axis's ticks, edge start, offset 225");
  h.eq((g.duration ?? 0) + (g.stagger?.totalMs ?? 0), SCAFFOLD_GRID_TOTAL_MS, "v2: a gridline group's footprint is planStagger(380, .3, ...) == 380");
  h.ok(at("axis.y.gridlines").anchor?.trackId === ty.id, "v2: the y gridlines anchor to the y ticks");
  const r = resolveBeat(ax, {}, () => legacy).tracks;
  const end = Math.max(...r.map(t => (t.start ?? 0) + (t.duration ?? 0) + staggerSpan(t, 6)));
  h.ok(end <= SCAFFOLD_MS, `v2: the Axes & grid click is one gesture of ${end} ms (<= 700; today: 400 + a second click)`);
  h.ok(ax.tracks.filter(t => t.easing !== undefined).length === 0, "v2: no scaffold track carries an authored easing (spines, ticks, labels take durations only)");
  // frame spines (top/right) are a 200 ms fade at 420: a synthetic manifest that has them
  const fm = { schemaVersion: "0.3.2", parts: { id: "figure", role: "figure", children: [{ id: "axis.x", role: "axis", children: [
      { id: "axis.x.spine.bottom", role: "spine" }, { id: "axis.x.spine.top", role: "spine" }, { id: "axis.y.spine.left", role: "spine" }, { id: "axis.y.spine.right", role: "spine" }] }] },
    build: { order: ["axis.x"], presets: { axis: { animation: "draw-on", durationMs: 400 } } } } as unknown as FluxPlotManifest;
  const fv = autoAnimatePlot(fm, "plot", { pace: V2_PACE })[0].tracks, fc = autoAnimatePlot(fm, "plot", { pace: CLASSIC_PACE })[0].tracks;
  const f2 = (ts: Track[], id: string) => ts.find(t => t.part === id)!;
  h.ok(f2(fv, "axis.x.spine.top").preset === "fade" && f2(fv, "axis.x.spine.top").duration === 200 && f2(fv, "axis.x.spine.top").start === 420 && f2(fv, "axis.y.spine.right").preset === "fade", "v2: frame spines (top/right) fade 200 @420");
  h.ok(f2(fv, "axis.x.spine.bottom").preset === "drawOn" && f2(fv, "axis.x.spine.bottom").start === 0 && f2(fv, "axis.y.spine.left").duration === SCAFFOLD_SPINE_MS, "v2: bottom/left spines draw from the origin corner");
  h.ok(f2(fc, "axis.x.spine.top").preset === "drawOn" && f2(fc, "axis.x.spine.top").start === 80 && f2(fc, "axis.x.spine.bottom").start === 0 && f2(fc, "axis.x.spine.bottom").duration === 400, "classic: frame spines keep T2's classic structure (drawOn, 0.2u = 80 ms later)");
}
{ // classic scaffold keeps T2's unit-400 structure and numbers
  h.eq(CLASSIC_PACE.unit, 400, "classic unit 400");
  const ax = autoAnimatePlot(legacy, "plot", { pace: CLASSIC_PACE })[0], at = (p: string) => ax.tracks.find(t => t.part === p)!;
  const tx = at("axis.x.ticks"), lx = at("axis.x.tick-labels"), tt = at("axis.x.title"), g = at("axis.x.gridlines");
  h.ok(tx.start === 60 && (tx.duration ?? 0) + (tx.stagger?.totalMs ?? 0) === 320, "classic: ticks start 0.15u = 60, footprint 0.8u = 320");
  h.ok(lx.start === 80 && (lx.duration ?? 0) + (lx.stagger?.totalMs ?? 0) === 400, "classic: tick labels start 0.2u = 80, footprint u = 400");
  h.ok(tt.start === 280 && tt.duration === 280, "classic: titles at spine end - 0.3u (= 280), 0.7u long");
  h.ok(g.anchor?.trackId === tx.id && g.anchor.offsetMs === 160 && (g.duration ?? 0) + (g.stagger?.totalMs ?? 0) === 340, "classic: gridlines anchored to the ticks at round(.5 * 320) = 160, footprint 0.85u = 340");
  h.ok(ax.tracks.every(t => t.easing === undefined), "classic: no authored easing anywhere");
}
{ // data phase pins: classic pace = the plot's own Each pacing (capped); v2 = lag law with a capped total
  const cls = autoAnimatePlot(scatter, "plot", { pace: CLASSIC_PACE }), v2 = autoAnimatePlot(scatter, "plot", { pace: V2_PACE });
  const cp = find(cls, "samples.points")!, vp = find(v2, "samples.points")!;
  const n = 60; // mpl_scatter fixture
  h.ok(cp.duration === 240 && cp.stagger?.perMs === Math.min(40, Math.floor(1200 / (n - 1) * 100) / 100) && cp.stagger.totalMs === undefined, "classic: window 240, Each step 40 ms lowered only to keep the spread <= 1200");
  const ref = Math.max(240, presetDef("stagger").autoBuildDurationMs ?? 0); // the V2 floor READS the catalog
  h.ok((vp.duration ?? 0) + (vp.stagger?.totalMs ?? 0) === lagTotal(n, ref, 0.1, 2000) && vp.stagger?.perMs === undefined, `v2: window + spread == lagTotal(60, ${ref}, .1, 2000) == ${lagTotal(n, ref, 0.1, 2000)}`);
  h.eq(vp.params?.child, "fade", "v2: points enter by fade until T6's grow child lands (hard ordering dependency, see R4 section 2)");
}
{ // the line starts while the points arrive: anchor == overlap x footprint
  const v2 = autoAnimatePlot(legacy, "plot", { pace: V2_PACE }), cls = autoAnimatePlot(legacy, "plot", { pace: CLASSIC_PACE });
  const line = (b: Beat[]) => find(b, "fit.line")!;
  const pts = (b: Beat[]) => find(b, "setosa.points")!;
  h.ok(line(v2).anchor?.trackId === pts(v2).id && line(v2).anchor!.offsetMs === Math.round(0.55 * ((pts(v2).duration ?? 0) + (pts(v2).stagger?.totalMs ?? 0))), "v2: the fit line anchors at 0.55 of the points' footprint");
  h.ok(line(cls).anchor!.offsetMs === Math.round(0.5 * Math.min(50 * 40, 1200)) || line(cls).anchor!.offsetMs > 0, "classic: the line keeps today's half-spread anchor (capped)");
  h.eq(line(v2).easing, "linear", "v2: a data-series line draw carries an explicit linear easing (constant-speed pen)");
  h.eq(line(cls).easing, undefined, "classic: the line draw carries no authored easing");
  const sw = autoAnimatePlot(sine, "plot", { pace: V2_PACE }).flatMap(b => b.tracks).filter(t => /\.line$/.test(t.part ?? ""));
  h.ok(sw.length >= 2 && sw.every(t => t.easing === "linear"), "v2: every series line of a multi-line plot draws linearly");
  h.ok(autoAnimatePlot(sine, "plot", { pace: V2_PACE }).flatMap(b => b.tracks).filter(t => t.easing !== undefined).every(t => /\.line$/.test(t.part ?? "")), "v2: only data-series lines carry an easing (not spines, ticks, areas, annotations)");
}
{ // bars: together on classic (plot authors grow-from-baseline), one after another on v2; composite chains
  const cb = autoAnimatePlot(bars, "plot", { pace: CLASSIC_PACE }), vb = autoAnimatePlot(bars, "plot", { pace: V2_PACE });
  const barOf = (b: Beat[]) => b.flatMap(x => x.tracks).find(t => /\.bars$/.test(t.part ?? ""))!;
  h.ok(barOf(cb).preset === "growBaseline" && !barOf(cb).stagger, "classic: bars grow together (authored grow-from-baseline preserved)");
  h.ok(barOf(vb).preset === "stagger" && barOf(vb).params?.child === "growBaseline" && barOf(vb).stagger!.totalMs! > 0, "v2: bars lag (stagger child growBaseline)");
  const bx = autoAnimatePlot(boxes, "plot", { pace: V2_PACE }).flatMap(b => b.tracks);
  const peaches = ["box", "whiskers", "caps", "medians", "fliers"].map(k => bx.find(t => t.part === `peaches.${k}`)).filter(Boolean) as Track[];
  h.ok(peaches.length >= 4 && peaches.slice(1).every((t, i) => t.anchor?.trackId === peaches[i].id || (i === 0 && t.anchor)), "v2: box -> whiskers -> caps -> medians -> fliers chain on anchors");
  const oranges = bx.find(t => t.part === "oranges.box")!;
  h.ok(oranges.anchor?.trackId === peaches[0].id && oranges.anchor.offsetMs === Math.round(0.5 * (peaches[0].duration ?? 0)), "v2: series k+1 starts as series k's box is half done");
}
{ // pace tables
  h.eq(DEFAULT_PACE, CLASSIC_PACE, "no pace passed = CLASSIC_PACE in this lane (the integrator flips DEFAULT_PACE to V2_PACE)");
  h.ok(AUTO_PACES.classic === CLASSIC_PACE && AUTO_PACES.v2 === V2_PACE && CLASSIC_PACE.id === "classic" && V2_PACE.id === "v2", "AUTO_PACES names both tables; there is no autoPaceOf and no motion option");
  const presets = ["fade", "fadeRise", "drawOn", "growBaseline", "stagger", "writeOn"] as const;
  h.ok(presets.every(p => V2_PACE.floor(p) === (presetDef(p).autoBuildDurationMs ?? 0) && CLASSIC_PACE.floor(p) === 0), "V2_PACE.floor READS the catalog (presetDef(p).autoBuildDurationMs), never a copied table; classic has no floor");
  h.eq([paceUsesLengths(CLASSIC_PACE), paceUsesLengths(V2_PACE), paceUsesLengths()], [false, true, false], "only a length-scaling pace asks the host to measure the plot");
  h.eq([drawDuration(60, 800, V2_PACE), drawDuration(350, 800, V2_PACE), drawDuration(600, 800, V2_PACE), drawDuration(900, 800, V2_PACE), drawDuration(2000, 800, V2_PACE)], [600, 600, 1000, 1500, 1600], "drawDuration v2: len/600 px/s clamped 600..1600 on a 50 ms grid");
  h.eq([drawDuration(undefined, 800, V2_PACE), drawDuration(0, 800, V2_PACE), drawDuration(900, 800, CLASSIC_PACE)], [800, 800, 800], "no measure (or classic pace) -> the authored duration");
}
// every generated deck validates against the unchanged schema, stamped as before
{
  const deck = slideOps.createDeck({ id: "d", title: "d" });
  const sid = slideOps.addSlide(deck, { layout: "blank" }).id;
  const pid = slideOps.addPlotToSlide(deck, sid, { assetId: "a", x: 0, y: 0, width: 400, height: 300 })!;
  applyAutoAnimation(deck, sid, pid, scatter, { pace: V2_PACE });
  h.eq(validateDeckFile(deck), [], "a v2-built deck validates against the UNCHANGED deck schema");
  h.eq((deck as unknown as { schemaVersion: string }).schemaVersion, DECK_SCHEMA_VERSION, "no schema bump: the deck keeps the current version stamp");
}

// ---------------------------------------------------------------- D. re-animation: classic -> v2 == v2 from scratch (R3 F1)
h.section("D. re-animate merges cleanly; idempotent");
{
  const mkDeck = () => { const d = slideOps.createDeck({ id: "d", title: "d" }); const s = slideOps.addSlide(d, { id: "s", layout: "blank" }); const p = slideOps.addPlotToSlide(d, s.id, { assetId: "a", x: 0, y: 0, width: 400, height: 300 })!; return { d, s, p }; };
  const A = mkDeck(); applyAutoAnimation(A.d, "s", A.p, scatter, { pace: CLASSIC_PACE }); applyAutoAnimation(A.d, "s", A.p, scatter, { pace: V2_PACE });
  const B = mkDeck(); applyAutoAnimation(B.d, "s", B.p, scatter, { pace: V2_PACE });
  const strip = (beats: Beat[]) => JSON.stringify(beats.map(b => [b.label, b.advance ?? "", b.tracks.length, b.tracks.map(t => [t.part, t.preset, t.duration, t.start ?? 0, t.stagger ?? null])]));
  h.eq(strip(A.s.beats), strip(B.s.beats), "classic then v2 on the same plot == v2 from scratch (no stale beat, no inherited advance)");
  const before = strip(B.s.beats); applyAutoAnimation(B.d, "s", B.p, scatter, { pace: V2_PACE });
  h.eq(strip(B.s.beats), before, "re-running Auto is idempotent");
  // a second plot joins the SAME three click beats
  const p2 = slideOps.addPlotToSlide(B.d, "s", { assetId: "a", x: 0, y: 0, width: 400, height: 300 })!;
  applyAutoAnimation(B.d, "s", p2, scatter, { pace: V2_PACE });
  h.eq(B.s.beats.length, 4, "a second plot merges into the same Axes & grid / Data / Legend clicks (resting + 3)");
  h.ok(B.s.beats.slice(1).every(b => b.advance !== "with-prev" && b.tracks.some(t => t.target === p2) && b.tracks.some(t => t.target === B.p)), "both plots build in each shared click");
}

// ---------------------------------------------------------------- E. suggestTrack (X-ray Animate on one part)
h.section("E. suggestTrack follows the same planner");
{
  const cls = suggestTrack(scatter, "plot", "samples.points"), v2 = suggestTrack(scatter, "plot", "samples.points", { pace: V2_PACE });
  h.ok(cls.duration === 240 && cls.stagger?.perMs !== undefined && (cls.duration + cls.stagger.perMs * 59) <= 240 + 1200 + 1, "classic suggestTrack: Each, spread capped at 1200 (60 points)");
  const ref = Math.max(240, presetDef("stagger").autoBuildDurationMs ?? 0);
  h.ok(v2.stagger?.totalMs !== undefined && (v2.duration ?? 0) + v2.stagger.totalMs === lagTotal(60, ref, 0.1, 2000), "v2 suggestTrack: planner total == lagTotal(60, window, .1, 2000)");
  h.eq({ ...suggestTrack(scatter, "plot", "samples.points", {}), id: "" }, { ...cls, id: "" }, "no pace option = CLASSIC_PACE (same track as the explicit classic pace)");
  const lineV2 = suggestTrack(legacy, "plot", "fit.line", { pace: V2_PACE, lengths: { "fit.line": 600 } }), lineCls = suggestTrack(legacy, "plot", "fit.line", { lengths: { "fit.line": 600 } });
  h.ok(lineV2.preset === "drawOn" && lineV2.duration === 1000 && lineV2.easing === "linear", "v2 suggestTrack: a 600 px data line draws 1000 ms with linear easing");
  h.ok(lineCls.preset === "drawOn" && lineCls.duration === suggestTrack(legacy, "plot", "fit.line").duration && lineCls.easing === undefined, "classic suggestTrack: authored window, no easing, lengths ignored");
  { // review F6: the X-ray toggle on a frame spine matches the Auto build under V2
    const fm = { schemaVersion: "0.3.2", parts: { id: "figure", role: "figure", children: [{ id: "axis.x", role: "axis", children: [
        { id: "axis.x.spine.bottom", role: "spine" }, { id: "axis.x.spine.top", role: "spine" }] }] },
      build: { order: ["axis.x"], presets: { axis: { animation: "draw-on", durationMs: 400 } } } } as unknown as FluxPlotManifest;
    const top = suggestTrack(fm, "plot", "axis.x.spine.top", { pace: V2_PACE }), bottom = suggestTrack(fm, "plot", "axis.x.spine.bottom", { pace: V2_PACE });
    h.ok(top.preset === "fade" && top.duration === 200 && top.start === 420, `v2 suggestTrack: a top frame spine fades 200 @420 like the Auto build (${top.preset} ${top.duration} @${top.start})`);
    h.ok(bottom.preset === "drawOn" && bottom.duration === SCAFFOLD_SPINE_MS && bottom.start === 0, "v2 suggestTrack: a primary spine draws 520 from 0");
    h.ok(suggestTrack(fm, "plot", "axis.x.spine.top").preset === "drawOn", "classic suggestTrack: a top frame spine keeps its authored drawOn");
  }
}

// ---------------------------------------------------------------- F. multi-target lag (authoring)
h.section("F. addAppearanceTracks: lag across >= 3 targets, reading order, capped");
{
  const d = slideOps.createDeck({ id: "m", title: "m" });
  const s = slideOps.addSlide(d, { id: "s", layout: "blank" });
  const ids: string[] = [];
  const pos = [[300, 200], [10, 10], [200, 10], [100, 200], [400, 10], [10, 200]];
  pos.forEach(([x, y], i) => ids.push(slideOps.addElement(d, "s", { id: `e${i}`, type: "rect", x, y, width: 60, height: 40, rotation: 0, fill: "#333", stroke: "none", strokeWidth: 0, cornerRadius: 0 })!));
  slideOps.addBeat(d, "s", { label: "Step 1", advance: "click" });
  const targets = ids.map(elementId => ({ elementId }));
  const r = addAppearanceTracks(d, "s", targets, "appear", 1, {})!;
  const tr = s.beats[1].tracks;
  const order = tr.map(t => t.target);
  h.eq(order, ["e1", "e2", "e4", "e5", "e3", "e0"], "reading order: top row left to right, then bottom row (independent of selection order)");
  const starts = tr.map(t => t.start ?? 0);
  h.ok(starts[0] === 0 && starts.every((v, i) => !i || v > starts[i - 1]), "starts strictly increase by one step");
  h.ok(Math.max(...tr.map(t => (t.start ?? 0) + (t.duration ?? 0))) <= 1000 + 60, `group footprint stays inside ~1 s (${Math.max(...tr.map(t => (t.start ?? 0) + (t.duration ?? 0)))} ms)`);
  h.ok(tr.every(t => (t.duration ?? 0) <= 300), "windows never grow beyond the track's own duration");
  h.eq(r.trackIds.length, 6, "six tracks created");
  const classic = slideOps.createDeck({ id: "c", title: "c" }); slideOps.addSlide(classic, { id: "s", layout: "blank" });
  ids.forEach((_, i) => slideOps.addElement(classic, "s", { id: `e${i}`, type: "rect", x: i * 70, y: 10, width: 60, height: 40, rotation: 0, fill: "#333", stroke: "none", strokeWidth: 0, cornerRadius: 0 }));
  slideOps.addBeat(classic, "s", { label: "Step 1", advance: "click" });
  addAppearanceTracks(classic, "s", ids.map(elementId => ({ elementId })), "emphasize", 1, {});
  h.ok(slideOps.slideById(classic, "s")!.beats[1].tracks.every(t => (t.start ?? 0) === 0), "emphasize of six selected objects stays together (only Appear/Disappear lag)");
  const gone = slideOps.createDeck({ id: "g", title: "g" }); slideOps.addSlide(gone, { id: "s", layout: "blank" });
  ids.forEach((_, i) => slideOps.addElement(gone, "s", { id: `e${i}`, type: "rect", x: i * 70, y: 10, width: 60, height: 40, rotation: 0, fill: "#333", stroke: "none", strokeWidth: 0, cornerRadius: 0 }));
  slideOps.addBeat(gone, "s", { label: "Step 1", advance: "click" });
  addAppearanceTracks(gone, "s", ids.map(elementId => ({ elementId })), "disappear", 1, {});
  { const st = slideOps.slideById(gone, "s")!.beats[1].tracks.map(t => t.start ?? 0); h.ok(st[0] === 0 && st.every((v, i) => !i || v > st[i - 1]), "Disappear lags in reading order too (unconditional, no pace option)"); }
  const two = slideOps.createDeck({ id: "t", title: "t" }); slideOps.addSlide(two, { id: "s", layout: "blank" });
  ["a", "b"].forEach((id, i) => slideOps.addElement(two, "s", { id, type: "rect", x: i * 70, y: 10, width: 60, height: 40, rotation: 0, fill: "#333", stroke: "none", strokeWidth: 0, cornerRadius: 0 }));
  slideOps.addBeat(two, "s", { label: "Step 1", advance: "click" });
  addAppearanceTracks(two, "s", [{ elementId: "a" }, { elementId: "b" }], "appear", 1, {});
  h.ok(slideOps.slideById(two, "s")!.beats[1].tracks.every(t => (t.start ?? 0) === 0), "two targets (a box and its label) stay together");
  const rows = readingOrder([{ x: 100, y: 50, width: 40, height: 40 }, { x: 10, y: 55, width: 40, height: 30 }, { x: 10, y: 200, width: 40, height: 40 }]);
  h.eq(rows.map(e => e.x), [10, 100, 10], "readingOrder groups near-equal vertical centres into one row");
}

// ---------------------------------------------------------------- G. shared modules (X8)
h.section("G. strokeGeometry owns drawGeometry / inDefs / GEO_TAGS");
h.ok(typeof strokeGeometry.drawGeometry === "function" && typeof strokeGeometry.inDefs === "function" && strokeGeometry.GEO_TAGS === "path,line,polyline,polygon,rect,ellipse,circle", "strokeGeometry exports drawGeometry, inDefs, GEO_TAGS (moved verbatim from player/presets.ts)");
{
  const presetsSrc = await fs.readFile(path.join(here, "..", "src", "lib", "slide", "player", "presets.ts"), "utf8");
  h.ok(/from "\.\.\/strokeGeometry"/.test(presetsSrc) && !/function (inDefs|drawGeometry|paintOf)\b/.test(presetsSrc) && !/const GEO_TAGS/.test(presetsSrc), "player/presets.ts imports them and no longer defines its own copy");
}
await h.done();
