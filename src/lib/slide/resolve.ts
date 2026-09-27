/** Deck styles and beat-local timing, resolved once before compilation/binding. */
import type { Beat, Deck, Slide, Track } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import { targetPartIds } from "./targets";
import { staggerSpan } from "./stagger";
import { trackDuration } from "./timing";

export type StyleContext = Pick<Deck, "animStyles">;
export type ManifestFor = (target: string) => FluxPlotManifest | undefined;
export interface TimingIssue { trackId?: string; target: string; reason: string }
export const ANIM_STYLE_FIELDS = ["preset", "params", "start", "duration", "easing", "influence", "stagger"] as const;

/** A present own field wins, including null (explicitly suppress inheritance).
 * The returned value is a read view; callers must never mutate its nested data. */
export function resolveTrack(track: Track, deck: StyleContext): Track {
  const style = deck.animStyles?.find(s => s.id === track.styleId);
  const result = { ...style?.track, ...track };
  for (const key of ANIM_STYLE_FIELDS) if (result[key] == null) delete result[key];
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
