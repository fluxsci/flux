/** One document renderer, with independent immutable byte-source owners. */
import { joinPath, type FileBridge } from '../project/types';
import { storedAssetPath } from '../project/assetPath';
import type { Model3dAsset } from './types';
import type { Model3dService } from './service';

export interface ModelPosterSource {
  readonly root: string;
  readonly prefix: string;
  readonly bridge: FileBridge | null;
  readonly scope: string;
  readonly isCurrent: () => boolean;
}
const abort = () => new DOMException('3D project changed or view closed', 'AbortError');
export function checkModelSource(source: ModelPosterSource) { if (!source.isCurrent()) throw abort(); }
/** Cancellation settles a caller even when a native read cannot itself be interrupted. */
export function awaitModelSource<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? abort());
    if (signal.aborted) { void promise.catch(() => {}); cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
export async function modelSourcePath(source: ModelPosterSource, asset: Model3dAsset): Promise<string> {
  checkModelSource(source);
  if (!source.root || !source.bridge) throw new Error('3D model file missing');
  const rel = storedAssetPath(`${source.prefix.replace(/\/$/, '')}${source.prefix ? '/' : ''}${asset.path}`);
  const path = source.bridge.projectAssetPath ? await source.bridge.projectAssetPath(source.root, rel) : joinPath(source.root, rel);
  checkModelSource(source);
  return path;
}
export async function checkModelFile(source: ModelPosterSource, asset: Model3dAsset) {
  const path = await modelSourcePath(source, asset);
  if (!await source.bridge!.exists(path)) throw new Error(`3D model file missing: ${asset.name || asset.id}`);
  checkModelSource(source);
  return path;
}

interface SourceEntry { source: ModelPosterSource; asset: Model3dAsset; refs: number }
interface Hold { source: ModelPosterSource; release: () => void }
const providers = new Map<string, SourceEntry>(), holds = new Set<Hold>();
let renderer: Model3dService | undefined, loading: Promise<Model3dService> | undefined;
let epoch = 0;
export async function sourceModel3dService(source: ModelPosterSource) {
  checkModelSource(source);
  const policy = await source.bridge?.model3dAvailability?.();
  checkModelSource(source);
  if (policy?.disabled) throw new Error('3D preview needs WebGL');
  const generation = epoch;
  loading ??= (async () => {
    const { getModel3dService } = await import('./service');
    if (generation !== epoch) throw abort();
    const service = getModel3dService({ sourceKey: `model3d-document-registry:${generation}`, modelBytes: async id => {
      const entry = providers.get(id);
      if (!entry) throw abort();
      const { source, asset } = entry, path = await checkModelFile(source, asset);
      const bytes = await source.bridge!.readFile(path); checkModelSource(source);
      if (bytes.byteLength > 200 * 1024 * 1024) throw new Error(`3D model "${asset.name || asset.id}" exceeds the model byte limit`);
      const hash = await crypto.subtle.digest('SHA-256', bytes.slice(0)); checkModelSource(source);
      const sha = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (sha !== asset.sha256) throw new Error(`3D model "${asset.name || asset.id}" changed since this view was captured`);
      return bytes;
    } });
    renderer = service;
    const available = await service.available();
    if (generation !== epoch) throw abort();
    if (!available.ok) throw new Error(`3D preview needs WebGL${available.reason ? `: ${available.reason}` : ''}`);
    return service;
  })();
  const result = await loading; checkModelSource(source); return result;
}
export function retainSourceModel(asset: Model3dAsset, source: ModelPosterSource) {
  checkModelSource(source);
  const id = `model:${JSON.stringify([source.scope, source.root, source.prefix, asset.path, asset.sha256])}`;
  let released = false, retained: Model3dService | undefined;
  const entry = providers.get(id) ?? { source, asset: structuredClone(asset), refs: 0 };
  entry.refs++; providers.set(id, entry);
  const hold: Hold = { source, release };
  holds.add(hold);
  function release() {
    if (released) return; released = true; holds.delete(hold); retained?.release(id);
    if (--entry.refs === 0 && providers.get(id) === entry) providers.delete(id);
  }
  const ready = sourceModel3dService(source).then(async service => {
    checkModelSource(source); if (released) throw abort();
    retained = service;
    await service.retain(id); checkModelSource(source);
    if (released) throw abort();
    return { service, assetId: id, owner: source };
  });
  return { ready, release };
}
/** Gallery byte-backed retains also participate in document ownership. */
export async function ownedModel3dService(source: ModelPosterSource): Promise<Model3dService> {
  const service = await sourceModel3dService(source);
  const owned = new Map<string, Hold[]>();
  return { ...service,
    retain(asset) {
      checkModelSource(source);
      const id = typeof asset === 'string' ? asset : asset.id;
      let released = false;
      const hold: Hold = { source, release() {
        if (released) return; released = true; holds.delete(hold); service.release(id);
        const list = owned.get(id); if (list) { const at = list.indexOf(hold); if (at >= 0) list.splice(at, 1); if (!list.length) owned.delete(id); }
      } };
      holds.add(hold); const list = owned.get(id) ?? []; list.push(hold); owned.set(id, list);
      return service.retain(asset);
    },
    release(id) { owned.get(id)?.[0]?.release(); },
    dispose() { for (const list of [...owned.values()]) for (const hold of [...list]) hold.release(); },
  };
}
/** Retiring an editor owner never tears down a still-owned Paper/export render. */
export function releaseModelSource(source: ModelPosterSource) {
  for (const hold of [...holds]) if (hold.source === source || !hold.source.isCurrent()) hold.release();
  if (!holds.size) disposeModelSourceRegistry();
}
export function disposeModelSourceRegistry() {
  for (const hold of [...holds]) hold.release();
  epoch++; renderer?.dispose(); renderer = undefined; loading = undefined; providers.clear();
}
export const modelSourceRegistryStats = () => renderer?.stats();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', disposeModelSourceRegistry);
