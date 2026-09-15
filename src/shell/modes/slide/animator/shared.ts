// Shared vocabulary of the animator components: preset colors, editor option
// lists, chip labels, and the temporal math the Gantt lanes are built on.

import type { Slide, Track, PresetName } from "../../../../lib/slide/types";
import type { FluxPlotManifest } from "../../../../lib/plot/types";
import { semanticTargets, trackDuration } from "../../../../lib/slide/compile";
import { staggerSpan } from "../../../../lib/slide/stagger";

export const PRESET_COLOR: Record<string, string> = {
  drawOn: "#4385be", fade: "#879a39", fadeRise: "#879a39", stagger: "#d14d41",
  growBaseline: "#d0a215", popIn: "#8b7ec8", writeOn: "#3aa99f", highlight: "#d0a215",
  dim: "#6f6e69", move: "#4385be", scale: "#4385be", rotate: "#4385be", camera: "#a02f6f",
  // the TRANSFORM family reads GREEN (the mockups' t1—t2 lanes) — one color
  // for all three ways (Change · Ghost · Become). (Distinct from fade's
  // lighter green; the full family palette lands with the Phase-3 animator.)
  transform: "#66800b",
  // exits render in the muted red family — visually "this leaves the stage"
  fadeOut: "#af3029", popOut: "#af3029", drawOff: "#af3029", wipeOut: "#af3029", countUp: "#66800b",
  videoStart: "#3aa99f", videoPause: "#d0a215", videoStop: "#af3029",
};

export const EDIT_PRESETS: PresetName[] = [
  "fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn",
  "fadeOut", "popOut", "drawOff", "wipeOut", "highlight", "dim", "countUp",
];
export const EASINGS = ["standard", "smooth", "enter", "exit", "linear"];
export function presetLabel(preset: string): string {
  return ({fade:"Fade in",fadeRise:"Rise in",popIn:"Pop in",drawOn:"Draw on",growBaseline:"Grow",stagger:"Stagger in",writeOn:"Wipe in",
    fadeOut:"Fade out",popOut:"Pop out",drawOff:"Draw off",wipeOut:"Wipe out",highlight:"Highlight",dim:"Dim",countUp:"Count up",transform:"Transform",camera:"Camera",videoStart:"Start video",videoPause:"Pause video",videoStop:"Stop video"} as Record<string,string>)[preset] ?? preset;
}

/** The three WAYS of transforming, read off the one transform track: a birth
 *  (`ghostFrom`) is a Ghost; an endpoint that names another kind (`state.type`)
 *  or another content asset (`to.assetId`) is a Become; anything else is a
 *  Change. Purely a label — playback never distinguishes them. */
export type TransformWay = "change" | "ghost" | "become";
export function transformWay(t: Track): TransformWay {
  if (t.ghostFrom) return "ghost";
  const st = t.to?.state as Record<string, unknown> | undefined;
  if ((st && typeof st.type === "string") || t.to?.assetId) return "become";
  return "change";
}
export const WAY_LABEL: Record<TransformWay, string> = { change: "Change", ghost: "Ghost", become: "Become" };
/** The lane sub-label: "Transform · Become", "Fade in", … */
export function trackKindLabel(t: Track): string {
  if (t.preset === "transform") return `Transform · ${WAY_LABEL[transformWay(t)]}`;
  return presetLabel(t.preset ?? "fade");
}
export const INFLUENCE_PRESETS: { name: string; in: number; out: number }[] = [
  { name: "ease", in: 0, out: 0 },
  { name: "subtle", in: 25, out: 25 },
  { name: "medium", in: 50, out: 50 },
  { name: "strong", in: 75, out: 75 },
  { name: "extreme", in: 95, out: 95 },
];

/** Element type → a compact glyph for tree rows / chip labels (the figure
 *  element union — slides-are-figures). */
export const EL_GLYPH: Record<string, string> = {
  plot: "▤", text: "¶", image: "▣", video: "▶", rect: "▭", ellipse: "◯", line: "╱", path: "〰",
};

/** A compact label for a track chip (prefixed with a P-tag when the slide has
 *  several plots so identical part names stay distinguishable). */
