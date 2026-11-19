/// <reference lib="webworker" />
/**
 * A fluximg decode worker. Everything heavy happens here, off the window's main thread: reading byte ranges
 * (asked of the main thread, which owns the file bridge), zstd, assembling tiles, projecting, and drawing
 * stills with the reference renderer. The main thread only hands buffers over.
 *
 * One worker serves any number of bundles. Several workers form the pool in `service.ts`.
 */
import { ZSTDDecoder } from "three/examples/jsm/libs/zstddec.module.js";
import { openFluximg, type BundleReadIO, type FluximgReader, type ZstdCodec } from "./reader";
import { histogram } from "./stats";
import { pixelMaps, readPiece, renderStill, StillCancelled } from "./still";
import { colormapLut, ensureColormapLuts } from "../color/colormapLuts";
import type { FluximgManifest, FluximgTypedArray } from "./types";
import type { FluximgProjectionMode, FluximgView, PixelRect } from "./view";

export type WorkerRequest =
  | { t: "open"; id: number; bundle: string }
  | { t: "text"; id: number; bundle: string; path: string }
  | { t: "plane"; id: number; bundle: string; level: number; leading: number[] }
  | { t: "projection"; id: number; bundle: string; level: number; leading: number[]; dim: string; from: number; to: number; mode: FluximgProjectionMode }
  | { t: "histogram"; id: number; bundle: string; level: number; leading: number[]; lo: number; hi: number; bins: number }
  | { t: "still"; id: number; bundle: string; view: FluximgView | null; crop: PixelRect | null; outWidth: number; outHeight: number }
  | { t: "cancel"; id: number }
  | { t: "forget"; bundle: string }
  | { t: "read-result"; rid: number; buffer?: ArrayBuffer; error?: string };

export type WorkerReply =
  | { t: "read"; rid: number; bundle: string; path: string; offset: number; length: number }
  | { t: "done"; id: number; result: unknown }
  | { t: "error"; id: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const decoder = new ZSTDDecoder();
const ready = decoder.init();
const codec: ZstdCodec = { decompress: (src, outBytes) => decoder.decode(src, outBytes) };

let nextRead = 1;
const reads = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
const cancelled = new Set<number>();
const readers = new Map<string, Promise<FluximgReader>>();

function ioFor(bundle: string): BundleReadIO {
  const range = (path: string, offset: number, length: number): Promise<Uint8Array> =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const rid = nextRead++;
      reads.set(rid, { resolve, reject });
      scope.postMessage({ t: "read", rid, bundle, path, offset, length } satisfies WorkerReply);
    }).then((b) => new Uint8Array(b));
  return {
    readRange: range,
    readText: async (path) => new TextDecoder().decode(await range(path, 0, -1)),
  };
}

function readerFor(bundle: string): Promise<FluximgReader> {
  let r = readers.get(bundle);
  if (!r) {
    r = ready.then(() => openFluximg(ioFor(bundle), codec));
    r.catch(() => readers.delete(bundle));
    readers.set(bundle, r);
  }
  return r;
}

// A small cache of decoded pieces, so a second still of the same plane (a contrast tweak) decodes nothing.
const CACHE_BYTES = 96 * 1024 * 1024;
const cache = new Map<string, FluximgTypedArray | Float32Array>();
let cacheBytes = 0;
function remember<T extends FluximgTypedArray | Float32Array>(key: string, value: T): T {
  if (cache.has(key)) return value;
  cache.set(key, value); cacheBytes += value.byteLength;
  for (const [k, v] of cache) { if (cacheBytes <= CACHE_BYTES) break; cache.delete(k); cacheBytes -= v.byteLength; }
  return value;
}
function recall(key: string): FluximgTypedArray | Float32Array | undefined {
  const v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); }
  return v;
}

const channelOf = (m: FluximgManifest, leading: readonly number[]): number => {
  const ci = m.pixels.dims.indexOf("c");
  return ci >= 0 ? leading[ci] : 0;
};
const pieceCache = { get: (key: string) => recall(key), set: (key: string, value: FluximgTypedArray): void => { remember(key, value); } };
const resolveLut = (name: string): string[] | null => colormapLut(name)?.lut ?? null;

