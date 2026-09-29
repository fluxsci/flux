/** Lazy in-app presentation host over an immutable capture of the editor's
 * resolved assets. Paper uses its separate captured service host instead. */
import { get } from 'svelte/store';
import { project } from '../store';
import type { Deck } from '../slide/types';
import { scene3dManifests } from './store';
import { captureAppModelPosterSource, cachedModelPosterUrl } from './posterStore';
import { checkModelFile, checkModelSource } from './sourceRegistry';
import { sha256ModelBytes } from './importData';
import { GLB_LIMITS } from './glbCore.mjs';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';
import type { Model3dHost } from './host';

export interface AppInlineModels {
  model3d: Model3dHost;
  modelAsset: (id: string) => Model3dAsset | undefined;
  modelManifest: (id: string) => Scene3dManifest | undefined;
  modelPoster: (element: Model3dElement) => string | undefined;
  dispose(): void;
}
export function createAppInlineModels(deck: Deck): AppInlineModels | undefined {
  const requested = new Set<string>();
  for (const slide of deck.slides) {
    for (const element of slide.elements) if (element.type === 'model3d') requested.add(element.assetId);
    for (const beat of slide.beats) for (const track of beat.tracks) if (track.to?.assetId) requested.add(track.to.assetId);
  }
  const assets = new Map(get(project).assets.filter((asset): asset is Model3dAsset => requested.has(asset.id) && asset.kind === 'glb' && !!asset.model && !!asset.sha256).map(asset => [asset.id, structuredClone(asset)]));
  if (!assets.size) return undefined;
  const source = captureAppModelPosterSource(); checkModelSource(source);
  const manifests: Record<string, Scene3dManifest> = structuredClone(get(scene3dManifests));
  let disposed = false;
  const current = () => { checkModelSource(source); if (disposed) throw new DOMException('3D presentation closed', 'AbortError'); };
  let actual: Model3dHost | undefined;
  let loading: Promise<Model3dHost> | undefined;
  const load = () => loading ??= (async () => {
    current(); const policy = await source.bridge?.model3dAvailability?.(); current();
    if (policy?.disabled) throw new Error('3D preview needs WebGL');
    const { createInlineHost } = await import('./inlineHost'); current(); return actual = createInlineHost({ sourceKey: `${source.scope}\0${JSON.stringify([...assets.values()].map(asset => [asset.id, asset.sha256]))}`,
    manifest: id => manifests[id], modelBytes: async id => {
      current(); const asset = assets.get(id); if (!asset) throw new Error(`3D model metadata missing: ${id}`);
      const path = await checkModelFile(source, asset), bytes = await source.bridge!.readFile(path); current();
      if (bytes.byteLength > GLB_LIMITS.maxBytes) throw new Error(`3D model ${asset.name || id} exceeds the model byte limit`);
      if (await sha256ModelBytes(bytes) !== asset.sha256) throw new Error(`3D model ${asset.name || id} changed since this presentation was captured`);
      current(); return bytes;
    } }); })();
  const host: Model3dHost = {
    async ready(ids, warm) { await (await load()).ready(ids, warm); current(); },
    view(canvas) { current(); if (!actual) throw new Error('3D presentation is still loading'); return actual.view(canvas); },
    flightView(canvas) { current(); if (!actual) throw new Error('3D presentation is still loading'); return actual.flightView?.(canvas) ?? actual.view(canvas); },
    async modelStats(id) { return (await load()).modelStats?.(id); },
    async snapshot(spec) { const renderer = await load(); if (!renderer.snapshot) throw new Error('3D snapshots unavailable'); return renderer.snapshot(spec); },
    dispose() { if (!disposed) { disposed = true; actual?.dispose(); } },
  };
  return { model3d: host, modelAsset: id => assets.get(id), modelManifest: id => manifests[id], modelPoster: element => { const asset = assets.get(element.assetId); return asset ? cachedModelPosterUrl({ element, asset, manifest: manifests[element.assetId], surface: 'slide' }, { source }) : undefined; }, dispose() { host.dispose(); } };
}
