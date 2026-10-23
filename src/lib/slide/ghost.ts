/** Ghost results keep ordinary element identities in the document. Their birth
 * pose is resolved once from the preceding step, never from live player DOM. */
import type { Element } from "../types";
import { elementBBox } from "../geometry";
import type { Slide, Track } from "./types";
import type { AnimationIssue, PartFrame, SlideFrame } from "./compile";
import { hasPartBinding } from "./targets";

// --- the Ghost law: a copy's ink is not doubled while it coincides with its source ------------------------------------------------------
// A Ghost copy is born exactly on top of its source (manim's TransformFromCopy). Two layers of the same anti-aliased glyphs are not one layer:
// an edge pixel of coverage c reads 1 - (1 - c)^2, so a text copy born on its source read BOLDER on its first frame (22.6 stage px² on the
// compositor, the frame it was born) and stayed doubled until it had moved a stroke width. Rendering twice is a rasteriser fact manim never meets
// (it draws one frame at a time and the copy hides under its original). The copy's ink therefore EMERGES with its separation from the source:
// invisible while it coincides, fully drawn once it has left by `ghostEmergeSpan` (a stroke width or so), a soft ramp between: it grows out of the
// original, as it does in manim. A copy that never separates (the same place, a different look) fades in over the start of its flight instead.
/** The distance (stage px) the copy has left its source by: the largest travel of any corner of its box, rotation and resize included. */
export function ghostSeparation(from: Element, to: Element): number {
  const corners = (e: Element) => {
    const bb = elementBBox({ ...e, rotation: 0 }), cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2, a = (e.rotation ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[-bb.w / 2, -bb.h / 2], [bb.w / 2, -bb.h / 2], [bb.w / 2, bb.h / 2], [-bb.w / 2, bb.h / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  };
  const a = corners(from), b = corners(to);
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}
/** Separation over which the copy's ink emerges: a tenth of its box's smaller side, 3 to 12 stage px (about a stroke width of its text). */
export function ghostEmergeSpan(e: Element): number {
  const bb = elementBBox({ ...e, rotation: 0 });
  return Math.max(3, Math.min(12, 0.1 * Math.min(bb.w, bb.h)));
}
/** Share of the copy's own ink drawn at flight progress `u` for its state `el` (0 on the birth frame, 1 once it has left the source). Decided
 *  once per Ghost track from its two ends: by separation when the copy travels at least its emerge span, by progress (the first quarter of the
 *  flight) when it does not. Pure; every seek is a function of (el, u). */
export function ghostEmergence(pre: Element, end: Element): (el: Element, u: number) => number {
  const span = ghostEmergeSpan(pre), travels = ghostSeparation(pre, end) >= span;
  const ramp = (x: number) => { const q = Math.max(0, Math.min(1, x)); return q * q * (3 - 2 * q); };
  return travels ? (el) => ramp(ghostSeparation(pre, el) / span) : (_el, u) => ramp(u / 0.25);
}

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
/** A copied plot/model's asset and source paths name the same accepted bundle. */
export function sourceAt(slide: Slide, sourceId: string, beforeBeat: number, sampled: Element): Element {
  const result = structuredClone(sampled);
  if (result.type !== "plot" && result.type !== "model3d") return result;
  for (let bi = 0; bi < Math.min(beforeBeat, slide.beats.length); bi++) for (const track of slide.beats[bi].tracks) {
    if (track.disabled || track.target !== sourceId || track.preset !== "transform" || !track.to?.assetId) continue;
    const to = track.to;
    const common = {
      ...(typeof to.manifestPath === "string" ? { manifestPath: to.manifestPath } : {}),
      ...(typeof to.recipePath === "string" ? { recipePath: to.recipePath } : {}),
      ...(typeof to.external === "boolean" ? { external: to.external } : {}),
      ...(typeof to.frozen === "boolean" ? { frozen: to.frozen } : {}),
    };
    if (result.type === "model3d" && typeof to.glbPath === "string") result.source = {
      glbPath: to.glbPath, ...common, ...(typeof to.sha256 === "string" ? { sha256: to.sha256 } : {}),
    };
    else if (result.type === "plot" && typeof to.svgPath === "string") result.source = {
      svgPath: to.svgPath,
      ...common,
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
    if (birth.track.preset !== "transform" || hasPartBinding(birth.track) || birth.beat === 0 || resolved.elements.some(e => e.type === "video" && (e.id === birth.source || e.id === birth.target))) {
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
