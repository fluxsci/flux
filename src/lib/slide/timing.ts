import type { Track } from "./types";
import { presetDef } from "./presetCatalog";

/** Duration of a resolved track (media commands are instantaneous). */
export function trackDuration(track: Track): number {
  const def = presetDef(track.preset);
  return def.family === "media" ? 0 : Math.max(0, track.duration ?? def.defaultDurationMs);
}
