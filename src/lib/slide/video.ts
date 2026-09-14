/** Continuous single-slide timing. Pure: shared by settings, capture and CLI. */
import type { Slide, StageSize } from "./types";
import { videoContentEnd, videoEventsForPlan } from "./mediaTimeline";

export interface SlideVideoOptions {
  stepDelayMs: number;
  startHoldMs: number;
  endHoldMs: number;
  height: 720 | 1080 | 2160;
  fps: 30 | 60;
}
export const DEFAULT_VIDEO_OPTIONS: SlideVideoOptions = { stepDelayMs: 500, startHoldMs: 1000, endHoldMs: 2000, height: 1080, fps: 60 };
export function videoOptions(input: Partial<SlideVideoOptions> = {}): SlideVideoOptions {
  const out = { ...DEFAULT_VIDEO_OPTIONS, ...input };
  for (const key of ["stepDelayMs", "startHoldMs", "endHoldMs"] as const)
    if (!Number.isFinite(out[key]) || out[key] < 0 || out[key] > 60000) throw new Error(`${key} must be between 0 and 60000 milliseconds`);
  if (![720, 1080, 2160].includes(out.height)) throw new Error("Video resolution must be 720, 1080 or 2160 pixels high");
  if (![30, 60].includes(out.fps)) throw new Error("Video frame rate must be 30 or 60 fps");
  return out;
}
export function videoSize(stage: StageSize, height: number): { width: number; height: number } {
  if (!(stage.width > 0 && stage.height > 0)) throw new Error("Invalid slide dimensions");
  const width = Math.ceil(height * stage.width / stage.height / 2) * 2;
  if (!Number.isFinite(width) || width < 2 || width > 7680) throw new Error("This slide aspect ratio is too wide for video export");
  return { width, height };
}
/** A with-prev step belongs to the same presenter cue. */
export function cueEnd(slide: Slide, from: number): number {
  let end = from;
  while (end + 1 < slide.beats.length && slide.beats[end + 1].advance === "with-prev") end++;
  return end;
}
export interface VideoCue { fromBeat: number; beat: number; start: number; duration: number }
export interface VideoPlan { cues: VideoCue[]; durationMs: number; frameCount: number; fps: number; initialTime: number; lastBeat: number }
export function planSlideVideo(slide: Slide, durations: number[], input: Partial<SlideVideoOptions> = {}): VideoPlan {
  const opts = videoOptions(input), cues: VideoCue[] = [];
  let time = opts.startHoldMs;
  const count = Math.max(1, slide.beats.length);
  const durationOf = (i: number) => {
    const d = durations[i] ?? 0;
    if (!Number.isFinite(d) || d < 0) throw new Error("Invalid animation duration");
    return d;
  };
  // Step zero normally is a static design, but authored effects there play too.
  if (durationOf(0) > 0) { cues.push({ fromBeat: 0, beat: 0, start: time, duration: durationOf(0) }); time += durationOf(0); }
  for (let from = 1; from < count;) {
    const end = cueEnd(slide, from), next = slide.beats[from];
    // Start hold controls the first cue; subsequent automatic cues retain their
    // authored delay. The export delay replaces a presenter's manual pause.
    if (cues.length) time += next.advance === "auto" ? Math.max(0, next.autoDelayMs ?? 600) : opts.stepDelayMs;
    const duration = Math.max(...Array.from({ length: end - from + 1 }, (_, i) => durationOf(from + i)));
    cues.push({ fromBeat: from, beat: end, start: time, duration }); time += duration;
    from = end + 1;
  }
  time = videoContentEnd(slide, videoEventsForPlan(slide, { cues }), time) + opts.endHoldMs;
  if (!Number.isFinite(time) || time > 30 * 60 * 1000) throw new Error("A single-slide video must be shorter than 30 minutes");
  return { cues, durationMs: time, frameCount: Math.max(1, Math.ceil(time * opts.fps / 1000)), fps: opts.fps, initialTime: durationOf(0) > 0 ? 0 : Infinity, lastBeat: count - 1 };
}
export function videoFrame(plan: VideoPlan, frame: number): { beat: number; fromBeat: number; time: number } {
  if (!Number.isInteger(frame) || frame < 0 || frame >= plan.frameCount) throw new Error("Video frame out of range");
  // Include the exact final pose even with a zero end hold or sub-frame effect.
  if (frame === plan.frameCount - 1) return { beat: plan.lastBeat, fromBeat: plan.lastBeat, time: Infinity };
  const time = frame * 1000 / plan.fps;
  let cue: VideoCue | undefined;
  for (const c of plan.cues) { if (c.start > time) break; cue = c; }
  return cue ? { beat: cue.beat, fromBeat: cue.fromBeat, time: Math.min(cue.duration, time - cue.start) }
    : { beat: 0, fromBeat: 0, time: plan.initialTime };
}

export interface SlideVideoProgress { jobId: string; phase: "preparing" | "rendering" | "encoding"; frame: number; total: number }
export interface SlideVideoResult { ok: boolean; cancelled?: boolean; path?: string; error?: string; warnings?: string[]; frames?: number; durationMs?: number }
