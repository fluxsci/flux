#!/usr/bin/env -S npx tsx
// PRESET_PARAMS — the ONE open table of every `track.params` key a preset reads (WP 1.2, ruling X10).
//   1. the table: a row per preset, every default is TODAY'S literal (a frozen snapshot below), ranges are sane;
//   2. the census (grep): player/presets.ts, compile.ts and export/pptxBuilds.ts read NO `params.<key>` directly, and
//      every `presetParam(...)` call site names a key the table declares (a new reader must extend the table);
//   3. the reader: absent / malformed (wrong type, NaN, "") -> the default; authored -> authored; `range` clamps;
//   4. the three engines agree: the player's keyframes, compile's samples and the PPTX twins read the SAME value for an
//      authored value (Release 1 authoring writes fadeRise y = 24), for an absent key and for a malformed one;
//   5. unknown keys are KEPT and reported (a compile issue), never refused or stripped; `requires` is reported.
//   Run: node --import tsx scripts/verify-preset-params.ts
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import {
  PRESET_PARAMS, PRESET_CATALOG, KNOWN_PRESETS, presetParam, paramSpec, paramDiagnostics, legacyScaleOf, legacyRotationOf,
  highlightOpacity, dimOpacity, type ParamRow,
} from "../src/lib/slide/presetCatalog";
import { PRESETS, type PresetCtx, type TargetNode } from "../src/lib/slide/player/presets";
import { compileSlide } from "../src/lib/slide/compile";
import { pptxPages } from "../src/lib/slide/export/pptxBuilds";
import { createDeck } from "../src/lib/slide/ops";
import { validateDeckFile } from "../src/lib/project/validate";
import type { Track } from "../src/lib/slide/types";

const h = harness("verify-preset-params");
const { document, DOMParser, XMLSerializer } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, DOMParser, XMLSerializer });

// ---------------------------------------------------------------------------------------------------------------
h.section("1. the table");
// The classic literals as they stood in presets.ts / compile.ts / pptxBuilds.ts BEFORE the table existed. FROZEN: a
// default may never change (saved decks and every authoring layer write values instead).
const FROZEN: Record<string, Record<string, unknown>> = {
  fadeRise: { y: 14 }, popIn: { from: 0.9 }, popOut: { to: 0.92 }, scale: { scale: 1.15 }, rotate: { deg: 15 },
  stagger: { child: "fadeRise" }, writeOn: { direction: "ltr" }, wipeOut: { direction: "ltr" },
  drawOn: { anchor: "start", direction: "forward", mode: "single", from: 0, to: 1 },
  drawOff: { anchor: "start", direction: "forward", mode: "single", from: 0, to: 1 },
  highlight: { level: 0.4 }, dim: { level: 0.3 },
};
h.eq(Object.keys(PRESET_PARAMS).sort(), Object.keys(PRESET_CATALOG).sort(), "one row per catalog preset (a new preset forces its row)");
for (const [preset, keys] of Object.entries(FROZEN)) {
  const row = PRESET_PARAMS[preset as keyof typeof PRESET_PARAMS];
  h.eq(Object.fromEntries(Object.entries(row).map(([k, s]) => [k, s.default])), keys, `${preset}: defaults are today's literals`);
}
for (const [preset, row] of Object.entries(PRESET_PARAMS)) for (const [key, spec] of Object.entries(row)) {
  const bad = spec.range && !(spec.range[0] < spec.range[1]) ? "range is not ordered" : spec.range && typeof spec.default !== "number" ? "range on a non-number" :
    spec.range && typeof spec.default === "number" && (spec.default < spec.range[0] || spec.default > spec.range[1]) ? "default outside its range" :
    spec.requires && !(spec.requires.key in row) ? "requires names a key that is not in the row" : "";
  if (bad) h.fail(`${preset}.${key}: ${bad}`);
}
h.ok(true, "every range is ordered and holds its default, every `requires` names a sibling key");
h.eq(Object.entries(PRESET_PARAMS).flatMap(([p, row]) => Object.entries(row).filter(([, s]) => s.range).map(([k, s]) => `${p}.${k}:${s.range}`)).sort(),
  ["dim.level:0,1", "highlight.level:0,1"], "only the NEW keys (the highlight/dim levels) are clamped; every legacy key stays unclamped");

