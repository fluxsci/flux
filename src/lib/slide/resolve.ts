/** Deck styles and beat-local timing, resolved before compilation/binding.
 *
 * A linked track (`styleId`) inherits every style field it does not carry
 * itself, EXCEPT `preset`. The preset defines the track's family, and
 * `familyOf(track)` (the family law, `tracksMatch`, ghost births, the media
 * checks) reads the RAW track, so a track never gives its preset up to a style.
 * `preset` is the one style field that propagates by WRITE rather than by
 * resolution: `linkTrackStyle` writes a same-family style's preset onto the
 * track once (a different family is refused), and `setAnimStyle(…, {track:
 * {preset}})` writes the new preset onto every linked track. */
import type { Beat, Deck, Slide, Track } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import type { Scene3dManifest } from "../model3d/types";
import { targetPartIds } from "./targets";
import { staggerSpan } from "./stagger";
import { trackDuration } from "./timing";

export type StyleContext = Pick<Deck, "animStyles">;
export type ManifestFor = (target: string) => FluxPlotManifest | Scene3dManifest | undefined;
export interface TimingIssue { trackId?: string; target: string; reason: string }
/** Every field an `AnimStyle.track` carries (materialize/detach copies all of them). */
export const ANIM_STYLE_FIELDS = ["preset", "params", "start", "duration", "easing", "influence", "curve", "stagger", "arc"] as const;
/** The style fields a linked track inherits by resolution: all but `preset` (see the header). */
export const INHERITED_STYLE_FIELDS = ANIM_STYLE_FIELDS.filter(f => f !== "preset");

/** Style fields under the track's own: a field PRESENT on the track wins, an
 * absent one inherits (`preset` never does; see the header). Present means a
 * value: `undefined` and `null` are absent (JSON drops `undefined` and the deck
 * schema refuses `null`, so memory and disk agree; there is no explicit-null
 * override). "None though the style
 * has one" is written with the sentinels the Animator already writes, which
 * are ordinary present values: `stagger: { perMs: 0 }` (no stagger),
 * `influence: { in: 0, out: 0 }` (no velocity profile; the easing token
 * falls back to the preset default) and `params: {}` (no params).
 * Easing, influence and curve form one group: any own value overrides the
 * entire style group, so a token can replace a style's spring.
 * The returned value is a read view; callers must never mutate its nested data. */
export function resolveTrackRaw(track: Track, deck: StyleContext): Track {
  const style = track.styleId == null ? undefined : deck.animStyles?.find(s => s.id === track.styleId);
  const result: Track = { ...track }, fields = result as unknown as Record<string, unknown>;
  if (result.preset == null) delete result.preset;
  const ownCurve = track.curve != null || track.influence != null || track.easing != null;
  for (const key of INHERITED_STYLE_FIELDS) {
    if (fields[key] != null) continue;
    const inherited = ownCurve && (key === "curve" || key === "influence" || key === "easing") ? undefined : style?.track[key];
    if (inherited == null) delete fields[key];
    else fields[key] = inherited;
  }
  return result;
}

/** A draw-on of an axis's tick marks (`axis.x.ticks`, `axis.y.ticks`). */
const AXIS_TICKS = /^axis\.([xy])\.ticks$/;
/** Share of the authored duration each tick's own draw takes when the ticks follow the pen. */
export const TICK_WINDOW_SHARE = 0.4;

/** X13, the one shared normaliser for ticks that would otherwise outrun the pen. Since the draw reaches its end exactly
 *  (WP 1.4), an axis whose ticks are ONE drawOn track with no stagger grows every tick at once, up to 450 px ahead of
 *  the spine tip. Such a track is read as a spatial stagger along its axis with the SAME cue length:
 *  `duration' = round(0.4 d)`, `stagger = { totalMs: d - duration', by: axis, from: "start" }`. `from` is "start" on BOTH
 *  axes, deliberately NOT the ruling's y -> "end": fluxplot's tick nodes carry no `data-x`/`data-y`, so `staggerRanks`
 *  falls back to DOM order, which already runs left to right and bottom to top (the y spine's pen direction); "end"
 *  would run the y ticks top to bottom, against the pen (measured in the real player, verify-slide-draw-browser).
 *  `stagger: { perMs: 0 }` opts out. Applies to a style-RESOLVED track; returns the fields to overlay, or null. */
