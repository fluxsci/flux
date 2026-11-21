/** Hand-off validation over canonical identities. Validate literal parts when
 * a manifest is available; static/embed hosts may only have SVG roots. */
import type { FluxPlotManifest } from "../plot/types";
import type { Scene3dManifest } from "../model3d/types";
import { buildScene3dPartIndex } from '../model3d/parts';
import { buildPartIndex } from "../plot/parse";
import type { Slide, TargetRef, Track } from "./types";
import { resolveTargetLeaves, mergeResolved, type ResolvedTarget } from "./targets";
import { transformPreState } from "./tween";
import { keyGroups, keyPolicyApplies, memberKeys, parseFluximgPartId, type FluximgPartIndex } from "../fluximg/parts";

export function handoffTargetResolver(slide: Slide, manifestFor: (assetId: string) => FluxPlotManifest | undefined, modelManifestFor?: (assetId: string) => Scene3dManifest | undefined,
  imagePartsFor?: (assetId: string) => FluximgPartIndex | undefined) {
  const indexes = new Map<FluxPlotManifest | Scene3dManifest, Set<string>>();
  const resolve = (ref: TargetRef, beat: number): ResolvedTarget[] => {
    // A destination set resolves member by member, each with ITS OWN
    // element's effective manifest at this beat (two plots' parts + a shape).
    // Malformed members (a nested set or group) resolve to nothing, never throw.
    if (ref.members) return mergeResolved(ref.members.filter(m => m?.element && !m.members && !m.group).map(member => resolve(member, beat)));
    const el = transformPreState(slide, ref.element, beat);
    const plot = el?.type === 'plot' ? manifestFor(el.assetId) : undefined;
    const model = el?.type === 'model3d' ? modelManifestFor?.(el.assetId) : undefined;
    // An image's objects resolve through its index alone (fluximgPartTargets only returns objects that exist).
    const image = el?.type === "fluximg" ? imagePartsFor?.(el.assetId) : undefined;
    const manifest = plot ?? model;
    let ids = manifest && indexes.get(manifest);
    if (manifest && !ids) { ids = new Set(Object.keys(model ? buildScene3dPartIndex(model) : buildPartIndex(plot))); indexes.set(manifest, ids); }
    // Resolve ownership against the canonical slide, never the sampled frame
    // whose appearance may currently hide or retype either side of the flight.
    const atBeat = el ? { ...slide, elements: slide.elements.map(item => item.id === el.id ? el : item) } : slide;
    return resolveTargetLeaves(ref, atBeat, () => plot, () => model, () => image).flatMap(target => {
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

/**
 * How a hand-off pairs by key (stage 2, plan D10), from its resolved ends alone (no geometry): an image object answers to
 * its key, a plot part to its series' id and name. `pairs` = matched keys; `auto` = whether "auto" would choose "key"
 * (the planner's own rule over the same members). For the PropertiesPane's count and the pick bar; the flight itself
 * pairs its outlines (correspondence.byKey) by the same law.
 */
export function handoffKeyPairs(slide: Slide, source: readonly ResolvedTarget[], destination: readonly ResolvedTarget[],
  lookups: { plotManifest?: (assetId: string) => FluxPlotManifest | undefined }): { pairs: number; source: number; destination: number; auto: boolean } {
  const members = (targets: readonly ResolvedTarget[]) => targets.flatMap(t => {
    const el = slide.elements.find(e => e.id === t.elementId);
    if (!el || t.partIds === null) return [];
    if (el.type === "fluximg") return t.partIds.map(id => { const p = parseFluximgPartId(id); return { keys: memberKeys({ key: p?.key }) }; });
    if (el.type !== "plot") return [];
    const manifest = lookups.plotManifest?.(el.assetId), index = buildPartIndex(manifest);
    const names = new Map((manifest?.series ?? []).map(s => [s.id, s.name ?? ""]));
    return t.partIds.map(id => { const series = index[id]?.series; return { keys: memberKeys({ series, seriesName: series ? names.get(series) : undefined }) }; });
  });
  const a = members(source), b = members(destination);
  const distinct = (side: { keys: readonly string[] }[]) => new Set(side.map(m => m.keys.join("\u0000")).filter(Boolean)).size;
  return { pairs: keyGroups(a, b).pairs, source: distinct(a), destination: distinct(b), auto: keyPolicyApplies(a, b) };
}
