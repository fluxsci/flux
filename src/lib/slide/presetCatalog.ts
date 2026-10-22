// Preset facts shared by compilation, playback and authoring. Keep this module
// pure: WAAPI compilers and role/element recommendation policy live elsewhere.
import type { EasingToken, PresetName } from "./types";
import type { TrackFamily } from "./family";

export interface PresetDef {
  name: PresetName;
  family: TrackFamily;
  phase: "enter" | "exit" | "emphasis" | "spatial" | "camera" | "media" | "transform" | "count";
  label: string;
  colour: string;
  wrapperProps: readonly string[];
  defaultDurationMs: number;
  defaultEasing: EasingToken;
  editable: boolean;
  legacy?: boolean;
  /** Plot build recommendations historically use different durations from
   *  tracks with omitted timing. Preserve both when authoring a build. */
  autoBuildDurationMs?: number;
  /** Explicit camera commands historically author a longer, smooth move.
   * Omitted playback timing still uses defaultDurationMs/defaultEasing. */
  authoringTiming?: { duration: number; easing: EasingToken };
}

// Editable entries are in the Animator's established select order.
export const PRESET_CATALOG: Readonly<Record<PresetName, PresetDef>> = {
  fade: { name: "fade", family: "appearance", phase: "enter", label: "Fade in", colour: "#879a39", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 300 },
  fadeRise: { name: "fadeRise", family: "appearance", phase: "enter", label: "Rise in", colour: "#879a39", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 320 },
  popIn: { name: "popIn", family: "appearance", phase: "enter", label: "Pop in", colour: "#8b7ec8", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 300 },
  drawOn: { name: "drawOn", family: "appearance", phase: "enter", label: "Draw on", colour: "#4385be", wrapperProps: [], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 600 },
  growBaseline: { name: "growBaseline", family: "appearance", phase: "enter", label: "Grow", colour: "#d0a215", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 500 },
  stagger: { name: "stagger", family: "appearance", phase: "enter", label: "Stagger in", colour: "#d14d41", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 240 },
  writeOn: { name: "writeOn", family: "appearance", phase: "enter", label: "Wipe in", colour: "#3aa99f", wrapperProps: ["clipPath"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 500 },
  fadeOut: { name: "fadeOut", family: "appearance", phase: "exit", label: "Fade out", colour: "#af3029", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true },
  popOut: { name: "popOut", family: "appearance", phase: "exit", label: "Pop out", colour: "#af3029", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true },
  drawOff: { name: "drawOff", family: "appearance", phase: "exit", label: "Draw off", colour: "#af3029", wrapperProps: [], defaultDurationMs: 320, defaultEasing: "standard", editable: true },
  wipeOut: { name: "wipeOut", family: "appearance", phase: "exit", label: "Wipe out", colour: "#af3029", wrapperProps: ["clipPath"], defaultDurationMs: 320, defaultEasing: "standard", editable: true },
  highlight: { name: "highlight", family: "appearance", phase: "emphasis", label: "Highlight", colour: "#d0a215", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true },
  dim: { name: "dim", family: "appearance", phase: "emphasis", label: "Dim", colour: "#6f6e69", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true },
  countUp: { name: "countUp", family: "appearance", phase: "count", label: "Count up", colour: "#66800b", wrapperProps: [], defaultDurationMs: 800, defaultEasing: "standard", editable: true },
  // Frozen compatibility channel; new geometry edits use transform.
  move: { name: "move", family: "appearance", phase: "spatial", label: "move", colour: "#4385be", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: false, legacy: true },
  scale: { name: "scale", family: "appearance", phase: "spatial", label: "scale", colour: "#4385be", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: false, legacy: true },
  rotate: { name: "rotate", family: "appearance", phase: "spatial", label: "rotate", colour: "#4385be", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: false, legacy: true },
  camera: { name: "camera", family: "camera", phase: "camera", label: "Camera", colour: "#a02f6f", wrapperProps: [], defaultDurationMs: 320, defaultEasing: "standard", editable: false, authoringTiming: { duration: 900, easing: "smooth" } },
  transform: { name: "transform", family: "transform", phase: "transform", label: "Transform", colour: "#66800b", wrapperProps: [], defaultDurationMs: 600, defaultEasing: "smooth", editable: false },
  videoStart: { name: "videoStart", family: "media", phase: "media", label: "Start video", colour: "#3aa99f", wrapperProps: [], defaultDurationMs: 0, defaultEasing: "linear", editable: false },
  videoPause: { name: "videoPause", family: "media", phase: "media", label: "Pause video", colour: "#d0a215", wrapperProps: [], defaultDurationMs: 0, defaultEasing: "linear", editable: false },
  videoStop: { name: "videoStop", family: "media", phase: "media", label: "Stop video", colour: "#af3029", wrapperProps: [], defaultDurationMs: 0, defaultEasing: "linear", editable: false },
};

export const KNOWN_PRESETS: ReadonlySet<string> = new Set(Object.keys(PRESET_CATALOG));

/** Absent/unknown names use the same fade default as playback. */
export function presetDef(name: string | undefined): PresetDef {
  return name !== undefined && KNOWN_PRESETS.has(name) ? PRESET_CATALOG[name as PresetName] : PRESET_CATALOG.fade;
}
export const isEnterPreset = (name?: string): boolean => presetDef(name).phase === "enter";
export const isExitPreset = (name?: string): boolean => presetDef(name).phase === "exit";
export const EDITABLE_PRESETS: readonly PresetName[] = Object.values(PRESET_CATALOG).filter(def => def.editable).map(def => def.name);

export function defaultEasingFor(preset?: string): EasingToken {
  return presetDef(preset).defaultEasing;
}

/** Timing written by authoring commands, distinct from omitted playback timing. */
export function defaultTimingFor(preset?: string): { duration: number; easing: EasingToken } {
  const def = presetDef(preset);
  return def.authoringTiming ?? { duration: def.defaultDurationMs, easing: defaultEasingFor(preset) };
}

// ---------------------------------------------------------------------------
// PRESET_PARAMS — the ONE open table of every `track.params` key a preset reads,
// with today's literal as its FROZEN default (X10). Player (player/presets.ts),
// compile (compile.ts) and PPTX (export/pptxBuilds.ts) all read through
// `presetParam`, so they can never disagree about a magnitude again.
//
//  • Defaults are classic literals. They never change: saved decks and every
//    authoring/profile layer write VALUES into the track instead (a default is
//    only what an absent key means).
//  • The table is OPEN. An authored key the table does not know is KEPT in the
//    deck and reported by `paramDiagnostics` (a compile issue); it is never
//    refused or stripped. Each work package adds its keys in the same commit
//    as the code that reads them.
//  • `range` clamps numeric reads (new keys only: legacy keys stay unclamped so
//    a saved deck never changes). `requires` marks a key that only takes effect
//    while a sibling key holds a value (reported when it does not).
// ---------------------------------------------------------------------------

export type ParamValue = number | string | boolean | null;
export interface ParamRequirement {
  /** A sibling key of the SAME preset row. */
  key: string;
  /** The value that sibling must hold (its authored value, else its default). */
  equals: ParamValue;
}
export interface ParamSpec {
  /** What an absent / malformed key means. `null` = derived from the target's content at play time. */
  default: ParamValue;
  /** Numeric reads are clamped into [min, max]. */
  range?: readonly [number, number];
  requires?: ParamRequirement;
  /** The value types an authored key may have (default: the type of `default`; any type for a `null` default). */
  types?: readonly ("number" | "string" | "boolean")[];
}
export type ParamRow = Readonly<Record<string, ParamSpec>>;

const WIPE_DIRECTION: ParamRow = { direction: { default: "ltr" } };
/** drawOn / drawOff trim-path params (rework §5): the legacy default draw is anchor start, forward, single, 0..1. */
const TRIM_PARAMS: ParamRow = {
  anchor: { default: "start", types: ["number", "string"] },
  direction: { default: "forward" },
  mode: { default: "single" },
  from: { default: 0 },
  to: { default: 1 },
};

export const PRESET_PARAMS: Readonly<Record<PresetName, ParamRow>> = {
  fade: {},
  fadeRise: { y: { default: 14 } },
  popIn: { from: { default: 0.9 } },
  drawOn: TRIM_PARAMS,
  growBaseline: {},
  stagger: { child: { default: "fadeRise" } },
  writeOn: WIPE_DIRECTION,
  fadeOut: {},
  popOut: { to: { default: 0.92 } },
  drawOff: TRIM_PARAMS,
  wipeOut: WIPE_DIRECTION,
  highlight: { level: { default: 0.4, range: [0, 1] } },
  dim: { level: { default: 0.3, range: [0, 1] } },
  // countUp keys are read by player/countup.ts; their defaults come from the target's text.
  countUp: { from: { default: 0 }, to: { default: null }, decimals: { default: null }, prefix: { default: null }, suffix: { default: null }, separator: { default: null } },
  move: {},
  scale: { scale: { default: 1.15 } },
  rotate: { deg: { default: 15 } },
  camera: {},
  transform: {},
  videoStart: {},
  videoPause: {},
  videoStop: {},
};

export interface ParamSource { preset?: string; params?: Record<string, unknown> }

/** The table entry for `key` of `preset` (absent / unknown preset names read as the fade row). */
export function paramSpec(preset: string | undefined, key: string): ParamSpec | undefined {
  const row = PRESET_PARAMS[presetDef(preset).name];
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

/** Does `v` have a type the spec accepts? A finite number, a non-empty string or a boolean; a `null` default with no
 *  `types` accepts any of them (content-derived keys). */
function typeOk(spec: ParamSpec, v: unknown): boolean {
  const t = typeof v;
  if (t !== "number" && t !== "string" && t !== "boolean") return false;
  if (t === "number" && !Number.isFinite(v)) return false;
  if (t === "string" && v === "") return false;
  const allowed = spec.types ?? (spec.default === null ? undefined : [typeof spec.default]);
  return !allowed || (allowed as readonly string[]).includes(t);
}

/** The effective value of a param: the authored value when it has the table's type (a finite number; a non-empty
 *  string; clamped into `range`), else the classic default. PURE: player, compile and PPTX share this one read.
 *  `as` names the preset whose row to use when the track hosts another preset's compiler (a `stagger` track's
 *  child reads `popIn.from` / `fadeRise.y` from the stagger track's own params). An unknown key is a programming
 *  error (every reader is gated), not an authoring one. */
export function presetParam<T extends ParamValue = number>(track: ParamSource, key: string, as?: string): T {
  const preset = as ?? track.preset;
  const spec = paramSpec(preset, key);
  if (!spec) throw new Error(`presetParam: ${presetDef(preset).name}.${key} is not in PRESET_PARAMS`);
  const authored = track.params?.[key];
  if (!typeOk(spec, authored)) return spec.default as T;
  if (typeof authored === "number" && spec.range) return Math.min(spec.range[1], Math.max(spec.range[0], authored)) as T;
  return authored as T;
}

const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** The frozen legacy `scale` delta: `to.scale`, else `params.scale`, else 1.15 (player and compile). */
export const legacyScaleOf = (track: ParamSource & { to?: Record<string, unknown> }): number =>
  finiteNumber(track.to?.scale) ? track.to.scale : presetParam(track, "scale", "scale");
/** The frozen legacy `rotate` delta in degrees: `to.rotation`, else `to.deg`, else `params.deg`, else 15. */
export const legacyRotationOf = (track: ParamSource & { to?: Record<string, unknown> }): number =>
  finiteNumber(track.to?.rotation) ? track.to.rotation : finiteNumber(track.to?.deg) ? track.to.deg : presetParam(track, "deg", "rotate");

/** highlight: the wink's opacity at eased progress `at` (level → 1). The player's keyframes [level, 1] sample the same line. */
export const highlightOpacity = (level: number, at: number): number => level + (1 - level) * at;
/** dim: opacity at eased progress `at` (1 → level). */
export const dimOpacity = (level: number, at: number): number => 1 - (1 - level) * at;

/** Diagnostics for authored params the table does not vouch for. They are advice, never a refusal: the keys stay
 *  in the deck (a newer build may read them) and playback ignores what it does not know. `table` is injectable
 *  for gates. */
export function paramDiagnostics(track: ParamSource, table: Readonly<Record<string, ParamRow>> = PRESET_PARAMS): string[] {
  const params = track.params;
  if (!params || typeof params !== "object") return [];
  const def = presetDef(track.preset);
  const rows: ParamRow[] = [table[def.name] ?? {}];
  // a stagger applies a child preset over its nodes, so the child's keys are the stagger track's keys too
  if (def.name === "stagger") {
    const child = typeof params.child === "string" && params.child ? params.child : "fadeRise";
    if (KNOWN_PRESETS.has(child) && child !== "stagger") rows.push(table[child] ?? {});
  }
  const out: string[] = [];
  for (const key of Object.keys(params)) {
    const owner = rows.find(row => Object.prototype.hasOwnProperty.call(row, key));
    if (!owner) { out.push(`Unknown option “${key}” for ${def.label}: kept in the deck, ignored by playback.`); continue; }
    const need = owner[key].requires;
    if (!need) continue;
    const sibling = owner[need.key];
    const effective = !sibling ? params[need.key] : typeOk(sibling, params[need.key]) ? params[need.key] : sibling.default;
    if (effective !== need.equals) out.push(`Option “${key}” of ${def.label} only applies when “${need.key}” is ${JSON.stringify(need.equals)}.`);
  }
  return out;
}
