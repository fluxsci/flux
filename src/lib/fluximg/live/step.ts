/**
 * The "this step" card of the board, on a slide (stage 2): what the step the board edits does to the image, and the
 * keys that author it. Read and written fresh from the slide store; every press is ONE `commitDeckLive` (one undo
 * step) through the same pure slide ops the Animate panel and flux-core call. Never used in a figure.
 *
 * In Design the card only says so: nothing here authors a step by surprise.
 */
import { get } from "svelte/store";
import { activeFigureId } from "../../store";
import { pushToast } from "../../toast";
import { commitDeckLive, composedSlide, deckOverlay, editDestination, selTrackIds } from "../../slide/store";
import * as slideOps from "../../slide/ops";
import { transformEndState, transformPreState } from "../../slide/tween";
import { familyOf } from "../../slide/family";
import { trackDuration } from "../../slide/timing";
import { isWholeElementRef, trackRef } from "../../slide/targets";
import type { Track } from "../../slide/types";
import type { VideoCommand } from "../../slide/mediaTimeline";
import type { FluximgElement } from "../element";
import { fluximgManifests } from "../store";
import { describeViewChange, longestWalk } from "../viewTween";
import { PACE_SPEEDS, PLAYBACK_MODES, resolvePlayback, walkableDims, type ResolvedPlayback } from "../playback";
import { resolveView } from "../viewOps";
import { liveElement, settleLiveEdit, previewHooks, fluximgPreview } from "./session";

export interface StepCard {
  /** Design: the resting view (the card says so and offers nothing). */
  design: boolean;
  /** The step's number (1 = the first step after Design). */
  index: number;
  slideId: string;
  beatId: string;
  /** What the step does to the image, in a few words each (`describeViewChange`); empty: nothing yet. */
  words: string[];
  /** The step's walk of planes, if it makes one. */
  walk: { dim: string; from: number; to: number } | null;
  /** The image's Change at this step, if any, and its length. */
  change: Track | null;
  durationMs: number | null;
  /** The walk pace the Change carries (null: its timing is the author's own, or it walks nothing). */
  pace: number | null;
  blend: boolean;
  /** The movie command this step gives the image, and whether the movie runs once the step has played. */
  movie: VideoCommand | null;
  movieState: "running" | "paused" | "stopped";
  playback: ResolvedPlayback | null;
  /** Dimensions the image can walk (time, depth, …). */
  dims: string[];
}

const fluximgManifestFor = (id: string) => get(fluximgManifests)[id];

/** The card for the live image, or null when the board is not on a slide (or the image or its manifest is missing). */
export function stepCard(): StepCard | null {
  const el = liveElement(), sid = get(activeFigureId), overlay = get(deckOverlay);
  if (!el || !sid || !overlay) return null;
  const manifest = get(fluximgManifests)[el.assetId];
  const slide = composedSlide(sid);
  if (!slide || !manifest) return null;
  const dest = get(editDestination);
  const bi = dest.kind === "after" ? slide.beats.findIndex((b) => b.id === dest.beatId) : 0;
  const playback = resolvePlayback(manifest, (slide.elements.find((e) => e.id === el.id) as FluximgElement | undefined)?.playback);
  const dims = walkableDims(manifest);
  const base = { slideId: sid, playback, dims };
  if (bi < 1) return { design: true, index: 0, beatId: slide.beats[0]?.id ?? "", words: [], walk: null, change: null, durationMs: null, pace: null, blend: false, movie: null, movieState: "stopped", ...base };
  const beat = slide.beats[bi];
  const pre = transformPreState(slide, el.id, bi) as FluximgElement | null;
  const change = beat.tracks.find((t) => familyOf(t) === "transform" && t.target === el.id && isWholeElementRef(trackRef(t)) && !t.disabled) ?? null;
  const end = pre && change ? (transformEndState(pre, change) as FluximgElement) : pre;
  const ends = pre && end ? [{ view: pre.view, crop: pre.crop }, { view: end.view, crop: end.crop }] as const : null;
  const words = ends ? describeViewChange(manifest, ends[0], ends[1]).map((c) => c.label) : [];
  const walk = ends ? longestWalk(manifest, ends[0], ends[1]) : null;
  const movie = (beat.tracks.find((t) => t.target === el.id && familyOf(t) === "media" && !t.disabled)?.preset ?? null) as VideoCommand | null;
  // Where the movie stands once this step has played: the last command so far (Start runs it, Pause holds, Stop resets).
  let last: string | null = null;
  for (let i = 1; i <= bi; i++) for (const t of slide.beats[i].tracks) if (t.target === el.id && familyOf(t) === "media" && !t.disabled) last = t.preset ?? null;
  return {
    design: false, index: bi, beatId: beat.id, words, walk, change,
    durationMs: change ? trackDuration(change) : null,
    pace: change ? slideOps.walkPace(change) : null,
    blend: change ? slideOps.walkBlends(change) : false,
    movie, movieState: last === "videoStart" ? "running" : last === "videoPause" ? "paused" : "stopped",
    ...base,
  };
}

