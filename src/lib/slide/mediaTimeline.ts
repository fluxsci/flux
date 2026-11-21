/** Video commands are independent of appearance and geometry. This pure clock
 * is shared by live seeking and continuous capture, including audio mixing.
 * Stage 2 (plan D7): the same three commands run an image (fluximg) along one
 * dimension as a movie; its events come from the same list and its position from
 * the same fold (`sampleImagePlayback`). Audio and the content end stay video-only. */
import type { Element } from "../types";
import type { FluximgManifest } from "../fluximg/types";
import type { FluximgPlaybackMode } from "../fluximg/element";
import { walkableDims } from "../fluximg/playback";
import type { Slide, Track } from "./types";
import type { VideoPlan } from "./video";
import { resolveBeat, type StyleContext, type ManifestFor } from "./resolve";
import { presetDef } from "./presetCatalog";

/** An image's (fluximg) manifest by asset id, when loaded: the same lookup the compiler takes (`CompileOptions.fluximgManifest`). */
export type FluximgManifestFor = (assetId: string) => FluximgManifest | undefined;

/** What a media command (Start / Pause / Stop) may target: a video clip, or an image (fluximg) with a dimension to
 *  play (unknown until its manifest is loaded: then it is let through, and the compiler checks it once it is). A
 *  constant-time kind check: a deck without images takes the video branch exactly as before. */
export function mediaTarget(el: Element | undefined, fluximgManifest?: FluximgManifestFor): boolean {
  if (el?.type === "video") return true;
  if (el?.type !== "fluximg") return false;
  const m = fluximgManifest?.(el.assetId);
  return !m || walkableDims(m).length > 0;
}

/** What a viewer's pause button calls a slide's playing media: "video" where the slide holds a video clip (as it always
 *  has), "movie" where only images play (stage 2). Asked only while the button shows. */
export const mediaNoun = (slide: Pick<Slide, "elements"> | undefined): "video" | "movie" =>
  !slide || slide.elements.some(e => e.type === "video") || !slide.elements.some(e => e.type === "fluximg") ? "video" : "movie";

export type VideoCommand = "videoStart" | "videoPause" | "videoStop";
export interface VideoEvent { target: string; command: VideoCommand; at: number; order: number }
export interface VideoSample { timeMs: number; running: boolean; started: boolean }
export interface VideoAudioSegment { assetId: string; startMs: number; endMs: number; offsetMs: number; loop: boolean }
export const isVideoCommand = (track: Track): boolean => presetDef(track.preset).family === "media";

// A media target the viewer can see: a video clip or an image movie (stage 2), not hidden, nor in a hidden group.
function visibleMedia(slide: Slide, element: Slide["elements"][number]): boolean {
  if ((element.type !== "video" && element.type !== "fluximg") || element.hidden) return false;
  let group = element.groupId; const seen = new Set<string>();
  while (group && !seen.has(group)) {
    seen.add(group); const definition = slide.groups?.[group];
    if (!definition) break;
    if (definition.hidden) return false;
    group = definition.parentId;
  }
  return true;
}

export interface MediaTimingContext extends StyleContext {
  manifestFor?: ManifestFor;
  resolvedTracks?: readonly (readonly Track[])[];
}

export function videoEvents(slide: Slide, beatStart: (beat: number) => number | undefined, context: MediaTimingContext = {}): VideoEvent[] {
  const targets = new Set(slide.elements.filter(e => visibleMedia(slide, e)).map(e => e.id));
  let order = 0;
  const events: VideoEvent[] = [];
  slide.beats.forEach((beat, bi) => {
    if (bi === 0) return; // Design is static; playback requires an explicit step.
    const start = beatStart(bi);
    if (start === undefined) return;
    for (const track of context.resolvedTracks?.[bi] ?? resolveBeat(beat, context, context.manifestFor).tracks) {
      if (track.disabled || track.keyframes || track.part || track.selector || track.stagger || !targets.has(track.target) || !isVideoCommand(track)) continue;
      events.push({ target: track.target, command: track.preset as VideoCommand, at: start + Math.max(0, track.start ?? 0), order: order++ });
    }
  });
  return events.sort((a, b) => a.at - b.at || a.order - b.order);
}

export function videoEventsForPlan(slide: Slide, plan: Pick<VideoPlan, "cues">, context: MediaTimingContext = {}): VideoEvent[] {
  return videoEvents(slide, beat => plan.cues.find(c => beat >= c.fromBeat && beat <= c.beat)?.start, context);
}

