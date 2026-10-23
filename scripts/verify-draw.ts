#!/usr/bin/env -S npx tsx
// T3 DRAW (WP 1.4) — the pure core of the draw rework plus X13's tick compensation.
//   * src/lib/slide/player/trim.ts: a reference dasher paints (dasharray, dashoffset) exactly as SVG does, and every claim
//     is checked against the PAINTED set, never against the strings alone: exact tables for hiddenDash / drawReach /
//     windowsDash / traceDash / passingFlash; a seeded property test (1,500 cases: painted set == the requested window
//     clipped to the authored pattern, NO zero dash entry ever, closing gap >= L); trimDashAt == the legacy trimKeyframes
//     visible set over every mode x direction x anchor class; the draw-reach contract.
//   * the draw plan through the real preset (linkedom): exit == enter backwards, transient list, pathLength honoured (X12).
//   * X13 (resolveTrack): a drawOn on `axis.x|y.ticks` with no stagger is read as `duration' = round(.4 d)` + a spatial
//     stagger of the remaining d - duration' along its axis, same cue length, in BOTH engines (the compiler and the
//     player); an explicit stagger or { perMs: 0 } is untouched; the STORED track is never rewritten.
// Run: npx tsx scripts/verify-draw.ts
import { parseHTML } from "linkedom";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenDash, drawReach, DRAW_REACH_EPS, windowsDash, traceDash, passingFlash, trimDashAt, trimKeyframes, type TrimSpec, type DashFrame } from "../src/lib/slide/player/trim";
import { PRESETS } from "../src/lib/slide/player/presets";
import { computeSlideAnims } from "../src/lib/slide/player/player";
import { compileSlide } from "../src/lib/slide/compile";
import { resolveTrack, resolveTrackRaw, resolveBeat, tickCompensation, TICK_WINDOW_SHARE } from "../src/lib/slide/resolve";
import { staggerDelay } from "../src/lib/slide/stagger";
import { partDomId } from "../src/lib/plot/parse";
import * as slideOps from "../src/lib/slide/ops";
import { alignTrackEdges, inheritTrack } from "../src/lib/slide/alignTracks";
import { makeAnimPreset, deriveTemplateSlots } from "../src/lib/slide/animTemplates";
import { cascadeTracks } from "../src/lib/slide/ops";
import { FLUX_DARK } from "../src/lib/slide/theme";
import type { Track, Slide, Deck, StageSize } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { RenderedSlide } from "../src/lib/slide/player/render";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-draw");
const assert = (cond: unknown, msg: string) => { h.ok(cond, msg); };
const quiet = (cond: unknown, msg: string) => { if (!cond) h.ok(false, msg); };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const here = path.dirname(fileURLToPath(import.meta.url));

// --- reference dasher (SVG semantics: odd lists repeat twice; offset advances INTO the pattern) -------
function listOf(f: DashFrame): number[] { const l = f.strokeDasharray.trim().split(/[\s,]+/).map(Number); return l.length % 2 ? [...l, ...l] : l; }
function paints(l: number[], P: number, offset: number, s: number): boolean {
  let p = (s + offset) % P; if (p < 0) p += P;
  let acc = 0;
  for (let i = 0; i < l.length; i++) { acc += l[i]; if (p < acc - 1e-12) return i % 2 === 0; }
  return false;
}
const N = 4000;
function painted(f: DashFrame | null, L: number): boolean[] {
  if (!f) return new Array<boolean>(N).fill(false);
  const l = listOf(f), P = l.reduce((a, b) => a + b, 0); // parsed ONCE per frame
  return Array.from({ length: N }, (_, i) => paints(l, P, f.strokeDashoffset, ((i + 0.5) / N) * L));
}
function expected(L: number, windows: [number, number][], pat?: number[]): boolean[] {
  const q = pat && pat.some((v) => v > 0) ? (pat.length % 2 ? [...pat, ...pat] : pat) : null;
  const P = q ? q.reduce((a, b) => a + b, 0) : 0;
  return Array.from({ length: N }, (_, i) => {
    const s = ((i + 0.5) / N) * L;
    if (!windows.some(([a, b]) => s >= a && s < b)) return false;
    if (!q) return true;
    let p = s % P, acc = 0;
    for (let j = 0; j < q.length; j++) { acc += q[j]; if (p < acc) return j % 2 === 0; }
    return false;
  });
}
const mismatch = (a: boolean[], b: boolean[]) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

