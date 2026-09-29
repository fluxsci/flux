/** Captured poster-only context for static Slides hosts. No inline renderer. */
import { get } from 'svelte/store';
import { project } from '../store';
import { scene3dManifests } from './store';
import { captureAppModelPosterSource, cachedModelPosterUrl, modelPosterUrl } from './posterStore';
import type { Model3dAsset, Model3dElement } from './types';
export function createAppModelPosters(signal: AbortSignal) {
  const source = captureAppModelPosterSource();
  const assets = new Map(get(project).assets.filter((a): a is Model3dAsset => a.kind === 'glb' && !!a.model && !!a.sha256).map(a => [a.id, structuredClone(a)]));
  const manifests = structuredClone(get(scene3dManifests)), requested = new Map<string, Model3dElement>();
  const context = {
    modelAsset: (id: string) => assets.get(id), modelManifest: (id: string) => manifests[id],
    modelPoster(element: Model3dElement) {
      // Static sampling may visit several states. Only its final placement
      // sample needs a poster, not every intermediate controller endpoint.
      requested.set(element.id, element);
      const asset = assets.get(element.assetId);
      return asset ? cachedModelPosterUrl({ element, asset, manifest: manifests[element.assetId], surface: 'slide' }, { source }) : undefined;
    },
  };
  return { context, async settle() {
    const requests = [...requested.values()]; requested.clear();
    await Promise.all(requests.map(element => {
      const asset = assets.get(element.assetId);
      return asset ? modelPosterUrl({ element, asset, manifest: manifests[element.assetId], surface: 'slide' }, { source, signal }) : undefined;
    }));
  } };
}
