import type { Track, Beat } from "./types";
import { presetDef } from "./presetCatalog";

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

/** Playback fallback for an `auto` beat that omits `autoDelayMs`. FROZEN: old decks never change. */
export const AUTO_DELAY_FALLBACK_MS = 600;
/** What authoring writes when a beat becomes "After previous" without a delay: near-continuous chaining
 *  (the owner's real decks: median 0-120 ms, every auto beat explicit). */
export const AUTO_DELAY_AUTHORED_MS = 150;
/** Automatic step delay shared by Present, video and PowerPoint builds. */
export function beatDelayMs(beat: Pick<Beat, "autoDelayMs">): number {
  return Math.max(0, beat.autoDelayMs ?? AUTO_DELAY_FALLBACK_MS);
}