// --- exact tables ----------------------------------------------------------------------------------
{
  const h = hiddenDash(100);
  assert(h.strokeDasharray === "101" && h.strokeDashoffset === 101, "hiddenDash(100) = '101' @ 101 (G = len+1, offset G: [0,G) is gap — paints nothing, no cap dot)");
  assert(painted(h, 100).every((v) => !v), "hiddenDash paints no pixel of the stroke");
  assert(near(drawReach(630, "ellipse"), 630 * (1 + DRAW_REACH_EPS.round) + 0.05) && DRAW_REACH_EPS.round === 0.006 && DRAW_REACH_EPS.other === 0.002, "drawReach: ellipse/circle +0.6 %, every other tag +0.2 %, +0.05 unit");
  assert(drawReach(3.5, "line") < 3.6 && drawReach(3.5, "line") > 3.5, "a 3.5-unit tick reaches 3.557 (the old slack len+max(4,5 %) reached 7.5, i.e. the tick was complete at 47 % of the clock)");
  const w = windowsDash({ len: 100, pattern: [10, 6] }, [[0, 35]])!;
  assert(w.strokeDasharray === "10 6 10 6 3 101" && w.strokeDashoffset === 0, "windowsDash dashed [0,35] = '10 6 10 6 3 101' @ 0 (dashes intact, clipped at the window end, one huge closing gap)");
  const dots = windowsDash({ len: 100, pattern: [0, 6] }, [[0, 50]]);
  assert(dots !== null && dots.strokeDasharray === "50 101" && dots.strokeDashoffset === 0, `a round-cap dotted pattern (0 6) draws SOLID during the draw instead of painting nothing (${dots?.strokeDasharray ?? "null"})`);
  const w2 = windowsDash({ len: 100 }, [[20, 50]])!;
  assert(w2.strokeDasharray === "30 101" && w2.strokeDashoffset === -20, "windowsDash solid [20,50] = '30 101' @ -20");
  assert(windowsDash({ len: 100 }, [[50, 50]]) === null && windowsDash({ len: 100 }, []) === null, "an empty window is null (caller emits hiddenDash)");
  const t = traceDash({ len: 100, closed: true }, 0.9, 1.1)!;
  assert(t.strokeDasharray === "20 80" && t.strokeDashoffset === -90, "traceDash closed 0.9..1.1 = '20 80' @ -90 (ONE dash of exact period L: Skia joins it across the seam)");
  const pf = passingFlash(0.1, 0.5);
  assert(near(pf.tail, 0.45) && near(pf.head, 0.55), "passingFlash(.1,.5) = {0.45, 0.55} (manim ShowPassingFlash: head = p(1+w), tail = head-w)");
  assert(passingFlash(0.2, 0).head === 0 && near(passingFlash(0.2, 0).tail, -0.2) && near(passingFlash(0.2, 1).tail, 1) && near(passingFlash(0.2, 1).head, 1.2), "passingFlash enters from before the start and leaves past the end");
}

