/** Video commands are independent of appearance and geometry. This pure clock
 * is shared by live seeking and continuous capture, including audio mixing. */
import type { Slide, Track } from "./types";
import type { VideoPlan } from "./video";

export type VideoCommand = "videoStart" | "videoPause" | "videoStop";
export interface VideoEvent { target: string; command: VideoCommand; at: number; order: number }
export interface VideoSample { timeMs: number; running: boolean; started: boolean }
export interface VideoAudioSegment { assetId: string; startMs: number; endMs: number; offsetMs: number; loop: boolean }
export const isVideoCommand = (track: Track): boolean => ["videoStart", "videoPause", "videoStop"].includes(track.preset ?? "");

function visibleVideo(slide: Slide, element: Slide["elements"][number]): boolean {
  if (element.type !== "video" || element.hidden) return false;
  let group = element.groupId; const seen = new Set<string>();
  while (group && !seen.has(group)) {
    seen.add(group); const definition = slide.groups?.[group];
    if (!definition) break;
    if (definition.hidden) return false;
    group = definition.parentId;
  }
  return true;
}

export function videoEvents(slide: Slide, beatStart: (beat: number) => number | undefined): VideoEvent[] {
  const targets = new Set(slide.elements.filter(e => visibleVideo(slide, e)).map(e => e.id));
  let order = 0;
  const events: VideoEvent[] = [];
  slide.beats.forEach((beat, bi) => {
    if (bi === 0) return; // Design is static; playback requires an explicit step.
    const start = beatStart(bi);
    if (start === undefined) return;
    for (const track of beat.tracks) {
      if (track.disabled || track.keyframes || track.part || track.selector || track.stagger || !targets.has(track.target) || !isVideoCommand(track)) continue;
      events.push({ target: track.target, command: track.preset as VideoCommand, at: start + Math.max(0, track.start ?? 0), order: order++ });
    }
  });
  return events.sort((a, b) => a.at - b.at || a.order - b.order);
}

export function videoEventsForPlan(slide: Slide, plan: Pick<VideoPlan, "cues">): VideoEvent[] {
  return videoEvents(slide, beat => plan.cues.find(c => beat >= c.fromBeat && beat <= c.beat)?.start);
}

export function sampleVideo(events: readonly VideoEvent[], target: string, at: number, durationMs: number, loop = false): VideoSample {
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
  if (durationMs > 0) {
    if (loop) position %= durationMs;
    else if (position >= durationMs) { position = durationMs; running = false; }
  }
  return { timeMs: position, running, started };
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
