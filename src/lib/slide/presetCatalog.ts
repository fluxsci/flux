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
