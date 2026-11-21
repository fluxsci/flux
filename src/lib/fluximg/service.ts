/**
 * The window's fluximg service: a small pool of decode workers and the caches in front of them.
 *
 * The main thread never decompresses, assembles or draws pixels. It relays byte ranges from the file bridge to
 * the workers (buffers are transferred, not copied) and keeps what came back: manifests, stills as data URLs,
 * and planes for the live view. Everything is bounded by a byte budget and evicted least-recently-used.
 *
 * No Svelte and no stores here: `store.ts` binds one instance to the open project.
 */
import type { FluximgReadRequest } from "./bridge";
import type { ValueMap } from "./encoding";
import type { FluximgDtype, FluximgManifest, FluximgTable, FluximgTypedArray } from "./types";
import type { FluximgProjectionMode, FluximgView, PixelRect } from "./view";
import type { WorkerReply, WorkerRequest } from "./fluximg.worker";
import { typedArrayFor } from "./types";

export interface FluximgHost {
  /** Read part of a bundle file. `bundle` is relative to the project root. */
  read(request: Omit<FluximgReadRequest, "root">): Promise<ArrayBuffer>;
}

export interface ServicePlane {
  key: string;
  width: number;
  height: number;
  dtype: FluximgDtype;
  data: FluximgTypedArray;
  map: ValueMap | null;
}

export interface StillRequest {
  bundle: string;
  view: FluximgView | null | undefined;
  crop: PixelRect | null | undefined;
  outWidth: number;
  outHeight: number;
  /** Requests sharing a slot replace each other: only the newest is worth finishing. */
  slot?: string;
}

export interface ServiceOptions {
  workers?: number;
  workerFactory?: () => Worker;
  planeBytes?: number;
  stillBytes?: number;
}

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
type Job = Distribute<Exclude<WorkerRequest, { t: "cancel" | "forget" | "read-result" }>>;

interface Slot { worker: Worker; busy: number }

