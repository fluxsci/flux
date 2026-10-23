#!/usr/bin/env -S npx tsx
// T1 PACE (Release 1, WP 1.7) — the authored pace table + params (authoredFields, X1a), the onset-exempt rule (X2),
// the frozen classic playback fallback, the quick-smooth curve, the tokens/linear() hygiene, the video holds and
// the interrupt-settle clock with its one `clockMode` (X14). Pure (linkedom + a fake rAF for the REAL player).
// Run: FLUX_NO_MIGRATE=1 npx tsx scripts/verify-pace-defaults.ts
import { parseHTML } from "linkedom";
import * as fs from "node:fs";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-pace-defaults");
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as any).document = document;
let now = 1000; const q = new Map<number, (t: number) => void>(); let rid = 0;
(globalThis as any).performance = { now: () => now };
(globalThis as any).requestAnimationFrame = (cb: any) => { q.set(++rid, cb); return rid; };
(globalThis as any).cancelAnimationFrame = (i: number) => { q.delete(i); };
const stepMs = (ms: number) => { now += ms; const cbs = [...q.values()]; q.clear(); cbs.forEach(cb => cb(now)); };

const { PRESET_CATALOG, defaultTimingFor, authoredTiming, authoredParams, authoredFields, autoBuildMs, withAuthoringTiming, QUICK_SMOOTH } = await import("../src/lib/slide/presetCatalog");
const { resolveCurve, CURVE_CATALOG } = await import("../src/lib/slide/curves");
const { smoothstep, smoothEasing, EASE, ceSmooth, rushInto, rushFrom, doubleSmooth } = await import("../src/lib/motion/tokens");
const { trackDuration, beatDelayMs, settleTime, firstTickOrigin, FIRST_TICK_MAX_MS, AUTO_DELAY_AUTHORED_MS, AUTO_DELAY_FALLBACK_MS, SETTLE_MAX_MS, SETTLE_MIN_REMAINING_MS } = await import("../src/lib/slide/timing");
const ops = await import("../src/lib/slide/ops");
const ab = await import("../src/lib/slide/autobuild");
const { DEFAULT_VIDEO_OPTIONS } = await import("../src/lib/slide/video");
const { createPlayer } = await import("../src/lib/slide/player/player");
const core = await import("../flux-core/index");
const { FLUX_DARK } = await import("../src/lib/slide/theme");

// ---- 1. the authored pace table (explicit numbers; five classes) ----------------------------------
h.section("authoring table");
const AUTHORED: Record<string, number> = { fade: 700, fadeRise: 700, popIn: 700, stagger: 700, highlight: 700, dim: 700, drawOn: 900, growBaseline: 900, writeOn: 900, countUp: 900, fadeOut: 500, popOut: 500, drawOff: 500, wipeOut: 500, camera: 900, transform: 1200,
  // WP 2.2 (X1): the fade-free vocabulary. scaleIn / scaleOut are onset-curved like every enter / exit; pulse / encircle are onset-exempt.
  scaleIn: 600, scaleOut: 500, pulse: 700, encircle: 900 };
for (const [p, d] of Object.entries(AUTHORED)) h.eq([authoredTiming(p).duration, defaultTimingFor(p).duration], [d, d], `${p} authors ${d} ms`);
// X2 (the onset rule): "quick smooth for every enter/exit/emphasis row except onsetExempt rows (pulse, encircle)". The symmetric
// there-and-back presets land with zero velocity, so they author the plain `smooth` token instead.
const ONSET_EXEMPT = new Set(["pulse", "encircle"]);
for (const [name, def] of Object.entries(PRESET_CATALOG)) {
  const t = authoredTiming(name), f = authoredFields(name);
  h.ok(!(t.easing && t.curve) && !(f.easing && f.curve), `${name}: easing and curve are never both written`);
  h.eq(f.duration, t.duration, `${name}: authoredFields carries authoredTiming's duration`);
  h.eq([f.easing, f.curve], [t.easing, t.curve], `${name}: authoredFields carries authoredTiming's curve|easing`);
  const exempt = ONSET_EXEMPT.has(name) || def.onsetExempt === true;
  if (["enter", "exit", "emphasis"].includes(def.phase)) {
    if (exempt) h.ok(t.curve === undefined && t.easing === "smooth", `${name} (onset-exempt) writes the plain smooth token, never quick smooth`);
    else h.eq(t.curve, QUICK_SMOOTH, `${name} writes the quick-smooth curve`);
  } else h.ok(t.curve === undefined && (t.easing === "smooth" || def.family === "media" || def.legacy), `${name}: no onset curve outside enter/exit/emphasis`);
  h.ok(def.onsetExempt !== true || (t.curve === undefined), `${name}: an onsetExempt row never carries a curve`);
}
for (const p of ["transform", "camera", "countUp"]) h.ok(authoredTiming(p).easing === "smooth" && !authoredTiming(p).curve, `${p} stays on the plain smooth token`);
// X1a: authored params. Release 1 has exactly one row (fadeRise y 24), also inherited by a stagger whose child is fadeRise or absent.
h.section("authored params (X1a)");
h.eq(Object.entries(PRESET_CATALOG).filter(([, d]) => d.authoringParams).map(([n, d]) => [n, d.authoringParams]), [["fadeRise", { y: 24 }], ["writeOn", { edge: "soft" }], ["highlight", { lead: 0.25 }]], "params rows: fadeRise { y: 24 }, (WP 2.4) writeOn { edge: soft } and (WP 2.2) highlight { lead: 0.25 }, nothing else");
h.eq([authoredFields("writeOn").params, authoredFields("wipeOut").params, authoredFields("drawOn").params, authoredFields("drawOff").params], [{ edge: "soft" }, undefined, undefined, undefined],
  "the soft wipe edge is AUTHORED on writeOn only (X1a); stroke order is never authored by default (only the Animator writes it on a multi-path Draw)");