// ---------------------------------------------------------------------------------------------------------------
h.section("2. the census: the three engines read params through the table only");
// presetParam<T>(track, "key", "preset") — the preset is a literal, or (trimAnim) the `preset` variable naming drawOn | drawOff.
const CALL = /presetParam(?:<[^>]*>)?\(\s*[^,()]+,\s*"(\w+)"\s*,\s*(?:"(\w+)"|(preset))\s*\)/g;
const owners = (literal: string | undefined, variable: string | undefined): string[] => literal ? [literal] : variable ? ["drawOn", "drawOff"] : [];
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
for (const file of ["src/lib/slide/player/presets.ts", "src/lib/slide/compile.ts", "src/lib/slide/export/pptxBuilds.ts"]) {
  const src = strip(readFileSync(file, "utf8"));
  const direct = [...src.matchAll(/\bparams\??\.\w+/g)].map((m) => m[0]);
  h.eq(direct, [], `${file}: no direct params.<key> read`);
  const sites = [...src.matchAll(CALL)].map((m) => ({ key: m[1], presets: owners(m[2], m[3]) }));
  const unknown = sites.filter((c) => !c.presets.length || c.presets.some((p) => !paramSpec(p, c.key))).map((c) => `${c.presets.join("|") || "?"}.${c.key}`);
  h.ok(unknown.length === 0, `${file}: ${sites.length} presetParam read(s), each names a table entry${unknown.length ? " — missing: " + unknown.join(", ") : ""}`);
}
{
  // every table key a compiler reads is read through the table: the keys the three files name == the table's keys (minus countUp's, read by countup.ts)
  const named = new Set<string>();
  for (const file of ["src/lib/slide/player/presets.ts", "src/lib/slide/compile.ts", "src/lib/slide/export/pptxBuilds.ts", "src/lib/slide/presetCatalog.ts"]) {
    for (const m of strip(readFileSync(file, "utf8")).matchAll(CALL)) for (const p of owners(m[2], m[3])) named.add(`${p}.${m[1]}`);
  }
  const declared = Object.entries(PRESET_PARAMS).filter(([p]) => p !== "countUp").flatMap(([p, row]) => Object.keys(row).map((k) => `${p}.${k}`));
  const unread = declared.filter((k) => !named.has(k));
  h.eq(unread, [], "every declared key (countUp's, read by player/countup.ts, excepted) is read through presetParam somewhere");
}

