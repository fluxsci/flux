/** Browser export preparation. Inputs are captured by the caller before awaiting. */
import type { Asset, Figure } from '../types';
import type { Scene3dManifest } from './types';
import type { PosterSurface } from './poster';
import { collectModelPosters, model3dSvgContext } from './static';
import { checkModelFile, awaitModelSource } from './sourceRegistry';
import { modelPosterUrl, type ModelPosterSource } from './posterStore';

export async function ensureModelPosters(figures: readonly Figure[], assets: readonly Asset[], manifests: Record<string, Scene3dManifest>, surface: PosterSurface,
  source: ModelPosterSource, options: { signal?: AbortSignal; namespace?: string } = {}) {
  const context = model3dSvgContext(assets, manifests, surface, options.namespace);
  const requests = collectModelPosters(figures, context, surface), urls: Record<string, string> = {}, warnings: string[] = [];
  for (const request of new Map(requests.map(request => [request.asset.path, request])).values()) {
    options.signal?.throwIfAborted();
    try { await awaitModelSource(checkModelFile(source, request.asset), options.signal); }
    catch (error) {
      options.signal?.throwIfAborted();
      throw new Error(`Cannot export 3D model "${request.element.name || request.asset.name || request.element.id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Sequential worker queue; duplicate placements share one content-addressed job.
  for (const request of requests) {
    options.signal?.throwIfAborted();
    if (urls[request.ref]) continue;
    try {
      urls[request.ref] = await modelPosterUrl({ ...request, surface }, { source, signal: options.signal, onWarning: warning => warnings.push(warning) });
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error(`Cannot export 3D model "${request.element.name || request.asset.name || request.element.id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { context, urls, warnings };
}
