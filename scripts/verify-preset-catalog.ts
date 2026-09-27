// A1: pin the public preset facts and their compiler/player/authoring views.
// Snapshot transcribed from git show b0f9c10:src/{lib/slide/{compile,autobuild,
// family,player/presets}.ts,shell/modes/slide/animator/shared.ts}, before refactoring.
import { harness } from "./lib/harness.mjs";
import type { PresetName, Slide, Track } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import { PRESET_CATALOG, presetDef, isEnterPreset, isExitPreset, EDITABLE_PRESETS, KNOWN_PRESETS } from "../src/lib/slide/presetCatalog";
import { PRESETS, ENTER_PRESETS, EXIT_PRESETS, PRESET_WRAPPER_PROPS } from "../src/lib/slide/player/presets";
import { familyOf } from "../src/lib/slide/family";
import { compileSlide, trackDuration } from "../src/lib/slide/compile";
import { autoAnimatePlot, suggestTrack } from "../src/lib/slide/autobuild";
import { isVideoCommand } from "../src/lib/slide/mediaTimeline";
import { PRESET_COLOR, EDIT_PRESETS, presetLabel } from "../src/shell/modes/slide/animator/shared";
import * as core from "../flux-core/index";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const h = harness("verify-preset-catalog");
type Snapshot = readonly [label: string, colour: string, wrapperProps: readonly string[], duration: number,
  editable: boolean, family: string, phase: string, autoBuildDuration?: number];
const EXPECTED = {
  fade:         ["Fade in",     "#879a39", ["opacity"],              320, true,  "appearance", "enter", 300],
  fadeRise:     ["Rise in",     "#879a39", ["opacity", "transform"], 320, true,  "appearance", "enter", 320],
  popIn:        ["Pop in",      "#8b7ec8", ["opacity", "transform"], 320, true,  "appearance", "enter", 300],
  drawOn:       ["Draw on",     "#4385be", [],                       320, true,  "appearance", "enter", 600],
  growBaseline: ["Grow",        "#d0a215", ["transform"],            320, true,  "appearance", "enter", 500],
  stagger:      ["Stagger in",  "#d14d41", ["opacity", "transform"], 320, true,  "appearance", "enter", 240],
  writeOn:      ["Wipe in",     "#3aa99f", ["clipPath"],             320, true,  "appearance", "enter", 500],
  fadeOut:      ["Fade out",    "#af3029", ["opacity"],              320, true,  "appearance", "exit"],
  popOut:       ["Pop out",     "#af3029", ["opacity", "transform"], 320, true,  "appearance", "exit"],
  drawOff:      ["Draw off",    "#af3029", [],                       320, true,  "appearance", "exit"],
  wipeOut:      ["Wipe out",    "#af3029", ["clipPath"],             320, true,  "appearance", "exit"],
  highlight:    ["Highlight",   "#d0a215", ["opacity"],              320, true,  "appearance", "emphasis"],
  dim:          ["Dim",         "#6f6e69", ["opacity"],              320, true,  "appearance", "emphasis"],
  countUp:      ["Count up",    "#66800b", [],                       800, true,  "appearance", "count"],
  move:         ["move",        "#4385be", ["transform"],            320, false, "appearance", "spatial"],
  scale:        ["scale",       "#4385be", ["transform"],            320, false, "appearance", "spatial"],
  rotate:       ["rotate",      "#4385be", ["transform"],            320, false, "appearance", "spatial"],
  camera:       ["Camera",      "#a02f6f", [],                       320, false, "camera",     "camera"],
  transform:    ["Transform",   "#66800b", [],                       600, false, "transform",  "transform"],
  videoStart:   ["Start video", "#3aa99f", [],                         0, false, "media",      "media"],
  videoPause:   ["Pause video", "#d0a215", [],                         0, false, "media",      "media"],
  videoStop:    ["Stop video",  "#af3029", [],                         0, false, "media",      "media"],
} as const satisfies Record<PresetName, Snapshot>;
const names = Object.keys(EXPECTED) as PresetName[];
// Both directions are checked by TypeScript as well as by the runtime census.
const exactNames: [Exclude<PresetName, keyof typeof PRESET_CATALOG>, Exclude<keyof typeof PRESET_CATALOG, PresetName>] extends [never, never] ? true : false = true;
h.ok(exactNames, "catalog keys cover exactly PresetName at the type boundary");
h.eq(Object.keys(PRESET_CATALOG).sort(), [...names].sort(), "catalog covers every base preset, with no extras");
// Camera still has a WAAPI compiler at base. Transform/countUp and the three
// zero-duration media commands are the names with no PRESETS implementation.
const controllers: PresetName[] = ["transform", "countUp", "camera", "videoStart", "videoPause", "videoStop"];
h.eq([...new Set([...Object.keys(PRESETS), ...controllers])].sort(), [...names].sort(), "real player compilers and controllers cover exactly the catalog");
h.eq(Object.keys(PRESETS).sort(), names.filter(name => !["transform", "countUp", "videoStart", "videoPause", "videoStop"].includes(name)).sort(),
  "every WAAPI preset, including camera, keeps its real compiler");
