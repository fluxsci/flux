import { trackDuration } from "../../../../lib/slide/compile";
// Bulk actions over the animator's track selection — shared by the timeline's
// context menu, the keyboard cockpit, and the TrackEditor strip. Every action is
// ONE commitDeck (one undo step) over every selected track.

import { get } from "svelte/store";
import { activeBeat, selTrackIds, commitDeckLive, deckOverlay } from "../../../../lib/slide/store";
import { activeFigureId, selection, partSelection } from "../../../../lib/store";
import { slideById, duplicateTrack, moveTrackToBeat, setTrackEnabled, removeTracks, setTrack, setTrackCurve } from "../../../../lib/slide/ops";
import type { Deck, Track } from "../../../../lib/slide/types";
import { resolveTrack } from "../../../../lib/slide/resolve";
import { familyOf } from "../../../../lib/slide/family";
import { defaultEasingFor } from "../../../../lib/slide/presetCatalog";
import { scene3dManifests } from "../../../../lib/model3d/store";
import { transformPreState } from "../../../../lib/slide/tween";
import { plotManifests } from "../../../../lib/plot/store";

function manifestForDeck(deck: Deck, sid: string) {
  const slide = slideById(deck, sid), manifests = get(plotManifests), models = get(scene3dManifests);
  return (target: string) => {
    const el = slide ? transformPreState(slide, target, get(activeBeat)) : undefined;
    return el?.type === "model3d" ? models[el.assetId] : el?.type === "plot" ? manifests[el.assetId] : undefined;
  };
}

function ctx(): { sid: string; ids: string[] } | null {
  const sid = get(activeFigureId); // slide id === projected figure id
  const ids = get(selTrackIds);
  return sid && ids.length ? { sid, ids } : null;
}

/** Mutate EVERY selected track in one commit (bulk edit). */
export function withSelectedTracks(fn: (t: Track, resolved: Track, deck: Deck, slideId: string) => void, coalesce?: string): void {
  const c = ctx();
  if (!c) return;
  commitDeckLive((d) => {
    const s = slideById(d, c.sid);
    if (s) for (const b of s.beats) for (const t of b.tracks) if (t.id && c.ids.includes(t.id)) {
      // A birth owns a result identity and must remain a whole-object Change.
      // Bulk property callbacks may share timing, never rewire that ownership.
      const birth = t.ghostFrom ? {target:t.target, ghostFrom:t.ghostFrom, preset:t.preset} : null;
      fn(t, resolveTrack(t, d), d, c.sid);
      if (birth) { Object.assign(t, birth); delete t.part; delete t.selector; }
      if (familyOf(t) === "media") { t.duration = 0; delete t.stagger; delete t.easing; delete t.influence; delete t.curve; }
    }
  }, coalesce ? { coalesce } : undefined);
}

type TimingCopy = Pick<Track, "duration" | "curve" | "easing" | "influence" | "stagger">;
let copiedTiming: TimingCopy | null = null;
export function canPasteTiming(): boolean { return copiedTiming !== null; }

/** Copy the resolved HOW, so a paste does not depend on the source's style. */
export function copySelectedTiming(): void {
  const c = ctx(), d = get(deckOverlay);
  const t = c && d && slideById(d, c.sid)?.beats.flatMap(b => b.tracks).find(t => t.id === c.ids.at(-1));
  if (!t || !d || familyOf(t) === "media") return;
  const r = resolveTrack(t, d);
  copiedTiming = structuredClone({ duration: trackDuration(r), curve: r.curve, influence: r.influence && (r.influence.in > 0 || r.influence.out > 0) ? r.influence : undefined,
    easing: r.easing ?? defaultEasingFor(r.preset), stagger: r.stagger });
}

export function pasteSelectedTiming(): void {
  if (!copiedTiming) return;
  const timing = copiedTiming;
  withSelectedTracks((t, _resolved, d, sid) => {
    if (!t.id || familyOf(t) === "media") return;
    setTrack(d, sid, t.id, { duration: timing.duration });
    if (timing.influence && !timing.curve) setTrack(d, sid, t.id, { influence: timing.influence });
    else setTrackCurve(d, sid, t.id, timing.curve ?? timing.easing ?? null);
    t.stagger = timing.stagger ? structuredClone(timing.stagger) : t.styleId ? { perMs: 0 } : undefined;
  });
}

export function deleteSelectedTracks(): void {
  const c = ctx();
  if (!c) return;
  commitDeckLive((d) => {
    removeTracks(d, c.sid, c.ids);
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
  if (copies.length) {
    selTrackIds.set(copies);
    const tracks = get(deckOverlay)?.slides.find(s => s.id === c.sid)?.beats.flatMap(b => b.tracks).filter(t => !!t.id && copies.includes(t.id)) ?? [];
    selection.set(new Set(tracks.filter(t => !t.target.startsWith("@")).map(t => t.target)));
    partSelection.set(tracks.length === 1 && tracks[0].part ? {elementId:tracks[0].target,partId:tracks[0].part} : null);
  }
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
  withSelectedTracks((t, resolved) => {
    if (field === "start") {
      if (t.anchor) t.anchor.offsetMs = (t.anchor.offsetMs ?? 0) + deltaMs;
      else t.start = Math.max(0, (resolved.start ?? 0) + deltaMs);
    } else if (familyOf(resolved) !== "media") t.duration = Math.max(50, trackDuration(resolved) + deltaMs);
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
    const manifestFor = manifestForDeck(d, c.sid);
    for (const id of c.ids) moveTrackToBeat(d, c.sid, id, toId, undefined, manifestFor);
  });
  activeBeat.set(to);
}

/** Move the selection into one specific beat (context menu / drag drop). */
export function moveSelectedToBeat(beatId: string, at?: number): void {
  const c = ctx();
  if (!c) return;
  commitDeckLive((d) => {
    let lane = at;
    const manifestFor = manifestForDeck(d, c.sid);
    for (const id of c.ids) {
      moveTrackToBeat(d, c.sid, id, beatId, lane, manifestFor);
      if (lane != null) lane++;
    }
  });
}
