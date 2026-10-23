#!/usr/bin/env -S node --import tsx
// WP 2.2 (T6): the PURE half of the fade-free vocabulary and emphasis. Pins the new presets (scaleIn, scaleOut, pulse, encircle), the
// single highlight/dim formulas (legacy bit-exact, new tracks continuous), the origin and bar-baseline geometry, the pulse peak law and
// its manimgl identity, the encircle geometry, the authored defaults (Q3a/Q3b, X1), the group origin, the PPTX page/twin rules, the V2
// plot-build point child, and that an OLD explicit track still plays exactly as it was made (X1b).
// The Chromium half (origins on real SVG, leaf-transform composition, legacy scale pivots, seek purity) is verify-slide-part-origin.ts.
//   Run: node --import tsx scripts/verify-appear-emphasis.ts
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import { PRESETS } from "../src/lib/slide/player/presets";
import {
  PRESET_CATALOG, EDITABLE_PRESETS, presetDef, presetParam, highlightOpacityAt, dimOpacityAt, authoredFields, QUICK_SMOOTH, PRESET_PARAMS, paramDiagnostics,
} from "../src/lib/slide/presetCatalog";
import { barGrow, growLocal, growOrigin, growStage, groupPoint, pulsePeak, pulseAuto } from "../src/lib/slide/growOrigin";
import { encircleShape, encircleParams, ENCIRCLE_DEFAULTS } from "../src/lib/slide/encircleGeometry";
import { EASING_TOKENS, resolveCurve } from "../src/lib/slide/curves";
import { smoothstep } from "../src/lib/motion/tokens";
import { compileSlide } from "../src/lib/slide/compile";
import { pptxPages } from "../src/lib/slide/export/pptxBuilds";
import { createDeck } from "../src/lib/slide/ops";
import { addAppearanceTracks } from "../src/lib/slide/animateSelection";
import { suggestElementTrack, autoAnimatePlot, elementEnterPreset, elementExitPreset, V2_PACE, CLASSIC_PACE } from "../src/lib/slide/autobuild";
import { makeModel3dElement } from "../src/lib/model3d/make";
import { inspectGlb, writeGlb } from "../src/lib/model3d/glbCore.mjs";
import type { Scene3dManifest, Model3dAsset } from "../src/lib/model3d/types";

const h = harness("verify-appear-emphasis");
const near = (a: number, b: number, e = 1e-12) => Math.abs(a - b) <= e;
const stage = { width: 640, height: 360 };
const fake = (svg = false) => ({ namespaceURI: svg ? "http://www.w3.org/2000/svg" : "", style: {} as Record<string, string>, id: "", getAttribute: () => null });
const ctx = (extra = {}) => ({ theme: {} as never, stage, ...extra }) as never;
const run = (preset: string, params: Record<string, unknown> | undefined, extra = {}, svg = false) =>
  PRESETS[preset]([fake(svg) as never], { target: "x", preset, ...(params ? { params } : {}) } as never, ctx(extra))[0];

h.section("A. the catalog: the new vocabulary, and the old one untouched");
h.eq(["scaleIn", "scaleOut", "pulse", "encircle"].map((n) => [presetDef(n).phase, !!presetDef(n).ephemeral, !!presetDef(n).onsetExempt]),
  [["enter", false, false], ["exit", false, false], ["emphasis", true, true], ["emphasis", true, true]], "scaleIn = enter, scaleOut = exit; pulse and encircle = emphasis + ephemeral + onset-exempt");
h.eq([PRESET_CATALOG.scaleIn.wrapperProps, PRESET_CATALOG.scaleOut.wrapperProps, PRESET_CATALOG.pulse.wrapperProps, PRESET_CATALOG.encircle.wrapperProps], [["transform"], ["transform"], ["transform"], []],
  "scaleIn / scaleOut / pulse animate ONLY transform (they never fade); encircle animates no node (its band is an overlay)");
h.eq(["scaleIn", "scaleOut", "pulse", "encircle", "growBaseline"].map((n) => presetDef(n).label), ["Scale in", "Scale out", "Pulse", "Circle it", "Grow bars"], "plain labels; growBaseline relabelled so 'Grow' is not said twice");
h.ok(["scaleIn", "scaleOut", "pulse", "encircle"].every((n) => EDITABLE_PRESETS.includes(n as never)), "all four are editable (the Animator select iterates EDITABLE_PRESETS)");
h.eq([...EASING_TOKENS], ["smooth", "standard", "enter", "exit", "linear"], "NO new easing token (schema enum, validators and the MCP lists are untouched)");
// X1 authored rows
h.eq(["scaleIn", "scaleOut", "pulse", "encircle"].map((n) => { const f = authoredFields(n); return [f.duration, f.curve ?? f.easing]; }),
  [[600, QUICK_SMOOTH], [500, QUICK_SMOOTH], [700, "smooth"], [900, "smooth"]], "authored rows: scaleIn 600 / scaleOut 500 quick smooth; pulse 700 / encircle 900 plain smooth (onset-exempt, X2)");
