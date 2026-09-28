/** App-owned poster IO. Mesh bytes remain outside assetData and save journals. */
import { get } from 'svelte/store';
import { project, embeddedProjectRoot, projectDir } from '../store';
import { fileBridge, joinPath } from '../project/types';
import { storedAssetPath } from '../project/assetPath';
import { bytesToDataUrl } from '../assets';
import { scene3dGeneration, scene3dManifests } from './store';
import { furnitureLayout } from './furnitureLayout';
import { posterKey, posterPath, posterPixels, type PosterSurface } from './poster';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';
import type { Model3dService } from './service';

interface Context {
  scope: string; root: string; prefix: string; dead: boolean;
  sources: Map<string, Model3dAsset>; service?: Model3dService;
  pending?: Promise<Model3dService>; controller: AbortController;
}
export interface PosterRequest { element: Model3dElement; asset: Model3dAsset; manifest?: Scene3dManifest; surface?: PosterSurface }
const cache = new Map<string, string>();
interface PosterWaiter { preview?: (url: string) => void }
interface PosterJob { promise: Promise<string>; cancel: AbortController; waiters: Set<PosterWaiter> }
const pending = new Map<string, PosterJob>();
function joinJob(job: PosterJob, signal?: AbortSignal, preview?: (url: string) => void): Promise<string> {
  if (signal?.aborted) return Promise.reject(abort());
  return new Promise((resolve, reject) => {
    const waiter = { preview }; job.waiters.add(waiter);
    const finish = () => { signal?.removeEventListener('abort', cancel); job.waiters.delete(waiter); };
    const cancel = () => { finish(); if (!job.waiters.size) job.cancel.abort(); reject(abort()); };
    signal?.addEventListener('abort', cancel, { once: true });
    job.promise.then(value => { finish(); if (signal?.aborted) reject(abort()); else resolve(value); }, error => { finish(); reject(error); });
  });
}
function waitForJob<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abort());
    if (signal.aborted) return cancel();
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
let context: Context | undefined;
export function model3dAppScope() { return scope(); }
function scope() { return `${get(embeddedProjectRoot) ?? get(projectDir) ?? ''}\0${get(embeddedProjectRoot) ? 'fig/' : ''}\0${get(scene3dGeneration)}`; }
function abort() { return new DOMException('3D project changed or view closed', 'AbortError'); }
function check(owner: Context) { if (owner.dead || owner !== context || owner.scope !== scope()) throw abort(); }
function disposeContext() { if (!context) return; context.dead = true; context.controller.abort(); context.service?.dispose(); context = undefined; cache.clear(); pending.clear(); }
for (const store of [embeddedProjectRoot, projectDir, scene3dGeneration]) store.subscribe(() => { if (context && context.scope !== scope()) disposeContext(); });
function current() {
  if (context?.scope === scope()) return context;
  disposeContext();
  return context = { scope: scope(), root: get(embeddedProjectRoot) ?? get(projectDir) ?? '', prefix: get(embeddedProjectRoot) ? 'fig/' : '', dead: false, sources: new Map(), controller: new AbortController() };
}
function remember(key: string, url: string) {
  cache.delete(key); cache.set(key, url);
  let bytes = [...cache.values()].reduce((sum, item) => sum + item.length * 2, 0);
  for (const [id, item] of cache) { if (cache.size <= 80 && bytes <= 96 * 1024 * 1024) break; cache.delete(id); bytes -= item.length * 2; }
}
async function service(owner: Context) {
  check(owner);
  return owner.pending ??= (async () => {
    const fb = fileBridge();
    const policy = await (fb as typeof fb & { model3dAvailability?: () => Promise<{ disabled: boolean }> })?.model3dAvailability?.();
    check(owner);
    if (policy?.disabled) throw new Error('3D preview needs WebGL');
    const { getModel3dService } = await import('./service');
    check(owner);
    const renderer = getModel3dService({ sourceKey: owner.scope, modelBytes: async (id) => {
      check(owner);
      const asset = owner.sources.get(id);
      if (!asset || !fb || !owner.root) throw new Error('3D model file missing');
      const rel = storedAssetPath(owner.prefix + asset.path);
      const abs = fb.projectAssetPath ? await fb.projectAssetPath(owner.root, rel) : joinPath(owner.root, rel);
      check(owner);
      if (!await fb.exists(abs)) throw new Error('3D model file missing');
      const bytes = await fb.readFile(abs); check(owner); return bytes;
    } });
    owner.service = renderer;
    const available = await renderer.available(); check(owner);
    if (!available.ok) throw new Error(`3D preview needs WebGL${available.reason ? `: ${available.reason}` : ''}`);
    return renderer;
  })();
}
export async function appModel3dService() { const owner = current(); return { service: await service(owner), isCurrent: () => !owner.dead && owner === context && owner.scope === scope() }; }
export function retainModel3d(asset: Model3dAsset) {
  const owner = current(), id = `model:${asset.id}:${asset.sha256}`;
  owner.sources.set(id, asset);
  let released = false, retained: Model3dService | undefined;
  const ready = service(owner).then(async renderer => {
    check(owner);
    if (released) throw abort();
    retained = renderer;
    await renderer.retain(id); check(owner);
    if (released) throw abort();
    return { service: renderer, assetId: id, owner };
  });
  return { ready, release() { if (released) return; released = true; retained?.release(id); } };
}
async function dataUrl(blob: Blob) { return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), 'image/png'); }
/** Decoding before publication also validates disk cache bytes. */
export async function decodeModelPoster(url: string): Promise<string> {
  const image = new Image(); image.src = url; await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('3D poster is empty');
  return url;
}
export async function modelPosterUrl(request: PosterRequest, options: { signal?: AbortSignal; onPreview?: (url: string) => void } = {}) {
  const owner = current(), { element, asset, manifest } = request, surface = request.surface ?? 'figure';
  const layout = furnitureLayout(manifest, element, element.overrides), px = posterPixels(layout.viewport, surface);
  const key = posterKey(element, asset, manifest, px), cacheKey = `${owner.scope}\0${key}`;
  const currentRequest = () => { check(owner); if (options.signal?.aborted) throw abort(); };
  const bridge = fileBridge();
  if (owner.root && bridge) {
    const relative = storedAssetPath(owner.prefix + asset.path);
    const source = bridge.projectAssetPath ? await bridge.projectAssetPath(owner.root, relative) : joinPath(owner.root, relative);
    currentRequest();
    if (!await bridge.exists(source)) throw new Error('3D model file missing');
    currentRequest();
  }
  const hit = cache.get(cacheKey); if (hit) { currentRequest(); return hit; }
  // Editor buckets live in memory; stored posters have a stable physical DPI.
  const editor = typeof surface === 'object' && surface.kind === 'editor';
  const storedPx = editor ? posterPixels(layout.viewport, surface.base ?? 'figure') : px;
  const storedKey = posterKey(element, asset, manifest, storedPx);
  const fb = fileBridge(), disk = owner.root && fb ? joinPath(owner.root, posterPath(storedKey)) : '';
  const cacheHit = cache.get(`${owner.scope}\0${storedKey}`);
  if (cacheHit) { currentRequest(); options.onPreview?.(cacheHit); }
  else if (disk && fb) {
    try {
      if (await fb.exists(disk)) {
        const value = await decodeModelPoster(bytesToDataUrl(new Uint8Array(await fb.readFile(disk)), 'image/png'));
        currentRequest(); remember(`${owner.scope}\0${storedKey}`, value);
        if (key === storedKey) return value;
        options.onPreview?.(value);
      }
    } catch (error) { currentRequest(); /* A corrupt derived cache regenerates below. */ }
  }
  currentRequest();
  const existing = pending.get(cacheKey);
  if (existing && !existing.cancel.signal.aborted) return joinJob(existing, options.signal, options.onPreview);
  const job: PosterJob = { promise: Promise.resolve(''), cancel: new AbortController(), waiters: new Set() };
  const ownerGone = () => job.cancel.abort();
  owner.controller.signal.addEventListener('abort', ownerGone, { once: true });
  const checkJob = () => { check(owner); if (job.cancel.signal.aborted) throw abort(); };
  const preview = (url: string) => { checkJob(); for (const waiter of job.waiters) waiter.preview?.(url); };
  job.promise = (async () => {
    const retained = retainModel3d(asset);
    const release = () => retained.release();
    job.cancel.signal.addEventListener('abort', release, { once: true });
    try {
      const loaded = await waitForJob(retained.ready, job.cancel.signal); checkJob();
      const render = async (size: { w: number; h: number }, renderKey: string) => {
        const blob = await loaded.service.renderPng({ assetId: loaded.assetId, ...size, element, manifest }, { lane: 'idle', key: renderKey, signal: job.cancel.signal });
        const url = await decodeModelPoster(await dataUrl(blob)); checkJob(); remember(`${owner.scope}\0${renderKey}`, url);
        return { blob, url };
      };
      if (!cache.has(`${owner.scope}\0${storedKey}`)) {
        const stored = await render(storedPx, storedKey); preview(stored.url);
        if (disk && fb) {
          // A read-only project still gets its valid rendered preview.
          try {
            checkJob(); await fb.mkdir(joinPath(owner.root, 'fig/renders/model3d')); checkJob();
            const bytes = new Uint8Array(await stored.blob.arrayBuffer()); checkJob();
            await fb.writeFile(disk, bytes); checkJob();
          } catch { checkJob(); }
        }
        if (key === storedKey) return stored.url;
      }
      return key === storedKey ? cache.get(`${owner.scope}\0${storedKey}`)! : (await render(px, key)).url;
    } catch (error) {
      checkJob();
      // A matching physical poster remains useful if the editor bucket cannot render.
      const fallback = cache.get(`${owner.scope}\0${storedKey}`);
      if (fallback) return fallback;
      throw error;
    } finally { job.cancel.signal.removeEventListener('abort', release); retained.release(); }
  })();
  pending.set(cacheKey, job);
  const cleanup = () => { owner.controller.signal.removeEventListener('abort', ownerGone); if (pending.get(cacheKey) === job) pending.delete(cacheKey); };
  job.promise.then(cleanup, cleanup);
  return joinJob(job, options.signal, options.onPreview);
}
/** Best-effort derived-cache GC, scheduled once after a successful project load. */
export function scheduleModelPosterPrune(root: string, isCurrent: () => boolean = () => true) {
  const run = () => { void pruneModelPosters(root, isCurrent).catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run); else setTimeout(run, 0);
}
export async function pruneModelPosters(root: string, isCurrent: () => boolean = () => true) {
  const fb = fileBridge(); if (!fb?.readdir || !fb.stat || !fb.remove || !root || !isCurrent()) return;
  const live = new Set<string>(), model = get(project), manifests = get(scene3dManifests);
  for (const figure of model.figures) for (const element of figure.elements) if (element.type === 'model3d') {
    const asset = model.assets.find(a => a.id === element.assetId);
    if (asset?.kind !== 'glb' || !asset.model || !asset.sha256) continue;
    const manifest = manifests[asset.id], viewport = furnitureLayout(manifest, element, element.overrides).viewport;
    live.add(posterKey(element, asset as Model3dAsset, manifest, posterPixels(viewport, 'figure')));
  }
  const dir = joinPath(root, 'fig/renders/model3d'); if (!await fb.exists(dir)) return;
  const entries = await fb.readdir(dir), cutoff = Date.now() - 14 * 86400_000;
  for (const entry of entries) {
    if (!isCurrent()) return;
    if (entry.dir || !/^m3d-[\da-f]{14}\.png$/.test(entry.name) || live.has(entry.name.slice(0, -4))) continue;
    const path = joinPath(dir, entry.name), stat = await fb.stat(path);
    if (stat && stat.mtimeMs < cutoff && isCurrent()) await fb.remove(path);
  }
}
export function model3dAppStats() { return { ...(context?.service?.stats() ?? { contexts: 0, retained: 0, residentBytes: 0, loads: 0, renders: 0, queued: 0, active: false }), posters: cache.size, pendingPosters: pending.size, scope: context?.scope ?? null }; }
if (import.meta.env.DEV) (window as unknown as { __fluxModel3d: { stats: typeof model3dAppStats } }).__fluxModel3d = { stats: model3dAppStats };
