// Bulk actions over the animator's track selection — shared by the timeline's
// context menu, the keyboard cockpit, and the TrackEditor strip. Every action is
// ONE commitDeck (one undo step) over every selected track.

import { get } from "svelte/store";
import { activeBeat, selTrackIds, commitDeckLive, deckOverlay } from "../../../../lib/slide/store";
import { activeFigureId } from "../../../../lib/store";
import { slideById, duplicateTrack, moveTrackToBeat, setTrackEnabled } from "../../../../lib/slide/ops";
import type { Track } from "../../../../lib/slide/types";

function ctx(): { sid: string; ids: string[] } | null {
  const sid = get(activeFigureId); // slide id === projected figure id
  const ids = get(selTrackIds);
  return sid && ids.length ? { sid, ids } : null;
}

/** Mutate EVERY selected track in one commit (bulk edit). */
export function withSelectedTracks(fn: (t: Track) => void, coalesce?: string): void {
  const c = ctx();
  if (!c) return;
  commitDeckLive((d) => {
    const s = slideById(d, c.sid);
    if (s) for (const b of s.beats) for (const t of b.tracks) if (t.id && c.ids.includes(t.id)) fn(t);
  }, coalesce ? { coalesce } : undefined);
}

export function deleteSelectedTracks(): void {
  const c = ctx();
  if (!c) return;
  commitDeckLive((d) => {
    const s = slideById(d, c.sid);
    if (s) for (const b of s.beats) b.tracks = b.tracks.filter((t) => !t.id || !c.ids.includes(t.id));
  });
  selTrackIds.set([]);
}

/** Duplicate the selected tracks in place; the copies become the selection. */
export function duplicateSelectedTracks(): void {
  const c = ctx();
  if (!c) return;
  const copies: string[] = [];
  commitDeckLive((d) => {
    for (const id of c.ids) {
      const nid = duplicateTrack(d, c.sid, id);
      if (nid) copies.push(nid);
    }
  });
  if (copies.length) selTrackIds.set(copies);
}

/** Toggle disabled on the selection (mixed → all become disabled). */
export function toggleSelectedDisabled(): void {
  const c = ctx();
  if (!c) return;
  const d0 = get(deckOverlay);
  const s0 = d0 && slideById(d0, c.sid);
  const all = s0?.beats.flatMap((b) => b.tracks).filter((t) => t.id && c.ids.includes(t.id)) ?? [];
  const anyEnabled = all.some((t) => !t.disabled);
  commitDeckLive((d) => {
    for (const id of c.ids) setTrackEnabled(d, c.sid, id, !anyEnabled);
  });
}

/** Nudge start (or duration) by ±ms on the whole selection (keyboard retime). */
export function nudgeSelected(field: "start" | "duration", deltaMs: number): void {
  withSelectedTracks((t) => {
    if (field === "start") t.start = Math.max(0, (t.start ?? 0) + deltaMs);
    else t.duration = Math.max(50, (t.duration ?? 400) + deltaMs);
  }, `nudge:${field}`);
}

/** Move the selection into an adjacent beat ([ / ] keys). */
export function moveSelectedToAdjacentBeat(dir: 1 | -1): void {
  const c = ctx();
  const d0 = get(deckOverlay);
  if (!c || !d0) return;
  const s = slideById(d0, c.sid);
  if (!s) return;
  const at = s.beats.findIndex((b) => b.tracks.some((t) => t.id && c.ids.includes(t.id)));
  if (at < 0) return;
  const to = at + dir;
  if (to < 1 || to >= s.beats.length) return;
  const toId = s.beats[to].id;
  commitDeckLive((d) => {
    for (const id of c.ids) moveTrackToBeat(d, c.sid, id, toId);
  });
  activeBeat.set(to);
}

/** Move the selection into one specific beat (context menu / drag drop). */
export function moveSelectedToBeat(beatId: string, at?: number): void {
  const c = ctx();
  if (!c) return;
  commitDeckLive((d) => {
    let lane = at;
    for (const id of c.ids) {
      moveTrackToBeat(d, c.sid, id, beatId, lane);
      if (lane != null) lane++;
    }
  });
}
