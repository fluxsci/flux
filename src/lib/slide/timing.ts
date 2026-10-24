import type { Track, Beat } from "./types";
import { presetDef, presetParam, type ParamSource } from "./presetCatalog";

/** Duration of a resolved track (media commands are instantaneous). */
export function trackDuration(track: Track): number {
  const def = presetDef(track.preset);
  return def.family === "media" ? 0 : Math.max(0, track.duration ?? def.defaultDurationMs);
}

/** A click while a cue is mid-flight no longer snaps that cue to its end (a jump that grows with pace:
 *  62 % of the move at a 300 ms click gap on a 700 ms cue): the cue FINISHES over at most SETTLE_MAX_MS
 *  by warping its clock, then the next cue starts. A remainder under SETTLE_MIN_REMAINING_MS just snaps. */
export const SETTLE_MAX_MS = 120;
export const SETTLE_MIN_REMAINING_MS = 60;
/** Warped cue time `elapsedMs` after a click that arrived at cue-time `t0` (of `duration`): continuous in
 *  position AND velocity at the click (rate 1), reaching `duration` exactly at `spanMs` (<= the remainder). Pure. */
export function settleTime(t0: number, duration: number, spanMs: number, elapsedMs: number): number {
  const remaining = Math.max(0, duration - t0);
  if (remaining === 0 || spanMs <= 0) return duration;
  const s = Math.min(1, Math.max(0, elapsedMs / spanMs)), a = Math.min(1, spanMs / remaining);
  return t0 + remaining * (a * s + (1 - a) * s * s);
}

/** WP 4.1 (W1) animated Back: a rewind walks the SAME pure sampler backwards, so every rewind frame equals the static sample at its
 *  time and the landing is a `seek` (the resting frame of a jump). Its wall time is the run's length / `rewindRate`, never above
 *  REWIND_CAP_MS (a long autobuild beat is a fast rewind, not a long wait); a Back within BACK_BURST_MS of the previous one jumps (a
 *  presenter hammering Back is navigating, not watching). */
export const REWIND_CAP_MS = 800;
export const BACK_BURST_MS = 350;
export const BACK_SCALE_DEFAULT = 0.7;
/** Beat ms per wall ms of a rewind of a run `runMs` long at speed `scale` (clamped to [0.25, 1.5]). Pure. */
export function rewindRate(runMs: number, scale = BACK_SCALE_DEFAULT): number {
  const s = Math.max(0.25, Math.min(1.5, Number.isFinite(scale) ? scale : BACK_SCALE_DEFAULT));
  return Math.max(1 / s, runMs / REWIND_CAP_MS);
}
/** Beat time `elapsedMs` into a rewind that started at beat time `from`: an EASE-OUT clock, time = from·(1−x)². A plain reversal starts
 *  at the END of every forward curve, where nothing moves (the first visible change took 117 ms, over the 100 ms budget); this one opens
 *  at twice the speed (67 ms measured) and decelerates into the landing. Exactly `from` at 0 and exactly 0 at the end. Pure. */
export function rewindTime(from: number, rate: number, elapsedMs: number): number {
  if (!(from > 0)) return 0;
  const x = Math.min(1, Math.max(0, elapsedMs * rate / from));
  return x >= 1 ? 0 : from * (1 - x) * (1 - x);
}

/** Playback fallback for an `auto` beat that omits `autoDelayMs`. FROZEN: old decks never change. */
export const AUTO_DELAY_FALLBACK_MS = 600;
/** What authoring writes when a beat becomes "After previous" without a delay: near-continuous chaining
 *  (the owner's real decks: median 0-120 ms, every auto beat explicit). */
export const AUTO_DELAY_AUTHORED_MS = 150;
/** Automatic step delay shared by Present, video and PowerPoint builds. */
export function beatDelayMs(beat: Pick<Beat, "autoDelayMs">): number {
  return Math.max(0, beat.autoDelayMs ?? AUTO_DELAY_FALLBACK_MS);
}

/** The clock of a step starts at its first PRESENTED frame, not at the input event: whatever delays that frame (a flight built on the
 *  click, layers promoted, a first raster) must never eat the beginning of the motion. The first tick of a cue therefore advances the
 *  clock by at most this long (one 60 Hz frame plus jitter); a longer first frame is a hitch, not progress. Later ticks keep the wall
 *  clock (a long frame mid-flight skips ahead, as any renderer on a real clock does). */
export const FIRST_TICK_MAX_MS = 20;
/** The origin the first tick of a cue should measure from: `origin` itself unless the first frame arrived later than FIRST_TICK_MAX_MS. Pure. */
export function firstTickOrigin(origin: number, ts: number): number {
  const lag = ts - origin;
  return lag > FIRST_TICK_MAX_MS ? origin + (lag - FIRST_TICK_MAX_MS) : origin;
}
/** A cue that primes its flight layers presents frame 0 first (player `begin`): the first moving frame waits until a frame at least this
 *  much later than frame 0 has arrived. A compositor catching up can deliver the next callback with frame 0's own timestamp; moving then
 *  would raster the layers mid-flight again. Half a 60 Hz frame. */
export const PREROLL_MIN_MS = 8;
/** How a text rewrite (the glyph-matched text morph) paints its leftovers and anagram letters. */
export interface TextLook {
  /** `travel`: the letters of a near-permutation (an anagram) fly to their places; `fade`: they cross-fade like any word. */
  letters: "travel" | "fade";
  /** `roll`: leftover words lift / rise 0.35 em (and drift toward the other side when far); `drift`: today's 6 % / 8 % drift with the 0.92 / 0.96 scale. */
  fadeStyle: "drift" | "roll";
}
/** The text look a transform track plays with: its authored params, nothing else (X1d: NO profile argument; playback
 *  never reads a default, the writers put the values into the track). Absent, malformed or unknown values read as
 *  today's look, so a deck made before these params existed plays exactly as made. Pure; the editor, Present, exported
 *  HTML and video all call this one function. */
export function resolveTextLook(params?: ParamSource["params"]): TextLook {
  const track: ParamSource = { preset: "transform", params };
  return {
    letters: presetParam<string>(track, "letters", "transform") === "travel" ? "travel" : "fade",
    fadeStyle: presetParam<string>(track, "fadeStyle", "transform") === "roll" ? "roll" : "drift",
  };
}
