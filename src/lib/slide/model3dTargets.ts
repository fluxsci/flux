/** Scene3d targets use the same effective hierarchy as X-ray and rendering.
 * Build once per resolution; selectors never invent datum indices absent from
 * the scene3d contract. No renderer, DOM or validation bundle dependency. */
import { buildScene3dPartIndex, scene3dTargetResolver } from '../model3d/parts';
import type { Scene3dManifest } from '../model3d/types';
import type { Track } from './types';

export function modelPartTargets(manifest: Scene3dManifest) {
  const index = buildScene3dPartIndex(manifest), targets = scene3dTargetResolver(index);
  const leaves = (id: string): string[] => Object.hasOwn(index, id) ? targets(id) : [];
  function resolve(binding: Pick<Track, 'part' | 'parts' | 'selector'>): string[] {
    const out = new Set<string>();
    for (const id of [binding.part, ...(binding.parts ?? [])]) if (id) for (const leaf of leaves(id)) out.add(leaf);
    const sel = binding.selector;
    if (sel && (sel.role != null || sel.series != null || sel.index != null) && sel.index == null) {
      for (const part of Object.values(index)) {
        if ((sel.role && part.role !== sel.role) || (sel.series && part.series !== sel.series)) continue;
        for (const leaf of leaves(part.id)) out.add(leaf);
      }
    }
    for (const id of sel?.except ?? []) for (const leaf of leaves(id)) out.delete(leaf);
    return [...out];
  }
  return { index, leaves, resolve };
}
