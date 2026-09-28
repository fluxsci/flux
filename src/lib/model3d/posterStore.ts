/** App-owned poster IO. Mesh bytes remain outside assetData and save journals. */
import { get } from 'svelte/store';
import { project, embeddedProjectRoot, projectDir } from '../store';
import { fileBridge, joinPath } from '../project/types';
import { bytesToDataUrl } from '../assets';
import { scene3dManifests } from './store';
import { furnitureLayout } from './furnitureLayout';
import { posterKey, posterPath, posterPixels, isModelPosterPrunable, type PosterSurface } from './poster';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';

export { type ModelPosterSource } from './sourceRegistry';
import { checkModelSource, checkModelFile, ownedModel3dService, awaitModelSource, retainSourceModel, releaseModelSource, modelSourceRegistryStats, type ModelPosterSource } from './sourceRegistry';
interface Context { source: ModelPosterSource; controller: AbortController }
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
// Scoped by project root and prefix only. Posters are content-addressed (the
// key covers the GLB hash and every render input) and asset files are
// immutable per id, so a same-root figure reload must NOT tear down the worker
// (which would re-read, re-hash and re-parse every GLB and flash every poster).
function scope() { return `${get(embeddedProjectRoot) ?? get(projectDir) ?? ''}\0${get(embeddedProjectRoot) ? 'fig/' : ''}`; }
function abort() { return new DOMException('3D project changed or view closed', 'AbortError'); }
function check(source: ModelPosterSource) { checkModelSource(source); }
function disposeContext() {
  if (!context) return;
  const owner = context; context = undefined; owner.controller.abort(); releaseModelSource(owner.source);
}
for (const store of [embeddedProjectRoot, projectDir]) store.subscribe(() => { if (context && context.source.scope !== scope()) disposeContext(); });
function current() {
  if (context?.source.scope === scope()) return context;
  disposeContext();
  const capturedScope = scope(), controller = new AbortController();
  const source: ModelPosterSource = Object.freeze({ scope: capturedScope, root: get(embeddedProjectRoot) ?? get(projectDir) ?? '', prefix: get(embeddedProjectRoot) ? 'fig' : '', bridge: fileBridge() ?? null,
    isCurrent: () => !controller.signal.aborted && capturedScope === scope() });
  return context = { source, controller };
}
export function captureAppModelPosterSource(): ModelPosterSource { return current().source; }
export interface PosterPublication { root: string; scope: string; key: string }
const subscribers = new Set<(value: PosterPublication) => void>();
export function subscribeModelPosters(listener: (value: PosterPublication) => void) { subscribers.add(listener); return () => subscribers.delete(listener); }
function remember(key: string, url: string) {
  cache.delete(key); cache.set(key, url);
  let bytes = [...cache.values()].reduce((sum, item) => sum + item.length * 2, 0);
  for (const [id, item] of cache) { if (cache.size <= 80 && bytes <= 96 * 1024 * 1024) break; cache.delete(id); bytes -= item.length * 2; }
}
export async function appModel3dService() {
  const source = captureAppModelPosterSource();
  return { service: await ownedModel3dService(source), isCurrent: source.isCurrent };
}
export function retainModel3d(asset: Model3dAsset, options: { source?: ModelPosterSource } = {}) {
  return retainSourceModel(asset, options.source ?? captureAppModelPosterSource());
}
async function dataUrl(blob: Blob) { return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), 'image/png'); }
/** Decoding and exact dimensions validate both disk caches and worker output. */
export async function decodeModelPoster(url: string, expected?: { w: number; h: number }): Promise<string> {
  const image = new Image(); image.src = url; await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('3D poster is empty');
  if (expected && (image.naturalWidth !== expected.w || image.naturalHeight !== expected.h)) throw new Error(`3D poster dimensions differ from ${expected.w} × ${expected.h}`);
  return url;
}
function requestKeys(request: PosterRequest) {
  const { element, asset, manifest } = request, surface = request.surface ?? 'figure';
  const layout = furnitureLayout(manifest, element, element.overrides), px = posterPixels(layout.viewport, surface);
  const editor = typeof surface === 'object' && surface.kind === 'editor';
  const storedPx = posterPixels(layout.viewport, editor ? surface.base ?? 'figure' : surface === 'slide' ? 'slide' : 'figure');
  return { px, key: posterKey(element, asset, manifest, px), storedPx, storedKey: posterKey(element, asset, manifest, storedPx), editor };
}
/** Synchronous decoded-memory lookup for Paper's first paint. No IO or worker. */
export function cachedModelPosterUrl(request: PosterRequest, options: { source?: ModelPosterSource } = {}) {
  const source = options.source ?? captureAppModelPosterSource();
  if (!source.isCurrent()) return undefined;
  const { key, storedKey } = requestKeys(request);
  return cache.get(`${source.scope}\0${key}`) ?? cache.get(`${source.scope}\0${storedKey}`);
}
export interface ModelPosterOptions { source?: ModelPosterSource; signal?: AbortSignal; onPreview?: (url: string) => void; onWarning?: (warning: string) => void }
export async function modelPosterUrl(request: PosterRequest, options: ModelPosterOptions = {}) {
  const source = options.source ?? captureAppModelPosterSource(), { element, asset, manifest } = request;
  const { px, key, storedPx, storedKey, editor } = requestKeys(request), cacheKey = `${source.scope}\0${key}`;
  const currentRequest = () => { check(source); if (options.signal?.aborted) throw abort(); };
  currentRequest(); await awaitModelSource(checkModelFile(source, asset), options.signal); currentRequest();
  const hit = cache.get(cacheKey); if (hit) return hit;
  const fb = source.bridge;
  const publish = (renderKey: string, url: string) => {
    currentRequest(); remember(`${source.scope}\0${renderKey}`, url);
    for (const subscriber of subscribers) subscriber({ root: source.root, scope: source.scope, key: renderKey });
  };
  const diskRead = async (renderKey: string, dimensions: { w: number; h: number }) => {
    const memory = cache.get(`${source.scope}\0${renderKey}`); if (memory) return memory;
    if (!source.root || !fb) return undefined;
    try {
      const path = joinPath(source.root, posterPath(renderKey));
      if (await fb.exists(path)) {
        const value = await decodeModelPoster(bytesToDataUrl(new Uint8Array(await fb.readFile(path)), 'image/png'), dimensions);
        currentRequest(); publish(renderKey, value); return value;
      }
    } catch { currentRequest(); }
    return undefined;
  };
  const exact = await awaitModelSource(diskRead(key, px), options.signal); currentRequest(); if (exact) return exact;
  const stored = key === storedKey ? undefined : await awaitModelSource(diskRead(storedKey, storedPx), options.signal); currentRequest();
  if (stored) options.onPreview?.(stored);
  const existing = pending.get(cacheKey);
  if (existing && !existing.cancel.signal.aborted) {
    const value = await joinJob(existing, options.signal, options.onPreview);
    if (!editor && key !== storedKey && !cache.has(cacheKey)) options.onWarning?.(`3D model "${element.name || asset.name || element.id}": using the stored poster because the requested export resolution could not be rendered`);
    return value;
  }
  const job: PosterJob = { promise: Promise.resolve(''), cancel: new AbortController(), waiters: new Set() };
  const appOwner = context?.source === source ? context : undefined;
  const ownerGone = () => job.cancel.abort(); appOwner?.controller.signal.addEventListener('abort', ownerGone, { once: true });
  const checkJob = () => { check(source); if (job.cancel.signal.aborted) throw abort(); };
  const preview = (url: string) => { checkJob(); for (const waiter of job.waiters) waiter.preview?.(url); };
  job.promise = (async () => {
    const retained = retainModel3d(asset, { source });
    const release = () => retained.release(); job.cancel.signal.addEventListener('abort', release, { once: true });
    try {
      const loaded = await waitForJob(retained.ready, job.cancel.signal); checkJob();
      const render = async (size: { w: number; h: number }, renderKey: string, persist: boolean) => {
        const blob = await loaded.service.renderPng({ assetId: loaded.assetId, ...size, element, manifest }, { lane: 'idle', key: renderKey, signal: job.cancel.signal });
        const url = await decodeModelPoster(await dataUrl(blob), size); checkJob();
        remember(`${source.scope}\0${renderKey}`, url);
        for (const subscriber of subscribers) subscriber({ root: source.root, scope: source.scope, key: renderKey });
        if (persist && source.root && fb) {
          try {
            await fb.mkdir(joinPath(source.root, 'fig/renders/model3d')); checkJob();
            const bytes = new Uint8Array(await blob.arrayBuffer()); checkJob();
            await fb.writeFile(joinPath(source.root, posterPath(renderKey)), bytes); checkJob();
          } catch { checkJob(); }
        }
        return url;
      };
      if (editor && !cache.has(`${source.scope}\0${storedKey}`)) preview(await render(storedPx, storedKey, true));
      return key === storedKey && cache.has(`${source.scope}\0${storedKey}`)
        ? cache.get(`${source.scope}\0${storedKey}`)! : await render(px, key, !editor);
    } catch (error) {
      checkJob();
      const fallback = cache.get(`${source.scope}\0${storedKey}`);
      if (fallback) return fallback;
      throw error;
    } finally { job.cancel.signal.removeEventListener('abort', release); retained.release(); }
  })();
  pending.set(cacheKey, job);
  const cleanup = () => { appOwner?.controller.signal.removeEventListener('abort', ownerGone); if (pending.get(cacheKey) === job) pending.delete(cacheKey); };
  job.promise.then(cleanup, cleanup);
  const result = await joinJob(job, options.signal, options.onPreview);
  if (!editor && key !== storedKey && !cache.has(cacheKey)) options.onWarning?.(`3D model "${element.name || asset.name || element.id}": using the stored poster because the requested export resolution could not be rendered`);
  return result;
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
  const entries = await fb.readdir(dir);
  for (const entry of entries) {
    if (!isCurrent()) return;
    if (entry.dir || !/^m3d-[\da-f]{14}\.png$/.test(entry.name) || live.has(entry.name.slice(0, -4))) continue;
    const path = joinPath(dir, entry.name), stat = await fb.stat(path);
    if (stat && isModelPosterPrunable(entry.name, stat.mtimeMs, live) && isCurrent()) await fb.remove(path);
  }
}
export function model3dAppStats() { return { ...(modelSourceRegistryStats() ?? { contexts: 0, retained: 0, residentBytes: 0, loads: 0, renders: 0, queued: 0, active: false }), posters: cache.size, pendingPosters: pending.size, scope: context?.source.scope ?? null }; }
/** Dev/test only: drop the worker so the next use re-probes WebGL availability
 *  (what a real GPU loss or a new project does; a same-root reload does not). */
export function resetModel3dServiceForTest() { disposeContext(); }
if (import.meta.env?.DEV) (window as unknown as { __fluxModel3d: { stats: typeof model3dAppStats; reset: () => void } }).__fluxModel3d = { stats: model3dAppStats, reset: resetModel3dServiceForTest };
