/** Lazy, one-worker render service. No requestAnimationFrame or idle polling. */
import type { RenderSpec, RenderCoreStats, LoadedModelStats } from './renderCore';

export type ModelBytes = (assetId: string, signal?: AbortSignal) => ArrayBuffer | Promise<ArrayBuffer>;
export interface RenderOptions {
  lane?: 'interactive' | 'idle';
  channel?: string;
  key?: string;
  signal?: AbortSignal;
  /** Pointer release/capture always requests the full authored pixel size. */
  fullResolution?: boolean;
}
export interface RetainAsset { id: string; bytes?: ArrayBuffer }
export interface Availability { ok: boolean; renderer?: string; reason?: string }
type Format = 'bitmap' | 'png';
type Output = ImageBitmap | Blob;
interface Waiter { resolve: (value: Output) => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort?: () => void }
interface Job { reqId: number; spec: RenderSpec; format: Format; channel: string; key: string; interactive: boolean; full: boolean; waiters: Set<Waiter>; stale: boolean; cancel: AbortController }
interface Resident { refs: number; bytes: number; touched: number; promise: Promise<LoadedModelStats> }
export interface ServiceOptions { sourceKey?: string; modelBytes: ModelBytes; maxResidentBytes?: number; sourceTimeoutMs?: number; workerFactory?: () => Worker }
const abortError = (message = 'Render superseded') => new DOMException(message, 'AbortError');