// --- property test: painted set == requested window ∩ pattern ---------------------------------------
let seed = 20261022;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
{
  let bad = 0, zeros = 0, long = 0, cases = 0;
  for (let c = 0; c < 1500; c++) {
    const L = 20 + rnd() * 900;
    const pat = rnd() < 0.5 ? undefined : [1 + rnd() * 20, 1 + rnd() * 20].slice(0, rnd() < 0.3 ? 1 : 2);
    const k = 1 + Math.floor(rnd() * 3);
    const cuts = Array.from({ length: 2 * k }, () => rnd() * L).sort((a, b) => a - b);
    const windows: [number, number][] = [];
    for (let i = 0; i < k; i++) if (cuts[2 * i + 1] - cuts[2 * i] > 0.2) windows.push([cuts[2 * i], cuts[2 * i + 1]]);
    const f = windowsDash({ len: L, pattern: pat }, windows);
    cases++;
    if (!f) { if (expected(L, windows, pat).some(Boolean)) bad++; continue; }
    const list = f.strokeDasharray.split(/\s+/).map(Number);
    if (list.some((v) => !(v > 0))) zeros++;
    if (!(list[list.length - 1] >= L)) long++;
    // tolerance: edge cells only (a window edge falls inside one raster cell)
    { const mm = mismatch(painted(f, L), expected(L, windows, pat)); const edges = 2 * windows.length + (pat ? 2 * Math.ceil(windows.reduce((a, [x, y]) => a + (y - x), 0) / Math.min(...pat)) : 0); if (mm > edges * 1.5 + 2) { bad++; if (process.env.DBG) console.log('BAD', L, pat, JSON.stringify(windows), mm, edges, f.strokeDasharray.slice(0,80)); } }
  }
  assert(cases === 1500 && bad === 0, `windowsDash painted set equals the window (clipped to the pattern) in 1,500 random cases (${bad} off by more than the edge cells)`);
  assert(zeros === 0, "no zero or negative dash entry in any case (a zero dash + round cap = a dot)");
  assert(long === 0, "the closing gap is >= the path length in every case (the neighbouring pattern repeat never touches [0,L])");
}
{
  // closed single window wrapping the seam, every width and phase
  let bad = 0;
  for (let c = 0; c < 400; c++) {
    const L = 50 + rnd() * 400, tail = rnd() * 3 - 1, w = 0.02 + rnd() * 0.95;
    const f = traceDash({ len: L, closed: true }, tail, tail + w)!;
    const got = painted(f, L), want = Array.from({ length: N }, (_, i) => { const s = ((i + 0.5) / N); const d = (((s - tail) % 1) + 1) % 1; return d < w; });
    if (mismatch(got, want) > 4) bad++;
  }
  assert(bad === 0, "traceDash closed wraps the seam: painted arc == the lap window in 400 random (tail, width) cases");
  let bad2 = 0;
  for (let c = 0; c < 400; c++) {
    const L = 50 + rnd() * 400, tail = rnd() * 1.6 - 0.3, w = 0.02 + rnd() * 0.8, f = traceDash({ len: L, closed: false }, tail, tail + w);
    const lo = Math.max(0, tail), hi = Math.min(1, tail + w);
    const want = Array.from({ length: N }, (_, i) => { const s = (i + 0.5) / N; return s >= lo && s < hi; });
    if (mismatch(painted(f, L), want) > 4) bad2++;
  }
  assert(bad2 === 0, "traceDash open clips to the path: painted arc == [max(0,tail), min(1,head)] in 400 random cases");
}

// --- trimDashAt == the legacy trimKeyframes visible set -----------------------------------------------
{
  const L = 100;
  const legacyAt = (spec: TrimSpec, p: number): boolean[] | null => {
    // sample the legacy keyframe list at eased progress p (piecewise-linear by offset), then paint
    const frames = trimKeyframes(spec, true);
    const offs = frames.map((f, i) => f.offset ?? (i === 0 ? 0 : i === frames.length - 1 ? 1 : NaN));
    let i = 0; while (i < frames.length - 2 && p > offs[i + 1]) i++;
    const a = frames[i], b = frames[i + 1], u = offs[i + 1] === offs[i] ? 0 : (p - offs[i]) / (offs[i + 1] - offs[i]);
    const da = a.strokeDasharray.split(/\s+/).map(Number), db = b.strokeDasharray.split(/\s+/).map(Number);
    if (da.length !== db.length) return null;
    const f: DashFrame = { strokeDasharray: da.map((v, j) => v + (db[j] - v) * u).join(" "), strokeDashoffset: a.strokeDashoffset + (b.strokeDashoffset - a.strokeDashoffset) * u };
    return painted(f, L);
  };
  let cases = 0, bad = 0;
  for (const closed of [false, true]) for (const mode of ["single", "both-ends", "middle-out"] as const) for (const direction of ["forward", "reverse"] as const) for (const anchor of [0, 0.25, 0.5, 0.75, 1]) for (const [from, to] of [[0, 1], [0.2, 0.8], [0.5, 1]]) {
    const spec: TrimSpec = { len: L, closed, anchor, direction, mode, from, to };
    for (let k = 1; k < 10; k++) {
      const p = k / 10, want = legacyAt(spec, p);
      if (!want) continue;
      cases++;
      const got = painted(trimDashAt(spec, p), L);
      if (mismatch(got, want) > 14) bad++;
    }
  }
  assert(cases > 600 && bad === 0, `trimDashAt paints the legacy trim windows (${cases} mode x direction x anchor x span x progress cases, ${bad} differ beyond the 0.35 % knee tolerance)`);
}