h.eq(["scaleIn", "scaleOut", "pulse", "encircle"].map((n) => authoredFields(n).params), Array(4).fill(undefined), "the new presets author no params (auto origin, auto peak, the table's band)");
h.eq(authoredFields("highlight").params, { lead: 0.25 }, "highlight authors lead 0.25 (X1a): the ramp into the dip");
h.eq([PRESET_CATALOG.scaleIn.autoBuildDurationMs, PRESET_CATALOG.scaleOut.autoBuildDurationMs], [500, undefined], "scaleIn carries the 500 ms plot-build floor (X1c); scaleOut none");

h.section("B. pulse: manimgl there_and_back, token-free, size-aware, stage-clamped");
const glSmooth = (t: number) => { const s = 1 - t; return t ** 3 * (10 * s * s + 5 * s * t + t * t); };
const glThereBack = (t: number) => glSmooth(t < 0.5 ? 2 * t : 2 * (1 - t));
const box = (x: number, y: number, width: number, height: number) => ({ type: "rect", x, y, width, height, rotation: 0 });
const scaleOf = (f: Record<string, unknown>) => Number(String(f.transform).match(/scale\(([^)]+)\)/)![1]);
{
  const na = run("pulse", undefined, { element: box(100, 100, 160, 100) }), k = scaleOf(na.keyframes[1]);
  h.eq(na.keyframes.map((f) => [f.transform, f.offset ?? null]), [["scale(1)", null], ["scale(1.12)", 0.5], ["scale(1)", null]], "keyframes [scale(1), scale(1.12)@0.5, scale(1)]: scale = paints in place, rest = identity");
  // the REAL resolved `smooth` curve (what a track plays), not only the token function: a drift of either trips the identity
  const realSmooth = resolveCurve({ easing: "smooth" } as never).fn;
  h.ok(Array.from({ length: 1001 }, (_, i) => Math.abs(realSmooth(i / 1000) - smoothstep(i / 1000))).every((d) => d < 1e-14), "resolveCurve(smooth) is the token smoothstep");
  let err = 0, mono = true, prev = 1;
  for (let i = 0; i <= 1000; i++) {
    const raw = i / 1000, got = scaleOf(na.sample!(raw, realSmooth) as never);
    err = Math.max(err, Math.abs((got - 1) / (k - 1) - glThereBack(raw)));
    if (raw <= 0.5) { if (got < prev - 1e-12) mono = false; prev = got; }
  }
  h.ok(err < 1e-14, `pulse(smooth) == manimgl there_and_back over 1001 samples (max err ${err.toExponential(1)}; the resolved curve, to ~1e-15)`);
  h.ok(mono && near(scaleOf(na.sample!(0.5, smoothstep) as never), k) && near(scaleOf(na.sample!(0.25, (x) => x) as never), 1 + (k - 1) * 0.5), "peak exactly k at 0.5; a linear easing gives the triangle wave");
  const a = [0.3, 0.9, 0.1, 0.5].map((r) => scaleOf(na.sample!(r, smoothstep) as never)), b = [0.1, 0.5, 0.3, 0.9].map((r) => scaleOf(na.sample!(r, smoothstep) as never));
  h.ok(near(a[0], b[2]) && near(a[1], b[3]) && near(a[2], b[0]) && near(a[3], b[1]), "pure in raw progress: call order (forward / reverse / shuffled seeks) cannot matter");
  h.ok(scaleOf(na.sample!(0, smoothstep) as never) === 1 && scaleOf(na.sample!(1, smoothstep) as never) === 1, "starts and lands on scale(1): no pop");
}
h.eq([pulseAuto({ w: 160, h: 100 }), pulseAuto({ w: 14, h: 14 }), pulseAuto({ w: 120, h: 30 }), pulseAuto({ w: 400, h: 5 }), pulseAuto(undefined)], [1.12, 1.3, 1 + 8 / 30, 1.3, 1.12],
  "size-aware peak clamp(1 + 8/min(w,h), 1.12, 1.3): a 14-unit dot grows 4.2 units, a 160x100 box 12 %");
