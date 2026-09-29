/** Captured poster-only context for static Slides hosts. No inline renderer. */
import { get } from 'svelte/store';
import { project } from '../store';
import { scene3dManifests } from './store';
import { captureAppModelPosterSource, cachedModelPosterUrl, modelPosterUrl } from './posterStore';
import type { Model3dAsset, Model3dElement } from './types';
export function createAppModelPosters(signal: AbortSignal) {
  const source = captureAppModelPosterSource();
  const assets = new Map(get(project).assets.filter((a): a is Model3dAsset => a.kind === 'glb' && !!a.model && !!a.sha256).map(a => [a.id, structuredClone(a)]));
  const manifests = structuredClone(get(scene3dManifests)), requested = new Map<string, { element: Model3dElement; partOpacity?: Record<string, number> }>();
  const context = {
    modelAsset: (id: string) => assets.get(id), modelManifest: (id: string) => manifests[id],
    modelPoster(element: Model3dElement, partOpacity?: Record<string, number>) {
      // Static sampling may visit several states. Only its final placement
      // sample needs a poster, not every intermediate controller endpoint.
      requested.set(element.id, { element, partOpacity });
      const asset = assets.get(element.assetId);
      if (!asset) return undefined;
      const request = { element, asset, manifest: manifests[element.assetId], surface: 'slide' as const };
      // Until settle() renders this step's own still, show the Design-appearance
      // still rather than a placeholder; the host re-renders after settle.
      return cachedModelPosterUrl({ ...request, partOpacity }, { source }) ?? (partOpacity ? cachedModelPosterUrl(request, { source }) : undefined);
    },
  };
  return { context, async settle() {
    const requests = [...requested.values()]; requested.clear();
    await Promise.all(requests.map(({ element, partOpacity }) => {
      const asset = assets.get(element.assetId);
      return asset ? modelPosterUrl({ element, asset, manifest: manifests[element.assetId], surface: 'slide', partOpacity }, { source, signal }) : undefined;
    }));
  } };
}
