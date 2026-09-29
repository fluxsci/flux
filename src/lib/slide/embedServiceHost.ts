/** Lazy Paper-only adapter: immutable project files enter the document worker.
 * This module never imports Three or parses GLB geometry on the main thread. */
import { createServiceHost, type ServiceHostBackend } from '../model3d/serviceHost';
import { retainSourceModel, releaseModelSource } from '../model3d/sourceRegistry';
import { fileBridge } from '../project/types';
import type { Model3dHost } from '../model3d/host';
import type { SlideSnapshot } from './embedRepository';

export function createEmbedServiceHost(snapshot: SlideSnapshot): Model3dHost | undefined {
  const captured = snapshot.modelSource;
  if (!captured) return undefined;
  let disposed = false;
  const source = { root: captured.root, prefix: '', bridge: fileBridge() ?? null, scope: captured.scope,
    // Repeated occurrences share the repository's immutable byte lifetime.
    // Closing the first widget must not abort another widget's shared load.
    isCurrent: captured.isCurrent };
  const assets = new Map(captured.assets.map(asset => [asset.id, asset]));
  const holds = new Map<string, ReturnType<typeof retainSourceModel>>();
  const required = (id: string) => {
    const hold = holds.get(id);
    if (!hold) throw new Error(`3D model "${id}" is not ready in this Paper widget`);
    return hold.ready;
  };
  const backend: ServiceHostBackend = {
    async retain(asset) {
      const id = typeof asset === 'string' ? asset : asset.id, metadata = assets.get(id);
      if (!metadata) throw new Error(`Missing Paper model metadata: ${id}`);
      const hold = retainSourceModel(metadata, source); holds.set(id, hold);
      await hold.ready;
      return { ...metadata.model, bytes: metadata.bytes, parseMs: 0 };
    },
    release(id) { holds.get(id)?.release(); holds.delete(id); },
    async renderBitmap(spec, options) {
      const loaded = await required(spec.assetId);
      const morph = spec.morph ? { ...spec.morph, to: (await required(spec.morph.to)).assetId } : undefined;
      const crossfade = spec.crossfade ? { ...spec.crossfade, to: (await required(spec.crossfade.to)).assetId } : undefined;
      if (disposed || !source.isCurrent()) throw new DOMException('Paper widget closed or changed', 'AbortError');
      return loaded.service.renderBitmap({ ...spec, assetId: loaded.assetId,
        ...(morph ? { morph } : {}), ...(crossfade ? { crossfade } : {}) }, options);
    },
  };
  const host = createServiceHost(backend, id => snapshot.payload.modelManifests?.[id]);
  return { ...host, dispose() { if (disposed) return; disposed = true; host.dispose(); releaseModelSource(source); } };
}