/** The one fold of a target's commands up to `at`: how long it has run since its last Start (Pause holds, Stop resets). */
export function mediaFold(events: readonly VideoEvent[], target: string, at: number): VideoSample {
  let position = 0, origin = 0, running = false, started = false;
  for (const event of events) {
    if (event.at > at) break;
    if (event.target !== target) continue;
    if (running) position += Math.max(0, event.at - origin);
    origin = event.at;
    if (event.command === "videoStart") { position = 0; running = true; started = true; }
    else if (event.command === "videoPause") running = false;
    else { position = 0; running = false; started = false; }
  }
  if (running) position += Math.max(0, at - origin);
  return { timeMs: position, running, started };
}

export function sampleVideo(events: readonly VideoEvent[], target: string, at: number, durationMs: number, loop = false): VideoSample {
  const folded = mediaFold(events, target, at);
  let position = folded.timeMs, running = folded.running;
  const started = folded.started;
  if (durationMs > 0) {
    if (loop) position %= durationMs;
    else if (position >= durationMs) { position = durationMs; running = false; }
  }
  return { timeMs: position, running, started };
}

/** Where an image movie stands: `plane` is the offset (0 .. planes − 1) inside its range. */
export interface ImagePlaybackSample { plane: number; running: boolean; started: boolean }

/**
 * The image movie's clock (plan D7), on the same fold as a video's: Start restarts at the range's first plane, Pause
 * holds, Stop returns to the state's own index (`started` false: the caller shows the step's own plane). One pass of
 * `planes` planes lasts `passMs`; `loop` wraps, `bounce` walks a triangle whose end planes are not shown twice, `once`
 * stops on the last plane when the pass is over. Pure and deterministic.
 */
export function sampleImagePlayback(events: readonly VideoEvent[], target: string, at: number, passMs: number, mode: FluximgPlaybackMode, planes: number): ImagePlaybackSample {
  const f = mediaFold(events, target, at);
  if (!f.started || !(planes > 1) || !(passMs > 0)) return { plane: 0, running: f.running && planes > 1 && passMs > 0, started: f.started };
  const p = playbackPlane(f.timeMs, passMs, mode, planes);
  return { plane: p.plane, running: f.running && !p.done, started: true };
}

/** The plane a movie shows `positionMs` after its Start (the one mapping: the clock above and the player's frame loop). */
export function playbackPlane(positionMs: number, passMs: number, mode: FluximgPlaybackMode, planes: number): { plane: number; done: boolean } {
  if (!(planes > 1) || !(passMs > 0)) return { plane: 0, done: false };
  // Whole planes elapsed (the epsilon lands a step boundary on its own plane despite rounding, as viewTween's walk does).
  const k = Math.floor(Math.max(0, positionMs) / (passMs / planes) + 1e-9);
  if (mode === "once") return positionMs >= passMs ? { plane: planes - 1, done: true } : { plane: Math.min(planes - 1, k), done: false };
  if (mode === "bounce") { const cycle = 2 * (planes - 1), p = k % cycle; return { plane: p <= planes - 1 ? p : cycle - p, done: false }; }
  return { plane: k % planes, done: false };
}

/** Last non-looping clips complete before the final hold. Earlier clips cut by
 * Pause/Stop/Start never extend the output, and loops have a finite export end. */
export function videoContentEnd(slide: Slide, events: readonly VideoEvent[], initialEnd: number): number {
  let end = initialEnd;
  for (const video of slide.elements) {
    if (video.type !== "video" || video.loop) continue;
    const last = events.filter(e => e.target === video.id).at(-1);
    if (last?.command === "videoStart") end = Math.max(end, last.at + video.durationMs);
  }
  return end;
}

/** Audio spans use the exact same start/stop events as pixels. Mute is an
 * authoring choice, never a browser autoplay workaround. */
export function videoAudioSegments(slide: Slide, events: readonly VideoEvent[], durationMs: number): VideoAudioSegment[] {
  const segments: VideoAudioSegment[] = [];
  for (const video of slide.elements) {
    if (video.type !== "video" || video.muted || video.hidden) continue;
    let start: number | undefined;
    const close = (at: number) => {
      if (start === undefined) return;
      const end = Math.min(durationMs, at, video.loop ? Infinity : start + video.durationMs);
      if (end > start) segments.push({ assetId: video.assetId, startMs: start, endMs: end, offsetMs: 0, loop: !!video.loop });
      start = undefined;
    };
    for (const event of events) if (event.target === video.id) { close(event.at); if (event.command === "videoStart") start = event.at; }
    close(durationMs);
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}
