/** Hand-off validation over canonical identities. Validate literal parts when
 * a manifest is available; static/embed hosts may only have SVG roots. */
import type { FluxPlotManifest } from "../plot/types";
import { buildPartIndex } from "../plot/parse";
import type { Slide, TargetRef, Track } from "./types";
import { resolveTargetLeaves, type ResolvedTarget } from "./targets";
import { transformPreState } from "./tween";

export function handoffTargetResolver(slide: Slide, manifestFor: (assetId: string) => FluxPlotManifest | undefined) {
  const indexes = new Map<FluxPlotManifest, Set<string>>();
  return (ref: TargetRef, beat: number): ResolvedTarget[] => {
    const el = transformPreState(slide, ref.element, beat);
    const manifest = el?.type === "plot" ? manifestFor(el.assetId) : undefined;
    let ids = manifest && indexes.get(manifest);
    if (manifest && !ids) { ids = new Set(Object.keys(buildPartIndex(manifest))); indexes.set(manifest, ids); }
    // Resolve ownership against the canonical slide, never the sampled frame
    // whose appearance may currently hide or retype either side of the flight.
    return resolveTargetLeaves(ref, slide, () => manifest).flatMap(target => {
      if (target.partIds === null) return [target];
      const partIds = ids ? target.partIds.filter(id => ids.has(id)) : target.partIds;
      return partIds.length ? [{ ...target, partIds }] : [];
    });
  };
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
}
