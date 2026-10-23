// Preset facts shared by compilation, playback and authoring. Keep this module
// pure: WAAPI compilers and role/element recommendation policy live elsewhere.
import type { EasingToken, PresetName } from "./types";
import type { TrackFamily } from "./family";
import type { Curve } from "./curves";

/** Appearance authoring curve: the quintic `smooth` with its dead lead-in removed (the first 8 % of the
 *  S-curve cut and the rest renormalised), as a bezier (max error 0.0097 of travel). It has `smooth`'s
 *  look with a 12 ms (not 58 ms) time-to-0.5 % at 700 ms, so a Present click shows motion as fast as
 *  the old front-loaded `standard` without its 14 %/frame pop (peak 4.8 %/frame). Catalog id "quick smooth". */
export const QUICK_SMOOTH: Curve = { kind: "bezier", p: [0.45, 0.12, 0.5, 1] };

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
  /** Floor, in ms, for a plot auto-build part of this preset (a build emits many small parts, so it sits
   *  below `authoringTiming`); the plot author's own durationMs wins only when it is longer (`autoBuildMs`). */
  autoBuildDurationMs?: number;
  /** What AUTHORING writes into a new track (always explicit, so a deck keeps its pace when the catalog
   *  is retuned). Playback of a track that OMITS timing keeps using the frozen `defaultDurationMs` /
   *  `defaultEasing` above forever: old decks never change (the T1 pace table, X1). `curve` is the
   *  appearance onset curve (QUICK_SMOOTH); it replaces `easing` in what is written (`authoredTiming`; a fresh copy per track, never the shared constant). */
  authoringTiming?: { duration: number; easing: EasingToken; curve?: Curve };
  /** Authored `params` written into a new track of this preset (X1a). Playback keeps its literal
   *  fallbacks (`?? 14` ...), so an omitted param on an old track plays exactly as before. */
  authoringParams?: Readonly<Record<string, number | string | boolean>>;
  /** Authored `params` written ONLY when the track's target is text (X1a): a text rewrite is the one place the
   *  look depends on what the target IS, so the table cannot be keyed by preset alone. Merged over `authoringParams`
   *  by `authoredFields(preset, params, rewrites)`. Absent keys keep today's playback (drift / fade). */
  authoringTextParams?: Readonly<Record<string, number | string | boolean>>;
  /** A symmetric there-and-back preset (pulse, encircle: not built yet): its landing must have zero
   *  velocity, so it is authored with `smooth`, never QUICK_SMOOTH (X2; verify-pace-defaults pins it). */
  onsetExempt?: boolean;
}

/** What a NEW text transform is authored with (owner decision, WP 2.5): leftover words ROLL (0.35 em, no shrink) and
 *  an anagram's letters TRAVEL. Written at AUTHORING time only (X1: playback never reads a profile); a track that
 *  omits them plays the frozen classic look ("drift" / "fade"), so old decks play exactly as made. */
export const TEXT_TRANSFORM_PARAMS: Readonly<Record<string, string>> = Object.freeze({ fadeStyle: "roll", letters: "travel" });

