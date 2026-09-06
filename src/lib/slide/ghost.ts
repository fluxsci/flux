/** Ghost results keep ordinary element identities in the document. Their birth
 * pose is resolved once from the preceding step, never from live player DOM. */
import type { Element } from "../types";
import type { Slide, Track } from "./types";
import type { AnimationIssue, PartFrame, SlideFrame } from "./compile";

export interface GhostBirth { target: string; source: string; beat: number; start: number; enabled: boolean; track: Track }
export function ghostTargetIds(slide: Slide): string[] {
  return [...new Set(slide.beats.flatMap(b => b.tracks.filter(t => t.ghostFrom != null).map(t => t.target)))];
}
export function ghostBirths(slide: Slide): GhostBirth[] {
  return slide.beats.flatMap((b, beat) => b.tracks.filter(t => t.ghostFrom != null).map(track => ({ target: track.target, source: track.ghostFrom!, beat, start: Math.max(0, track.start ?? 0), enabled: !track.disabled && track.preset === "transform", track })));
}
const structural = ["id", "name", "groupId", "locked", "hidden", "lockAspect", "styleId", "panelLabel"] as const;
export function withGhostIdentity(source: Element, result: Element): Element {
  const copy = structuredClone(source) as unknown as Record<string, unknown>;
  const own = result as unknown as Record<string, unknown>;
  for (const key of structural) {
    if (key in own) copy[key] = structuredClone(own[key]);
    else delete copy[key];
  }
  return copy as unknown as Element;
}
/** A copied plot's asset and source paths must name the same accepted bundle. */
export function sourceAt(slide: Slide, sourceId: string, beforeBeat: number, sampled: Element): Element {
  const result = structuredClone(sampled);
  if (result.type !== "plot") return result;
  for (let bi = 0; bi < Math.min(beforeBeat, slide.beats.length); bi++) for (const track of slide.beats[bi].tracks) {
    if (track.disabled || track.target !== sourceId || !["transform", "morph"].includes(track.preset ?? "") || !track.to?.assetId) continue;
    const to = track.to;
    if (typeof to.svgPath === "string") result.source = {
      svgPath: to.svgPath,
      ...(typeof to.manifestPath === "string" ? { manifestPath: to.manifestPath } : {}),
      ...(typeof to.recipePath === "string" ? { recipePath: to.recipePath } : {}),
      ...(typeof to.external === "boolean" ? { external: to.external } : {}),
      ...(typeof to.frozen === "boolean" ? { frozen: to.frozen } : {}),
    };
    else delete result.source;
  }
  return result;
}
export function copyFrameSource(slide: Slide, frame: SlideFrame, sourceId: string, birthBeat: number): Element | null {
  if (frame.presentation.unbornElementIds?.includes(sourceId)) return null;
  const el = frame.elements.find(e => e.id === sourceId);
  if (!el) return null;
  const result = sourceAt(slide, sourceId, birthBeat, el);
  const appearance = frame.presentation.elementStates[sourceId];
  if (appearance) result.opacity = (result.opacity ?? 1) * appearance.opacity;
  return result;
}
export interface ResolvedGhosts {
  slide: Slide;
  births: GhostBirth[];
  issues: AnimationIssue[];
  partFactors: Record<string, Record<string, PartFrame>>;
}
export function resolveGhosts(slide: Slide, sample: (resolved: Slide, beat: number, partFactors: ResolvedGhosts["partFactors"]) => SlideFrame): ResolvedGhosts {
  const births = ghostBirths(slide), issues: AnimationIssue[] = [], partFactors: ResolvedGhosts["partFactors"] = {};
  if (!births.length) return { slide, births, issues, partFactors };
  const resolved = structuredClone(slide);
  const owners = new Map<string, GhostBirth>();
  for (const birth of births) {
    if (owners.has(birth.target)) { birth.enabled = false; owners.get(birth.target)!.enabled = false; issues.push({ trackId: birth.track.id, target: birth.target, reason: "This ghost result has more than one birth. Keep one Ghost transform." }); }
    else owners.set(birth.target, birth);
    if (birth.track.preset !== "transform" || birth.track.part || birth.track.selector || birth.beat === 0) {
      birth.enabled = false;
      issues.push({ trackId: birth.track.id, target: birth.target, reason: "Ghost births require a whole-object Change after Design." });
    }
  }
  for (const [bi, beat] of resolved.beats.entries()) for (const track of beat.tracks) {
    const birth = owners.get(track.target);
    if (birth && bi < birth.beat && !track.disabled) {
      track.disabled = true;
      issues.push({ trackId: track.id, target: track.target, reason: "This effect precedes its ghost's birth and cannot run. Move it after the Ghost transform." });
    }
  }
  for (const bi of [...new Set(births.map(b => b.beat))].sort((a, b) => a - b)) {
    const frame = sample(resolved, bi - 1, partFactors);
    frame.presentation.unbornElementIds = births.filter(b => !b.enabled || b.beat >= bi).map(b => b.target);
    for (const birth of births.filter(b => b.beat === bi && b.enabled)) {
      const index = resolved.elements.findIndex(e => e.id === birth.target);
      if (index < 0) continue;
      const sourceBirth = owners.get(birth.source);
      const unavailable = birth.source === birth.target || sourceBirth && (!sourceBirth.enabled || sourceBirth.beat >= bi);
      const source = unavailable ? null : copyFrameSource(resolved, frame, birth.source, bi);
      if (!source) {
        issues.push({ trackId: birth.track.id, target: birth.target, reason: "Ghost source is missing or not yet born. Using the saved copy as its starting state." });
        continue;
      }
      resolved.elements[index] = withGhostIdentity(source, resolved.elements[index]);
      if (frame.partStates[birth.source]) partFactors[birth.target] = structuredClone(frame.partStates[birth.source]);
    }
  }
  return { slide: resolved, births, issues, partFactors };
}