// ---------------------------------------------------------------------------------------------------------------
h.section("3. the reader");
const T = (preset: string, params?: Record<string, unknown>): Track => ({ id: "t", target: "x", preset, ...(params ? { params } : {}) }) as Track;
h.eq(presetParam(T("fadeRise"), "y", "fadeRise"), 14, "absent -> the default");
h.eq(presetParam(T("fadeRise", {}), "y", "fadeRise"), 14, "empty params -> the default");
h.eq(presetParam(T("fadeRise", { y: 24 }), "y", "fadeRise"), 24, "authored -> authored");
h.eq(presetParam(T("fadeRise", { y: 0 }), "y", "fadeRise"), 0, "authored 0 is a value, not absence");
h.eq(presetParam(T("fadeRise", { y: -30 }), "y", "fadeRise"), -30, "legacy keys are not clamped (a negative rise is authored)");
for (const bad of ["24", "", NaN, Infinity, null, true, {}, [24]]) h.eq(presetParam(T("fadeRise", { y: bad }), "y", "fadeRise"), 14, `malformed ${JSON.stringify(bad) ?? String(bad)} -> the default`);
h.eq(presetParam(T("popIn", { from: 0.5 }), "from", "popIn"), 0.5, "popIn.from authored");
h.eq(presetParam(T("stagger", { child: "popIn" }), "child", "stagger"), "popIn", "stagger.child authored");
h.eq(presetParam(T("stagger", { child: "" }), "child", "stagger"), "fadeRise", "an empty child -> fadeRise (the old `|| \"fadeRise\"`)");
h.eq(presetParam(T("writeOn", { direction: "rtl" }), "direction", "writeOn"), "rtl", "wipe direction authored");
h.eq(presetParam(T("drawOn", { anchor: 0.5 }), "anchor", "drawOn"), 0.5, "trim anchor accepts a number");
h.eq(presetParam(T("drawOn", { anchor: "middle" }), "anchor", "drawOn"), "middle", "trim anchor accepts a name");
h.eq(presetParam(T("drawOn", { anchor: {} }), "anchor", "drawOn"), "start", "trim anchor of another type -> start");
h.eq(presetParam(T("highlight", { level: 2 }), "level", "highlight"), 1, "highlight.level clamps to 1");
h.eq(presetParam(T("highlight", { level: -1 }), "level", "highlight"), 0, "highlight.level clamps to 0");
h.eq(presetParam(T("dim", { level: 0.5 }), "level", "dim"), 0.5, "dim.level authored in range");
h.eq(presetParam(T("stagger", { y: 30 }), "y", "fadeRise"), 30, "`as` reads another preset's row from the host track (a stagger's child)");
let threw = false; try { presetParam(T("fadeRise"), "nope", "fadeRise"); } catch { threw = true; }
h.ok(threw, "a reader asking for a key the table lacks is a programming error (throws), not a silent default");
h.eq(legacyScaleOf(T("scale")), 1.15, "legacy scale: default 1.15");
h.eq(legacyScaleOf({ ...T("scale", { scale: 1.4 }), to: { scale: 2 } } as never), 2, "legacy scale: `to.scale` wins over params");
h.eq(legacyScaleOf(T("scale", { scale: 1.4 })), 1.4, "legacy scale: params.scale");
h.eq(legacyRotationOf(T("rotate")), 15, "legacy rotate: default 15");
h.eq(legacyRotationOf({ ...T("rotate", { deg: 40 }), to: { rotation: 90, deg: 10 } } as never), 90, "legacy rotate: to.rotation, then to.deg, then params.deg");
h.eq(legacyRotationOf({ ...T("rotate", { deg: 40 }), to: { deg: 10 } } as never), 10, "legacy rotate: to.deg");
h.eq(legacyRotationOf(T("rotate", { deg: 40 })), 40, "legacy rotate: params.deg");
{
  let bad = 0;
  for (let i = 0; i <= 20; i++) { const at = i / 20; if (highlightOpacity(0.4, at) !== 0.4 + 0.6 * at || dimOpacity(0.3, at) !== 1 - 0.7 * at) bad++; }
  h.eq(bad, 0, "highlight/dim at the default levels are BIT-IDENTICAL to the old `.4 + .6*at` / `1 - .7*at`");
}

// ---------------------------------------------------------------------------------------------------------------
h.section("4. player, compile and PPTX read the same value");
const node = (): TargetNode => ({ style: {}, getAttribute: () => null } as unknown as TargetNode);
const ctx = { theme: {}, stage: { width: 640, height: 360 } } as unknown as PresetCtx;
const play = (t: Track) => PRESETS[t.preset ?? "fade"]([node()], t, ctx)[0].keyframes;
const num = (s: unknown, rx: RegExp): number => Number(String(s).match(rx)![1]);