h.eq([...KNOWN_PRESETS].sort(), [...names].sort(), "known names are the exact catalog keys");

const stage = { width: 1280, height: 720 };
for (const name of names) {
  const [label, colour, wrapperProps, duration, editable, family, phase, autoBuildDuration] = EXPECTED[name] as Snapshot;
  const def = presetDef(name);
  h.eq([def.name, def.label, def.colour, def.wrapperProps, def.defaultDurationMs, def.editable, def.family, def.phase, def.autoBuildDurationMs],
    [name, label, colour, wrapperProps, duration, editable, family, phase, autoBuildDuration], `${name}: exact base facts`);
  h.ok(def === PRESET_CATALOG[name], `${name}: lookup returns the catalog definition`);
  h.eq([presetLabel(name), PRESET_COLOR[name], PRESET_WRAPPER_PROPS[name] ?? [], EDIT_PRESETS.includes(name)],
    [label, colour, wrapperProps, editable], `${name}: UI and wrapper views preserve their bytes`);
  h.eq(Object.hasOwn(PRESET_WRAPPER_PROPS, name), wrapperProps.length > 0, `${name}: empty wrapper entries remain absent`);
  h.eq([isEnterPreset(name), isExitPreset(name), ENTER_PRESETS.has(name), EXIT_PRESETS.has(name)],
    [phase === "enter", phase === "exit", phase === "enter", phase === "exit"], `${name}: phase views agree`);
  h.eq(familyOf({ preset: name }), family, `${name}: family law agrees`);
  h.eq(isVideoCommand({ target: "e", preset: name }), family === "media", `${name}: media classification agrees`);
  h.eq(!!def.legacy, ["move", "scale", "rotate"].includes(name), `${name}: only the frozen spatial channel is legacy`);
  const track: Track = { target: family === "camera" ? "@camera" : "e", preset: name };
  h.eq([trackDuration(track), trackDuration({ ...track, duration: 123 }), trackDuration({ ...track, duration: -1 })],
    [duration, family === "media" ? 0 : 123, 0], `${name}: default, explicit and clamped duration`);
  const slide: Slide = { id: "s", elements: [{ type: "video", id: "e", assetId: "video", posterAssetId: "poster", durationMs: 1000, x: 0, y: 0, width: 100, height: 100, rotation: 0 }],
    beats: [{ id: "design", tracks: [] }, { id: "step", tracks: [track] }] };
  const compiled = compileSlide(slide, stage, {});
  h.eq(compiled.issues, [], `${name}: accepted by the real compiler`);
  h.eq(compiled.cues[1].tracks[0]?.duration, duration, `${name}: compiled timing preserves the default`);
  if (phase === "enter" || phase === "exit") {
    h.eq([compiled.sample(0).presentation.elementStates.e?.opacity, compiled.sample(1).presentation.elementStates.e?.opacity],
      phase === "enter" ? [0, 1] : [1, 0], `${name}: compiled visibility preserves phase`);
  }
}
h.eq(EDITABLE_PRESETS, names.filter(name => EXPECTED[name][4]), "editable preset order is byte-identical to the original select");
h.eq(EDIT_PRESETS, EDITABLE_PRESETS, "Animator consumes the catalog's editable order");

h.section("autobuild keeps its authored defaults, separate from playback defaults");
for (const name of names.filter(name => EXPECTED[name][6] === "enter")) {
  const role = name === "stagger" ? "point" : "area";
  const animation = ({ fade: "fade-in", fadeRise: "rise", popIn: "pop-in", drawOn: "draw-on", growBaseline: "grow", stagger: "stagger-in", writeOn: "write-on" } as Record<string, string>)[name];
  const manifest: FluxPlotManifest = { spec: "fluxplot", schemaVersion: "0.3.0", plotType: "test", svg: "fixture.svg",
    size: { width: 100, height: 100, unit: "px" }, axes: [], series: [],
    parts: { id: "plot", role: "plot", children: [{ id: "mark", role }] },
    build: { order: ["mark"], presets: { [role]: { animation } } } };
  const pick = ({ id: _id, ...track }: Track) => track;
  const expected = { target: "plot1", part: "mark", preset: name, duration: (EXPECTED[name] as Snapshot)[7], start: 0,
    ...(name === "stagger" ? { stagger: { perMs: 40, by: "x", from: "start" }, params: { child: "fade" } } : {}) };
  h.eq(pick(suggestTrack(manifest, "plot1", "mark")), expected, `${name}: suggested track bytes unchanged except generated ID`);
  h.eq(pick(autoAnimatePlot(manifest, "plot1")[0].tracks[0]), { ...expected, generatedBy: "auto-reveal" }, `${name}: automatic build bytes unchanged except generated ID`);
  manifest.build!.presets![role].durationMs = 117;
  h.eq(suggestTrack(manifest, "plot1", "mark").duration, 117, `${name}: manifest duration still wins`);
}