h.eq(authoredFields("highlight").params, { lead: 0.25 }, "authoredFields(highlight) carries lead 0.25 (the ramp into the dip, X1a)");
h.eq(["scaleIn", "scaleOut", "pulse", "encircle"].map(p => authoredFields(p).params), Array(4).fill(undefined), "the new presets author NO params: auto origin, auto peak, the table's band");
h.eq(authoredFields("fadeRise").params, { y: 24 }, "authoredFields(fadeRise) carries y 24");
h.eq(authoredFields("stagger").params, { y: 24 }, "a stagger with no child plays fadeRise (player default): y 24");
h.eq(authoredFields("stagger", { child: "fadeRise" }).params, { y: 24 }, "a stagger whose child is fadeRise: y 24");
h.eq([authoredFields("stagger", { child: "fade" }).params, authoredFields("stagger", { child: "popIn" }).params], [undefined, undefined], "a stagger with another child gets no params");
h.eq(["fade", "popIn", "drawOn", "fadeOut", "transform", "camera", "countUp"].map(p => authoredFields(p).params), Array(7).fill(undefined), "no other preset authors params yet");
h.eq([authoredParams("videoStart"), authoredParams(undefined), authoredParams("nonsense")], [undefined, undefined, undefined], "media / unknown names author no params");
{ const a = authoredFields("fadeRise"), b = authoredFields("fadeRise"); a.params!.y = 1; (a.curve as any).p[0] = 9;
  h.eq([b.params, b.curve], [{ y: 24 }, QUICK_SMOOTH], "every call returns fresh params and curve objects (no shared mutable constant)"); }
// ---- 2. classic playback is FROZEN ---------------------------------------------------------------
h.section("frozen classic fallback");
const CLASSIC: Record<string, [number, string]> = { fade: [320, "standard"], fadeRise: [320, "standard"], popIn: [320, "standard"], drawOn: [320, "standard"], growBaseline: [320, "standard"], stagger: [320, "standard"], writeOn: [320, "standard"], fadeOut: [320, "standard"], popOut: [320, "standard"], drawOff: [320, "standard"], wipeOut: [320, "standard"], highlight: [320, "standard"], dim: [320, "standard"], countUp: [800, "standard"], camera: [320, "standard"], transform: [600, "smooth"],
  scaleIn: [320, "standard"], scaleOut: [320, "standard"], pulse: [700, "smooth"], encircle: [900, "smooth"] };
for (const [p, [d, e]] of Object.entries(CLASSIC)) h.eq([PRESET_CATALOG[p as keyof typeof PRESET_CATALOG].defaultDurationMs, PRESET_CATALOG[p as keyof typeof PRESET_CATALOG].defaultEasing, trackDuration({ preset: p as any })], [d, e, d], `${p}: omitted timing still plays ${d} ms ${e}`);
h.eq(beatDelayMs({}), AUTO_DELAY_FALLBACK_MS, "omitted autoDelayMs still plays 600 ms");
h.eq(beatDelayMs({ autoDelayMs: 0 }), 0, "an explicit 0 is honoured");
// ---- 3. curve budgets measured from the repo's own functions --------------------------------------
h.section("curve budgets (60 fps)");
function curveStats(fn: (t: number) => number, D: number) {
  let vmax = 0, prev = 0; const at: Record<string, number> = {}; const lv: Record<string, number> = { t05: .005, t2: .02, t50: .5, t90: .9 };
  for (let i = 1; i <= 20000; i++) { const t = i / 20000, y = fn(t); vmax = Math.max(vmax, (y - prev) * 20000); prev = y; for (const k in lv) if (at[k] == null && y >= lv[k]) at[k] = t * D; }
  return { peak: vmax / ((D / 1000) * 60) * 100, ...at };
}
const trimmed = (t: number) => { const L = 0.08; return (smoothstep(L + (1 - L) * t) - smoothstep(L)) / (1 - smoothstep(L)); };
{ const f = resolveCurve({ curve: QUICK_SMOOTH }).fn; let err = 0; for (let i = 0; i <= 2000; i++) err = Math.max(err, Math.abs(f(i / 2000) - trimmed(i / 2000)));
  h.ok(err < 0.011, `quick-smooth bezier fits the trimmed quintic within 0.011 (${err.toFixed(4)})`);
  h.ok(resolveCurve({ curve: QUICK_SMOOTH }).css.startsWith("cubic-bezier("), "quick-smooth has a native css (y within [0,1])"); }