export class FluximgService {
  private pool: Slot[] = [];
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; slot: Slot }>();
  private manifests = new Map<string, Promise<FluximgManifest>>();
  private texts = new Map<string, Promise<string>>();
  private planes = new Map<string, { promise: Promise<ServicePlane>; bytes: number }>();
  private planeBytesHeld = 0;
  private stills = new Map<string, { promise: Promise<string>; bytes: number; href?: string }>();
  private stillBytesHeld = 0;
  private slots = new Map<string, number>();
  private readonly size: number;
  private readonly planeBudget: number;
  private readonly stillBudget: number;
  private disposed = false;

  constructor(private host: FluximgHost, private options: ServiceOptions = {}) {
    const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    this.size = Math.max(1, options.workers ?? Math.min(4, Math.max(1, cores - 1)));
    this.planeBudget = options.planeBytes ?? 384 * 1024 * 1024;
    this.stillBudget = options.stillBytes ?? 96 * 1024 * 1024;
  }

  private spawn(): Slot {
    const worker = this.options.workerFactory?.() ?? new Worker(new URL("./fluximg.worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { worker, busy: 0 };
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (msg.t === "read") {
        this.host.read({ bundle: msg.bundle, path: msg.path, offset: msg.offset, length: msg.length }).then(
          (buffer) => worker.postMessage({ t: "read-result", rid: msg.rid, buffer } satisfies WorkerRequest, [buffer]),
          (err: unknown) => worker.postMessage({ t: "read-result", rid: msg.rid, error: err instanceof Error ? err.message : String(err) } satisfies WorkerRequest),
        );
        return;
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      w.slot.busy--;
      if (msg.t === "done") w.resolve(msg.result); else w.reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      for (const [id, w] of this.waiting) if (w.slot === slot) { this.waiting.delete(id); w.reject(new Error(`fluximg worker failed: ${e.message}`)); }
      slot.busy = 0;
    };
    this.pool.push(slot);
    return slot;
  }

  /** The least busy worker, growing the pool while every worker has work. */
  private pick(): Slot {
    const idle = this.pool.find((s) => s.busy === 0);
    if (idle) return idle;
    if (this.pool.length < this.size) return this.spawn();
    return this.pool.reduce((a, b) => (b.busy < a.busy ? b : a));
  }

  private call<T>(job: Job): { id: number; promise: Promise<T> } {
    if (this.disposed) return { id: 0, promise: Promise.reject(new Error("fluximg service is closed")) };
    const id = this.nextId++, slot = this.pick();
    slot.busy++;
    const promise = new Promise<T>((resolve, reject) => { this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, slot }); });
    slot.worker.postMessage({ ...job, id } as WorkerRequest);
    return { id, promise };
  }

  private cancel(id: number): void {
    const w = this.waiting.get(id);
    if (w) w.slot.worker.postMessage({ t: "cancel", id } satisfies WorkerRequest);
  }

  manifest(bundle: string): Promise<FluximgManifest> {
    let m = this.manifests.get(bundle);
    if (!m) {
      m = this.call<FluximgManifest>({ t: "open", bundle }).promise;
      m.catch(() => this.manifests.delete(bundle));
      this.manifests.set(bundle, m);
    }
    return m;
  }

  /** A text file of the bundle (a layer's SVG, a table). */
  text(bundle: string, path: string): Promise<string> {
    const key = `${bundle}|${path}`;
    let t = this.texts.get(key);
    if (!t) {
      t = this.call<string>({ t: "text", bundle, path }).promise;
      t.catch(() => this.texts.delete(key));
      this.texts.set(key, t);
    }
    return t;
  }

  async table(bundle: string, path: string): Promise<FluximgTable> { return JSON.parse(await this.text(bundle, path)) as FluximgTable; }

  private keepPlane(key: string, promise: Promise<ServicePlane>): Promise<ServicePlane> {
    const entry = { promise, bytes: 0 };
    this.planes.set(key, entry);
    promise.then((p) => {
      if (this.planes.get(key) !== entry) return;
      entry.bytes = p.data.byteLength; this.planeBytesHeld += entry.bytes;
      for (const [k, v] of this.planes) {
        if (this.planeBytesHeld <= this.planeBudget) break;
        if (k === key) continue;
        this.planes.delete(k); this.planeBytesHeld -= v.bytes;
      }
    }, () => { if (this.planes.get(key) === entry) this.planes.delete(key); });
    return promise;
  }

  private touchPlane(key: string): Promise<ServicePlane> | undefined {
    const hit = this.planes.get(key);
    if (!hit) return undefined;
    this.planes.delete(key); this.planes.set(key, hit);
    return hit.promise;
  }

  /** One whole plane of a level, as stored samples, for the live view. Calling it early is how to decode ahead. */
  plane(bundle: string, level: number, leading: readonly number[]): Promise<ServicePlane> {
    const key = planeKey(bundle, level, leading);
    return this.touchPlane(key) ?? this.keepPlane(key, this.call<Omit<ServicePlane, "key">>({ t: "plane", bundle, level, leading: [...leading] }).promise.then((p) => revive(key, p)));
  }

  /** True when that plane is already decoded and held. */
  hasPlane(bundle: string, level: number, leading: readonly number[]): boolean {
    const e = this.planes.get(planeKey(bundle, level, leading));
    return !!e && e.bytes > 0;
  }

  /**
   * A statistic over a run of planes along one dimension, as float values. Requests sharing a `slot` replace each
   * other (a range being dragged): the superseded one is abandoned in its worker and rejects with "cancelled".
   */
  projection(bundle: string, level: number, leading: readonly number[], dim: string, from: number, to: number, mode: FluximgProjectionMode, slot?: string): Promise<ServicePlane> {
    const key = projectionKey(bundle, level, leading, dim, from, to, mode);
    const hit = this.touchPlane(key);
    if (hit) return hit;
    if (slot) { const prior = this.slots.get(slot); if (prior) this.cancel(prior); }
    const { id, promise } = this.call<Omit<ServicePlane, "key">>({ t: "projection", bundle, level, leading: [...leading], dim, from, to, mode });
    if (slot) {
      this.slots.set(slot, id);
      const release = (): void => { if (this.slots.get(slot) === id) this.slots.delete(slot); };
      promise.then(release, release);
    }
    return this.keepPlane(key, promise.then((p) => revive(key, p)));
  }

  /** An intensity layer on the grid of the pixel level with that downsampling (1 = the layer's own samples). */
  layer(bundle: string, layerId: string, downsample: number): Promise<ServicePlane> {
    const key = layerKey(bundle, layerId, downsample);
    return this.touchPlane(key) ?? this.keepPlane(key, this.call<Omit<ServicePlane, "key">>({ t: "layer", bundle, layerId, downsample }).promise.then((p) => revive(key, p)));
  }

  histogram(bundle: string, level: number, leading: readonly number[], lo: number, hi: number, bins = 256): Promise<Uint32Array> {
    return this.call<Uint32Array>({ t: "histogram", bundle, level, leading: [...leading], lo, hi, bins }).promise;
  }

  /** A still of a view as a PNG data URL, drawn by the reference renderer. `key` must identify the pixels. */
  still(key: string, request: StillRequest): Promise<string> {
    const hit = this.stills.get(key);
    if (hit) { this.stills.delete(key); this.stills.set(key, hit); return hit.promise; }
    if (request.slot) {
      const prior = this.slots.get(request.slot);
      if (prior) this.cancel(prior);
    }
    const { id, promise: raw } = this.call<{ href: string }>({ t: "still", bundle: request.bundle, view: request.view ?? null, crop: request.crop ?? null, outWidth: request.outWidth, outHeight: request.outHeight });
    if (request.slot) this.slots.set(request.slot, id);
    const promise = raw.then((r) => r.href);
    const entry: { promise: Promise<string>; bytes: number; href?: string } = { promise, bytes: 0 };
    this.stills.set(key, entry);
    promise.then((href) => {
      if (request.slot && this.slots.get(request.slot) === id) this.slots.delete(request.slot);
      if (this.stills.get(key) !== entry) return;
      entry.href = href;
      entry.bytes = href.length * 2; this.stillBytesHeld += entry.bytes;
      for (const [k, v] of this.stills) {
        if (this.stillBytesHeld <= this.stillBudget) break;
        if (k === key) continue;
        this.stills.delete(k); this.stillBytesHeld -= v.bytes;
      }
    }, () => { if (this.stills.get(key) === entry) this.stills.delete(key); });
    return promise;
  }

  /** A still that is already drawn, without asking for one. */
  peekStill(key: string): Promise<string> | undefined { return this.stills.get(key)?.promise; }

  /** A still that has already landed, synchronously (the slide player's stills at rest); undefined otherwise. */
  stillHref(key: string): string | undefined { return this.stills.get(key)?.href; }

  /** Drop everything known about a bundle (its files changed or it left the project). */
  forget(bundle: string): void {
    this.manifests.delete(bundle);
    const mine = (k: string): boolean => k.startsWith(`${bundle}|`);
    for (const k of [...this.texts.keys()]) if (mine(k)) this.texts.delete(k);
    for (const [k, v] of [...this.planes]) if (mine(k)) { this.planes.delete(k); this.planeBytesHeld -= v.bytes; }
    for (const [k, v] of [...this.stills]) if (mine(k)) { this.stills.delete(k); this.stillBytesHeld -= v.bytes; }
    for (const s of this.pool) s.worker.postMessage({ t: "forget", bundle } satisfies WorkerRequest);
  }

  get stats(): { workers: number; planes: number; planeBytes: number; stills: number; stillBytes: number; pending: number } {
    return { workers: this.pool.length, planes: this.planes.size, planeBytes: this.planeBytesHeld, stills: this.stills.size, stillBytes: this.stillBytesHeld, pending: this.waiting.size };
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.pool) s.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error("fluximg service is closed"));
    this.pool = []; this.waiting.clear(); this.manifests.clear(); this.texts.clear(); this.planes.clear(); this.stills.clear(); this.slots.clear();
    this.planeBytesHeld = 0; this.stillBytesHeld = 0;
  }
}

/** Cache keys: one definition, shared with whoever needs to recognise a plane it asked for. */
export const planeKey = (bundle: string, level: number, leading: readonly number[]): string => `${bundle}|${level}|${leading.join(",")}`;
export const projectionKey = (bundle: string, level: number, leading: readonly number[], dim: string, from: number, to: number, mode: FluximgProjectionMode): string =>
  `${bundle}|${level}|${leading.join(",")}|${dim}:${from}-${to}:${mode}`;
export const layerKey = (bundle: string, layerId: string, downsample: number): string => `${bundle}|layer:${layerId}|${downsample}`;

/** Structured clone keeps typed arrays typed; this only names the plane and guards against a stray view. */
function revive(key: string, p: Omit<ServicePlane, "key">): ServicePlane {
  const data = ArrayBuffer.isView(p.data) ? p.data : typedArrayFor(p.dtype, p.data as unknown as ArrayBuffer, 0, p.width * p.height);
  return { ...p, data, key };
}
