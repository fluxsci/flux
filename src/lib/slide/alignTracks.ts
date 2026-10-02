/** Timeline alignment and Inherit — the animator's Alt+A / Alt+D and
 * Ctrl+Alt-drag, and their headless twins (`align-tracks`, `inherit-track`).
 *
 * One pure module so the GUI and the CLI move exactly the same bytes
 * (guide §2). It sits beside `ops.ts` rather than inside it and builds only on
 * its public ops (`setTrack`, `linkTrackStyle`, `findTrack`).
 *
 * Edges are the RESOLVED footprint the timeline draws: a track's start after
 * styles and anchors, and its end = start + duration + stagger tail (the same
 * end a timing anchor and a drag magnet use). */
import type { Deck, Track } from "./types";
import type { Id } from "../types";
import { resolveBeat, resolveTrack, type ManifestFor } from "./resolve";
import { trackDuration } from "./timing";
import { staggerSpan } from "./stagger";
import { targetPartIds } from "./targets";
import { familyOf } from "./family";
import { defaultEasingFor, presetDef } from "./presetCatalog";
import { findTrack, linkTrackStyle, setTrack } from "./ops";

export type AlignEdge = "start" | "end";
export type AlignMode = "move" | "resize";

/** The drawn footprint of a resolved track: [start, end], tail included. */
export function trackEdges(track: Track, manifestFor: ManifestFor = () => undefined): { start: number; end: number; tail: number } {
  const start = track.start ?? 0;
  const tail = staggerSpan(track, targetPartIds(track, manifestFor(track.target)).length);
  return { start, end: start + trackDuration(track) + tail, tail };
}

export interface AlignCandidate {
  ms: number;
  /** The track whose edge this is (the label: "→ ‹rect 2› end · 1.95 s"). */
  trackId: Id | null;
  /** `selection`: the selection's own extreme; `above`: a lane above it. */
  from: "selection" | "above";
}

const SAME_MS = .5;

/** The candidate law for one Alt+A / Alt+D press cycle (owner, 2026-10-02).
 *
 * `tracks` are the beat's RESOLVED tracks in lane order (top first);
 * `selectedIds` the selection. Returns the targets successive presses visit;
 * the caller returns to the origin after the last one (a full cycle).
 * 1. Within the selection first: with ≥ 2 selected tracks whose edges differ,
 *    the selection's own extreme — the earliest start (A) or the latest end (D).
 * 2. Then every enabled, unselected lane ABOVE the topmost selected lane
 *    contributes its edge; times are deduplicated (the upper lane names a
 *    shared time), a time equal to the selection's common edge or to the
 *    within-selection extreme is dropped, and the rest are ordered by distance
 *    from the selection's edge (its common edge, else the extreme), nearest
 *    first, ties to the upper lane. */
export function alignCandidates(tracks: readonly Track[], selectedIds: readonly Id[], edge: AlignEdge, manifestFor: ManifestFor = () => undefined): AlignCandidate[] {
  const chosen = new Set(selectedIds);
  const top = tracks.findIndex(t => t.id != null && chosen.has(t.id));
  if (top < 0) return [];
  const edgeOf = (t: Track) => trackEdges(t, manifestFor)[edge];
  const selected = tracks.filter(t => t.id != null && chosen.has(t.id));
  const edges = selected.map(edgeOf);
  const common = edges.every(ms => Math.abs(ms - edges[0]) <= SAME_MS) ? edges[0] : null;
  const out: AlignCandidate[] = [];
  let reference = common ?? 0;
  if (common == null) {
    const extreme = edge === "start" ? Math.min(...edges) : Math.max(...edges);
    out.push({ ms: extreme, trackId: selected[edges.findIndex(ms => ms === extreme)].id ?? null, from: "selection" });
    reference = extreme;
  }
  const above: AlignCandidate[] = [];
  for (const t of tracks.slice(0, top)) {
    if (t.disabled || t.id == null || chosen.has(t.id)) continue;
    const ms = edgeOf(t);
    if (Math.abs(ms - reference) <= SAME_MS || above.some(c => Math.abs(c.ms - ms) <= SAME_MS)) continue;
    above.push({ ms, trackId: t.id, from: "above" });
  }
  // Array.prototype.sort is stable: equal distances keep lane order (upper first).
  above.sort((a, b) => Math.abs(a.ms - reference) - Math.abs(b.ms - reference));
  return [...out, ...above];
}

/** The next press of an align cycle: candidate 0, 1, … then back to the
 *  ORIGIN (-1), then round again, so repeated presses never strand the user. */
export function alignCycleStep(index: number, count: number): number {
  return count <= 0 || index + 1 >= count ? -1 : index + 1;
}

export interface AlignResult {
  /** Tracks whose timing changed. */
  changed: Id[];
  /** Tracks whose timing anchor was detached because their start moved, with
   *  the leader each one followed (the GUI's "Detached from ‹…›" toast). */
  detached: { trackId: Id; from: Id }[];
  refused: { trackId: Id; reason: string }[];
}

