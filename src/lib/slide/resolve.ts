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
export function resolveTrack(track: Track, deck: StyleContext): Track {
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

function beatResolver(beat: Beat, deck: StyleContext, manifestFor: ManifestFor) {
  const tracks = beat.tracks.map(t => resolveTrack(t, deck));
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

export function resolveStart(track: Track, beat: Beat, deck: StyleContext, manifestFor: ManifestFor = () => undefined): { start: number; issue?: string } {
  const index = beat.tracks.findIndex(t => t === track || track.id != null && t.id === track.id);
  // Accept an edited candidate without requiring the caller to mutate the beat.
  const tracks = [...beat.tracks];
  if (index < 0) tracks.push(track); else tracks[index] = track;
  return beatResolver({ ...beat, tracks }, deck, manifestFor).visit(index < 0 ? tracks.length - 1 : index);
}

/** Lane order is preserved; DFS memoization resolves chains in one pass. */
export function resolveBeat(beat: Beat, deck: StyleContext, manifestFor: ManifestFor = () => undefined): { tracks: Track[]; issues: TimingIssue[] } {
  const { tracks, visit } = beatResolver(beat, deck, manifestFor);
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
