// Animator-only UI state (never persisted, never in the deck model). Shared by
// the animator's split components (PartsTree / BeatTimeline / TrackEditor).

import { writable } from "svelte/store";

/** Track id under the pointer in the timeline (hover-highlight seam). */
export const hoverTrackId = writable<string | null>(null);

/** Timeline zoom (px per ms). null = auto-fit to the slide's longest beat. */
export const timelinePxPerMs = writable<number | null>(null);

/** One-shot flash signal: bump `n` with a track id (chip click feedback). */
export const flashTrack = writable<{ n: number; trackId: string | null }>({ n: 0, trackId: null });
export function requestFlash(trackId: string): void {
  flashTrack.update((f) => ({ n: f.n + 1, trackId }));
}