h.eq([pulsePeak(undefined, { x: 10, y: 10, w: 620, h: 340 }, stage), pulsePeak(undefined, { x: 0, y: 0, w: 640, h: 360 }, stage), pulsePeak(1.5, { x: 270, y: 155, w: 100, h: 50 }, stage), pulsePeak(0.5, { x: 270, y: 155, w: 100, h: 50 }, stage), pulsePeak(Number.NaN, { x: 270, y: 155, w: 100, h: 50 }, stage), pulsePeak(99, { x: 270, y: 155, w: 20, h: 20 }, stage)],
  [1.0129032258064516, 1, 1.5, 1.16, 1.16, 3], "stage clamp (6-unit margin): a 620x340 box centred -> 1.0129, full-stage -> 1; authored 1.5 honoured; scale <= 1 / NaN -> auto; authored capped at 3");
h.ok(pulsePeak(undefined, { x: 10, y: 180, w: 620, h: 0 }, stage) < 1.12 && pulsePeak(undefined, { x: 300, y: 10, w: 0, h: 340 }, stage) < 1.12 && pulsePeak(undefined, { x: 270, y: 180, w: 100, h: 0 }, stage) === 1.12,
  "a horizontal / vertical line (zero extent on one axis) is stage-clamped on its long axis (620 of 640 -> k < 1.12) and unclamped when it fits");
h.ok(near(pulsePeak(2, { x: 300, y: 150, w: 100, h: 60 }, stage, { x: 350, y: 180 }), 2) && pulsePeak(3, { x: 520, y: 150, w: 100, h: 60 }, stage, { x: 400, y: 180 }) < 2, "about-point clamp: the grown box about a group point also stays on stage");
h.eq(run("pulse", { about: { x: 300, y: 200 } }, { element: box(0, 0, 100, 50) }).origin, "300.00px 200.00px", "pulse about a stage point: the effects-layer origin is that point in the element's local frame");
h.eq(run("pulse", { about: { x: 300, y: 200 } }, { element: box(0, 0, 100, 50) }, true).origin, "50% 50%", "...but an SVG part keeps its own fill-box centre");
h.eq(run("pulse", undefined, { element: box(0, 0, 100, 50) }).origin, "50% 50%", "default: the pulse pivots about the target's own centre");
h.eq(run("pulse", { scale: 1.5 }, { element: box(100, 100, 160, 100) }).keyframes[1].transform, "scale(1.5)", "authored scale wins");
{
  // a plot PART is sized by its own box (the whole plot's 500 x 300 would give every marker the 1.12 floor)
  const plot = box(70, 30, 500, 300), marker = { x: 200, y: 150, w: 6, h: 6 }, bar = { x: 300, y: 100, w: 40, h: 200 };
  const k = (partBox?: unknown) => scaleOf(run("pulse", undefined, { element: plot, ...(partBox ? { partBox: () => partBox } : {}) }, true).keyframes[1]);
  h.eq([k(), k(marker), k(bar)], [1.12, 1.3, 1 + 8 / 40], "pulse on a plot part: a 6-unit marker swells to 1.3x, a 40-unit-wide bar to 1.2x, and with no part box the whole plot's 1.12");
}
h.eq(run("pulse", { about: "group" }, { element: box(0, 0, 100, 50), group: { x: 300, y: 200 } }).origin, "300.00px 200.00px", "about: group = the group point the player resolved");
h.eq(run("pulse", { about: "group" }, { element: box(0, 0, 100, 50) }).origin, "50% 50%", "about: group with nothing else pulsing = its own centre");

