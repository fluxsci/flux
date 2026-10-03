/** Hand-off validation over canonical identities. Validate literal parts when
 * a manifest is available; static/embed hosts may only have SVG roots. */
import type { FluxPlotManifest } from "../plot/types";
import type { Scene3dManifest } from "../model3d/types";
import { buildScene3dPartIndex } from '../model3d/parts';
import { buildPartIndex } from "../plot/parse";
import type { Slide, TargetRef, Track } from "./types";
import { resolveTargetLeaves, mergeResolved, type ResolvedTarget } from "./targets";
import { transformPreState } from "./tween";

export function handoffTargetResolver(slide: Slide, manifestFor: (assetId: string) => FluxPlotManifest | undefined, modelManifestFor?: (assetId: string) => Scene3dManifest | undefined) {
  const indexes = new Map<FluxPlotManifest | Scene3dManifest, Set<string>>();
  const resolve = (ref: TargetRef, beat: number): ResolvedTarget[] => {
    // A destination set resolves member by member, each with ITS OWN
    // element's effective manifest at this beat (two plots' parts + a shape).
    // Malformed members (a nested set or group) resolve to nothing, never throw.
    if (ref.members) return mergeResolved(ref.members.filter(m => m?.element && !m.members && !m.group).map(member => resolve(member, beat)));
    const el = transformPreState(slide, ref.element, beat);
    const plot = el?.type === 'plot' ? manifestFor(el.assetId) : undefined;
    const model = el?.type === 'model3d' ? modelManifestFor?.(el.assetId) : undefined;
    const manifest = plot ?? model;
    let ids = manifest && indexes.get(manifest);
    if (manifest && !ids) { ids = new Set(Object.keys(model ? buildScene3dPartIndex(model) : buildPartIndex(plot))); indexes.set(manifest, ids); }
    // Resolve ownership against the canonical slide, never the sampled frame
    // whose appearance may currently hide or retype either side of the flight.
    const atBeat = el ? { ...slide, elements: slide.elements.map(item => item.id === el.id ? el : item) } : slide;
    return resolveTargetLeaves(ref, atBeat, () => plot, () => model).flatMap(target => {
      if (target.partIds === null) return [target];
      const partIds = ids ? target.partIds.filter(id => ids.has(id)) : target.partIds;
      return partIds.length ? [{ ...target, partIds }] : [];
    });
  };
  return resolve;
}

/** A whole-element landing includes all of that element's part leaves. */
export function handoffTargetsOverlap(a: readonly ResolvedTarget[], b: readonly ResolvedTarget[]): boolean {
  return a.some(x => b.some(y => x.elementId === y.elementId &&
    (x.partIds === null || y.partIds === null || x.partIds.some(id => y.partIds!.includes(id)))));
}

/** Copies and ephemeral embed namespaces remap the same destination identity. */
export function remapBecomeTarget(track: Track, elements: ReadonlyMap<string, string>, groups?: ReadonlyMap<string, string>): void {
  const ref = track.to?.become?.ref;
  if (!ref) return;
  ref.element = elements.get(ref.element) ?? ref.element;
  if (ref.group) ref.group = groups?.get(ref.group) ?? ref.group;
  // A set remaps every member's element (and nothing else).
  for (const member of ref.members ?? []) member.element = elements.get(member.element) ?? member.element;
}