h.section("fallback and the headless export surface");
for (const name of [undefined, "unknown-effect", "", "toString", "constructor", "__proto__"]) {
  h.ok(presetDef(name) === PRESET_CATALOG.fade, `${String(name)}: lookup falls back to the fade definition`);
  h.ok(!KNOWN_PRESETS.has(name as string), `${String(name)}: fallback does not register an unknown name`);
}
h.eq(presetLabel("unknown-effect"), "unknown-effect", "unknown UI labels retain the authored string");
h.eq(trackDuration({ target: "e" }), 320, "absent preset retains the fade duration");
h.eq(familyOf({}), "appearance", "absent preset retains the appearance family");
const unknown: Track = { target: "@camera", preset: "unknown-effect" as PresetName };
h.eq([trackDuration(unknown), familyOf(unknown)], [320, "appearance"], "unknown tracks retain fallback timing and family");
const rejected = compileSlide({ id: "unknown", elements: [], beats: [{ id: "b", tracks: [unknown] }] }, stage, {});
h.eq(rejected.cues[0].tracks.length, 0, "the compiler rejects unknown effects before playback");
h.eq(rejected.issues[0]?.reason, "Unknown effect: unknown-effect", "unknown effect diagnostics are unchanged");
h.ok(core.PRESET_CATALOG === PRESET_CATALOG && core.presetDef === presetDef && core.isEnterPreset === isEnterPreset && core.isExitPreset === isExitPreset && core.EDITABLE_PRESETS === EDITABLE_PRESETS && core.KNOWN_PRESETS === KNOWN_PRESETS,
  "flux-core exports the same catalog and helpers, not a second implementation");

h.section("no hand-kept enter/exit lists outside the catalog");
// Plan §2.2 item 7: a second list of enter or exit names is how a new preset
// silently misses a consumer. Any bracket literal (array / Set / `.includes`
// operand) naming two or more presets of one phase is such a list; derive it
// from presetCatalog.ts instead (isEnterPreset / isExitPreset / ENTER_PRESETS).
const phaseNames = (phase: string) => new Set(Object.values(PRESET_CATALOG).filter(def => def.phase === phase).map(def => def.name as string));
const enterNames = phaseNames("enter"), exitNames = phaseNames("exit");
function phaseLists(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\[[^\[\]]*\]/g)) {
    const quoted = [...m[0].matchAll(/["'`]([A-Za-z]+)["'`]/g)].map(q => q[1]);
    if (quoted.filter(n => enterNames.has(n)).length >= 2 || quoted.filter(n => exitNames.has(n)).length >= 2)
      found.push(m[0].replace(/\s+/g, " ").slice(0, 90));
  }
  return found;
}
h.ok(phaseLists(`t => ["fadeOut", "popOut", "drawOff", "wipeOut"].includes(t.preset ?? "")`).length === 1, "the census detects an inline exit list");
h.ok(phaseLists(`new Set([\n  "fade", "fadeRise",\n])`).length === 1, "the census detects a multi-line enter Set");
h.ok(phaseLists(`const RISE = new Set(["fadeRise"]), POP_OUT = new Set(["popOut"]); a[i] === "fadeOut"`).length === 0,
  "single-preset special cases and index expressions are not lists");
const repo = path.join(import.meta.dirname, "..");
const scanned: string[] = [];
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(ts|svelte|js|mjs)$/.test(name)) scanned.push(file);
  }
};
walk(path.join(repo, "src/lib/slide"));
walk(path.join(repo, "src/shell/modes/slide"));
scanned.push(path.join(repo, "flux-core/slides.ts"));
const catalogFile = path.join(repo, "src/lib/slide/presetCatalog.ts");
h.ok(["src/lib/slide/presetCatalog.ts", "src/lib/slide/ops.ts", "src/lib/slide/compile.ts", "src/shell/modes/slide/SlideMode.svelte", "src/shell/modes/slide/animator/shared.ts"]
  .every(f => scanned.includes(path.join(repo, f))) && scanned.length > 60,
  `the census covers src/lib/slide/**, src/shell/modes/slide/** and flux-core/slides.ts (${scanned.length} files)`);
const offenders = scanned.filter(f => f !== catalogFile).flatMap(f => phaseLists(readFileSync(f, "utf8")).map(list => `${path.relative(repo, f)}: ${list}`));
h.eq(offenders, [], "no literal enter/exit preset list outside presetCatalog.ts");
await h.done();