h.section("C. highlight / dim: ONE formula; saved tracks bit-exact; new tracks continuous");
{
  let exact = true, parity = 0;
  for (const prior of [1, 0.3, 0.8]) for (let i = 0; i <= 20; i++) { const at = i / 20; if (highlightOpacityAt(at, prior, 0.4, 0) !== 0.4 + 0.6 * at) exact = false; }
  h.ok(exact, "lead 0 (every saved highlight): highlightOpacityAt === .4 + .6 * at for every prior (compile.ts used this literal; the model3d part gates pin it)");
  h.ok([0, 0.25, 0.5, 0.75, 1].every((at) => dimOpacityAt(at, 1, 0.3) === 1 - 0.7 * at), "dim from a fully visible node: bit-exact the old 1 - .7 * at");
  for (const lead of [0, 0.25]) for (const prior of [1, 0.3, 0.4, 0.8]) for (let i = 0; i <= 20; i++) {
    const at = i / 20, frames = run("highlight", { lead }, { priorOpacity: () => prior }).keyframes;
    const pts = frames.map((f, j) => ({ at: f.offset ?? j / (frames.length - 1), v: Number(f.opacity) }));
    let j = 0; while (j < pts.length - 2 && at > pts[j + 1].at) j++;
    const got = pts[j].v + (pts[j + 1].v - pts[j].v) * (at - pts[j].at) / (pts[j + 1].at - pts[j].at);
    if (!near(got, highlightOpacityAt(at, lead > 0 ? prior : 1, 0.4, lead))) parity++;
  }
  h.eq(parity, 0, "player keyframes == highlightOpacityAt for lead in {0, .25} x 4 priors x 21 points (player and compile.sample cannot disagree)");
  let dimParity = 0;
  for (const prior of [1, 0.3, 0.6]) for (let i = 0; i <= 20; i++) {
    const at = i / 20, f = run("dim", undefined, { priorOpacity: () => prior }).keyframes;
    if (!near(Number(f[0].opacity) + (Number(f[1].opacity) - Number(f[0].opacity)) * at, dimOpacityAt(at, prior, 0.3))) dimParity++;
  }
  h.eq(dimParity, 0, "player dim keyframes == dimOpacityAt for 3 priors x 21 points");
  h.ok(highlightOpacityAt(0, 1, 0.4, 0) === 0.4 && highlightOpacityAt(0, 1, 0.4, 0.25) === 1 && highlightOpacityAt(0, 0.3, 0.4, 0.25) === 0.3, "the beat-start jump: a saved highlight 1 -> .4 (kept), a new one starts at the prior (1 and .3 both continuous)");
  h.ok(near(highlightOpacityAt(0.25, 1, 0.4, 0.25), 0.4) && near(highlightOpacityAt(1, 0.3, 0.4, 0.25), 1) && near(highlightOpacityAt(0.25, 0.3, 0.4, 0.25), 0.3), "new highlight: dip at lead (min(prior, level)), ends at 1; a dimmed node (0.3) never dips below where it is");
  h.ok(dimOpacityAt(0, 0.3, 0.3) === 0.3 && dimOpacityAt(0, 1, 0.3) === 1 && dimOpacityAt(1, 0.6, 0.3) === 0.3, "dim starts at the node's current opacity and ends at its level (a dim of a dimmed node does not jump to 1)");
  // X1b: an OLD explicit track plays as it was made
  const old = run("highlight", undefined, { priorOpacity: () => 0.3 }).keyframes;
  h.eq(old.map((f) => [f.opacity, f.offset ?? null]), [[0.4, null], [1, null]], "an old highlight (no lead) still jumps to .4 and climbs: stored tracks are never rewritten, the player never reads a profile");
}

h.section("D. authored params read through the ONE table");
h.eq([presetParam({ preset: "scaleIn" }, "from"), presetParam({ preset: "scaleIn", params: { from: "s" } }, "from"), presetParam({ preset: "scaleIn", params: { from: { x: 3, y: 4 } } }, "from"), presetParam({ preset: "scaleIn", params: { from: { x: "3", y: 4 } } }, "from"), presetParam({ preset: "scaleIn", params: { from: 7 } }, "from")],
  ["auto", "s", { x: 3, y: 4 }, "auto", "auto"], "scaleIn.from: a word or a stage point; anything malformed reads as auto");
h.eq([presetParam({ preset: "scaleIn", params: { spin: NaN } }, "spin"), presetParam({ preset: "scaleIn", params: { spin: 1e9 } }, "spin"), presetParam({ preset: "scaleOut", params: { spin: -1e9 } }, "spin")], [0, 720, -720], "spin: NaN -> none, clamped to +-720");
h.eq([presetParam({ preset: "pulse" }, "scale"), presetParam({ preset: "pulse", params: { scale: 0.4 } }, "scale"), presetParam({ preset: "pulse", params: { scale: 9 } }, "scale"), presetParam({ preset: "pulse", params: { scale: "2" } }, "scale")], [null, 1, 3, null], "pulse.scale: auto when absent / malformed, clamped to [1, 3]");
h.eq(paramDiagnostics({ preset: "scaleIn", params: { from: "group", spin: 30 } }), [], "the vocabulary's keys are known to the table (no 'Unknown option')");