/** A still as a PNG data URL: the reference renderer's pixels, encoded here because only this side has a canvas. */
async function still(msg: Extract<WorkerRequest, { t: "still" }>): Promise<{ href: string; width: number; height: number; level: number }> {
  const r = await readerFor(msg.bundle);
  await ensureColormapLuts();
  const s = await renderStill(r, { view: msg.view, crop: msg.crop, outWidth: msg.outWidth, outHeight: msg.outHeight },
    { resolveLut, cancelled: () => cancelled.has(msg.id), cache: pieceCache, cacheScope: msg.bundle });
  const canvas = new OffscreenCanvas(s.width, s.height);
  canvas.getContext("2d")!.putImageData(new ImageData(s.rgba as Uint8ClampedArray<ArrayBuffer>, s.width, s.height), 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  if (cancelled.has(msg.id)) throw new StillCancelled();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return { href: `data:image/png;base64,${btoa(binary)}`, width: s.width, height: s.height, level: s.level };
}

async function handle(msg: WorkerRequest): Promise<{ result: unknown; transfer?: Transferable[] }> {
  switch (msg.t) {
    case "open": return { result: (await readerFor(msg.bundle)).manifest };
    case "text": return { result: await (await readerFor(msg.bundle)).readText(msg.path) };
    case "plane": {
      const r = await readerFor(msg.bundle), a = await r.level(msg.level), nd = a.meta.shape.length;
      // A copy the main thread may keep: the reader may hand back a view of a shared decode buffer.
      const data = (await r.readPlane(a, msg.leading)).slice();
      return { result: { data, dtype: a.meta.dtype, width: a.meta.shape[nd - 1], height: a.meta.shape[nd - 2], map: pixelMaps(r.manifest)[channelOf(r.manifest, msg.leading)] }, transfer: [data.buffer as ArrayBuffer] };
    }
    case "projection": {
      const r = await readerFor(msg.bundle), a = await r.level(msg.level), nd = a.meta.shape.length;
      const W = a.meta.shape[nd - 1], H = a.meta.shape[nd - 2];
      const p = await readPiece(r, a, msg.level, { channel: channelOf(r.manifest, msg.leading), leading: msg.leading, dim: msg.dim, from: msg.from, to: msg.to, mode: msg.mode }, { x: 0, y: 0, width: W, height: H },
        { cache: pieceCache, cacheScope: msg.bundle, cancelled: () => cancelled.has(msg.id) });
      const data = (p.data as Float32Array).slice();
      return { result: { data, dtype: "float32", width: W, height: H, map: null }, transfer: [data.buffer as ArrayBuffer] };
    }
    case "histogram": {
      const r = await readerFor(msg.bundle), a = await r.level(msg.level);
      const data = await r.readPlane(a, msg.leading);
      const counts = histogram({ data, map: pixelMaps(r.manifest)[channelOf(r.manifest, msg.leading)] }, msg.lo, msg.hi, msg.bins);
      return { result: counts, transfer: [counts.buffer as ArrayBuffer] };
    }
    case "still": return { result: await still(msg) };
    default: throw new Error(`fluximg worker: unknown request ${(msg as { t: string }).t}`);
  }
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.t === "read-result") {
    const waiting = reads.get(msg.rid);
    reads.delete(msg.rid);
    if (!waiting) return;
    if (msg.buffer) waiting.resolve(msg.buffer); else waiting.reject(new Error(msg.error ?? "read failed"));
    return;
  }
  if (msg.t === "cancel") { cancelled.add(msg.id); return; }
  if (msg.t === "forget") {
    readers.delete(msg.bundle);
    for (const k of [...cache.keys()]) if (k.startsWith(`${msg.bundle}|`)) { cacheBytes -= cache.get(k)!.byteLength; cache.delete(k); }
    return;
  }
  handle(msg).then(
    ({ result, transfer }) => { cancelled.delete(msg.id); scope.postMessage({ t: "done", id: msg.id, result } satisfies WorkerReply, transfer ?? []); },
    (err: unknown) => { cancelled.delete(msg.id); scope.postMessage({ t: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) } satisfies WorkerReply); },
  );
};