for (const [p, d] of Object.entries(AUTHORED)) {
  const def = PRESET_CATALOG[p as keyof typeof PRESET_CATALOG]; if (def.family === "media") continue;
  const s = curveStats(resolveCurve({ ...authoredTiming(p) as any, preset: p }).fn, d);
  // scaleIn is the owner's 600 ms row (X1 / Q3a): 600 ms quick-smooth peaks at 5.62 %/frame, a hair over the 700 ms enters' 5.5 (the
  // budget was measured at 700); pinned tight to the measured peak (5.7) so a later curve change still trips it, still 2.4x under
  // classic popIn's 14.2
  const cap = def.phase === "exit" ? 7 : def.family === "transform" || def.family === "camera" ? 3.6 : p === "scaleIn" ? 5.7 : 5.5;
  h.ok(s.peak <= cap, `${p} ${d} ms: peak ${s.peak.toFixed(2)} %/frame <= ${cap} (classic standard@320 = 13.9)`);
  // the click-onset budget is the quick-smooth curve's job; an onset-exempt there-and-back (pulse, encircle) is the symmetric smooth
  // token instead, which must leave AND land at rest (X2): zero velocity at both ends, so its landing never snaps
  if (def.onsetExempt) {
    const f = resolveCurve({ ...authoredTiming(p) as any, preset: p }).fn, e = 1e-4;
    h.ok(Math.abs(f(e) / e) < 1e-6 && Math.abs((1 - f(1 - e)) / e) < 1e-6, `${p}: onset-exempt curve starts and lands with zero velocity (smooth)`);
  } else if (def.family === "appearance" && def.phase !== "count") h.ok(s.t05 <= 20 && s.t2 <= 70, `${p}: click onset t0.5% ${s.t05.toFixed(0)} ms <= 20, t2% ${s.t2.toFixed(0)} ms <= 70`);
}
h.ok(curveStats(resolveCurve({ easing: "standard" }).fn, 320).peak > 13, "classic standard@320 reference is 13.9 %/frame");
// ---- 4. authoring writers write explicit pace -----------------------------------------------------
h.section("authoring writers");
const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false } as any);
const s = ops.addSlide(deck, { id: "s", layout: "blank" } as any);
const T = (id: string, y: number) => ({ type: "text", id, x: 0, y, width: 300, height: 40, rotation: 0, text: id, fontFamily: "Arial", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000", sizing: "fixed" }) as any;
ops.addElement(deck, s.id, T("t", 0));
ops.addElement(deck, s.id, { type: "rect", id: "r", x: 0, y: 50, width: 50, height: 50, rotation: 0, fill: "#f00", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as any);
ops.addElement(deck, s.id, { type: "line", id: "l", x: 0, y: 120, width: 80, height: 0, rotation: 0, x1: 0, y1: 0, x2: 80, y2: 0, stroke: "#000", strokeWidth: 3 } as any);
const want = (tr: any, preset: string, dur: number, params?: any) => h.eq([tr.preset, tr.duration, tr.easing, tr.curve, tr.params], [preset, dur, undefined, QUICK_SMOOTH, params], `animate ${tr.target}: ${preset} ${dur} ms quick-smooth${params ? " + params" : ""}`);
want(ab.suggestElementTrack({ id: "t", type: "text" } as any), "fadeRise", 700, { y: 24 });
// WP 2.2 (Q3a): shapes and arrows GROW in (scaleIn 600), images and plots rise in; the exits mirror (scaleOut 500).
want(ab.suggestElementTrack({ id: "i", type: "image" } as any), "fadeRise", 700, { y: 24 });
want(ab.suggestElementTrack({ id: "r", type: "rect" } as any), "scaleIn", 600);
want(ab.suggestElementTrack({ id: "e", type: "ellipse" } as any), "scaleIn", 600);
want(ab.suggestElementTrack({ id: "l", type: "line", arrowStart: false, arrowEnd: false } as any), "drawOn", 900);
want(ab.suggestElementTrack({ id: "a", type: "line", arrowStart: false, arrowEnd: true } as any), "scaleIn", 600);
want(ab.suggestElementTrack({ id: "a2", type: "line", arrowStart: true, arrowEnd: false } as any), "scaleIn", 600);
want(ab.suggestElementTrack({ id: "p", type: "path" } as any), "drawOn", 900);
want(ab.suggestElementTrack({ id: "g", type: "plot" } as any), "fadeRise", 700, { y: 24 });
want(ab.suggestElementTrack({ id: "t", type: "text" } as any, { exit: true }), "fadeOut", 500);
want(ab.suggestElementTrack({ id: "l", type: "line", arrowStart: false, arrowEnd: false } as any, { exit: true }), "drawOff", 500);
want(ab.suggestElementTrack({ id: "a", type: "line", arrowStart: false, arrowEnd: true } as any, { exit: true }), "scaleOut", 500);
want(ab.suggestElementTrack({ id: "r", type: "rect" } as any, { exit: true }), "scaleOut", 500);
h.eq([ab.elementEnterPreset({ type: "model3d" } as any), ab.elementExitPreset({ type: "image" } as any), ab.elementEnterPreset({ type: "video" } as any)], ["fade", "fadeOut", "fade"], "kinds without a rule keep fade / fadeOut");
want(ab.suggestElementTrack({ id: "t", type: "text" } as any, { part: "p" }), "fade", 700);
want(ab.suggestElementTrack({ id: "t", type: "text" } as any, { part: "p", exit: true }), "fadeOut", 500);
// animateElement: an explicit preset override re-authors the track as THAT preset (no stale curve/params of the kind default)
{ const sid = s.id;
  const over = (preset: string) => { const r = ab.animateElement(deck, sid, "t", { preset: preset as any, beatIndex: undefined })!; return deck.slides[0].beats[r.beatIndex].tracks.find(x => x.id === r.trackId)!; };
  const pop = over("popIn"); h.eq([pop.preset, pop.duration, pop.curve, pop.easing, pop.params], ["popIn", 700, QUICK_SMOOTH, undefined, undefined], "animateElement popIn override on text: popIn pace, fadeRise's y dropped");
  const drw = over("drawOn"); h.eq([drw.preset, drw.duration], ["drawOn", 900], "animateElement drawOn override: 900 ms");
  const stg = over("stagger"); h.eq([stg.preset, stg.duration, stg.params], ["stagger", 700, { y: 24 }], "animateElement stagger override: 700 ms, y 24 (child absent plays fadeRise)"); }
h.eq([ab.autoBuildMs === autoBuildMs, core.autoBuildMs === autoBuildMs, core.authoredFields === authoredFields], [true, true, true], "autoBuildMs / authoredFields: one implementation, exported by autobuild and flux-core");
h.eq(autoBuildMs("fade", 240), 500, "plot part: a short manifest duration is raised to the preset floor");
h.eq(autoBuildMs("drawOn", 1200), 1200, "plot part: a longer manifest duration wins");
h.eq(autoBuildMs("fadeOut"), 500, "plot part without a floor uses the authoring duration");
h.eq(Object.fromEntries(["fade", "fadeRise", "popIn", "drawOn", "growBaseline", "scaleIn", "stagger", "writeOn"].map(p => [p, autoBuildMs(p as any)])), { fade: 500, fadeRise: 600, popIn: 500, drawOn: 800, growBaseline: 800, scaleIn: 500, stagger: 600, writeOn: 700 }, "plot-part floors (scaleIn 500 for the V2 point child, X1c)");
// X1c: V2_PACE reads the catalog's floors (it gained scaleIn 500 by the catalog row, not by a copy); CLASSIC_PACE has none and still fades.
h.eq([ab.V2_PACE.floor("scaleIn"), ab.V2_PACE.floor("stagger"), ab.CLASSIC_PACE.floor("scaleIn")], [500, 600, 0], "V2_PACE.floor reads the catalog (scaleIn 500, stagger 600); CLASSIC_PACE has no floors");
h.eq([ab.V2_STAGGER_CHILD, ab.V2_PACE.pointChild(1), ab.V2_PACE.pointChild(150), ab.V2_PACE.pointChild(151), ab.V2_PACE.pointChild(1200), ab.CLASSIC_PACE.pointChild(1), ab.CLASSIC_PACE.pointChild(40)],
  ["scaleIn", "scaleIn", "scaleIn", "fade", "fade", "fade", "fade"], "V2 grows a point group of n <= 150 in (V2_STAGGER_CHILD scaleIn); a denser one and every CLASSIC build fade");
h.eq(ab.V2_PACE.barLag, 0.25, "V2_PACE enables the bar lag (bars ripple, each growing from its own zero line: origins landed in WP 1.2)");
h.eq(autoBuildMs("drawOn", undefined), 800, "no manifest duration = the floor");
const m = ops.addBeat(deck, s.id, { advance: "auto" })!; h.eq(m.autoDelayMs, AUTO_DELAY_AUTHORED_MS, "a new auto beat writes 150 ms");
const m2 = ops.addBeat(deck, s.id, { advance: "auto", autoDelayMs: 0 })!; h.eq(m2.autoDelayMs, 0, "an explicit delay wins");
const m3 = ops.addBeat(deck, s.id, {})!; ops.setBeat(deck, s.id, m3.id, { advance: "auto" }); h.eq(m3.autoDelayMs, 150, "switching a beat to After previous writes 150 ms");
h.eq(withAuthoringTiming({ preset: "fade" } as any), { preset: "fade", duration: 700, curve: QUICK_SMOOTH }, "headless set-animation fills omitted timing");
h.eq(withAuthoringTiming({ preset: "fadeRise" } as any), { preset: "fadeRise", duration: 700, curve: QUICK_SMOOTH, params: { y: 24 } }, "headless set-animation fills fadeRise's authored y");
h.eq(withAuthoringTiming({ preset: "highlight" } as any), { preset: "highlight", duration: 700, curve: QUICK_SMOOTH, params: { lead: 0.25 } }, "headless set-animation fills highlight's authored lead");
h.eq(withAuthoringTiming({ preset: "highlight", params: { lead: 0 } } as any).params, { lead: 0 }, "a supplied lead 0 (the legacy jump) wins");
h.eq(withAuthoringTiming({ preset: "writeOn" } as any), { preset: "writeOn", duration: 900, curve: QUICK_SMOOTH, params: { edge: "soft" } }, "headless set-animation fills writeOn's soft edge");
h.eq(withAuthoringTiming({ preset: "writeOn", params: { edge: "hard" } } as any).params, { edge: "hard" }, "a supplied edge: hard wins (the author restored the clip)");
h.eq(withAuthoringTiming({ preset: "pulse" } as any), { preset: "pulse", duration: 700, easing: "smooth" }, "headless set-animation fills pulse's plain-smooth pace (onset-exempt, no curve)");
h.eq(withAuthoringTiming({ preset: "scaleIn" } as any), { preset: "scaleIn", duration: 600, curve: QUICK_SMOOTH }, "headless set-animation fills scaleIn's pace");
h.eq(withAuthoringTiming({ preset: "fadeRise", params: { y: 8 } } as any).params, { y: 8 }, "a supplied param wins, key by key");
h.eq(withAuthoringTiming({ preset: "fadeRise", params: { dx: 3 } } as any).params, { y: 24, dx: 3 }, "authored params fill only the keys the caller omitted");
h.eq(withAuthoringTiming({ preset: "stagger" } as any).params, { y: 24 }, "a bare stagger gets the fadeRise child's y");
h.eq(withAuthoringTiming({ preset: "stagger", params: { child: "fade" } } as any).params, { child: "fade" }, "a stagger over another child gets no y");
h.eq(withAuthoringTiming({ preset: "fade", curve: { kind: "bezier", p: [0, 0, 1, 1] } } as any), { preset: "fade", curve: { kind: "bezier", p: [0, 0, 1, 1] }, duration: 700 }, "a supplied curve is untouched (no easing added)");
{ const input = { preset: "fadeRise" }; withAuthoringTiming(input as any); h.eq(input, { preset: "fadeRise" }, "withAuthoringTiming never mutates its input"); }
h.eq(withAuthoringTiming({ preset: "fade", duration: 400, easing: "linear" } as any), { preset: "fade", duration: 400, easing: "linear" }, "supplied timing is untouched");
h.eq(withAuthoringTiming({ preset: "fade", influence: { in: 30, out: 30 } } as any), { preset: "fade", influence: { in: 30, out: 30 }, duration: 700 }, "an influence is a curve choice: duration filled, no easing added");
{ const linked = { target: "x", preset: "fadeRise", styleId: "gentle-reveal" }; h.eq(withAuthoringTiming(linked as any), { target: "x", preset: "fadeRise", styleId: "gentle-reveal" }, "a style-linked track is returned unchanged (the style supplies duration/curve/params)");
  h.eq(withAuthoringTiming({ target: "x", preset: "fade" } as any), { target: "x", preset: "fade", duration: 700, curve: QUICK_SMOOTH }, "an unlinked track is still filled"); }
h.eq(withAuthoringTiming({ preset: "videoStart" } as any), { preset: "videoStart" }, "media commands untouched");
h.eq(withAuthoringTiming({ target: "x" } as any), { target: "x" }, "keyframe-only tracks untouched");
ops.addElement(deck, s.id, { type: "ellipse", id: "e", x: 200, y: 50, width: 50, height: 50, rotation: 0, fill: "#00f", stroke: "none", strokeWidth: 0 } as any);
const bb = ops.addBeat(deck, s.id, {})!; ops.becomeTransform(deck, s.id, bb.id, "r", "e");
const tr = deck.slides[0].beats.find(x => x.id === bb.id)!.tracks.find(t => t.preset === "transform")!;
h.eq([tr.duration, tr.easing, tr.curve], [1200, "smooth", undefined], "Become authors 1200 ms on the plain smooth token");
// ---- 4b. the text-rewrite look (WP 2.5, owner decision: letters travel by default for NEW text transforms) ------------
h.section("authored text look (X1a rows)");
{
  const { TEXT_TRANSFORM_PARAMS, rewritesText } = await import("../src/lib/slide/presetCatalog");
  const { resolveTextLook } = await import("../src/lib/slide/timing");
  const LOOK = { fadeStyle: "roll", letters: "travel" };
  h.eq(Object.entries(PRESET_CATALOG).filter(([, d]) => d.authoringTextParams).map(([n, d]) => [n, d.authoringTextParams]), [["transform", LOOK]], "ONE text-look row: the transform preset { fadeStyle: roll, letters: travel }");
  h.eq(Object.entries(PRESET_CATALOG).filter(([, d]) => d.authoringParams).map(([n, d]) => [n, d.authoringParams]), [["fadeRise", { y: 24 }]], "...and the plain authoring rows are still only fadeRise { y: 24 }");
  h.eq({ ...TEXT_TRANSFORM_PARAMS }, LOOK, "TEXT_TRANSFORM_PARAMS is the row");
  h.eq([authoredFields("transform").params, authoredFields("transform", undefined, false).params], [undefined, undefined], "a transform that does not rewrite text authors no params");
  h.eq(authoredFields("transform", undefined, true), { duration: 1200, easing: "smooth", params: LOOK }, "a text transform authors 1200 ms smooth + the look");
  h.eq(authoredParams("transform", undefined, true), LOOK, "authoredParams(transform, rewrites) is the look");
  h.eq(["fade", "fadeRise", "popIn", "drawOn", "camera", "countUp", "stagger"].map(p => authoredFields(p, undefined, true).params?.fadeStyle), Array(7).fill(undefined), "no other preset ever carries the text look, rewrites flag or not");
  h.eq(authoredFields("fadeRise", undefined, true).params, { y: 24 }, "the flag does not disturb fadeRise's own row");
  { const a = authoredFields("transform", undefined, true); a.params!.letters = "x"; h.eq(authoredFields("transform", undefined, true).params, LOOK, "a fresh params object per call (the frozen row is never handed out)"); }
  h.eq([rewritesText({ type: "text" }), rewritesText({ type: "text" }, { type: "text" }), rewritesText({ type: "text" }, { type: "rect" }), rewritesText({ type: "rect" }), rewritesText({ type: "rect" }, { type: "text" }), rewritesText(undefined), rewritesText({ type: "text" }, { type: "set" })],
    [true, true, false, false, false, false, false], "rewritesText: text -> text (or a Change of text); never a shape, a missing target, or a set");
  // headless set-animation (withAuthoringTiming): the caller says whether the target is text
  h.eq(withAuthoringTiming({ preset: "transform" } as any, true), { preset: "transform", duration: 1200, easing: "smooth", params: LOOK }, "set-animation of a text transform fills the look");
  h.eq(withAuthoringTiming({ preset: "transform" } as any), { preset: "transform", duration: 1200, easing: "smooth" }, "...and not for any other target");
  h.eq(withAuthoringTiming({ preset: "transform", params: { letters: "fade" } } as any, true).params, { fadeStyle: "roll", letters: "fade" }, "a supplied look key wins, key by key");
  h.eq(withAuthoringTiming({ preset: "transform", params: {} } as any, true).params, LOOK, "an empty params object is filled (only a style-linked track is exempt)");
  h.eq(withAuthoringTiming({ target: "t", preset: "transform", styleId: "calm" } as any, true), { target: "t", preset: "transform", styleId: "calm" }, "a style-linked text transform is returned unchanged (the style supplies the look)");
  h.eq(withAuthoringTiming({ preset: "fade" } as any, true), { preset: "fade", duration: 700, curve: QUICK_SMOOTH }, "the flag is inert on a fade");
  // ---- the writers (ops): every place a text transform is born -----------------------------------------------
  const d = ops.createDeck({ id: "dt", title: "dt", withTitleSlide: false } as any), sl = ops.addSlide(d, { id: "st", layout: "blank" } as any);
  const text = (id: string, t: string) => ({ type: "text", id, x: 10, y: 10, width: 200, height: 40, rotation: 0, text: t, fontSize: 24, fontFamily: "Inter", fontWeight: 400, fill: "#000", align: "left" }) as any;
  ops.addElement(d, sl.id, text("t1", "alpha beta")); ops.addElement(d, sl.id, text("t2", "beta alpha"));
  ops.addElement(d, sl.id, { type: "rect", id: "box", x: 0, y: 100, width: 50, height: 50, rotation: 0, fill: "#f00", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as any);
  const beat = () => ops.addBeat(d, sl.id, {})!;
  const track = (b: { id: string }, pred: (t: any) => boolean = () => true) => d.slides[0].beats.find(x => x.id === b.id)!.tracks.find(t => t.preset === "transform" && pred(t))!;
  { const b = beat(); ops.setTransform(d, sl.id, b.id, "t1", { state: { text: "beta alpha" } });
    h.eq([track(b).params, track(b).duration, track(b).easing], [LOOK, 1200, "smooth"], "a Change on text (setTransform) is born with the look");
    ops.setTransform(d, sl.id, b.id, "t1", { state: { fill: "#00f" } });
    h.eq(track(b).params, LOOK, "a later edit of the same Change keeps its params");
    track(b).params = { fadeStyle: "drift" }; ops.setTransform(d, sl.id, b.id, "t1", { state: { fill: "#0f0" } }); h.eq(track(b).params, { fadeStyle: "drift" }, "...and never rewrites a track the author already set"); }
  { const b = beat(); ops.setTransform(d, sl.id, b.id, "box", { state: { x: 40 } }); h.eq(track(b).params, undefined, "a Change on a rect has no params"); }
  { const b = beat(); ops.setTransform(d, sl.id, b.id, "t1", { ref: { parts: ["p1"] }, state: { opacity: 1 } }); h.eq(track(b).params, undefined, "a part-bound Change has no params (text has no parts)"); }
  { const b = beat(); ops.becomeTransform(d, sl.id, b.id, "t1", "t2", { mode: "handoff" });
    h.eq([track(b).params, track(b).to.become.mode], [LOOK, "handoff"], "a text -> text hand-off Become is born with the look"); }
  { const b = beat(); ops.becomeTransform(d, sl.id, b.id, "t2", "box", { mode: "handoff" }); h.eq(track(b).params, undefined, "a text -> rect Become is not a text rewrite: no params"); }
  { const b = beat(); ops.becomeTransform(d, sl.id, b.id, "box", "t1", { mode: "handoff" }); h.eq(track(b).params, undefined, "a rect -> text Become: no params"); }
  { const d2 = ops.createDeck({ id: "dc", title: "dc", withTitleSlide: false } as any), s2 = ops.addSlide(d2, { id: "sc", layout: "blank" } as any);
    ops.addElement(d2, s2.id, text("a", "one two")); ops.addElement(d2, s2.id, text("b", "two one"));
    const b = ops.addBeat(d2, s2.id, {})!; ops.becomeTransform(d2, s2.id, b.id, "a", "b", { mode: "consume" });
    const t = d2.slides[0].beats.find(x => x.id === b.id)!.tracks.find(x => x.preset === "transform")!;
    h.eq([t.params, t.to?.become?.mode], [LOOK, "consume"], "a text Consume Become is born with the look"); }
  { const b = beat(); const g = ops.addGhostTransform(d, sl.id, b.id, "t1", { count: 2, original: "stay", states: [{ text: "x y" }, { text: "y x" }] })!;
    const ts = d.slides[0].beats.find(x => x.id === b.id)!.tracks.filter(t => t.ghostFrom === "t1");
    h.eq(ts.map(t => t.params), [LOOK, LOOK], "text ghost copies are born with the look"); h.eq(g.trackIds.length, 2, "(two ghosts)"); }
  { const b = beat(); ops.addGhostTransform(d, sl.id, b.id, "box", { count: 1, original: "stay", states: [{ x: 90 }] });
    h.eq(d.slides[0].beats.find(x => x.id === b.id)!.tracks.filter(t => t.ghostFrom === "box").map(t => t.params), [undefined], "a rect ghost has no params"); }
  { const old = { id: "old", target: "t1", preset: "transform", duration: 1200, easing: "smooth", to: { state: { text: "x" } } } as any;
    h.eq(resolveTextLook(old.params), { letters: "fade", fadeStyle: "drift" }, "an OLD text transform (no params) plays the classic look: nothing is read from a profile"); }
}
// ---- 5. tokens / curves hygiene --------------------------------------------------------------------
h.section("tokens");
h.eq(EASE.smooth, smoothEasing(64), "EASE.smooth is the exact quintic string (was a bezier look-alike)");
h.eq(resolveCurve({ easing: "smooth" }).css, smoothEasing(64), "token smooth resolves to the 64-knot string");
{ const knots = [...smoothEasing(64).matchAll(/[\d.]+/g)].map(x => +x[0]); let mid = 0; for (let i = 0; i < 64 * 4; i++) { const x = i / (64 * 4), k = Math.floor(x * 64), f = x * 64 - k; mid = Math.max(mid, Math.abs(knots[k] + f * (knots[k + 1] - knots[k]) - smoothstep(x))); }
  h.ok(mid < 3e-4, `64-knot linear() max error ${mid.toExponential(2)} < 3e-4 (24 knots: 1.25e-3)`); }
h.ok(fs.readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8").includes(`--ease-smooth: ${smoothEasing(64)}`), "tokens.css --ease-smooth carries the same string");
let ce = 0; { const g = resolveCurve({ curve: { kind: "bezier", p: [0.627, 0, 0.373, 1] } }).fn; for (let i = 0; i <= 1000; i++) ce = Math.max(ce, Math.abs(g(i / 1000) - ceSmooth(i / 1000))); }
h.ok(ce < 0.006, `glide fits manim-CE smooth within 0.006 (${ce.toFixed(4)})`);
h.ok(CURVE_CATALOG.some(c => c.id === "glide") && CURVE_CATALOG.some(c => c.id === "quick smooth"), "catalog lists glide and quick smooth");
{ let e1 = 0, e2 = 0; for (let i = 0; i <= 200; i++) { const t = i / 200; e1 = Math.max(e1, Math.abs(doubleSmooth(t) - (t < .5 ? .5 * smoothstep(2 * t) : .5 + .5 * smoothstep(2 * t - 1)))); e2 = Math.max(e2, Math.abs(rushInto(t) - 2 * smoothstep(t / 2))); }
  h.ok(e1 < 1e-12 && e2 < 1e-12 && Math.abs(rushInto(1) - 1) < 1e-12 && Math.abs(rushFrom(0)) < 1e-12 && Math.abs(doubleSmooth(.5) - .5) < 1e-12, "doubleSmooth / rushInto / rushFrom identities"); }
// ---- 6. video defaults ------------------------------------------------------------------------------
h.section("video");
h.eq([DEFAULT_VIDEO_OPTIONS.stepDelayMs, DEFAULT_VIDEO_OPTIONS.startHoldMs, DEFAULT_VIDEO_OPTIONS.endHoldMs], [1000, 1000, 2000], "video holds 1000 / 1000 / 2000");
h.ok(/raw\.v !== 2\)\s*delete raw\.stepDelayMs/.test(fs.readFileSync(new URL("../src/shell/modes/slide/SlideVideoDialog.svelte", import.meta.url), "utf8")), "the dialog re-seeds a pre-v2 persisted step delay");
// ---- 7. interrupt settle + the one clockMode (X14) -------------------------------------------------
h.section("settle clock (pure)");
{ const t0 = 150, D = 700; const f = (e: number) => settleTime(t0, D, 120, e);
  h.eq([f(0), f(120), f(500)], [t0, D, D], "settleTime starts at the click time and lands exactly on the end");
  let mono = true; for (let e = 1; e <= 120; e++) if (f(e) < f(e - 1)) mono = false; h.ok(mono, "monotone");
  h.ok(Math.abs((f(0.001) - f(0)) / 0.001 - 1) < 1e-3, "velocity is continuous at the click (rate 1)");
  // the true end-of-settle cue-time rate is 2/a - 1 with a = span/remaining (rate is 1 at the click, rising monotonically)
  { const a = 120 / (D - t0), rate = (e: number) => (f(e + 0.01) - f(e - 0.01 < 0 ? 0 : e - 0.01)) / (e - 0.01 < 0 ? 0.01 : 0.02);
    h.ok(Math.abs(rate(0) - 1) < 1e-2 && rate(120 - 0.01) <= 2 / a - 1 + 1e-6 && Math.abs(rate(120 - 0.01) - (2 / a - 1)) < 0.05, `end-of-settle rate is 2/a - 1 = ${(2 / a - 1).toFixed(2)}x real time (measured ${rate(120 - 0.01).toFixed(2)}x), never above it`); } 
  // the VISIBLE quantity: eased progress per 16.7 ms frame of a QUICK_SMOOTH appearance clicked at 300 of 700 ms
  { const curve = (resolveCurve({ curve: QUICK_SMOOTH, preset: "fade" } as any) as any).fn as (x: number) => number, D2 = 700, c0 = 300;
    const g = (e: number) => curve(settleTime(c0, D2, 120, e) / D2);
    let step = 0; for (let e = 16.7; e <= 120; e += 1) step = Math.max(step, g(e) - g(e - 16.7));
    const snap = 1 - curve(c0 / D2);
    h.ok(snap > 0.4 && step < 0.5 * snap, `a settled click moves at most ${(step * 100).toFixed(0)}% of the progress in one frame vs the ${(snap * 100).toFixed(0)}% snap jump (R4_T1 measured 11% at its click point)`); }
  h.eq([settleTime(700, 700, 120, 10), settleTime(0, 700, 0, 10), settleTime(150, 700, 120, -5)], [700, 700, 150], "degenerate inputs: nothing remaining / zero span snap to the end; negative elapsed clamps to the click time"); }
h.ok(SETTLE_MAX_MS === 120 && SETTLE_MIN_REMAINING_MS === 60, "SETTLE_MAX_MS 120, SETTLE_MIN_REMAINING_MS 60");
h.section("the clock starts at the first presented frame (lane J)");
{ h.eq([FIRST_TICK_MAX_MS, firstTickOrigin(1000, 1016.7), firstTickOrigin(1000, 1020), firstTickOrigin(1000, 1200), firstTickOrigin(1000, 990)], [20, 1000, 1000, 1180, 1000], "firstTickOrigin: a first frame within 20 ms keeps the origin; a later one is a hitch and is not progress; a frame before the origin changes nothing");
  const mk = () => createPlayer(document.createElement("div") as any, (() => { const d = ops.createDeck({ id: "f", title: "f", withTitleSlide: false } as any); const sl = ops.addSlide(d, { id: "s", layout: "blank" } as any); ops.addElement(d, sl.id, { id: "r", type: "rect", x: 10, y: 10, width: 50, height: 50, rotation: 0, fill: "#f00", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as any); const bb = ops.addBeat(d, sl.id, {})!; ops.setAnimation(d, sl.id, bb.id, { target: "r", preset: "popIn", start: 0, duration: 700, easing: "smooth" } as any); return d; })(), { theme: FLUX_DARK, plotManifest: () => undefined } as any);
  const p = mk(); p.seek(0, 0, Infinity); p.next();
  stepMs(250);   // the first frame arrives 250 ms after the click: flight build, layer promotion and a first raster ate it
  const first = p.state().time; h.ok(first > 0 && first <= FIRST_TICK_MAX_MS + 0.5, `a first frame ${250} ms late advances the clock by ${first.toFixed(1)} ms (<= ${FIRST_TICK_MAX_MS}), not 250: the beginning is not skipped`);
  stepMs(16.7); h.ok(Math.abs(p.state().time - (first + 16.7)) < 0.5, "later frames keep the wall clock");
  p.destroy(); }
{ // a gliding enter presents frame 0 first, with its layers primed, and moves only once a REAL later frame has arrived
  const d = ops.createDeck({ id: "g", title: "g", withTitleSlide: false } as any); const sl = ops.addSlide(d, { id: "s", layout: "blank" } as any);
  ops.addElement(d, sl.id, T("a", 0)); const bb = ops.addBeat(d, sl.id, {})!; ops.setAnimation(d, sl.id, bb.id, { target: "a", preset: "fadeRise", start: 0, duration: 700, easing: "smooth" } as any);
  const p = createPlayer(document.createElement("div") as any, d, { theme: FLUX_DARK, plotManifest: () => undefined } as any);
  p.seek(0, 0, Infinity); p.next();
  h.eq([p.state().playing, p.state().time], [true, 0], "the click presents frame 0 and starts no motion yet");
  stepMs(16.7); h.eq(p.state().time, 0, "the pre-roll frame only starts the clock (time 0)");
  stepMs(0); h.eq(p.state().time, 0, "a catch-up callback with the SAME frame timestamp does not move the stage (the primed layers have not rasterised yet)");
  stepMs(16.7); h.ok(Math.abs(p.state().time - 16.7) < 0.5, `the first moving frame is one frame of motion (${p.state().time.toFixed(1)} ms)`);
  p.destroy(); }
{ // a glider whose delay is shorter than one frame is primed at frame 0 too (it would be neither pending at frame 0 nor still pending at the first tick)
  const d = ops.createDeck({ id: "g2", title: "g2", withTitleSlide: false } as any); const sl = ops.addSlide(d, { id: "s", layout: "blank" } as any);
  ops.addElement(d, sl.id, T("a", 0)); const bb = ops.addBeat(d, sl.id, {})!; ops.setAnimation(d, sl.id, bb.id, { target: "a", preset: "fadeRise", start: 10, duration: 700, easing: "smooth" } as any);
  const p = createPlayer(document.createElement("div") as any, d, { theme: FLUX_DARK, plotManifest: () => undefined } as any);
  p.seek(0, 0, Infinity); p.next(); stepMs(16.7);
  h.eq(p.state().time, 0, "a gliding enter delayed by 10 ms (inside the first tick) also presents frame 0 first: the pre-roll frame only starts the clock");
  p.destroy(); }
h.section("settle in the real player (clockMode)");
function mkDeck() {
  const d = ops.createDeck({ id: "d", title: "d", withTitleSlide: false } as any);
  const sl = ops.addSlide(d, { id: "s", layout: "blank" } as any);
  ops.addElement(d, sl.id, T("a", 0)); ops.addElement(d, sl.id, T("b", 60)); ops.addElement(d, sl.id, T("c", 120));
  for (const el of ["a", "b", "c"]) { const bb = ops.addBeat(d, sl.id, {})!; ops.setAnimation(d, sl.id, bb.id, { target: el, preset: "fade", start: 0, duration: 700, easing: "smooth" } as any); }
  return d;
}
const mkPlayer = (extra: Record<string, unknown> = {}) => createPlayer(document.createElement("div") as any, mkDeck(), { theme: FLUX_DARK, plotManifest: () => undefined, ...extra } as any);
const frames = (n: number, ms = 16.7) => { for (let i = 0; i < n; i++) stepMs(ms); };
{ const p = mkPlayer();
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(20);
  const before = p.state(); h.eq([before.beat, before.playing], [1, true], "cue 1 is playing");
  p.next(); const mid = p.state(); h.eq([mid.beat, mid.time === before.time], [1, true], "a click mid-cue does not jump the playhead");
  const times: number[] = []; for (let i = 0; i < 12; i++) { stepMs(16.7); if (p.state().beat === 1) times.push(p.state().time); }
  h.ok(times.length >= 3 && times.length <= 8, `the settle lasts ${times.length} frames (<= 120 ms)`);
  h.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), "cue 1 keeps advancing monotonically while settling");
  h.ok(times[times.length - 1] <= 700, "the warped time never exceeds the cue duration");
  h.ok(p.state().beat === 2 && p.state().playing, "after <= 120 ms the interrupted cue has landed and cue 2 is playing");
  h.ok(p.state().time < 80, "cue 2 starts from 0 (a settled click costs at most SETTLE_MAX_MS)");
  stepMs(2000); h.eq([p.state().beat, p.state().playing], [2, false], "chain finishes on cue 2");
  p.seek(0, 0, Infinity); p.next(); stepMs(20); p.next(); p.next(); frames(80);
  h.eq([p.state().beat, p.state().playing], [3, false], "a three-click burst plays each cue in turn (none dropped), ending on the last cue");
  p.destroy(); }
{ const p = mkPlayer({ settle: false });
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(20); p.next(); h.eq([p.state().beat, p.state().time], [2, 0], "settle:false keeps the legacy snap"); p.destroy(); }
{ const p = mkPlayer();
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(660); stepMs(10); p.next(); h.ok(p.state().beat === 2 && p.state().time <= 20, "a click within SETTLE_MIN_REMAINING of the end just advances"); p.destroy(); }
{ const p = mkPlayer({ manualSteps: true });
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(20); p.next();
  h.ok(p.state().beat === 1 && !p.state().playing && p.state().time === p.state().duration, "manualSteps embeds keep the snap (the click finishes the beat, no settle)"); p.destroy(); }
{ const p = mkPlayer({ reducedMotion: true });
  p.seek(0, 0, Infinity); p.next(); h.ok(p.state().beat === 1 && !p.state().playing, "reduced motion: the cue lands at once, nothing to settle"); p.next(); h.eq(p.state().beat, 2, "reduced motion: the next click advances"); p.destroy(); }
{ const p = mkPlayer(); // seek / prev / goTo never settle and drop a pending settle (cancelClock resets the mode to "forward")
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(20); p.next(); stepMs(16.7);
  p.prev(); const st = p.state(); h.eq([st.beat, st.playing], [0, false], "prev() during a settle cancels it and goes back");
  frames(20); h.eq([p.state().beat, p.state().playing], [0, false], "the cancelled settle never chains the next cue");
  p.next(); stepMs(20); h.ok(p.state().beat === 1 && p.state().playing && Math.abs(p.state().time - 20) < 0.5, `the next cue after a cancelled settle runs on the plain forward clock (time ${p.state().time.toFixed(1)} ~ 20)`);
  p.next(); frames(12); h.eq(p.state().beat, 2, "and a click on it settles and chains as usual");
  p.destroy(); }
{ const p = mkPlayer();
  p.seek(0, 0, Infinity); p.next(); stepMs(20); p.next(); stepMs(16.7);
  p.seek(0, 1, 300); h.eq([p.state().beat, p.state().time, p.state().playing], [1, 300, false], "seek() during a settle parks the playhead exactly where asked");
  p.resume(); stepMs(16.7); stepMs(16.7);
  h.ok(Math.abs(p.state().time - (300 + 33.4)) < 1, `after a seek the clock is the forward wall clock again (cancelClock reset the mode): time ${p.state().time.toFixed(1)} ~ 333.4`);
  p.destroy(); }
{ const p = mkPlayer(); // pause / resume save and restore the mode
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(20); p.next(); stepMs(16.7);
  const parked = p.state().time; p.pause(); h.eq([p.state().beat, p.state().playing], [1, false], "pause() while settling freezes the cue");
  stepMs(500); h.eq([p.state().beat, p.state().time], [1, parked], "a paused settle does not advance");
  p.resume(); h.ok(p.state().playing, "resume() restarts the clock");
  frames(12); h.ok(p.state().beat === 2 && p.state().playing, "resume() restored the settling mode: the interrupted cue lands, then the clicked cue starts");
  p.destroy(); }
{ const p = mkPlayer();
  p.seek(0, 0, Infinity); p.next(); stepMs(20); stepMs(20); p.pause(); stepMs(300); p.resume(); frames(2);
  h.ok(p.state().beat === 1 && p.state().playing && p.state().time < 140, "pause/resume of an ordinary forward cue stays on the wall clock");
  p.next(); frames(2); h.ok(p.state().beat === 1 && p.state().playing, "and a click after that resume still settles (the mode is 'forward', not stuck)");
  frames(10); h.eq(p.state().beat, 2, "...and chains the next cue"); p.destroy(); }
{ const p = mkPlayer(); // the last beat: a click goes to the next slide (none here); it never starts a settle
  p.seek(0, 3, Infinity); p.next(); h.eq([p.state().beat, p.state().playing], [3, false], "a click on the last beat settles nothing"); p.destroy(); }
// X14: ONE clockMode variable and ONE time switch (WP 4.1 adds "rewinding" to the same switch)
{ const src = fs.readFileSync(new URL("../src/lib/slide/player/player.ts", import.meta.url), "utf8");
  h.eq([...src.matchAll(/\blet clockMode\b/g)].length, 1, "exactly one clockMode variable");
  h.ok(/type ClockMode = "forward" \| "settling"/.test(src), "clockMode is \"forward\" | \"settling\" in Release 1 (\"rewinding\" joins in WP 4.1)");
  h.ok(/function clockTime\(ts: number\)/.test(src) && /time = clockTime\(timestamp\)/.test(src), "tick computes time through the one clockTime(ts) switch");
  h.eq([...src.matchAll(/\bsettleTime\(/g)].length, 1, "settleTime is called in exactly one place (clockTime)");
  h.ok(/function cancelClock\(\)[^]*?clockMode = "forward"/.test(src), "cancelClock resets the mode to forward");
  h.ok(/if \(clockMode === "forward" && remaining >= SETTLE_MIN_REMAINING_MS\)/.test(src), "the settle branch of nextCue is guarded by clockMode === \"forward\""); }
// "Next during a rewind replays the undone beat and never settles" (X14) needs WP 4.1's "rewinding" mode: it lands with that WP.
// ---- 4c. headless set-animation through flux-core (CLI + MCP share it): a text transform is authored with the look --------
h.section("headless set-animation (flux-core)");
{
  const fsp = await import("node:fs/promises"), os = await import("node:os"), path = await import("node:path");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "flux-textlook-"));
  try {
    await core.scaffold(root, { title: "Text look" });
    const { deckId } = await core.createDeck(root, { id: "talk", title: "Talk" });
    const { slideId } = await core.addSlide(root, deckId, { name: "S", layout: "full-bleed" });
    const { elementId: t1 } = await core.addTextToSlide(root, deckId, slideId, { text: "alpha beta", x: 90, y: 150, width: 400, height: 60, fontSize: 24 });
    const { elementId: t2 } = await core.addTextToSlide(root, deckId, slideId, { text: "beta alpha", x: 90, y: 250, width: 400, height: 60, fontSize: 24 });
    const { beatId } = await core.addBeat(root, deckId, slideId, { label: "go" });
    const LOOK = { fadeStyle: "roll", letters: "travel" };
    const text = await core.setAnimation(root, deckId, slideId, beatId, { target: t1, preset: "transform", to: { state: { text: "beta alpha" } } } as any);
    h.eq(text.params, LOOK, "set-animation: a text transform gets the look");
    const stored = (await core.loadDeck(root, deckId)).slides.find(s => s.id === slideId)!.beats.find(b => b.id === beatId)!.tracks.find(t => t.target === t1)!;
    h.eq([stored.params, stored.duration, stored.easing], [LOOK, 1200, "smooth"], "...and the stored track carries it with the authored pace");
    const { beatId: b2 } = await core.addBeat(root, deckId, slideId, { label: "go2" });
    const hand = await core.setAnimation(root, deckId, slideId, b2, { target: t2, preset: "transform", to: { state: {}, become: { ref: { element: t1 }, mode: "handoff" } } } as any);
    h.eq(hand.params, LOOK, "set-animation: a text -> text hand-off gets the look");
    const { beatId: b3 } = await core.addBeat(root, deckId, slideId, { label: "go3" });
    const own = await core.setAnimation(root, deckId, slideId, b3, { target: t1, preset: "transform", params: { letters: "fade" }, to: { state: { text: "x" } } } as any);
    h.eq(own.params, { fadeStyle: "roll", letters: "fade" }, "set-animation: a supplied key wins");
    const { beatId: b4 } = await core.addBeat(root, deckId, slideId, { label: "go4" });
    const move = await core.setAnimation(root, deckId, slideId, b4, { target: t1, preset: "fade" } as any);
    h.eq(move.params, undefined, "set-animation: a fade carries no look");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}
await h.done();