// the PPTX planner on a one-click deck
const box = (id: string, x: number, y: number) => ({ rotation: 0, id, type: "rect", name: id, x, y, width: 100, height: 60, fill: "#205EA6", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
const pages = (preset: string, params: Record<string, unknown> | undefined, enter: boolean) => {
  const d = createDeck({ id: "pp", title: "pp", withTitleSlide: false }); d.stage = { width: 640, height: 360 };
  d.slides = [{ id: "s", name: "s", groups: {}, elements: [box("a", 100, 100)], beats: [{ id: "b0", tracks: enter ? [] : [] }, { id: "b1", tracks: [{ id: "k", target: "a", preset, duration: 1000, easing: "linear", ...(params ? { params } : {}) }] }] }] as never;
  if (!enter) (d.slides[0].elements[0] as { hidden?: boolean }).hidden = false;
  return pptxPages({ deck: d, plots: {}, assets: {}, assetSizes: {} } as never, "animated");
};
const el = (p: ReturnType<typeof pages>, i: number) => p[i].ev.elements.find((e) => e.id === "a")!;

for (const [label, params, want] of [["authored y = 24", { y: 24 }, 24], ["absent y", undefined, 14], ["malformed y = \"24\"", { y: "24" }, 14]] as const) {
  const kf = play(T("fadeRise", params as never));
  const player = num(kf[0].transform, /translateY\((-?[\d.]+)px\)/);
  const p = pages("fadeRise", params as never, true);
  const pptx = el(p, 0).y - el(p, 1).y;
  h.ok(player === want && pptx === want, `fadeRise ${label}: player ${player}, PPTX twin ${pptx}, table ${want}`);
}
for (const [label, params, want] of [["authored from = 0.5", { from: 0.5 }, 0.5], ["absent from", undefined, 0.9], ["malformed from", { from: "0.5" }, 0.9]] as const) {
  const player = num(play(T("popIn", params as never))[0].transform, /scale\(([\d.]+)\)/);
  const p = pages("popIn", params as never, true);
  const pptx = el(p, 0).width / el(p, 1).width;
  h.ok(player === want && Math.abs(pptx - want) < 1e-9, `popIn ${label}: player ${player}, PPTX twin ${pptx.toFixed(4)}, table ${want}`);
}
for (const [label, params, want] of [["authored to = 0.5", { to: 0.5 }, 0.5], ["absent to", undefined, 0.92], ["malformed to", { to: "0.5" }, 0.92]] as const) {
  const player = num(play(T("popOut", params as never))[1].transform, /scale\(([\d.]+)\)/);
  const p = pages("popOut", params as never, false);
  const pptx = el(p, 1).width / el(p, 0).width;
  h.ok(player === want && Math.abs(pptx - want) < 1e-9, `popOut ${label}: player ${player}, PPTX twin ${pptx.toFixed(4)}, table ${want}`);
}

// compile samples (the editor canvas, PPTX pages, video) vs the player's keyframes
const compiled = (preset: string, params: Record<string, unknown> | undefined) => {
  const d = createDeck({ id: "cc", title: "cc", withTitleSlide: false });
  d.slides = [{ id: "s", name: "s", groups: {}, elements: [box("a", 100, 100)], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "k", target: "a", preset, duration: 1000, easing: "linear", ...(params ? { params } : {}) }] }] }] as never;
  return compileSlide(d.slides[0], { width: 640, height: 360 }, {});
};
for (const preset of ["highlight", "dim"] as const) for (const [label, params, level] of [["authored level 0.2", { level: 0.2 }, 0.2], ["absent level", undefined, preset === "dim" ? 0.3 : 0.4], ["malformed level", { level: "0.2" }, preset === "dim" ? 0.3 : 0.4], ["clamped level 3", { level: 3 }, 1]] as const) {
  const kf = play(T(preset, params as never)), a = Number(kf[0].opacity), b = Number(kf[1].opacity), c = compiled(preset, params as never);
  let worst = 0;
  for (const at of [0, 0.25, 0.5, 0.75, 1]) { const player = a + (b - a) * at, comp = c.sample(1, at * 1000).presentation.elementStates.a?.opacity ?? 1; worst = Math.max(worst, Math.abs(player - comp)); }
  h.ok(worst === 0 && (preset === "dim" ? b : a) === level, `${preset} ${label}: player keyframes == compile samples (worst ${worst}), level ${preset === "dim" ? b : a}`);
}
for (const [label, params, want] of [["authored scale 1.5", { scale: 1.5 }, 1.5], ["absent scale", undefined, 1.15], ["malformed scale", { scale: "1.5" }, 1.15]] as const) {
  const player = num(play(T("scale", params as never))[1].transform, /scale\(([\d.]+)\)/);
  const end = compiled("scale", params as never).sample(1, 1000).elements.find((e) => e.id === "a")!;
  h.ok(player === want && Math.abs(end.width / 100 - want) < 1e-9, `scale ${label}: player ${player}, compile ${(end.width / 100).toFixed(4)}, table ${want}`);
}
for (const [label, params, want] of [["authored deg 40", { deg: 40 }, 40], ["absent deg", undefined, 15], ["malformed deg", { deg: "40" }, 15]] as const) {
  const player = num(play(T("rotate", params as never))[1].transform, /rotate\((-?[\d.]+)deg\)/);
  const end = compiled("rotate", params as never).sample(1, 1000).elements.find((e) => e.id === "a")!;
  h.ok(player === want && Math.abs(end.rotation - want) < 1e-9, `rotate ${label}: player ${player}, compile ${end.rotation}, table ${want}`);
}
// wipes + trim + stagger child: the player reads the table (compile/PPTX never read these)
h.ok(String(play(T("writeOn", { direction: "rtl" }))[0].clipPath).includes("100%") && play(T("writeOn", { direction: "rtl" }))[0].clipPath !== play(T("writeOn"))[0].clipPath, "writeOn.direction authored changes the wipe; absent = ltr");
h.eq(play(T("writeOn", { direction: 5 }))[0].clipPath, play(T("writeOn"))[0].clipPath, "writeOn.direction malformed -> ltr");
h.eq(play(T("wipeOut", { direction: "ttb" }))[1].clipPath !== play(T("wipeOut"))[1].clipPath, true, "wipeOut.direction authored changes the wipe");
h.eq(play(T("stagger", { child: "popIn", from: 0.5 }))[0].transform, "scale(0.5)", "stagger child popIn reads popIn.from from the stagger track's own params");
h.eq(play(T("stagger", { y: 30 }))[0].transform, "translateY(30px)", "stagger default child fadeRise reads fadeRise.y");
h.eq(play(T("stagger", { child: "nope" }))[0].transform, "translateY(14px)", "an unknown stagger child falls back to fadeRise");