// Editable entries are in the Animator's established select order.
export const PRESET_CATALOG: Readonly<Record<PresetName, PresetDef>> = {
  fade: { name: "fade", family: "appearance", phase: "enter", label: "Fade in", colour: "#879a39", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 500, authoringTiming: { duration: 700, easing: "smooth", curve: QUICK_SMOOTH } },
  fadeRise: { name: "fadeRise", family: "appearance", phase: "enter", label: "Rise in", colour: "#879a39", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 600, authoringTiming: { duration: 700, easing: "smooth", curve: QUICK_SMOOTH }, authoringParams: { y: 24 } },
  popIn: { name: "popIn", family: "appearance", phase: "enter", label: "Pop in", colour: "#8b7ec8", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 500, authoringTiming: { duration: 700, easing: "smooth", curve: QUICK_SMOOTH } },
  drawOn: { name: "drawOn", family: "appearance", phase: "enter", label: "Draw on", colour: "#4385be", wrapperProps: [], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 800, authoringTiming: { duration: 900, easing: "smooth", curve: QUICK_SMOOTH } },
  growBaseline: { name: "growBaseline", family: "appearance", phase: "enter", label: "Grow", colour: "#d0a215", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 800, authoringTiming: { duration: 900, easing: "smooth", curve: QUICK_SMOOTH } },
  stagger: { name: "stagger", family: "appearance", phase: "enter", label: "Stagger in", colour: "#d14d41", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 600, authoringTiming: { duration: 700, easing: "smooth", curve: QUICK_SMOOTH } },
  writeOn: { name: "writeOn", family: "appearance", phase: "enter", label: "Wipe in", colour: "#3aa99f", wrapperProps: ["clipPath"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, autoBuildDurationMs: 700, authoringTiming: { duration: 900, easing: "smooth", curve: QUICK_SMOOTH } },
  fadeOut: { name: "fadeOut", family: "appearance", phase: "exit", label: "Fade out", colour: "#af3029", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, authoringTiming: { duration: 500, easing: "smooth", curve: QUICK_SMOOTH } },
  popOut: { name: "popOut", family: "appearance", phase: "exit", label: "Pop out", colour: "#af3029", wrapperProps: ["opacity", "transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, authoringTiming: { duration: 500, easing: "smooth", curve: QUICK_SMOOTH } },
  drawOff: { name: "drawOff", family: "appearance", phase: "exit", label: "Draw off", colour: "#af3029", wrapperProps: [], defaultDurationMs: 320, defaultEasing: "standard", editable: true, authoringTiming: { duration: 500, easing: "smooth", curve: QUICK_SMOOTH } },
  wipeOut: { name: "wipeOut", family: "appearance", phase: "exit", label: "Wipe out", colour: "#af3029", wrapperProps: ["clipPath"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, authoringTiming: { duration: 500, easing: "smooth", curve: QUICK_SMOOTH } },
  highlight: { name: "highlight", family: "appearance", phase: "emphasis", label: "Highlight", colour: "#d0a215", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, authoringTiming: { duration: 700, easing: "smooth", curve: QUICK_SMOOTH } },
  dim: { name: "dim", family: "appearance", phase: "emphasis", label: "Dim", colour: "#6f6e69", wrapperProps: ["opacity"], defaultDurationMs: 320, defaultEasing: "standard", editable: true, authoringTiming: { duration: 700, easing: "smooth", curve: QUICK_SMOOTH } },
  countUp: { name: "countUp", family: "appearance", phase: "count", label: "Count up", colour: "#66800b", wrapperProps: [], defaultDurationMs: 800, defaultEasing: "standard", editable: true, authoringTiming: { duration: 900, easing: "smooth" } },
  // Frozen compatibility channel; new geometry edits use transform.
  move: { name: "move", family: "appearance", phase: "spatial", label: "move", colour: "#4385be", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: false, legacy: true },
  scale: { name: "scale", family: "appearance", phase: "spatial", label: "scale", colour: "#4385be", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: false, legacy: true },
  rotate: { name: "rotate", family: "appearance", phase: "spatial", label: "rotate", colour: "#4385be", wrapperProps: ["transform"], defaultDurationMs: 320, defaultEasing: "standard", editable: false, legacy: true },
  camera: { name: "camera", family: "camera", phase: "camera", label: "Camera", colour: "#a02f6f", wrapperProps: [], defaultDurationMs: 320, defaultEasing: "standard", editable: false, authoringTiming: { duration: 900, easing: "smooth" } },
  transform: { name: "transform", family: "transform", phase: "transform", label: "Transform", colour: "#66800b", wrapperProps: [], defaultDurationMs: 600, defaultEasing: "smooth", editable: false, authoringTiming: { duration: 1200, easing: "smooth" }, authoringTextParams: TEXT_TRANSFORM_PARAMS },
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

/** Timing written by authoring commands, distinct from omitted playback timing (see PRESET_CATALOG
 *  `authoringTiming`; the catalog's `defaultDurationMs`/`defaultEasing` stay the frozen fallback).
 *  Strips the onset `curve`: camera/transform sites and gates read the easing token only. */
export function defaultTimingFor(preset?: string): { duration: number; easing: EasingToken } {
  const def = presetDef(preset);
  return def.authoringTiming ? { duration: def.authoringTiming.duration, easing: def.authoringTiming.easing } : { duration: def.defaultDurationMs, easing: defaultEasingFor(preset) };
}

/** The timing fields a NEW track of `preset` gets: an explicit duration plus either the QUICK_SMOOTH `curve`
 *  (appearance) or the `easing` token. Never both: easing / influence / curve are one group (resolve.ts). */
export function authoredTiming(preset?: string): { duration: number; easing?: EasingToken; curve?: Curve } {
  const def = presetDef(preset), t = defaultTimingFor(preset);
  return def.authoringTiming?.curve ? { duration: t.duration, curve: structuredClone(def.authoringTiming.curve) } : { duration: t.duration, easing: t.easing };
}

/** The type of element a track is born on: all authoring rows that depend on the target ask only this. */
export interface AuthoredTarget { type?: string }
/** Does a transform of `target` rewrite TEXT? `become` = what a Become turns the target into (omitted for a Change,
 *  which rewrites the element itself): the glyph-matched text morph needs text on BOTH sides, so a text that becomes
 *  a shape (or the other way round) is not a text rewrite and carries no text look. */
export function rewritesText(target?: AuthoredTarget, become?: AuthoredTarget): boolean {
  return target?.type === "text" && (become === undefined || become.type === "text");
}

/** The authored `params` of a new track of `preset`, or undefined. A `stagger` plays its `child` preset
 *  (default fadeRise, player/presets.ts), so it carries the CHILD's authored params: a stagger whose
 *  `child` is absent or fadeRise gets `y: 24` (X1a); any other child gets none. A preset with
 *  `authoringTextParams` (the text-rewrite transform) adds them when `rewrites` says the track rewrites text. */
export function authoredParams(preset?: string, params?: Readonly<Record<string, unknown>>, rewrites = false): Record<string, number | string | boolean> | undefined {
  const owner = preset === "stagger" ? (typeof params?.child === "string" && params.child ? params.child : "fadeRise") : preset;
  const def = owner !== undefined && KNOWN_PRESETS.has(owner) ? PRESET_CATALOG[owner as PresetName] : undefined;
  const out = { ...def?.authoringParams, ...(rewrites ? def?.authoringTextParams : undefined) };
  return Object.keys(out).length ? out : undefined;
}

/** EVERYTHING a writer puts into a new track of `preset` (X1a): `{ duration, curve | easing, params? }`.
 *  Every place a track is born spreads this; `authoredTiming` stays timing-only for callers that own `params`.
 *  `params` (optional) is the track's existing params, consulted only for a stagger's `child`. A writer that
 *  already has params merges: `{ ...fields.params, ...ownParams }`. `rewrites` (see `rewritesText`) adds the text
 *  look of a text-rewrite transform. */
export function authoredFields(preset?: string, params?: Readonly<Record<string, unknown>>, rewrites = false): { duration: number; easing?: EasingToken; curve?: Curve; params?: Record<string, number | string | boolean> } {
  const authored = authoredParams(preset, params, rewrites);
  return { ...authoredTiming(preset), ...(authored ? { params: authored } : {}) };
}

/** Duration of one auto-built plot part: the plot author's own `durationMs` (fluxplot presets are classic-paced,
 *  240-800 ms) never makes a part SHORTER than the preset's floor (`autoBuildDurationMs`; the whole-element
 *  authoring duration when the preset has no floor). Pure; the plot-part writers (`choreograph`) call it. */
export function autoBuildMs(preset: PresetName, manifestMs?: number): number {
  const floor = presetDef(preset).autoBuildDurationMs ?? defaultTimingFor(preset).duration;
  return Math.max(manifestMs ?? 0, floor);
}

/** A track written through the headless verbs (set-animation / MCP): a duration, curve or authored param the
 *  caller OMITTED is filled from `authoredFields`, so an agent-authored deck gets the same explicit pace as a
 *  GUI-authored one. Only known, non-media presets are filled; supplied fields win key by key; an `influence`
 *  or `curve` the caller supplied suppresses the easing/curve fill (one group); keyframe-only tracks are left
 *  alone; a style-linked track (`styleId`) is returned unchanged so the style keeps supplying its fields. `rewrites`
 *  (`rewritesText` of the track's target, which only the caller can look up) adds a text transform's authored look. Copy/paste, snapshots and library inserts never call this (an omitted field there stays omitted,
 *  i.e. frozen-classic). */
export function withAuthoringTiming<T extends { preset?: string; styleId?: string; duration?: number; easing?: EasingToken; influence?: unknown; curve?: unknown; params?: Record<string, unknown> }>(track: T, rewrites = false): T {
  if (track.styleId !== undefined) return track; // a style-linked track INHERITS its timing/curve/params from the style: never write local overrides
  if (track.preset === undefined || !KNOWN_PRESETS.has(track.preset) || PRESET_CATALOG[track.preset as PresetName].family === "media") return track;
  const fields = authoredFields(track.preset, track.params, rewrites), out = { ...track } as T & { easing?: EasingToken; curve?: unknown };
  if (out.duration === undefined) out.duration = fields.duration;
  if (out.easing === undefined && out.influence === undefined && out.curve === undefined) { if (fields.easing) out.easing = fields.easing; if (fields.curve) out.curve = fields.curve; }
  if (fields.params) out.params = { ...fields.params, ...track.params };
  return out;
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
  // The text-rewrite look (text morph, player/textMorph.ts via resolveTextLook): classic = drift fades, letters fade.
  transform: { fadeStyle: { default: "drift" }, letters: { default: "fade" } },
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
  // a preset this build does not know (a newer deck) or a keyframe-only track: its keys are the newer build's, stay quiet
  if (track.preset ? !KNOWN_PRESETS.has(track.preset) : (track as { keyframes?: unknown }).keyframes !== undefined) return [];
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
    if (!owner) {
      // a key some OTHER preset declares is a stale leftover of a preset switch (autobuild keeps `child` when a
      // stagger suggestion is overridden to fade): the Animator has no control to clear it, so it stays silent
      if (Object.values(table).some(row => Object.prototype.hasOwnProperty.call(row, key))) continue;
      out.push(`Unknown option “${key}” for ${def.label}: kept in the deck, ignored by playback.`);
      continue;
    }
    const need = owner[key].requires;
    if (!need) continue;
    const sibling = owner[need.key];
    const effective = !sibling ? params[need.key] : typeOk(sibling, params[need.key]) ? params[need.key] : sibling.default;
    if (effective !== need.equals) out.push(`Option “${key}” of ${def.label} only applies when “${need.key}” is ${JSON.stringify(need.equals)}.`);
  }
  return out;
}
