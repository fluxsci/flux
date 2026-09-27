// ---------------------------------------------------------------------------
// Flux Slide — the track FAMILY law (animation rework, 0.3.0). Every track
// belongs to exactly one authoring family:
//
//   • "appearance" — the object arrives/leaves/pulses (enters, exits,
//     emphasis, stagger, writeOn, countUp…). What the (dis)Appearances pane
//     edits.
//   • "transform"  — the object becomes a different version of itself, or
//     another object entirely (Change · Ghost · Become — one family; the
//     legacy `morph` preset is normalized to `transform` at load).
//   • "media"      — independent zero-duration video Start/Pause/Stop commands.
//   • "camera"     — stage-pose moves (target `@camera`).
//
// The law: an appearance and a transform COEXIST on one object in one beat
// (setAnimation replaces only within-family), and a target carries at most
// ONE transform per beat (chaining happens across beats). Pure — flux-core
// loads this module; keep its dependencies pure.
// ---------------------------------------------------------------------------

import type { Track } from "./types";
import { presetDef } from "./presetCatalog";

export type TrackFamily = "appearance" | "transform" | "camera" | "media";

/** The family a track animates in (see module doc for the law it drives). */
export function familyOf(track: Pick<Track, "preset">): TrackFamily {
  return presetDef(track.preset).family;
}