// --- the early-finish contract -----------------------------------------------------------------------
{
  // fraction of a stroke of length L painted when the pen has swept c of `drawReach`
  const coverAt = (L: number, tag: string, c: number) => { const f = windowsDash({ len: drawReach(L, tag) }, [[0, c * drawReach(L, tag)]]); return f ? painted(f, L).filter(Boolean).length / N : 0; };
  for (const L of [3.5, 12, 40, 100, 400, 2000]) quiet(coverAt(L, "path", 1) >= 0.999, `full reach paints >= 99.9 % (L=${L})`);
  assert(true, "a full draw paints >= 99.9 % of strokes from 3.5 to 2000 units");
  // eased progress at which the stroke is fully painted: 1/(1+eps) (+0.05 unit), i.e. the last 0.6 % for ellipses, 1.6 % for a 3.5-unit tick
  const done = (L: number, tag: string) => { let c = 0; while (c < 1 && coverAt(L, tag, c) < 0.9995) c += 0.001; return c; };
  const worst = Math.min(...[3.5, 12, 40, 100, 400, 2000].flatMap((L) => [done(L, "path"), done(L, "ellipse")]));
  assert(worst >= 0.97, `every length is complete only in the last 3 % of the eased clock (worst ${worst.toFixed(3)}; the old slack len+max(4,5 %) completed L=3.5 at 0.467 and L>=100 at 0.952 of the eased progress)`);
}

// ---------------------------------------------------------------------------------------------------------------
// the draw plan, through the real preset (linkedom has no layout and no getTotalLength: lengths fall back to the
// authored `pathLength`, which is exactly the dash-math contract of X12)
// ---------------------------------------------------------------------------------------------------------------
h.section("the draw plan: pathLength (X12), exit == enter backwards, transient list");
{
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  (globalThis as { document?: unknown }).document = document;
  const svgNS = "http://www.w3.org/2000/svg";
  const mk = (attrs: Record<string, string>, tag = "path") => { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n as unknown as SVGElement; };
  const dummy = {} as never;
  const ctx = { theme: FLUX_DARK, stage: { width: 640, height: 360 } };
  const track = { target: "x", preset: "drawOn", duration: 1000 } as Track;
  const stroke = mk({ d: "M 0 0 L 100 0", stroke: "#fff", fill: "none", pathLength: "1000" });
  const [anim] = PRESETS.drawOn([stroke as never], track, ctx);
  const linear = (x: number) => x;
  const half = anim.sample!(0.5, linear) as unknown as DashFrame;
  const reach = drawReach(1000, "path");
  assert(near(parseFloat(half.strokeDasharray), 0.5 * reach, 1e-6) && half.strokeDashoffset === 0, `pathLength="1000": the dash math runs in pathLength units: half the clock = ${half.strokeDasharray} of ${reach.toFixed(2)} (X12)`);
  const hidden = anim.keyframes[0] as unknown as DashFrame, full = anim.keyframes[1] as unknown as DashFrame;
  assert(hidden.strokeDasharray === String(Math.round((reach + 1) * 100) / 100) || near(parseFloat(hidden.strokeDasharray), reach + 1, 0.01), "pre-beat: the hidden gap is reach + 1 (paints nothing, no cap dot)");
  assert(near(parseFloat(full.strokeDasharray), reach, 0.01), "the full-draw keyframe sweeps drawReach, not the old len + max(4, 5 %) slack");
  assert(anim.transient?.includes("strokeDashoffset") && anim.transient.includes("strokeDasharray") && anim.transient.includes("transform"), "a draw declares its transient props (dropped at rest by the generic filter, not by preset name)");
  const [off] = PRESETS.drawOff([stroke as never], { ...track, preset: "drawOff" } as Track, ctx);
  const ease = (x: number) => x * x; // an asymmetric curve: the exit is the enter backwards with the MIRRORED curve
  const enter = (r: number) => (anim.sample!(r, ease) as unknown as DashFrame), exit = (r: number) => (off.sample!(r, ease) as unknown as DashFrame);
  const fracOf = (f: DashFrame) => parseFloat(f.strokeDasharray) / reach;
  assert(near(fracOf(exit(0.25)), 1 - ease(0.25), 1e-6) && near(fracOf(exit(0.9)), 1 - ease(0.9), 1e-6), "drawOff at t paints 1 - e(t): the legacy exit semantic for any curve (the enter backwards with the mirrored curve)");
  assert(near(fracOf(enter(0.3)), ease(0.3), 1e-6), "drawOn at raw .3 paints e(.3) of the stroke");
  assert(off.transient === undefined && enter(1.4) !== undefined, "exits rest hidden (no transient list); a spring's raw > 1 is clamped, never extrapolated");
  // an arrow: shaft + filled head on ONE pen clock, the head scaled from the shaft end
  const g = mk({}, "g");
  const shaft = mk({ x1: "0", y1: "0", x2: "100", y2: "0", stroke: "#000", fill: "none" }, "line"), head = mk({ points: "100,0 90,-5 90,5", fill: "#000", stroke: "none" }, "polygon");
  g.appendChild(shaft); g.appendChild(head);
  const arrow = PRESETS.drawOn([g as never], track, ctx);
  const headAnim = arrow.find((a) => a.node === (head as never))!, shaftAnim = arrow.find((a) => a.node === (shaft as never))!;
  const hs = (r: number) => (headAnim.sample!(r, linear) as unknown as { transform: string; transformOrigin: string });
  assert(headAnim && shaftAnim && /^scale\(0\.0001\)$/.test(hs(0.001).transform) && hs(0.001).transformOrigin === "90px 0px", "an arrow head joins its shaft's unit: hidden while the pen is on the shaft, scaled about its BASE midpoint");
  const shaftShare = 1 / (1 + 10); // linkedom has no getTotalLength: the shaft pen length falls back to 1; the head's is 10 (tip to base). The REAL ratio is pinned in the browser gate.
  assert(parseFloat(hs(shaftShare * 0.8).transform.slice(6)) <= 1e-3 && parseFloat(hs((shaftShare + 1) / 2).transform.slice(6)) > 0.45, "the head grows only after the shaft's slice of the clock, half grown mid-head");
  const filled = mk({ points: "0,0 40,0 40,30 0,30", fill: "#d14d41", stroke: "#222" }, "polygon");
  const [fa] = PRESETS.drawOn([filled as never], track, ctx);
  const fr = (r: number) => fa.sample!(r, linear) as unknown as DashFrame & { fillOpacity: number };
  assert(fr(0.03).strokeDasharray.includes(",") === false && parseFloat(fr(0.03).strokeDasharray) > 0 && fr(0.03).strokeDasharray.split(" ").length === 2, "a filled+stroked shape shows ink at 3 % of the clock (the old plan showed nothing for 58 %)");
  assert(fr(0.3).fillOpacity === 0 && fr(0.6).fillOpacity > 0.05 && fr(0.6).fillOpacity < 0.5 && near(fr(0.999).fillOpacity, 1, 0.02), "the fill stays 0 until 45 % of the clock, ramps after the outline, and lands at 1");
  void dummy;
}

