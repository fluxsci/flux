// The track flavor of the cascade popover: a TrackCascadeAdapter over the
// animator's selection, injected into src/lib/CascadePopover.svelte by
// SlideMode (the popover never imports slide code — bundle rule, guide §9).
//
// Preview rides commitDeckLive with ONE coalesce key per session, so the
// whole live-tuning burst is a single undo entry (the first commit captured
// the pre-state + overlay companion); Esc rolls that entry back, Enter just
// seals the run. Absolute-from-baseline application lives in the pure
// slideOps.cascadeTracks — this module only owns the session.

import { get } from "svelte/store";
import { activeFigureId, editGen, rollbackGesture, cascadeState } from "../../../../lib/store";
import { selTrackIds, commitDeckLive, sealHistory, deckOverlay } from "../../../../lib/slide/store";
import { slideById, cascadeTracks, type TrackCascadeBaseline } from "../../../../lib/slide/ops";
import { TRACK_CASCADE_PROPS, type TrackCascadeAdapter, type TrackCascadeProp, type TrackCascadeSpec } from "../../../../lib/cascade";

let seq = 0;
const sess = {
  sid: "",
  ids: [] as string[],
  baseline: new Map<string, TrackCascadeBaseline>(),
  key: "",
  began: false,
  gen: -1,
};

export const trackCascadeAdapter: TrackCascadeAdapter = {
  info() {
    const d = get(deckOverlay);
    const s = d && slideById(d, sess.sid);
    const all = s?.beats.flatMap((b) => b.tracks).filter((t) => t.id && sess.ids.includes(t.id)) ?? [];
    const applies = Object.fromEntries(
      TRACK_CASCADE_PROPS.map((p) => [p, p === "stagger.perMs" ? all.filter((t) => t.stagger).length : all.length]),
    ) as Record<TrackCascadeProp, number>;
    return { total: all.length, applies };
  },
  begin() {
    sess.sid = get(activeFigureId) ?? "";
    sess.ids = [...get(selTrackIds)];
    sess.baseline = new Map();
    sess.key = `cascade:${++seq}`;
    sess.began = false;
    sess.gen = -1;
  },
  preview(spec: TrackCascadeSpec) {
    if (!sess.sid || !sess.ids.length) return;
    commitDeckLive((d) => cascadeTracks(d, sess.sid, sess.ids, spec, sess.baseline), { coalesce: sess.key });
    sess.began = true;
    sess.gen = editGen.n;
  },
  commit() {
    sealHistory();
    sess.began = false;
  },
  cancel() {
    // Roll the coalesced run's single entry back — but never a foreign one:
    // if any other edit landed after our last preview, the previewed state
    // stands (still one clean undo step away).
    if (sess.began && editGen.n === sess.gen) rollbackGesture();
    sealHistory();
    sess.began = false;
  },
};

/** BeatRail / PropertiesPane / the ⌃⇧C chord: open the popover in track
 *  flavor on the current animator selection (silent no-op below 2 tracks). */
export function openTrackCascade(): void {
  if (get(selTrackIds).length < 2) return;
  cascadeState.set({ kind: "tracks" });
}