export function chipLabel(t: Track, slide: Slide | null, plotTags: Map<string, string>): string {
  if (t.target.startsWith("@")) return t.target.slice(1);
  const tag = plotTags.get(t.target);
  const pre = tag ? `${tag} · ` : "";
  if (t.part) {
    const el = slide?.elements.find((e) => e.id === t.target);
    return `${el?.name || tag || "Plot"} › ${t.part.split(".").join(" › ")}`;
  }
  const el = slide?.elements.find((e) => e.id === t.target);
  if (!el) return pre + "missing"; // dangling target — tolerated + surfaced
  if (t.ghostFrom) {
    const source = slide?.elements.find(e => e.id === t.ghostFrom);
    return `${source?.name || source?.type || "Missing source"} → ${el.name || "Ghost"}`;
  }
  if (el.type === "text") return pre + (el.name || el.text.split("\n")[0]?.slice(0, 60) || "Text");
  return pre + ((el.name ?? el.type) || "elem");
}

/** A track whose element target no longer exists on the slide (the figure
 *  editor deleted it). Tolerated (the player no-ops), marked in the timeline,
 *  never auto-pruned — an undo of the deletion restores the animation. */
export function isDanglingTrack(t: Track, slide: Slide | null): boolean {
  if (t.target.startsWith("@")) return false;
  return !slide?.elements.some((e) => e.id === t.target);
}

/** How many targets a track fans out to (drives the stagger tail length). */
export function trackFanout(t: Track, slide: Slide | null, manifest: FluxPlotManifest | undefined): number {
  if (slide && (t.part || t.selector)) return Math.max(1, semanticTargets(t,slide,{plotManifest:()=>manifest}).length);
  return 1;
}

/** A track's time footprint within its beat: [start, start+duration+staggerSpan]. */
export function trackEndMs(t: Track, slide: Slide | null, manifest: FluxPlotManifest | undefined): number {
  const start = t.start ?? 0;
  const dur = trackDuration(t);
  const span = staggerSpan(t, trackFanout(t, slide, manifest));
  return start + dur + span;
}

/** The latest end time of any track on a beat (min 1ms so empty beats layout). */
export function beatEndMs(tracks: Track[], slide: Slide | null, manifestFor: (target: string) => FluxPlotManifest | undefined): number {
  let end = 0;
  for (const t of tracks.filter(t=>!t.disabled)) end = Math.max(end, trackEndMs(t, slide, manifestFor(t.target)));
  return end;
}

/** Auto-fit px-per-ms: the slide's longest beat maps to ~260px, clamped sane. */
export function autoPxPerMs(maxEndMs: number): number {
  return Math.max(0.04, Math.min(0.35, 260 / Math.max(1, maxEndMs)));
}

/** The minor grid step between two ruler ticks: half a tick, a quarter once
 *  the timeline is zoomed in past .3 px/ms (a 250ms tick then subdivides to
 *  62.5ms lines that still sit ≥18px apart). */
export function minorTickStep(tickStep: number, pxPerMs: number): number {
  return tickStep / (pxPerMs > 0.3 ? 4 : 2);
}

/** The minor grid lines of a beat: every subdivision of the ruler ticks that
 *  is NOT itself a tick (the timeline draws ticks as major lines). */
export function minorTicks(durationMs: number, tickStep: number, pxPerMs: number): number[] {
  const step = minorTickStep(tickStep, pxPerMs);
  const per = Math.round(tickStep / step);
  const out: number[] = [];
  for (let i = 1; i * step <= durationMs; i++) if (i % per) out.push(i * step);
  return out;
}

/** Snap a ms value: magnet-snap to other tracks' boundaries + the nearest 50ms
 *  grid line within an 8-screen-px threshold; otherwise quantize to 10ms so
 *  drags land on round numbers. Alt disables via `enabled:false`. */
export function snapMs(ms: number, magnets: number[], pxPerMs: number, enabled: boolean): number {
  if (!enabled) return Math.max(0, Math.round(ms));
  const thresholdMs = 8 / pxPerMs;
  const grid = Math.round(ms / 50) * 50;
  let best = grid;
  let bestD = Math.abs(ms - grid);
  for (const m of magnets) {
    const d = Math.abs(ms - m);
    if (d < bestD) { best = m; bestD = d; }
  }
  if (bestD <= thresholdMs) return Math.max(0, best);
  return Math.max(0, Math.round(ms / 10) * 10);
}