/** What Play through would write here, for its key's preview (a ghost run on the rail): along `dim` (default: time, else depth). */
export function playThroughPlan(dim?: string): { dim: string; from: number; to: number } | null {
  const el = liveElement(), sid = get(activeFigureId);
  const manifest = el ? get(fluximgManifests)[el.assetId] : undefined;
  const slide = sid ? composedSlide(sid) : null, dest = get(editDestination);
  if (!el || !manifest || !slide || dest.kind !== "after") return null;
  const bi = slide.beats.findIndex((b) => b.id === dest.beatId);
  const pre = bi > 0 ? (transformPreState(slide, el.id, bi) as FluximgElement | null) : null;
  const dims = walkableDims(manifest), d = dim ?? dims[0];
  if (!pre || !d || !dims.includes(d)) return null;
  const n = manifest.pixels.shape[manifest.pixels.dims.indexOf(d)], from = resolveView(manifest, pre.view).index[d] ?? 0;
  return { dim: d, from, to: from === n - 1 ? 0 : n - 1 };
}

/** Run one authoring op on this step as ONE undo step (the board's open gesture and preview end first). */
function onStep(what: string, fn: (deck: Parameters<Parameters<typeof commitDeckLive>[0]>[0], card: StepCard, target: string) => Track | boolean | null | void): void {
  const card = stepCard(), el = liveElement();
  if (!card || card.design || !el) return;
  settleLiveEdit();
  if (get(fluximgPreview)) previewHooks.stop?.();
  try {
    const out = commitDeckLive((d) => fn(d, card, el.id));
    if (out && typeof out === "object" && out.id) selTrackIds.set([out.id]);
  } catch (error) { pushToast("info", `${what}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Play through: this step walks the image to the far end of `dim` at the data's own pace (`slideOps.addImageWalk`). */
export function playThroughHere(dim?: string): void {
  onStep("Play through", (d, c, target) => slideOps.addImageWalk(d, { slideId: c.slideId, beatId: c.beatId, target, dim, fluximgManifest: fluximgManifestFor }));
}

/** The pace dial: re-time this step's walk at `speed` times the data's own rate. */
export function setStepPace(speed: number): void {
  onStep("Pace", (d, c, target) => {
    const slide = slideOps.slideById(d, c.slideId), beat = slide?.beats.find((b) => b.id === c.beatId);
    const track = beat?.tracks.find((t) => t.id === c.change?.id);
    const pre = slide && transformPreState(slide, target, c.index);
    if (!track || !pre || !c.walk) throw new Error("this step walks no planes yet: Play through first");
    slideOps.retimeImageWalk(track, pre, transformEndState(pre, track), { fluximgManifest: fluximgManifestFor, speed, force: true });
    return track;
  });
}
/** Step the pace dial (+1 faster, −1 slower; wraps). */
export function stepPaceDial(by: number): void {
  const c = stepCard();
  if (!c?.walk) return;
  const now = c.pace ?? 1;
  const at = PACE_SPEEDS.reduce((best, v, i) => (Math.abs(v - now) < Math.abs(PACE_SPEEDS[best] - now) ? i : best), 0);
  setStepPace(PACE_SPEEDS[(at + by + PACE_SPEEDS.length) % PACE_SPEEDS.length]);
}

/** Blend planes on or off for this step's Change. */
export function toggleStepBlend(): void {
  onStep("Blend planes", (d, c) => {
    const track = slideOps.slideById(d, c.slideId)?.beats.find((b) => b.id === c.beatId)?.tracks.find((t) => t.id === c.change?.id);
    if (!track || !c.walk) throw new Error("this step walks no planes: there is nothing to blend");
    const p = { ...(track.params ?? {}) };
    if (slideOps.walkBlends(track)) delete p.blend; else p.blend = true;
    if (Object.keys(p).length) track.params = p; else delete track.params;
    return track;
  });
}

/** A movie key: give this step that command, or (the key is lit) take it away. */
export function toggleStepMovie(action: "start" | "pause" | "stop"): void {
  const preset = action === "start" ? "videoStart" : action === "pause" ? "videoPause" : "videoStop";
  onStep("Movie", (d, c, target) => {
    if (c.movie === preset) {
      const ids = slideOps.slideById(d, c.slideId)?.beats.find((b) => b.id === c.beatId)?.tracks.filter((t) => t.target === target && t.preset === preset).map((t) => t.id!).filter(Boolean) ?? [];
      slideOps.removeTracks(d, c.slideId, ids);
      return true;
    }
    if (!slideOps.setVideoTrack(d, c.slideId, c.beatId, target, action, { fluximgManifest: fluximgManifestFor })) throw new Error("this image has no time or depth axis to play");
    return slideOps.slideById(d, c.slideId)?.beats.find((b) => b.id === c.beatId)?.tracks.find((t) => t.target === target && t.preset === preset) ?? true;
  });
}

/** The movie's loop / bounce / once key: the next mode (Design-level, like a video's loop). */
export function cycleMovieMode(): void {
  const c = stepCard(), el = liveElement();
  if (!c || !el || !c.playback) return;
  const next = PLAYBACK_MODES[(PLAYBACK_MODES.indexOf(c.playback.mode) + 1) % PLAYBACK_MODES.length];
  settleLiveEdit();
  try { commitDeckLive((d) => slideOps.setImagePlayback(d, c.slideId, el.id, { mode: next }, { fluximgManifest: fluximgManifestFor })); }
  catch (error) { pushToast("info", `Movie: ${error instanceof Error ? error.message : String(error)}`); }
}