export function createModel3dService(options: ServiceOptions) {
  let worker: Worker | undefined, disposed = false, counter = 0, active: Job | undefined;
  let availability: Promise<Availability> | undefined;
  let lastTiming = { ms: 0, renderMs: 0, encodeMs: 0 };
  let status: RenderCoreStats = { contexts: 0, residentBytes: 0, loads: 0, renders: 0, lost: false, assets: 0, morphPairs: 0 };
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const interactive = new Map<string, Job>(), idle = new Map<string, Job>(), residents = new Map<string, Resident>();
  const scales = new Map<string, number>();
  const lifetime = new AbortController();
  const contextListeners = new Set<(lost: boolean) => void>();
  const maxBytes = options.maxResidentBytes ?? 768 * 1024 * 1024;
  function ensureWorker() {
    if (disposed) throw new Error('3D service disposed');
    if (worker) return worker;
    worker = options.workerFactory?.() ?? new Worker(new URL('./model3d.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.stats) status = message.stats;
      if (typeof message.ms === 'number') lastTiming = { ms: message.ms, renderMs: message.renderMs, encodeMs: message.encodeMs };
      if (message.type === 'lost' || message.type === 'restored') {
        status = { ...status, lost: message.type === 'lost' };
        for (const listener of contextListeners) listener(status.lost);
        return;
      }
      const request = pending.get(message.reqId);
      if (!request) { message.bitmap?.close(); return; }
      pending.delete(message.reqId); clearTimeout(request.timer);
      if (message.type === 'error') request.reject(new Error(message.reason)); else request.resolve(message);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || '3D worker failed');
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear(); status = { ...status, lost: true };
    };
    return worker;
  }
  function rpc(type: string, body: Record<string, unknown> = {}, transfer: Transferable[] = []) {
    const reqId = ++counter;
    return new Promise<any>((resolve, reject) => {
      const instance = ensureWorker();
      const timer = setTimeout(() => { pending.delete(reqId); reject(new Error(`3D worker ${type} timed out`)); }, 60_000);
      pending.set(reqId, { resolve, reject, timer });
      try { instance.postMessage({ type, reqId, ...body }, transfer); } catch (error) { clearTimeout(timer); pending.delete(reqId); reject(error); }
    });
  }
  function available() {
    return availability ??= rpc('available').then((m) => ({ ok: m.ok, renderer: m.renderer, reason: m.reason }), (error) => ({ ok: false, reason: String(error) }));
  }
  function evict() {
    let bytes = [...residents.values()].reduce((sum, r) => sum + r.bytes, 0);
    for (const [id, entry] of [...residents].sort((a, b) => a[1].touched - b[1].touched)) {
      if (bytes <= maxBytes) break;
      if (entry.refs > 0) continue;
      residents.delete(id); bytes -= entry.bytes;
      void entry.promise.then(() => { if (!residents.has(id) && !disposed) return rpc('unload', { assetId: id }); }).catch(() => {});
    }
  }
  function sourceBytes(id: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(abortError('3D source disposed')); };
      const timer = setTimeout(() => { lifetime.signal.removeEventListener('abort', abort); reject(new Error('3D byte source timed out')); }, options.sourceTimeoutMs ?? 60_000);
      lifetime.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => options.modelBytes(id, lifetime.signal)).then(resolve, reject).finally(() => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); });
    });
  }
  function retain(asset: RetainAsset | string): Promise<LoadedModelStats> {
    if (disposed) return Promise.reject(abortError('3D service disposed'));
    const id = typeof asset === 'string' ? asset : asset.id;
    const existing = residents.get(id);
    if (existing) { existing.refs++; existing.touched = ++counter; return existing.promise; }
    const entry: Resident = { refs: 1, bytes: 0, touched: ++counter, promise: Promise.resolve(null as never) };
    entry.promise = (async () => {
      const bytes = typeof asset === 'string' || !asset.bytes ? await sourceBytes(id) : asset.bytes;
      // Keep the provider's buffer usable by other consumers. Worker owns this copy.
      const transferred = bytes.slice(0); entry.bytes = bytes.byteLength;
      const result = await rpc('load', { assetId: id, bytes: transferred }, [transferred]);
      evict(); return result.model;
    })().catch((error) => { if (residents.get(id) === entry) residents.delete(id); throw error; });
    residents.set(id, entry); return entry.promise;
  }
  function release(id: string) { const entry = residents.get(id); if (entry) { entry.refs = Math.max(0, entry.refs - 1); entry.touched = ++counter; evict(); } }
  function rejectJob(job: Job, reason: unknown) {
    job.stale = true; job.cancel.abort();
    for (const waiter of job.waiters) { waiter.signal?.removeEventListener('abort', waiter.abort!); waiter.reject(reason); }
    job.waiters.clear();
  }
  async function drain() {
    if (active || disposed) return;
    const next = interactive.entries().next().value as [string, Job] | undefined;
    const queued = next ?? idle.entries().next().value as [string, Job] | undefined;
    if (!queued) return;
    const [key, job] = queued; (next ? interactive : idle).delete(key); active = job;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(abortError());
        if (job.cancel.signal.aborted) return abort();
        job.cancel.signal.addEventListener('abort', abort, { once: true });
        Promise.all([residents.get(job.spec.assetId)?.promise, job.spec.morph ? residents.get(job.spec.morph.to)?.promise : undefined]).then(() => resolve(), reject).finally(() => job.cancel.signal.removeEventListener('abort', abort));
      });
      if (job.stale || !job.waiters.size) return;
      const scale = job.interactive && !job.full ? scales.get(job.channel) ?? 1 : 1;
      const spec = scale === 1 ? job.spec : { ...job.spec, w: Math.max(1, Math.round(job.spec.w * scale)), h: Math.max(1, Math.round(job.spec.h * scale)) };
      const reply = await rpc('render', { spec, format: job.format });
      if (job.interactive && !job.full && reply.ms > 40) scales.set(job.channel, Math.max(0.25, scale / 2));
      const output: Output = reply.bitmap ?? reply.blob;
      if (job.stale || !job.waiters.size) { if (job.format === 'bitmap') (output as ImageBitmap).close(); return; }
      const waiters = [...job.waiters];
      // Keep waiters reachable until cloning finishes: cancellation/disposal rejects them.
      const copies = await Promise.allSettled(waiters.map((_, i) => job.format === 'bitmap' && i > 0 ? createImageBitmap(output as ImageBitmap) : Promise.resolve(output)));
      const failed = copies.find((copy) => copy.status === 'rejected');
      if (failed || disposed || job.stale) {
        if (job.format === 'bitmap') for (const copy of copies) if (copy.status === 'fulfilled') (copy.value as ImageBitmap).close();
        rejectJob(job, failed?.status === 'rejected' ? failed.reason : abortError()); return;
      }
      job.waiters.clear();
      waiters.forEach((waiter, i) => { const value = (copies[i] as PromiseFulfilledResult<Output>).value; waiter.signal?.removeEventListener('abort', waiter.abort!); if (waiter.signal?.aborted) { if (job.format === 'bitmap') (value as ImageBitmap).close(); waiter.reject(abortError()); } else waiter.resolve(value); });
    } catch (error) { rejectJob(job, error); }
    finally { active = undefined; evict(); void drain(); }
  }
  function enqueue(spec: RenderSpec, format: Format, opts: RenderOptions = {}): Promise<Output> {
    if (disposed) return Promise.reject(new Error('3D service disposed'));
    if (opts.signal?.aborted) return Promise.reject(abortError());
    const isInteractive = (opts.lane ?? 'interactive') === 'interactive';
    const channel = opts.channel ?? 'default', key = JSON.stringify([format, opts.key ?? spec]);
    let job = !isInteractive ? (idle.get(key) ?? (!active?.interactive && active?.key === key ? active : undefined)) : undefined;
    if (job?.stale || job?.cancel.signal.aborted) job = undefined;
    if (!job) {
      job = { reqId: ++counter, spec, format, channel, key, interactive: isInteractive, full: opts.fullResolution ?? false, waiters: new Set(), stale: false, cancel: new AbortController() };
      if (isInteractive) {
        const old = interactive.get(channel); if (old) rejectJob(old, abortError());
        if (active?.interactive && active.channel === channel) rejectJob(active, abortError());
        interactive.set(channel, job);
      } else idle.set(key, job);
    }
    const target = job;
    const promise = new Promise<Output>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal: opts.signal };
      waiter.abort = () => { target.waiters.delete(waiter); if (!target.waiters.size) target.cancel.abort(); reject(abortError('Render cancelled')); };
      opts.signal?.addEventListener('abort', waiter.abort, { once: true }); target.waiters.add(waiter);
    });
    queueMicrotask(() => { void drain(); }); return promise;
  }
  function dispose() {
    if (disposed) return; disposed = true; lifetime.abort();
    const error = abortError('3D service disposed');
    for (const job of [...interactive.values(), ...idle.values(), ...(active ? [active] : [])]) rejectJob(job, error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); interactive.clear(); idle.clear(); residents.clear(); contextListeners.clear(); worker?.terminate(); worker = undefined;
    status = { ...status, contexts: 0, residentBytes: 0, assets: 0, morphPairs: 0 };
  }
  return { available, retain, release, subscribeContext(listener: (lost: boolean) => void) { contextListeners.add(listener); listener(status.lost); return () => { contextListeners.delete(listener); }; }, renderBitmap: (spec: RenderSpec, opts?: RenderOptions) => enqueue(spec, 'bitmap', opts) as Promise<ImageBitmap>, renderPng: (spec: RenderSpec, opts?: RenderOptions) => enqueue(spec, 'png', opts) as Promise<Blob>, stats: () => ({ ...status, lastTiming: { ...lastTiming }, scales: Object.fromEntries(scales), retained: [...residents.values()].filter((r) => r.refs > 0).length, queued: interactive.size + idle.size, active: !!active }), dispose };
}
export type Model3dService = ReturnType<typeof createModel3dService>;
let shared: Model3dService | undefined;
let sharedSource: string | ModelBytes | undefined;
/** App entry point; separate windows have separate module instances/workers. */
export function getModel3dService(options: ServiceOptions) {
  const source = options.sourceKey ?? options.modelBytes;
  if (shared && source !== sharedSource) shared.dispose();
  if (!shared || source !== sharedSource) { sharedSource = source; shared = createModel3dService(options); }
  return shared;
}
export function disposeModel3dService() { shared?.dispose(); shared = undefined; sharedSource = undefined; }
