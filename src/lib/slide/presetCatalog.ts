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
  /** A symmetric there-and-back preset (pulse, encircle: not built yet): its landing must have zero
   *  velocity, so it is authored with `smooth`, never QUICK_SMOOTH (X2; verify-pace-defaults pins it). */
  onsetExempt?: boolean;
}

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
  transform: { name: "transform", family: "transform", phase: "transform", label: "Transform", colour: "#66800b", wrapperProps: [], defaultDurationMs: 600, defaultEasing: "smooth", editable: false, authoringTiming: { duration: 1200, easing: "smooth" } },
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

/** The authored `params` of a new track of `preset`, or undefined. A `stagger` plays its `child` preset
 *  (default fadeRise, player/presets.ts), so it carries the CHILD's authored params: a stagger whose
 *  `child` is absent or fadeRise gets `y: 24` (X1a); any other child gets none. */
export function authoredParams(preset?: string, params?: Readonly<Record<string, unknown>>): Record<string, number | string | boolean> | undefined {
  const owner = preset === "stagger" ? (typeof params?.child === "string" && params.child ? params.child : "fadeRise") : preset;
  const row = owner !== undefined && KNOWN_PRESETS.has(owner) ? PRESET_CATALOG[owner as PresetName].authoringParams : undefined;
  return row ? { ...row } : undefined;
}

/** EVERYTHING a writer puts into a new track of `preset` (X1a): `{ duration, curve | easing, params? }`.
 *  Every place a track is born spreads this; `authoredTiming` stays timing-only for callers that own `params`.
 *  `params` (optional) is the track's existing params, consulted only for a stagger's `child`. A writer that
 *  already has params merges: `{ ...fields.params, ...ownParams }`. */
export function authoredFields(preset?: string, params?: Readonly<Record<string, unknown>>): { duration: number; easing?: EasingToken; curve?: Curve; params?: Record<string, number | string | boolean> } {
  const authored = authoredParams(preset, params);
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
 *  alone. Copy/paste, snapshots and library inserts never call this (an omitted field there stays omitted,
 *  i.e. frozen-classic). */
export function withAuthoringTiming<T extends { preset?: string; duration?: number; easing?: EasingToken; influence?: unknown; curve?: unknown; params?: Record<string, unknown> }>(track: T): T {
  if (track.preset === undefined || !KNOWN_PRESETS.has(track.preset) || PRESET_CATALOG[track.preset as PresetName].family === "media") return track;
  const fields = authoredFields(track.preset, track.params), out = { ...track } as T & { easing?: EasingToken; curve?: unknown };
  if (out.duration === undefined) out.duration = fields.duration;
  if (out.easing === undefined && out.influence === undefined && out.curve === undefined) { if (fields.easing) out.easing = fields.easing; if (fields.curve) out.curve = fields.curve; }
  if (fields.params) out.params = { ...fields.params, ...track.params };
  return out;
}