h.section("E. origins and bars");
const m = { series: [{ svg: { bars: ["a", "b", "c"] }, bar: { orientation: "horizontal", length: [3, -2, 4] } }, { svg: { bars: ["v0", "v1"] }, bar: { orientation: "vertical", length: [5, -1] } }] } as never;
h.eq([barGrow(m, "a"), barGrow(m, "b"), barGrow(m, "v0"), barGrow(m, "v1")], [{ fn: "scaleX", origin: "0% 50%" }, { fn: "scaleX", origin: "100% 50%" }, { fn: "scaleY", origin: "50% 100%" }, { fn: "scaleY", origin: "50% 0%" }], "bar table: horizontal +/-, vertical +/- (fill-box percentages of the bar's OWN box)");
const arrow = { type: "line", x: 120, y: 170, width: 400, height: 60, x1: 0, y1: 50, x2: 400, y2: 10, arrowEnd: true, arrowStart: false };
const rect = { type: "rect", x: 100, y: 100, width: 200, height: 100, rotation: 0 };
h.eq([growOrigin("auto", arrow), growStage("tail", arrow), growStage("tail", { ...arrow, arrowEnd: false, arrowStart: true }), growOrigin("auto", rect), growOrigin("s", rect), growOrigin(undefined, rect), growOrigin("auto", { ...arrow, arrowStart: true })],
  ["0.00px 40.00px", { x: 120, y: 220 }, { x: 520, y: 180 }, "50% 50%", "100.00px 100.00px", "50% 50%", "50% 50%"], "origins: arrow tail (head excluded), start-headed arrow (its far end), plain rect -> centre, compass s, a double-headed arrow -> centre");
{
  const rot = { ...rect, rotation: 37 }, pt = { x: 250, y: 120 }, l = growLocal(pt, rot)!, a = 37 * Math.PI / 180, cx = 200, cy = 150;
  const back = { x: cx + (l.x + 100 - cx) * Math.cos(a) - (l.y + 100 - cy) * Math.sin(a), y: cy + (l.x + 100 - cx) * Math.sin(a) + (l.y + 100 - cy) * Math.cos(a) };
  h.ok(near(back.x, pt.x, 1e-9) && near(back.y, pt.y, 1e-9), "a stage point is inverse-rotated into a rotated element's local frame (round trip < 1e-9)");
  const gp = groupPoint([{ type: "rect", x: 150, y: 90, width: 340, height: 180 }, { type: "text", x: 166, y: 100, width: 200, height: 40 }, { type: "text", x: 300, y: 220, width: 180, height: 40 }]);
  h.eq(gp, { x: 320, y: 180 }, "group origin = centre of the rotated-AABB union of the elements entering together");
  h.eq(growOrigin("group", { type: "text", x: 166, y: 100, width: 200, height: 40, rotation: 0 }, gp), "154.00px 80.00px", "from:'group' on a member = the shared point in its local frame");
  h.eq(growOrigin("group", arrow, undefined), growOrigin("auto", arrow), "'group' with no group point (nothing else enters with it) reads as 'auto': an arrow keeps its tail");
}
h.eq(run("scaleIn", { spin: 90 }).keyframes.map((f) => f.transform), ["scale(0) rotate(-90deg)", "scale(1) rotate(0deg)"], "spin: scale(0) rotate(-spin) -> scale(1) rotate(0) (manim's spiral_path)");
h.ok(!run("scaleIn", undefined).keyframes.some((f) => "opacity" in f) && !run("scaleOut", undefined).keyframes.some((f) => "opacity" in f), "scaleIn / scaleOut keyframes carry NO opacity channel");
{
  const so = run("scaleOut", { to: "s" }, { element: rect });
  h.eq([so.enter, so.keyframes.map((f) => f.transform), so.origin], [false, ["scale(1)", "scale(0)"], "100.00px 100.00px"], "scaleOut: scale(1) -> scale(0) about params.to, an exit (the symmetric, fade-free Disappear)");
  const si = run("scaleIn", { from: "se" }, { element: rect }, true);
  h.eq(si.origin, "100% 100%", "a plot part takes a compass word as a point of its own fill-box");
  h.eq(run("scaleIn", { from: "tail" }, { element: arrow }, true).origin, "50% 50%", "...and falls back to its centre for the whole-element-only words");
  h.eq(run("scaleIn", undefined, { element: arrow }).origin, "0.00px 40.00px", "a whole arrow: auto = its tail");
}