// ---------------------------------------------------------------------------------------------------------------
h.section("5. unknown keys: kept, reported, never refused");
{
  const d = createDeck({ id: "u", title: "u", withTitleSlide: false });
  const params = { y: 24, wobble: 3, note: "hi" };
  d.slides = [{ id: "s", name: "s", groups: {}, elements: [box("a", 100, 100)], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [
    { id: "k", target: "a", preset: "fadeRise", duration: 500, params },
    { id: "ok", target: "a", preset: "stagger", duration: 500, params: { child: "popIn", from: 0.5 } },
    { id: "cu", target: "a", preset: "countUp", duration: 500, params: { to: 10, decimals: 1, prefix: "$", suffix: "k", separator: true } },
    { id: "tr", target: "a", preset: "drawOn", duration: 500, params: { anchor: "middle", mode: "both-ends", from: 0.1, to: 0.9, direction: "reverse" } },
  ] }] }] as never;
  const c = compileSlide(d.slides[0], { width: 640, height: 360 }, {});
  const issues = c.issues.filter((i) => /Unknown option/.test(i.reason));
  h.eq(issues.map((i) => `${i.trackId}:${i.reason.match(/“(\w+)”/)![1]}`).sort(), ["k:note", "k:wobble"], "exactly the unknown keys are reported (stagger children, countUp and trim keys are known)");
  h.ok(JSON.stringify(d.slides[0].beats[1].tracks[0].params) === JSON.stringify({ y: 24, wobble: 3, note: "hi" }), "compile never strips an unknown key from the track");
  h.eq(c.resolvedSlide.beats[1].tracks[0].params, params, "the resolved track keeps the unknown keys too");
  h.eq(validateDeckFile(d), [], "the deck load gate does not refuse a deck with an unknown param");
  h.eq(c.sample(1, 500).elements.length, 1, "the unknown key does not stop the track from compiling");
}
h.eq(paramDiagnostics(T("fade")), [], "no params -> no diagnostics");
h.eq(paramDiagnostics(T("dim", { level: 0.2 })), [], "a known key -> no diagnostics");
h.eq(paramDiagnostics(T("stagger", { child: "nope", from: 0.5 })).length, 1, "an unknown stagger child contributes no keys: `from` is reported");
{
  // `requires` (T2's order, T8's clock/pen/tight): a key that only applies while a sibling holds a value
  const table: Record<string, ParamRow> = { ...PRESET_PARAMS, drawOn: { mode: { default: "single" }, lag: { default: 0.3, requires: { key: "mode", equals: "sequence" } } } };
  h.eq(paramDiagnostics(T("drawOn", { lag: 0.5 }), table).length, 1, "requires: `lag` without mode \"sequence\" is reported");
  h.eq(paramDiagnostics(T("drawOn", { lag: 0.5, mode: "sequence" }), table), [], "requires: met by an authored sibling -> silent");
  h.eq(paramDiagnostics(T("drawOn", { lag: 0.5, mode: 3 }), table).length, 1, "requires: a malformed sibling reads as its default -> reported");
}
h.ok(KNOWN_PRESETS.size === Object.keys(PRESET_PARAMS).length, "KNOWN_PRESETS and PRESET_PARAMS agree");
await h.done();