export function tickCompensation(track: Track): Pick<Track, "duration" | "stagger"> | null {
  if (track.preset !== "drawOn" || track.stagger != null || !track.part) return null;
  const axis = AXIS_TICKS.exec(track.part)?.[1] as "x" | "y" | undefined;
  if (!axis) return null;
  const d = trackDuration(track), own = Math.round(TICK_WINDOW_SHARE * d);
  if (!(d > 0) || own < 1) return null;
  return { duration: own, stagger: { totalMs: d - own, by: axis, from: "start" } };
}

/** The track as PLAYBACK, the timeline and the Animator's display read it: styles resolved, then X13's tick compensation.
 *  A READ view: it must never be spread back into storage. Code that reads a track in order to WRITE one (detaching or
 *  deriving a style, cascades, copy/paste of timing) uses `resolveTrackRaw`, so a resolved stagger never leaks into the
 *  deck: the stored track is never rewritten. */
export function resolveTrack(track: Track, deck: StyleContext): Track {
  const result = resolveTrackRaw(track, deck);
  const compensation = tickCompensation(result);
  return compensation ? { ...result, ...compensation } : result;
}

/** `view` (default): tracks as playback and the timeline read them (X13's tick compensation applied). `raw`: the stored
 *  fields with styles resolved and nothing else, for code that plans WRITES from a resolved beat (align, drag). A
 *  compensated track keeps its cue footprint, so anchors and starts resolve identically in both modes (one-target tick
 *  groups excepted: a single tick has no spread to carry the compensation's tail). */
export type ResolveMode = "view" | "raw";

function beatResolver(beat: Beat, deck: StyleContext, manifestFor: ManifestFor, mode: ResolveMode = "view") {
  const tracks = beat.tracks.map(t => mode === "raw" ? resolveTrackRaw(t, deck) : resolveTrack(t, deck));
  const byId = new Map(tracks.flatMap((t, i) => t.id ? [[t.id, i] as const] : []));
  const done = new Map<number, { start: number; issue?: string }>();
  const stack = new Set<number>();
  const visit = (index: number): { start: number; issue?: string } => {
    const saved = done.get(index);
    if (saved) return saved;
    const track = tracks[index], start = track.start ?? 0, anchor = track.anchor;
    if (!anchor) { const result = { start }; done.set(index, result); return result; }
    if (stack.has(index)) return { start, issue: "Timing anchor cycle. Using the literal start." };
    const parent = byId.get(anchor.trackId);
    if (parent === undefined) {
      const result = { start, issue: "Timing anchor is missing from this step. Anchors must name a track in the same beat; using the literal start." };
      done.set(index, result); return result;
    }
    stack.add(index);
    const edge = visit(parent);
    stack.delete(index);
    const target = tracks[parent];
    const result = edge.issue ? { start, issue: edge.issue } : {
      start: edge.start + (anchor.edge === "end" ? trackDuration(target) + staggerSpan(target, targetPartIds(target, manifestFor(target.target)).length) : 0) + (anchor.offsetMs ?? 0),
    };
    done.set(index, result);
    return result;
  };
  return { tracks, visit };
}

export function resolveStart(track: Track, beat: Beat, deck: StyleContext, manifestFor: ManifestFor = () => undefined, mode: ResolveMode = "view"): { start: number; issue?: string } {
  const index = beat.tracks.findIndex(t => t === track || track.id != null && t.id === track.id);
  // Accept an edited candidate without requiring the caller to mutate the beat.
  const tracks = [...beat.tracks];
  if (index < 0) tracks.push(track); else tracks[index] = track;
  return beatResolver({ ...beat, tracks }, deck, manifestFor, mode).visit(index < 0 ? tracks.length - 1 : index);
}

/** Lane order is preserved; DFS memoization resolves chains in one pass. */
export function resolveBeat(beat: Beat, deck: StyleContext, manifestFor: ManifestFor = () => undefined, mode: ResolveMode = "view"): { tracks: Track[]; issues: TimingIssue[] } {
  const { tracks, visit } = beatResolver(beat, deck, manifestFor, mode);
  const issues: TimingIssue[] = [];
  const starts = tracks.map((track, i) => {
    const result = visit(i);
    if (result.issue) issues.push({ trackId: track.id, target: track.target, reason: result.issue });
    return result.start;
  });
  return { tracks: tracks.map((track, i) => track.anchor ? { ...track, start: starts[i] } : track), issues };
}

/** Styles referenced by a portable slide, never the rest of its source deck. */
export function slideAnimStyles(slide: Slide, deck: StyleContext): NonNullable<Deck["animStyles"]> {
  const ids = new Set(slide.beats.flatMap(b => b.tracks.map(t => t.styleId)));
  return structuredClone((deck.animStyles ?? []).filter(s => ids.has(s.id)));
}