/** Land each track's resolved `edge` on `toMs`.
 * `move` keeps the duration (an end-align changes the start); `resize` keeps
 * the opposite edge (a start-align lengthens or shortens from the front, an
 * end-align changes the duration). Starts clamp at 0, durations at 1 ms. A
 * moved start writes an own `start` (it overrides a style, like a drag) and
 * detaches a timing anchor (`anchor: null`, again like a drag); an end resize
 * keeps the anchor. Video commands have no duration: `move` places them,
 * `resize` refuses them. Every target is computed from the pre-edit state,
 * then applied through `setTrack`. */
export function alignTrackEdges(deck: Deck, slideId: Id, beatId: Id, trackIds: readonly Id[], edge: AlignEdge, toMs: number,
  opts: { mode?: AlignMode; manifestFor?: ManifestFor } = {}): AlignResult {
  const mode = opts.mode ?? "move", manifestFor = opts.manifestFor ?? (() => undefined);
  const result: AlignResult = { changed: [], detached: [], refused: [] };
  const slide = deck.slides.find(s => s.id === slideId), beat = slide?.beats.find(b => b.id === beatId);
  if (!slide || !beat) { result.refused.push(...trackIds.map(trackId => ({ trackId, reason: "Step not found on this slide" }))); return result; }
  if (!Number.isFinite(toMs) || toMs < 0) { result.refused.push(...trackIds.map(trackId => ({ trackId, reason: "Align time must be non-negative and finite" }))); return result; }
  const resolved = new Map(resolveBeat(beat, deck, manifestFor).tracks.flatMap(t => t.id ? [[t.id, t] as const] : []));
  const plans: { id: Id; patch: { start?: number; duration?: number }; leader?: Id }[] = [];
  for (const id of new Set(trackIds)) {
    const raw = beat.tracks.find(t => t.id === id), track = resolved.get(id);
    if (!raw || !track) { result.refused.push({ trackId: id, reason: "Track not found in this step" }); continue; }
    const media = familyOf(raw) === "media";
    if (media && mode === "resize") { result.refused.push({ trackId: id, reason: "Video commands have no duration to resize" }); continue; }
    const { start, end, tail } = trackEdges(track, manifestFor), duration = trackDuration(track);
    let nextStart = start, nextDuration = duration;
    if (mode === "move") nextStart = Math.max(0, edge === "start" ? toMs : toMs - duration - tail);
    else if (edge === "start") { nextStart = Math.max(0, Math.min(toMs, end - tail - 1)); nextDuration = end - tail - nextStart; }
    else nextDuration = Math.max(1, toMs - start - tail);
    const patch: { start?: number; duration?: number } = {};
    if (Math.abs(nextStart - start) > 1e-9) patch.start = nextStart;
    if (!media && Math.abs(nextDuration - duration) > 1e-9) patch.duration = nextDuration;
    if (patch.start === undefined && patch.duration === undefined) continue;
    plans.push({ id, patch, leader: patch.start !== undefined ? raw.anchor?.trackId : undefined });
  }
  for (const { id, patch, leader } of plans) {
    const edit = setTrack(deck, slideId, id, { ...patch, ...(patch.start !== undefined ? { anchor: null } : {}) }, manifestFor);
    if (!edit.ok) { result.refused.push({ trackId: id, reason: edit.reason! }); continue; }
    result.changed.push(id);
    if (leader) result.detached.push({ trackId: id, from: leader });
  }
  return result;
}

/** Resolve an align target: a time in ms, or a track's edge in the same step
 * (`trackId[:start|end]`, defaulting to the aligned edge). */
export function alignTargetMs(deck: Deck, slideId: Id, beatId: Id, to: number | string, edge: AlignEdge, manifestFor: ManifestFor = () => undefined): number | null {
  if (typeof to === "number") return to;
  if (/^\d+(?:\.\d+)?$/.test(to)) return Number(to);
  const match = /^(.+?)(?::(start|end))?$/.exec(to);
  const beat = deck.slides.find(s => s.id === slideId)?.beats.find(b => b.id === beatId);
  const track = beat && match ? resolveBeat(beat, deck, manifestFor).tracks.find(t => t.id === match[1]) : undefined;
  return track ? trackEdges(track, manifestFor)[(match![2] as AlignEdge | undefined) ?? edge] : null;
}

export interface InheritResult {
  inherited: Id[];
  /** The style the targets now link to (a linked source), else undefined (copied). */
  styleId?: Id;
  refused: { trackId: Id; reason: string }[];
}

/** HOW fields a copy may carry; never bindings, endpoints, identity or timing anchors. */
const TIMING_GROUP = ["curve", "influence", "easing"] as const;