// ---------------------------------------------------------------------------------------------------------------
// X13 — resolveTrack's tick compensation
// ---------------------------------------------------------------------------------------------------------------
h.section("X13: tick compensation in resolveTrack (one normaliser, both engines)");
const load = (p: string) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", p), "utf8")) as FluxPlotManifest;
const scatter = load("plots/mpl_scatter_FLUXPLOT.fluxplot.json");
{
  const t = (extra: Partial<Track> = {}): Track => ({ id: "t", target: "plot", part: "axis.x.ticks", preset: "drawOn", duration: 800, ...extra });
  const ctx0 = {};
  const rx = resolveTrack(t(), ctx0), ry = resolveTrack(t({ part: "axis.y.ticks" }), ctx0);
  assert(rx.duration === 320 && JSON.stringify(rx.stagger) === JSON.stringify({ totalMs: 480, by: "x", from: "start" }), "x ticks, 800 ms: duration 320 + stagger { totalMs 480, by x, from start }");
  assert(ry.duration === 320 && JSON.stringify(ry.stagger) === JSON.stringify({ totalMs: 480, by: "y", from: "start" }), "y ticks: by y, from START (fluxplot tick nodes carry no data-y, so ranks follow DOM order = bottom to top = the y spine's pen; the ruling's 'end' runs them against the pen, measured in the browser gate)");
  assert(rx.duration! + rx.stagger!.totalMs! === 800 && TICK_WINDOW_SHARE === 0.4, "the cue length d is kept exactly (duration' + totalMs == d)");
  const odd = resolveTrack(t({ duration: 333 }), ctx0);
  assert(odd.duration === 133 && odd.stagger!.totalMs === 200, "round(0.4 d): d = 333 -> 133 + 200");
  const dflt = resolveTrack(t({ duration: undefined }), ctx0);
  assert(dflt.duration === 128 && dflt.stagger!.totalMs === 192, "no authored duration: d is the preset default (320) -> 128 + 192");
  const same = (a: Track, b: Track) => JSON.stringify(a) === JSON.stringify(b);
  assert(same(resolveTrack(t({ stagger: { perMs: 0 } }), ctx0), t({ stagger: { perMs: 0 } })), "{ perMs: 0 } opts out: the track is exactly as stored");
  assert(same(resolveTrack(t({ stagger: { perMs: 30, by: "x" } }), ctx0), t({ stagger: { perMs: 30, by: "x" } })) && same(resolveTrack(t({ stagger: { totalMs: 300 } }), ctx0), t({ stagger: { totalMs: 300 } })), "an explicit stagger (Each or Total) is untouched");
  assert(same(resolveTrack(t({ preset: "fade" }), ctx0), t({ preset: "fade" })) && same(resolveTrack(t({ part: "axis.x.tick-labels" }), ctx0), t({ part: "axis.x.tick-labels" })) && same(resolveTrack(t({ part: "axis.x.spine" }), ctx0), t({ part: "axis.x.spine" })) && same(resolveTrack(t({ part: undefined }), ctx0), t({ part: undefined })), "other presets and other parts are untouched");
  assert(same(resolveTrack(t({ part: "axis.z.ticks" }), ctx0), t({ part: "axis.z.ticks" })), "only the x and y axes");
  const styled = { animStyles: [{ id: "st", name: "s", family: "appearance", track: { preset: "drawOn", stagger: { perMs: 50 } } }] } as never;
  assert(resolveTrack(t({ styleId: "st" }), styled).stagger?.perMs === 50 && resolveTrack(t({ styleId: "st" }), styled).duration === 800, "compensation runs AFTER style inheritance: a style-inherited stagger counts as present");
  const styledOptOut = { animStyles: [{ id: "st", name: "s", family: "appearance", track: { preset: "drawOn", stagger: { totalMs: 200 }, duration: 600 } }] } as never;
  assert(resolveTrack(t({ styleId: "st", duration: undefined, stagger: { perMs: 0 } }), styledOptOut).stagger?.perMs === 0, "an own { perMs: 0 } beats a style's stagger and keeps the opt-out");
  assert(resolveTrackRaw(t(), ctx0).duration === 800 && resolveTrackRaw(t(), ctx0).stagger === undefined, "resolveTrackRaw never compensates");
  assert(tickCompensation(t()) !== null && tickCompensation(t({ stagger: { perMs: 0 } })) === null, "tickCompensation is the single predicate");
  const orig = t(); const before = JSON.stringify(orig); resolveTrack(orig, ctx0); resolveTrack(orig, ctx0);
  assert(JSON.stringify(orig) === before, "resolving never mutates the stored track");
}
const stage: StageSize = { width: 640, height: 360 };
const mkSlide = (track: Partial<Track>, id = "tk"): Slide => ({
  id: "s", elements: [{ id: "plot", type: "plot", assetId: "a", x: 0, y: 0, width: 400, height: 300, rotation: 0 }],
  beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id, target: "plot", part: "axis.x.ticks", preset: "drawOn", start: 0, duration: 800, ...track } as Track] }],
} as unknown as Slide);
{
  // compile engine: resolved stagger, cue end, ranks; the authored slide is untouched
  const slide = mkSlide({}), authored = JSON.stringify(slide);
  const c = compileSlide(slide, stage, { plotManifest: () => scatter });
  const ct = c.cues[1].tracks[0];
  assert(ct.parts.length === 6, `axis.x.ticks resolves to its 6 tick leaves (${ct.parts.length})`);
  assert(ct.duration === 320 && ct.end - ct.start === 800 && c.cues[1].duration === 800, `compiler: window 320, cue END unchanged at 800 (end - start = ${ct.end - ct.start})`);
  const starts = ct.ranks.map((r) => staggerDelay(ct.track, r, ct.maxRank));
  assert(starts[0] === 0 && near(starts[5], 480, 1e-9) && starts.every((v, i) => !i || v > starts[i - 1]), `compiler: per-node delays ${starts.map((v) => Math.round(v)).join("/")} run along x`);
  assert(JSON.stringify(c.resolvedSlide.beats[1].tracks[0].stagger) === JSON.stringify({ totalMs: 480, by: "x", from: "start" }) && c.resolvedSlide.beats[1].tracks[0].duration === 320, "resolvedSlide (what the player and the Animator read) carries the resolved stagger");
  assert(JSON.stringify(slide) === authored && slide.beats[1].tracks[0].stagger === undefined, "the authored slide is never rewritten");
  const y = compileSlide(mkSlide({ part: "axis.y.ticks" }), stage, { plotManifest: () => scatter }).cues[1].tracks[0];
  assert(y.ranks[0] === 0 && y.ranks[y.ranks.length - 1] === y.maxRank, "compiler: the y ticks rank in DOM order (tick 1, the BOTTOM tick, first; the top tick last)");
  const opt = compileSlide(mkSlide({ stagger: { perMs: 0 } }), stage, { plotManifest: () => scatter }).cues[1].tracks[0];
  assert(opt.duration === 800 && opt.end - opt.start === 800 && opt.ranks.every((r) => staggerDelay(opt.track, r, opt.maxRank) === 0), "{ perMs: 0 }: one 800 ms window, every tick at once (the old look)");
  const exp = compileSlide(mkSlide({ stagger: { perMs: 40, by: "x" } }), stage, { plotManifest: () => scatter }).cues[1].tracks[0];
  assert(exp.duration === 800 && exp.end - exp.start === 800 + 5 * 40, "an explicit stagger keeps its own arithmetic");
  // BOTH engines agree: per-node delays through computeSlideAnims on a hand-built plot DOM
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  (globalThis as { document?: unknown }).document = document;
  const build = (axis: "x" | "y", values: number[]) => {
    const wrap = document.createElement("div"); (wrap as unknown as HTMLElement).dataset.elId = "plot";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); wrap.appendChild(svg);
    const ids = values.map((v, i) => {
      const n = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const id = partDomId("plot", `axis.${axis}.tick.${i + 1}`);
      n.setAttribute("id", id); n.setAttribute("d", "M0 0 L0 5"); n.setAttribute("stroke", "#000"); n.setAttribute("fill", "none"); void v; // no data-x / data-y: the real fluxplot tick nodes carry none, so ranks follow DOM order
      svg.appendChild(n); return id;
    });
    return { wrap: wrap as unknown as HTMLElement, ids };
  };
  const cam = document.createElement("div") as unknown as HTMLElement;
  const run = (slide: Slide, wrap: HTMLElement) => computeSlideAnims(slide, { elements: new Map([["plot", wrap]]) } as unknown as RenderedSlide, cam, stage, { theme: FLUX_DARK, plotManifest: () => scatter });
  const dx = build("x", [10, 20, 30, 40, 50, 60]);
  const sx = run(mkSlide({}), dx.wrap);
  const delays = dx.ids.map((id) => sx.find((s) => (s.node as unknown as { id: string }).id === id)!.delay);
  assert(JSON.stringify(delays.map(Math.round)) === JSON.stringify(starts.map(Math.round)) && sx.every((s) => s.duration === 320), `player: the same per-node delays (${delays.map(Math.round).join("/")}) and window 320 as the compiler`);
  const dy = build("y", [300, 250, 200, 150, 100, 50]); // tick 1 = the BOTTOM tick (DOM order runs bottom to top, like the y spine)
  const sy = run(mkSlide({ part: "axis.y.ticks" }), dy.wrap);
  const ydelays = dy.ids.map((id) => sy.find((s) => (s.node as unknown as { id: string }).id === id)!.delay);
  assert(ydelays[0] === 0 && ydelays.every((v, i) => !i || v > ydelays[i - 1]), `player: the y ticks run bottom to top (${ydelays.map(Math.round).join("/")}), following the pen`);
  const so = run(mkSlide({ stagger: { perMs: 0 } }), dx.wrap);
  assert(so.every((s) => s.delay === 0 && s.duration === 800), "player: { perMs: 0 } plays one 800 ms window");
  const ends = sx.map((s) => s.delay + s.duration);
  assert(Math.max(...ends) === 800, "player: the last tick ends at the cue end, 800 ms");
}

