import type { Track, Beat } from "./types";
import { presetDef } from "./presetCatalog";

/** Duration of a resolved track (media commands are instantaneous). */
export function trackDuration(track: Track): number {
  const def = presetDef(track.preset);
  return def.family === "media" ? 0 : Math.max(0, track.duration ?? def.defaultDurationMs);
}

/** Automatic step delay shared by Present, video and PowerPoint builds. */
export function beatDelayMs(beat: Pick<Beat, "autoDelayMs">): number {
  return Math.max(0, beat.autoDelayMs ?? 600);
}