h.section("F. encircle geometry (pure)");
{
  const p = encircleParams(undefined), r = { type: "rect", x: 220, y: 120, width: 200, height: 110, rotation: 40 };
  h.eq(p, ENCIRCLE_DEFAULTS, "the defaults are the table's (6 / 6 / 3.5 / 0.3)");
  const s = encircleShape({ el: r }, p)!, m0 = p.gap + p.width / 2;
  h.ok(s.rotation === 40 && s.cx === 320 && s.cy === 175 && near(s.w, 200 + 2 * m0) && near(s.h, 110 + 2 * m0) && s.x === 220 - m0, "rotated rect: the band is the rect's own box + gap + half the stroke, rotated 40 degrees about its centre");
  const t = encircleShape({ el: { type: "text", x: 70, y: 140, width: 500, height: 50, rotation: 0 }, ink: { x: 130, y: 6, w: 240, h: 38 } }, p)!;
  h.ok(near(t.w, 240 + 2 * m0) && t.x === 70 + 130 - m0, "text: the INK extent, not the 500-unit box");
  const l = encircleShape({ el: { type: "line", x: 0, y: 0, width: 0, height: 0, strokeWidth: 4, rotation: 25 }, boxes: [{ x: 100, y: 150, w: 300, h: 130 }] }, p)!;
  h.ok(l.rotation === 0 && near(l.x, 100 - (p.gap + 2 + p.width / 2)) && near(l.w, 300 + 2 * (p.gap + 2 + p.width / 2)), "line / path: union of the stage outlines (rotation applied, arrowhead inside) + half the stroke");
  h.eq([encircleParams({ gap: -5, radius: NaN, width: 99, window: 7 }), encircleParams({ gap: 1e9 })].map((q) => [q.gap, q.radius, q.width, q.window]), [[0, 6, 12, 1], [60, 6, 3.5, 0.3]], "free-form params are clamped (no negative sizes, NaN or 1e9 gaps reach the DOM)");
  h.ok(encircleShape({ el: { type: "line", x: 0, y: 0, width: 0, height: 0 } }, p) === undefined, "a line with no outlines yields no band (no NaN rect)");
  h.eq(PRESETS.encircle([fake() as never], { target: "x", preset: "encircle" } as never, ctx()), [], "encircle animates no node: the player builds its overlay controller");
}

h.section("G. compile: ephemeral presets leave no trace; model3d part diagnostics");
{
  const el = (id: string) => ({ rotation: 0, id, type: "rect", x: 10, y: 10, width: 100, height: 50, fill: "#205EA6", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  const slide = { id: "s", name: "s", groups: {}, elements: [el("a"), el("b")], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "p", target: "a", preset: "pulse", duration: 600 }, { id: "e", target: "b", preset: "encircle", duration: 600 }, { id: "s", target: "a", preset: "scaleIn", start: 700, duration: 300 }] }] } as never;
  const c = compileSlide(slide, stage, {});
  const mid = c.sample(1, 300).presentation;
  h.ok(mid.elementStates["b"] === undefined, "mid-encircle: the compiled presentation holds NO state for its target (ephemeral = no appearance state)");
  h.eq([mid.elementStates["a"]?.visible, mid.elementStates["a"]?.opacity], [false, 0], "mid-pulse: `a` is still hidden, decided by its LATER scaleIn alone (a pulse before an entrance does not make it visible)");
  h.ok(c.issues.length === 0, `no diagnostics for pulse / encircle / scaleIn on flat shapes (${c.issues.length})`);
  const manifest: Scene3dManifest = { spec: "fluxplot/scene3d", schemaVersion: "0.1.0", glb: "neuron.glb", parts: [{ id: "neuron.soma", node: "soma", role: "soma", series: "neuron" }, { id: "axes.x.label", role: "axis-label", text: "X" }] };
  const bytes = writeGlb({ parts: [{ name: "soma", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] });
  const asset: Model3dAsset = { id: "neuron", name: "Neuron", kind: "glb", path: "assets/neuron.glb", bytes: bytes.length, sha256: "a".repeat(64), model: inspectGlb(bytes) };
  const d = createDeck({ withTitleSlide: false }); d.assets = [asset];
  const model = makeModel3dElement(asset, { id: "M" });
  const m3 = { id: "m", name: "m", groups: {}, elements: [model], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [
    { id: "x", target: "M", part: "neuron.soma", preset: "scaleIn" }, { id: "y", target: "M", part: "neuron.soma", preset: "pulse" }, { id: "z", target: "M", part: "neuron.soma", preset: "fade" },
    { id: "w", target: "M", preset: "scaleIn" }] }] } as never;
  const why = compileSlide(m3, stage, { modelManifest: () => manifest }).issues.filter((i) => i.target === "M" && !/overlap/.test(i.reason)).map((i) => `${i.trackId}:${i.reason.slice(0, 18)}`);
  h.eq(why, ["x:Scale in has no 3D", "y:Pulse acts on the "], "scaleIn / pulse on a model's MESH PARTS raise a diagnostic (mesh opacity comes from compile.sample: scaleIn would silently fade); fade and a whole-model scaleIn do not");
}