// ---------------------------------------------------------------------------------------------------------------
// X13 storage: the stored track is never rewritten by a resolved read (the write-back audit)
// ---------------------------------------------------------------------------------------------------------------
h.section("X13 audit: no write-back site stores the resolved stagger / duration");
{
  const mkDeck = (extra: Partial<Track> = {}) => {
    const deck: Deck = slideOps.createDeck({ id: "d", title: "d" });
    const sid = slideOps.addSlide(deck, { id: "s", layout: "blank" }).id;
    const pid = slideOps.addPlotToSlide(deck, sid, { assetId: "a", x: 0, y: 0, width: 400, height: 300 })!;
    const bid = slideOps.addBeat(deck, sid, { label: "build", advance: "click" })!.id;
    slideOps.setAnimation(deck, sid, bid, { id: "tick1", target: pid, part: "axis.x.ticks", preset: "drawOn", duration: 800, ...extra } as Track);
    slideOps.setAnimation(deck, sid, bid, { id: "line1", target: pid, part: "axis.x.spine", preset: "drawOn", duration: 600 } as Track);
    const track = () => slideOps.slideById(deck, sid)!.beats.flatMap((b) => b.tracks).find((x) => x.id === "tick1")!;
    return { deck, sid, pid, bid, track };
  };
  const manifestFor = () => scatter;
  { const m = mkDeck(); slideOps.setTrack(m.deck, m.sid, "tick1", { duration: 500 }, manifestFor);
    assert(m.track().duration === 500 && m.track().stagger === undefined, "editing a tick track's duration stores the typed duration and NO stagger"); }
  { const m = mkDeck(); const st = slideOps.styleFromTrack(m.deck, m.sid, "tick1", "Ticks")!;
    assert(st.track.duration === 800 && st.track.stagger === undefined, "a style made from a tick track stores the STORED how (800 ms, no stagger)");
    slideOps.deleteAnimStyle(m.deck, st.id, { detach: true });
    assert(m.track().duration === 800 && m.track().stagger === undefined, "detaching it (materializeStyle) leaves the stored track clean"); }
  { const m = mkDeck();
    cascadeTracks(m.deck, m.sid, ["line1", "tick1"], { property: "duration", mode: "add", delta: 100, order: "list" } as never);
    assert(m.track().duration === 1000 && m.track().stagger === undefined, `a duration cascade (+100 x rank 2 on the second lane) steps from the STORED 800 (-> ${m.track().duration}; from the 320 ms window it would be 520) and stores no stagger`); }
  { const m = mkDeck(); const r = alignTrackEdges(m.deck, m.sid, m.bid, ["tick1"], "end", 1200, { mode: "resize", manifestFor });
    assert(r.refused.length === 0 && m.track().duration === 1200 && m.track().stagger === undefined, `align-resize plans from the stored track: duration ${m.track().duration} (not derived from the 320 ms window), no stagger stored`); }
  { const m = mkDeck();
    inheritTrack(m.deck, m.sid, "tick1", ["line1"], { manifestFor });
    const line = slideOps.slideById(m.deck, m.sid)!.beats[1].tracks.find((x) => x.id === "line1")!;
    assert(line.duration === 800 && line.stagger === undefined, "inherit copies the stored how onto another track (800 ms, no stagger)"); }
  { // saved presets / templates are STORAGE (review F2): the GUI save sites read the raw beat (PropertiesPane.doSavePreset, AnimLibrary.saveTemplateFromSelection)
    const m = mkDeck();
    const slide = slideOps.slideById(m.deck, m.sid)!;
    const tracksOf = (mode: "view" | "raw") => slide.beats.flatMap((b) => resolveBeat(b, m.deck, manifestFor, mode).tracks).filter((t) => t.id === "tick1");
    const viewT = tracksOf("view")[0], rawT = tracksOf("raw")[0];
    assert(viewT.stagger !== undefined && viewT.duration === 320, "control: the VIEW beat carries the compensated 320 ms + stagger (so a save from it would leak)");
    const preset = makeAnimPreset("ticks", rawT);
    assert(preset.track.duration === 800 && preset.track.stagger === undefined, "a preset saved from the RAW beat holds the stored 800 ms and no stagger");
    const tpl = deriveTemplateSlots(tracksOf("raw"), { elements: slide.elements, manifestFor });
    assert(tpl.slots.length === 1 && tpl.slots[0].track.duration === 800 && tpl.slots[0].track.stagger === undefined, "a template slot derived from the RAW beat holds the stored 800 ms and no stagger");
    const leak = deriveTemplateSlots(tracksOf("view"), { elements: slide.elements, manifestFor });
    assert(leak.slots[0]?.track.stagger !== undefined, "control: deriving from the VIEW beat WOULD store the stagger (the audit has teeth)");
    const src = (f: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/shell/modes/slide/animator", f), "utf8");
    assert(/resolveBeat\([^]*?"raw"\)\.tracks\)\.filter\(t => t\.id && ids\.includes/.test(src("AnimLibrary.svelte")), "AnimLibrary.saveTemplateFromSelection reads resolveBeat(..., \"raw\")");
    assert(/doSavePreset[^]*?"raw"\)\.tracks/.test(src("PropertiesPane.svelte")), "PropertiesPane.doSavePreset reads resolveBeat(..., \"raw\")");
  }
  { const m = mkDeck({ stagger: { perMs: 0 } }); slideOps.setTrack(m.deck, m.sid, "tick1", { duration: 700 }, manifestFor);
    assert(m.track().duration === 700 && m.track().stagger?.perMs === 0, "an opted-out track keeps its { perMs: 0 } through an edit"); }
  { const m = mkDeck(); slideOps.setTrack(m.deck, m.sid, "tick1", { stagger: { totalMs: 300 } }, manifestFor);
    const t = m.track();
    assert(t.stagger?.totalMs === 300 && t.stagger.perMs === undefined && t.duration === 800, "an explicit stagger edit starts from the STORED track (no inherited compensation) and is stored as given"); }
}
await h.done();