/** Inherit: the targets take the source effect's exact animation parameters
 * (owner, 2026-10-02 — Ctrl+Alt-drag the selection onto another lane).
 *
 * A LINKED source (`styleId`): each target links to the same style
 * (`linkTrackStyle`, so a cross-family link is refused with its reason), its own
 * overrides are cleared, and the source's own overrides are copied, so the
 * target resolves exactly like the source and follows later style edits.
 * An UNLINKED source: the target receives the source's resolved HOW — the
 * materialized `duration`; the timing group exactly as the source carries it
 * (resolved through its style); `stagger`; and, within one family and phase
 * (entrance → entrance, exit → exit, transform → transform), `params`, `arc`
 * and `preset`. A linked target is detached first (materialized), since
 * it now takes its timing from the source rather than its style. Across
 * families or phases only timing travels, and an absent timing group
 * materializes the source preset's default easing so the curve is still the
 * source's. Video
 * commands and animations never share timing.
 * Never copied: `target`/`part`/`parts`/`selector`, `to`, `ghostFrom`,
 * `anchor`, `groupId`, `disabled`, `keyframes`, `id`. `start` is copied (as a
 * literal resolved start; any anchor detaches) only with `includeStart`;
 * otherwise each target keeps its own resolved start in time. */
export function inheritTrack(deck: Deck, slideId: Id, sourceTrackId: Id, targetTrackIds: readonly Id[],
  opts: { includeStart?: boolean; beatId?: Id; manifestFor?: ManifestFor } = {}): InheritResult {
  const manifestFor = opts.manifestFor ?? (() => undefined);
  const out: InheritResult = { inherited: [], refused: [] };
  const found = findTrack(deck, sourceTrackId);
  if (!found || found.slide.id !== slideId || opts.beatId !== undefined && found.beat.id !== opts.beatId) {
    out.refused.push(...targetTrackIds.map(trackId => ({ trackId, reason: "Source effect not found in this step" })));
    return out;
  }
  const source = found.track, family = familyOf(source);
  const resolvedSource = resolveBeat(found.beat, deck, manifestFor).tracks.find(t => t.id === sourceTrackId)!;
  const style = source.styleId != null ? deck.animStyles?.find(s => s.id === source.styleId) : undefined;
  if (style) out.styleId = style.id;
  for (const id of new Set(targetTrackIds)) {
    if (id === sourceTrackId) { out.refused.push({ trackId: id, reason: "An effect cannot inherit from itself" }); continue; }
    const target = findTrack(deck, id);
    if (!target || target.slide.id !== slideId || opts.beatId !== undefined && target.beat.id !== opts.beatId) {
      out.refused.push({ trackId: id, reason: "Target effect not found in this step" }); continue;
    }
    const track = target.track, targetFamily = familyOf(track);
    if ((family === "media") !== (targetFamily === "media")) {
      out.refused.push({ trackId: id, reason: family === "media" ? "A video command's timing cannot drive an animation" : "Video commands cannot inherit an animation's timing" });
      continue;
    }
    const keepStart = resolveBeat(target.beat, deck, manifestFor).tracks.find(t => t.id === id)?.start ?? 0;
    if (style) {
      const linked = linkTrackStyle(deck, slideId, id, style.id);
      if (!linked.ok) { out.refused.push({ trackId: id, reason: linked.reason! }); continue; }
      // The source's own overrides ride along, so the target resolves exactly like it.
      for (const key of ["params", "duration", ...TIMING_GROUP, "stagger", "arc"] as const)
        if (source[key] != null) (track as unknown as Record<string, unknown>)[key] = structuredClone(source[key]);
      if (source.preset != null && !track.ghostFrom) track.preset = source.preset;
    } else {
      if (track.styleId != null) linkTrackStyle(deck, slideId, id, null);
      const from = resolveTrack(source, deck);
      // The effect itself (preset + its params + arc) travels only within one
      // family AND phase: an entrance never turns an exit into a second entrance.
      const same = family === targetFamily && family !== "media" && presetDef(source.preset).phase === presetDef(track.preset).phase;
      if (targetFamily !== "media") track.duration = trackDuration(from);
      for (const key of TIMING_GROUP) delete track[key];
      if (from.curve != null) track.curve = structuredClone(from.curve);
      else if (from.influence != null) track.influence = { ...from.influence };
      else if (from.easing != null) track.easing = from.easing;
      else if (!same) track.easing = defaultEasingFor(from.preset);
      if (from.stagger != null && targetFamily !== "media") track.stagger = structuredClone(from.stagger); else delete track.stagger;
      if (same) {
        if (from.params != null) track.params = structuredClone(from.params); else delete track.params;
        if (from.arc != null) track.arc = from.arc; else delete track.arc;
        if (source.preset != null && !track.ghostFrom) track.preset = source.preset;
      }
    }
    if (opts.includeStart) {
      delete track.anchor;
      if (style && source.start == null && source.anchor == null) delete track.start;
      else track.start = resolvedSource.start ?? 0;
    } else if (!track.anchor) {
      // Keep the target where it sat in time, whatever the style now supplies.
      const now = resolveTrack(track, deck).start ?? 0;
      if (Math.abs(now - keepStart) > 1e-9) track.start = keepStart;
    }
    out.inherited.push(id);
  }
  return out;
}