h.section("H. PowerPoint export");
{
  const d = createDeck({ id: "pp", title: "pp", withTitleSlide: false }); d.stage = stage;
  const box2 = (id: string, x: number, y: number) => ({ rotation: 0, id, type: "rect", name: id, x, y, width: 100, height: 60, fill: "#205EA6", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  const arrowL = { rotation: 0, id: "ar", type: "line", name: "ar", x: 100, y: 250, width: 200, height: 20, x1: 0, y1: 10, x2: 200, y2: 10, stroke: "#111111", strokeWidth: 3, arrowStart: false, arrowEnd: true, arrowStyle: "filled" };
  const tr = (target: string, preset: string, extra = {}) => ({ id: `${target}-${preset}`, target, preset, duration: 600, easing: "linear", ...extra });
  const pages = (beats: unknown[], elements = [box2("a", 0, 100), box2("b", 200, 100), box2("c", 400, 100), arrowL]) => { d.slides = [{ id: "s", name: "s", groups: {}, elements, beats: [{ id: "b0", tracks: [] }, ...beats] }] as never; return pptxPages({ deck: d, plots: {}, assets: {}, assetSizes: {} } as never, "animated"); };
  h.eq(pages([{ id: "b1", tracks: [tr("a", "pulse")] }]).length, 1, "a click that only pulses exports NO extra page (it was a duplicate 'step 1')");
  h.eq(pages([{ id: "b1", tracks: [tr("a", "encircle"), tr("b", "pulse")] }]).length, 1, "pulse + encircle only: still one page");
  h.eq(pages([{ id: "b1", tracks: [tr("a", "pulse"), tr("c", "fade")] }]).length, 2, "pulse + fade in one click: the fade's page, the pulse adds none");
  h.eq(pages([{ id: "b1", tracks: [tr("a", "pulse")] }, { id: "b2", tracks: [tr("b", "fade")] }]).length, 2, "a pulse-only click between real clicks is skipped (no empty step)");
  const s = pages([{ id: "b1", tracks: [{ ...tr("a", "scaleIn"), params: { from: "nw" } }, tr("ar", "scaleIn")] }], [box2("a", 100, 100), arrowL]);
  const before = s[0].ev.elements, a = before.find((e) => e.id === "a")!, ar = before.find((e) => e.id === "ar") as never as { opacity: number; x1: number; x2: number };
  const so = pages([{ id: "b1", tracks: [{ ...tr("a", "scaleOut"), params: { to: "nw" } }] }], [box2("a", 100, 100)]);
  const gone = so[1].ev.elements.find((e) => e.id === "a")!;
  h.ok(gone.opacity === 0 && !gone.hidden && near(gone.width, 2) && near(gone.x, 100) && near(gone.y, 100), "scaleOut: the exit ends as an invisible 0.02x twin pinned at the nw corner");
  h.ok(a.opacity === 0 && !a.hidden && near(a.width, 2) && near(a.height, 1.2) && near(a.x, 100) && near(a.y, 100), "scaleIn twin: an invisible 0.02x box on the page before, pinned at the nw corner (100,100)");
  h.ok(ar.opacity === 0 && near(ar.x1 ?? 0, 0, 1e-6) && near(ar.x2, 4, 1e-6), "an arrow's twin is the shaft shrunk 0.02x about its TAIL (x2 = 4 of 200)");
  const g = pages([{ id: "b1", tracks: [{ ...tr("a", "scaleIn"), params: { from: "group" } }, { ...tr("b", "scaleIn"), params: { from: "group" } }] }], [box2("a", 0, 100), box2("b", 200, 100)]);
  const ga = g[0].ev.elements.find((e) => e.id === "a")!, gb = g[0].ev.elements.find((e) => e.id === "b")!;
  const cxs = [ga.x + ga.width / 2, gb.x + gb.width / 2];
  h.ok(near(cxs[0], 0 + (50 - 150) * 0.02 + 150, 1e-6) && near(cxs[1], 150 + (250 - 150) * 0.02, 1e-6), "from: group: both twins shrink toward ONE point (the centre of their union, x = 150)");
}

h.section("I. authoring: the Q3 defaults, Emphasize, the group origin (X1, X1b)");
{
  const els = [
    { rotation: 0, id: "r", type: "rect", x: 10, y: 10, width: 100, height: 50, fill: "#205EA6", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
    { rotation: 0, id: "e", type: "ellipse", x: 130, y: 10, width: 60, height: 50, fill: "#205EA6", stroke: "none", strokeWidth: 0 },
    { rotation: 0, id: "ar", type: "line", x: 10, y: 100, width: 100, height: 0, x1: 0, y1: 0, x2: 100, y2: 0, stroke: "#111", strokeWidth: 2, arrowEnd: true, arrowStart: false },
    { rotation: 0, id: "ln", type: "line", x: 10, y: 120, width: 100, height: 0, x1: 0, y1: 0, x2: 100, y2: 0, stroke: "#111", strokeWidth: 2, arrowEnd: false, arrowStart: false },
    { rotation: 0, id: "tx", type: "text", x: 10, y: 150, width: 100, height: 30, text: "hi", fontFamily: "Gelasio", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111", sizing: "fixed" },
    { rotation: 0, id: "pl", type: "plot", x: 200, y: 100, width: 100, height: 80, assetId: "a" },
    { rotation: 0, id: "im", type: "image", x: 300, y: 100, width: 100, height: 80, assetId: "i" },
  ] as never[];
  h.eq(els.map((el) => suggestElementTrack(el as never).preset), ["scaleIn", "scaleIn", "scaleIn", "drawOn", "fadeRise", "fadeRise", "fadeRise"], "Appear: shapes and arrows grow in (no fade), a plain line draws on, text / plots / images rise in");
  h.eq(els.map((el) => suggestElementTrack(el as never, { exit: true }).preset), ["scaleOut", "scaleOut", "scaleOut", "drawOff", "fadeOut", "fadeOut", "fadeOut"], "Disappear: shapes and arrows scale out (the fade-free mirror), a plain line draws off");
  h.eq(els.map((el) => [elementEnterPreset(el as never), elementExitPreset(el as never)]), els.map((el) => [suggestElementTrack(el as never).preset, suggestElementTrack(el as never, { exit: true }).preset]), "X1b: elementEnterPreset / elementExitPreset take the ELEMENT and are the one place the choice lives");
  h.eq(els.slice(0, 2).map((el) => { const t = suggestElementTrack(el as never); return [t.duration, t.curve, t.params ?? null]; }), [[600, QUICK_SMOOTH, null], [600, QUICK_SMOOTH, null]], "a new scaleIn is written with its authored pace (600 ms quick smooth), no params");
  const mk = () => { const d = createDeck({ id: "a", title: "a", withTitleSlide: false }); d.stage = stage; d.slides = [{ id: "s", name: "s", groups: {}, elements: structuredClone(els), beats: [{ id: "b0", tracks: [] }] }] as never; return d; };
  const go = (kind: "appear" | "emphasize" | "disappear", ids: string[]) => { const d = mk(); addAppearanceTracks(d, "s", ids.map((elementId) => ({ elementId })), kind, 0, {}); return d.slides[0].beats.at(-1)!.tracks; };
  h.eq(go("emphasize", ["r"]).map((t) => [t.preset, t.duration, t.easing, t.curve ?? null, t.params ?? null]), [["pulse", 700, "smooth", null, null]], "Emphasize writes pulse 700 plain smooth (Q3b), no highlight");
  h.eq(go("appear", ["r", "e"]).map((t) => [t.preset, t.params?.from]), [["scaleIn", "group"], ["scaleIn", "group"]], "Appear on two objects writes from:'group' (a label never leaves its card)");
  h.eq(go("appear", ["r"]).map((t) => [t.preset, t.params ?? null]), [["scaleIn", null]], "a single object keeps the default origin (auto)");
  h.eq(go("disappear", ["r", "e"]).map((t) => [t.preset, t.params?.to]), [["scaleOut", "group"], ["scaleOut", "group"]], "Disappear on two shapes shrinks them to one group centre");
  h.eq(go("emphasize", ["r", "e"]).map((t) => [t.preset, t.params?.about]), [["pulse", "group"], ["pulse", "group"]], "Emphasize on a multi-selection pulses about the group centre");
  h.eq(go("appear", ["r", "ln"]).map((t) => [t.preset, t.params ?? null]), [["scaleIn", null], ["drawOn", null]], "two different effects share no origin: a lone scaleIn writes no group");
  const three = go("appear", ["r", "e", "ar"]);
  h.ok(three.every((t) => t.preset === "scaleIn" && t.params === undefined) && new Set(three.map((t) => t.start ?? 0)).size === 3, "three objects lag one after another, each about its own origin (an arrow keeps its tail): no group");
  // plot builds
  const manifest = JSON.parse(readFileSync("scripts/fixtures/plots/mpl_scatter_FLUXPLOT.fluxplot.json", "utf8"));
  const child = (pace: typeof V2_PACE) => autoAnimatePlot(manifest, "p", { pace }).flatMap((b) => b.tracks).filter((t) => t.preset === "stagger").map((t) => t.params?.child);
  h.ok(child(CLASSIC_PACE).length > 0 && child(CLASSIC_PACE).every((c) => c === "fade") && child(V2_PACE).every((c) => c === "scaleIn"), "Auto-animate a scatter: classic points fade in (unchanged); V2 points grow in (stagger child scaleIn, n <= 150)");
  const points = autoAnimatePlot(manifest, "p").flatMap((b) => b.tracks).find((t) => t.preset === "stagger" && t.params?.child === "scaleIn")!;
  h.ok(points.params?.y === undefined && points.curve !== undefined, "a scaleIn point group carries the quick-smooth curve and NO fadeRise y");
}
await h.done();
