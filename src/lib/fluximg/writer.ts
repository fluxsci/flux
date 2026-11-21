/**
 * Write a fluximg bundle through an injected IO. Pure.
 *
 * This is the reference writer: fluxplot's Python writer produces the same contract, and Flux uses this one
 * for its own conversions and for test fixtures. It streams: planes are pulled from a `PixelSource` twice (once
 * to learn the image, once to store it), so a stack never has to fit in memory as a whole.
 */
import {
  DEFAULT_ZSTD_LEVEL, DTYPE_BYTES, FIRST_OVERVIEW, FLUXIMG_MANIFEST, FLUXIMG_SPEC, GUARD_THRESHOLD, MAX_SHARD_BYTES, OVERVIEW_FLOOR,
  PERCENTILE_KEYS, TILE_SIZE, TILE_THRESHOLD, allocTyped, canonicalDims, isFloatDtype,
  type FluximgAxis, type FluximgChannel, type FluximgDtype, type FluximgEncoding, type FluximgLayer, type FluximgLevel,
  type FluximgManifest, type FluximgRegion, type FluximgStats, type FluximgTable, type FluximgTypedArray,
} from "./types";
import {
  OME_UNITS, arrayMetaJson, chunkCounts, encodeShardIndex, groupMetaJson, ndindex, product, shardKey, type ZarrArrayMeta,
} from "./zarr";
import { collectNeighbourDiffs, encodeLinear16, guardPasses, guardRatio, linear16Params, median } from "./encoding";
import { labelOutlines } from "./outlines";
import type { ZstdCodec } from "./reader";

export interface BundleWriteIO {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
}

/** Pixels handed over one (y, x) plane at a time. `dims` must already be in canonical order. */
export interface PixelSource {
  dims: string[];
  shape: number[];
  dtype: FluximgDtype;
  /** Row-major samples of one plane for the given leading indices. The writer never keeps the array. */
  plane(leading: readonly number[]): FluximgTypedArray | Promise<FluximgTypedArray>;
}

export function arraySource(data: FluximgTypedArray, dims: string[], shape: number[], dtype: FluximgDtype): PixelSource {
  const nd = shape.length, plane = shape[nd - 2] * shape[nd - 1];
  if (data.length !== product(shape)) throw new Error(`fluximg: data has ${data.length} samples, shape ${JSON.stringify(shape)} needs ${product(shape)}`);
  return {
    dims, shape, dtype,
    plane(leading) {
      let k = 0;
      for (let i = 0; i < nd - 2; i++) k = k * shape[i] + leading[i];
      return data.subarray(k * plane, (k + 1) * plane) as FluximgTypedArray;
    },
  };
}

export interface WriteChannel { name?: string; color?: string | null; lut?: string | null; range?: [number, number]; /** false: the channel starts hidden. */ visible?: boolean }
export type WriteLayer =
  | { kind: "intensity"; id: string; name?: string; data: FluximgTypedArray; dtype: FluximgDtype; color?: string | null; lut?: string | null; range?: [number, number]; opacity?: number | "value"; visible?: boolean; lossless?: boolean; from?: string }
  | { kind: "labels"; id: string; name?: string; data: Uint16Array | Uint32Array; table?: FluximgTable; key?: string; color?: string | null; visible?: boolean; weights?: string | null; from?: string }
  | { kind: "vector"; id: string; name?: string; /** SVG shape elements, each with data-key. */ body: string; count: number; table?: FluximgTable | null; key?: string | null; color?: string | null; visible?: boolean; from?: string };

export interface WriteInput {
  name: string;
  source: PixelSource;
  axes?: Record<string, FluximgAxis>;
  channels?: WriteChannel[];
  /** For integer data: the value that means "no data". Float data uses NaN. */
  nodata?: number | null;
  /** Store floats exactly instead of at 16 bits per channel range. */
  lossless?: boolean;
  photometric?: "rgb" | null;
  layers?: WriteLayer[];
  regions?: FluximgRegion[];
  world?: FluximgManifest["world"];
  provenance?: FluximgManifest["provenance"];
  defaults?: FluximgManifest["defaults"];
}

export interface WriteOptions {
  zstdLevel?: number;
  tileThreshold?: number;
  tileSize?: number;
  overviewFloor?: number;
  maxShardBytes?: number;
  guardThreshold?: number;
  /** Checked between planes: an aborted write throws an AbortError before the manifest is written. */
  signal?: AbortSignal;
  /** After every plane of each pass. `bytesRead` is the source's own count when it keeps one. */
  onProgress?: (p: WriteProgress) => void;
  /** Write `preview.png` (the default view, at most 512 px, SPEC 8) with this PNG encoder of straight RGBA. Off by
   *  default: callers before it write exactly the files they did. */
  preview?: { encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array };
  /** "auto": add a region per connected valid area of the union of 16 evenly spaced planes' masks (fluxplot's rule:
   *  8-neighbour, at least `regionMinPixels`, never the whole image, none when more than 64). Off by default. */
  regions?: "auto";
  regionMinPixels?: number;
  /** Chunks compressed at once when the codec has `compressAsync` (default 1: synchronous, as callers before it
   *  expect; the TIFF converter asks for 8). The window holds that many chunks besides the shard-size sample. */
  concurrency?: number;
}

export interface WriteProgress { phase: "learn" | "store"; done: number; total: number; bytesRead?: number }

/** What `signal` aborts with (the platform's AbortError name, so callers can tell a cancel from a failure). */
export class WriteAbortError extends Error { constructor() { super("The image write was cancelled"); this.name = "AbortError"; } }
const checkAbort = (signal?: AbortSignal): void => { if (signal?.aborted) throw new WriteAbortError(); };
/** Raw bytes in flight in the compression window, at most (besides the chunk count). */
const INFLIGHT_BYTES = 128 * 1024 * 1024;

export interface WriteReport {
  manifest: FluximgManifest;
  bytes: number;
  files: number;
  /** Why the pixels were stored the way they were, in words a person can read. */
  notes: string[];
}

/**
 * Default channel colours (fluxplot's writer uses the same). Two channels: green + magenta. Three: gray, green,
 * magenta (the trio that stays distinguishable for deuteranopes, protanopes and tritanopes). Four and more
 * continue cyan, azure, red: past three no additive set stays apart for every colour-vision deficiency, so the
 * first three keep their colours when a channel is added and the rest are simply distinct hues. `null` = the
 * gray LUT.
 */
export function defaultChannelColours(n: number): Array<string | null> {
  if (n <= 1) return [null];
  if (n === 2) return ["#00ff00", "#ff00ff"];
  const seq: Array<string | null> = [null, "#00ff00", "#ff00ff", "#00ffff", "#0080ff", "#ff0000"];
  return Array.from({ length: n }, (_, i) => seq[i % seq.length]);
}
/** Vector and label layers without a colour take these in turn (yellow first): none is a default channel colour. */
export const DEFAULT_LAYER_COLOURS = ["#ffd400", "#ff8000", "#ffffff", "#ff5c5c", "#9c8cff"];
const ID_RE = /^[a-z][a-z0-9_]*$/;

/** How many planes the shard-size estimate looks at (SPEC 3.3, "the estimate"). */
export const SHARD_SAMPLE_PLANES = 8;

/**
 * What the first compressed chunks of an array cost (SPEC 3.3, "the estimate"): the `planes` complete planes
 * sampled took `planeBytes`; the `rows` complete rows of inner chunks sampled (those planes' rows plus any of
 * the plane after them) took `rowBytes`.
 */
export interface ShardEstimate { planes: number; planeBytes: number; rows: number; rowBytes: number }

/**
 * SPEC 3.3's shard rule: inner chunks per shard along each dimension, from the chunk counts, the estimate and
 * the cap. Exported so the gate (and another writer's port) can check it in isolation.
 *
 * A shard spans y and x whole. Walking the leading dimensions from the LAST one backwards, it spans each
 * whole while the estimate stays at or below the cap; the first that does not fit is split into runs of k
 * inner chunks (k = floor(0.9 x cap / size of one run unit), at least 1), and every earlier dimension gets 1.
 * Only when one plane is itself over the cap is y split, into runs of rows of inner chunks (x stays whole).
 * Integer arithmetic throughout (`9 * cap / 10`, not `0.9 * cap`), so two writers that measured the same bytes
 * choose the same shape.
 */
export function shardChunks(counts: readonly number[], est: ShardEstimate, cap: number): number[] {
  const nd = counts.length, per = counts.slice();
  if (!(est.planes > 0 && est.planeBytes <= cap * est.planes)) {
    // One plane is over the cap (or never completed within it): runs of rows of inner chunks, x whole.
    for (let i = 0; i < nd - 2; i++) per[i] = 1;
    if (est.rowBytes > 0) per[nd - 2] = Math.max(1, Math.min(counts[nd - 2], Math.floor((9 * cap * est.rows) / (10 * est.rowBytes))));
    return per;
  }
  const { planes: q, planeBytes: s } = est;
  let unit = 1;                                         // planes in one step along the dimension being judged
  for (let i = nd - 3; i >= 0; i--) {
    if (s * unit * counts[i] <= cap * q) { unit *= counts[i]; continue; }
    per[i] = Math.max(1, Math.min(counts[i], Math.floor((9 * cap * q) / (10 * s * unit))));
    for (let j = 0; j < i; j++) per[j] = 1;
    break;
  }
  return per;
}

/**
 * Streams inner chunks, in C order, into shard files shaped by `shardChunks`.
 *
 * The first chunks are held (compressed) until the estimate is known: the first `SHARD_SAMPLE_PLANES` planes,
 * or fewer once they pass the cap, so at most about one shard's worth waits. Because a shard spans every
 * dimension after its split dimension whole, chunks in C order fill one shard after another; each shard is
 * written as soon as the next one starts, so memory stays at about one shard whatever the array's size.
 */
class ArrayWriter {
  readonly counts: number[];
  private readonly chunkBytes: number;
  private readonly samplePlanes: number;
  private per: number[] | null = null;                 // inner chunks per shard, once decided
  private held: Array<{ coords: number[]; blob: Uint8Array }> = [];
  private heldBytes = 0;
  private rowsDone = 0;
  private planesDone = 0;
  private planesBytes = 0;
  private open: { shard: number[]; parts: Array<{ local: number; blob: Uint8Array }> } | null = null;
  /** Compressions in flight, in C order; consumed from the front, so shards get exactly the sync path's bytes. */
  private pending: Array<{ coords: number[]; job: Promise<Uint8Array> | null; bytes: number }> = [];
  private pendingBytes = 0;
  bytes = 0;
  files = 0;

  constructor(
    private io: BundleWriteIO, private codec: ZstdCodec, readonly path: string,
    readonly shape: number[], readonly dtype: FluximgDtype, readonly inner: number[], readonly fill: number,
    readonly dims: string[], private level: number, private maxShardBytes: number, private window = 1,
  ) {
    this.counts = chunkCounts(shape, inner);
    this.chunkBytes = product(inner) * DTYPE_BYTES[dtype];
    this.samplePlanes = Math.min(SHARD_SAMPLE_PLANES, product(this.counts.slice(0, -2)));
    if (!codec.compressAsync) this.window = 1;
  }

  /** `chunk` must be exactly one inner chunk; null (or entirely fill) writes nothing. Every chunk of the array
   *  must be offered, in C order of `coords` (the estimate counts rows and planes as they end). With a window
   *  above 1 the chunk is compressed asynchronously: the caller must not modify it afterwards. */
  async add(coords: readonly number[], chunk: FluximgTypedArray | null): Promise<void> {
    let raw: Uint8Array | null = null;
    if (chunk && !allFill(chunk, this.fill)) {
      raw = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (raw.byteLength !== this.chunkBytes) throw new Error(`fluximg: chunk has ${raw.byteLength} bytes, expected ${this.chunkBytes}`);
    }
    if (this.window <= 1) { await this.accept(coords, raw ? this.codec.compress!(raw, this.level) : null); return; }
    const job = raw ? this.codec.compressAsync!(raw, this.level) : null;
    job?.catch(() => {});                                // a failure surfaces when the job is consumed, not as unhandled
    this.pending.push({ coords: coords.slice(), job, bytes: raw?.byteLength ?? 0 });
    this.pendingBytes += raw?.byteLength ?? 0;
    while (this.pending.length >= this.window || this.pendingBytes > INFLIGHT_BYTES) await this.drainOne();
  }

  private async drainOne(): Promise<void> {
    const p = this.pending.shift()!;
    this.pendingBytes -= p.bytes;
    await this.accept(p.coords, p.job ? await p.job : null);
  }

  private async accept(coords: readonly number[], blob: Uint8Array | null): Promise<void> {
    if (this.per) { if (blob) await this.put(coords, blob); return; }
    if (blob) { this.held.push({ coords: coords.slice(), blob }); this.heldBytes += blob.byteLength; }
    const nd = coords.length;
    if (coords[nd - 1] !== this.counts[nd - 1] - 1) return;            // a row of inner chunks ends here
    this.rowsDone++;
    if (coords[nd - 2] === this.counts[nd - 2] - 1) { this.planesDone++; this.planesBytes = this.heldBytes; }
    if (this.planesDone >= this.samplePlanes || this.heldBytes > this.maxShardBytes) await this.decide();
  }

  private async decide(): Promise<void> {
    this.per = shardChunks(this.counts, { planes: this.planesDone, planeBytes: this.planesBytes, rows: this.rowsDone, rowBytes: this.heldBytes }, this.maxShardBytes);
    const held = this.held;
    this.held = [];
    for (const h of held) await this.put(h.coords, h.blob);
  }

  private async put(coords: readonly number[], blob: Uint8Array): Promise<void> {
    const per = this.per!;
    const shard: number[] = [];
    let local = 0;
    for (let i = 0; i < per.length; i++) { shard.push(Math.floor(coords[i] / per[i])); local = local * per[i] + (coords[i] % per[i]); }
    if (!this.open || this.open.shard.some((v, i) => v !== shard[i])) {
      await this.writeOpen();
      this.open = { shard, parts: [] };
    }
    this.open.parts.push({ local, blob });
  }

  /** Write the open shard: its chunks in the order they came (C order), then the index. */
  private async writeOpen(): Promise<void> {
    const open = this.open;
    this.open = null;
    if (!open || !open.parts.length) return;                           // an entirely empty shard is not written
    const n = product(this.per!);
    const offsets = new Float64Array(n).fill(-1), lengths = new Float64Array(n);
    let size = 0;
    for (const p of open.parts) { offsets[p.local] = size; lengths[p.local] = p.blob.byteLength; size += p.blob.byteLength; }
    const index = encodeShardIndex({ offsets, lengths });
    const file = new Uint8Array(size + index.byteLength);
    let at = 0;
    for (const p of open.parts) { file.set(p.blob, at); at += p.blob.byteLength; }
    file.set(index, at);
    await this.io.writeFile(`${this.path}/${shardKey(open.shard)}`, file);
    this.bytes += file.byteLength; this.files++;
  }

  async finish(attributes: Record<string, unknown> = {}): Promise<ZarrArrayMeta> {
    while (this.pending.length) await this.drainOne();
    if (!this.per) await this.decide();
    await this.writeOpen();
    const outer = this.per!.map((p, i) => p * this.inner[i]);
    const meta: ZarrArrayMeta = { shape: this.shape, dtype: this.dtype, inner: this.inner, outer, fill: this.fill, dims: this.dims, zstdLevel: this.level };
    const text = JSON.stringify(arrayMetaJson(meta, attributes), null, 1);
    await this.io.writeText(`${this.path}/zarr.json`, text);
    this.bytes += text.length; this.files++;
    return meta;
  }
}

function allFill(a: FluximgTypedArray, fill: number): boolean {
  if (Number.isNaN(fill)) { for (let i = 0; i < a.length; i++) if (a[i] === a[i]) return false; return true; }
  for (let i = 0; i < a.length; i++) if (a[i] !== fill) return false;
  return true;
}

/** Tile a plane (stored samples) into inner chunks, padding edge tiles with fill. */
function* tilesOf(plane: FluximgTypedArray, W: number, H: number, cw: number, ch: number, dtype: FluximgDtype, fill: number): Generator<{ ty: number; tx: number; chunk: FluximgTypedArray }> {
  if (cw === W && ch === H) { yield { ty: 0, tx: 0, chunk: plane }; return; }
  for (let ty = 0; ty * ch < H; ty++) {
    for (let tx = 0; tx * cw < W; tx++) {
      const chunk = allocTyped(dtype, cw * ch);
      if (fill !== 0) chunk.fill(fill as never);
      const x1 = Math.min(W, (tx + 1) * cw), y1 = Math.min(H, (ty + 1) * ch);
      for (let y = ty * ch; y < y1; y++) chunk.set(plane.subarray(y * W + tx * cw, y * W + x1) as never, (y - ty * ch) * cw);
      yield { ty, tx, chunk };
    }
  }
}

/** Mean of the valid samples in each f x f block (fewer at the right and bottom edges); NaN where none.
 *  `into` (sized for this level) is reused instead of allocating; `data` is then `into.sum`. */
export function blockMean(values: Float32Array | Float64Array, W: number, H: number, f: number, into?: { sum: Float64Array; cnt: Uint32Array }): { data: Float64Array; width: number; height: number } {
  const w = Math.ceil(W / f), h = Math.ceil(H / f);
  const sum = into ? into.sum.fill(0) : new Float64Array(w * h), cnt = into ? into.cnt.fill(0) : new Uint32Array(w * h);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / f) * w;
    for (let x = 0; x < W; x++) {
      const v = values[y * W + x];
      if (v === v) { const k = row + Math.floor(x / f); sum[k] += v; cnt[k]++; }
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : NaN;
  return { data: sum, width: w, height: h };
}

interface ChannelAcc { min: number; max: number; sample: number[]; diffs: number[]; seen: number }

function percentile(sorted: Float64Array, p: number): number {
  if (!sorted.length) return NaN;
  const r = (p / 100) * (sorted.length - 1), lo = Math.floor(r), hi = Math.ceil(r);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (r - lo);
}

function finishStats(acc: ChannelAcc): FluximgStats {
  const s = Float64Array.from(acc.sample).sort();
  if (!s.length) return { count: 0, min: 0, max: 0, percentiles: Object.fromEntries(PERCENTILE_KEYS.map((k) => [k, 0])), hist: { lo: 0, hi: 1, counts: new Array(256).fill(0) } };
  const percentiles: Record<string, number> = {};
  for (const k of PERCENTILE_KEYS) percentiles[k] = percentile(s, Number(k));
  let lo = percentiles["0.1"], hi = percentiles["99.9"];
  if (!(hi > lo)) { lo = acc.min; hi = acc.max > acc.min ? acc.max : acc.min + 1; }
  const counts = new Array<number>(256).fill(0), k = 256 / (hi - lo);
  for (let i = 0; i < s.length; i++) { const b = Math.floor((s[i] - lo) * k); if (b >= 0 && b < 256) counts[b]++; else if (s[i] === hi) counts[255]++; }
  return { count: s.length, min: acc.min, max: acc.max, percentiles, hist: { lo, hi, counts } };
}

const defaultRange = (st: FluximgStats): [number, number] => {
  let lo = st.percentiles["1"], hi = st.percentiles["99.8"];
  if (!(hi > lo)) { lo = st.min; hi = st.max; }
  if (!(hi > lo)) hi = lo + 1;
  return [lo, hi];
};

/** What one pass over a set of planes learns: range, a value sample and a neighbour-difference sample per channel. */
function newAcc(): ChannelAcc { return { min: Infinity, max: -Infinity, sample: [], diffs: [], seen: 0 }; }

function learnPlane(acc: ChannelAcc, plane: FluximgTypedArray, W: number, H: number, isFloat: boolean, nodata: number | null, sampleStride: number, diffStride: number): { sum: number; count: number } {
  let sum = 0, count = 0;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (isFloat ? !Number.isFinite(v) : v === nodata) continue;
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
    sum += v; count++;
    if (acc.seen++ % sampleStride === 0) acc.sample.push(v);
  }
  if (diffStride > 0 && isFloat) collectNeighbourDiffs(plane, W, H, diffStride, acc.diffs);
  return { sum, count };
}

function chooseEncoding(accs: ChannelAcc[], dtype: FluximgDtype, lossless: boolean, threshold: number, notes: string[], what: string): FluximgEncoding {
  if (!isFloatDtype(dtype)) return { kind: "exact", sourceDtype: dtype };
  if (lossless) { notes.push(`${what}: stored exactly (${dtype}), as asked.`); return { kind: "exact", sourceDtype: dtype }; }
  const params = accs.map((a) => linear16Params(Number.isFinite(a.min) ? a.min : 0, Number.isFinite(a.max) ? a.max : 0));
  const ratios = accs.map((a, i) => guardRatio(params[i].scale, median(a.diffs)));
  const guard = { stepOverNeighbour: ratios, threshold };
  if (guardPasses(ratios, threshold)) {
    notes.push(`${what}: stored at 16 bits per channel range (largest step ${Math.max(...ratios.map((r) => r ?? 0)).toPrecision(2)} of the neighbour difference; limit ${threshold}).`);
    return { kind: "linear16", channels: params, nodataCode: 0, sourceDtype: dtype, guard };
  }
  notes.push(`${what}: stored exactly (${dtype}). A 16-bit copy would be too coarse for this image (step / neighbour difference: ${ratios.map((r) => (r === null ? "no variation" : r.toPrecision(2))).join(", ")}; limit ${threshold}).`);
  return { kind: "exact", sourceDtype: dtype, fallback: "guard", guard };
}

/** Store one plane's values under an encoding: the stored dtype and samples. */
function storePlane(values: FluximgTypedArray, encoding: FluximgEncoding, channel: number): FluximgTypedArray {
  if (encoding.kind !== "linear16") return values;
  const out = new Uint16Array(values.length);
  const p = encoding.channels[Math.min(channel, encoding.channels.length - 1)];
  encodeLinear16(values, p.scale, p.offset, out);
  return out;
}

const storedDtype = (dtype: FluximgDtype, enc: FluximgEncoding): FluximgDtype => (enc.kind === "linear16" ? "uint16" : dtype);
const storedFill = (dtype: FluximgDtype, enc: FluximgEncoding, nodata: number | null): number =>
  enc.kind === "linear16" ? 0 : isFloatDtype(dtype) ? NaN : nodata ?? 0;

function innerShape(shape: readonly number[], tileThreshold: number, tileSize: number): number[] {
  const nd = shape.length, H = shape[nd - 2], W = shape[nd - 1];
  const tiled = Math.max(H, W) > tileThreshold;
  return [...new Array(nd - 2).fill(1), tiled ? Math.min(tileSize, H) : H, tiled ? Math.min(tileSize, W) : W];
}

export async function writeFluximg(io: BundleWriteIO, codec: ZstdCodec, input: WriteInput, options: WriteOptions = {}): Promise<WriteReport> {
  if (!codec.compress) throw new Error("fluximg: this codec cannot compress");
  const zstdLevel = options.zstdLevel ?? DEFAULT_ZSTD_LEVEL;
  const tileThreshold = options.tileThreshold ?? TILE_THRESHOLD, tileSize = options.tileSize ?? TILE_SIZE;
  const overviewFloor = options.overviewFloor ?? OVERVIEW_FLOOR, maxShard = options.maxShardBytes ?? MAX_SHARD_BYTES;
  const threshold = options.guardThreshold ?? GUARD_THRESHOLD;
  const { signal, onProgress } = options;
  const window = Math.max(1, Math.floor(options.concurrency ?? 1));
  const { source } = input;
  const bytesRead = (): number | undefined => (source as { bytesRead?: unknown }).bytesRead as number | undefined;
  checkAbort(signal);
  const { dims, shape, dtype } = source;
  const nd = dims.length;
  if (nd < 2 || dims[nd - 2] !== "y" || dims[nd - 1] !== "x") throw new Error("fluximg: the last two dimensions must be y and x");
  if (JSON.stringify(canonicalDims(dims)) !== JSON.stringify(dims)) throw new Error(`fluximg: dims must be in canonical order ${JSON.stringify(canonicalDims(dims))}`);
  if (new Set(dims).size !== nd) throw new Error("fluximg: duplicate dimension name");
  const H = shape[nd - 2], W = shape[nd - 1];
  const ci = dims.indexOf("c"), C = ci >= 0 ? shape[ci] : 1;
  const leadShape = shape.slice(0, nd - 2);
  const isFloat = isFloatDtype(dtype);
  const nodata = isFloat ? null : input.nodata ?? null;
  const notes: string[] = [];
  let bytes = 0, files = 0;

  // ---- pass 1: learn the image -------------------------------------------------------------------
  const accs = Array.from({ length: C }, newAcc);
  const planesPerChannel = product(leadShape) / C;
  const sampleStride = Math.max(1, Math.ceil((planesPerChannel * H * W) / 1_000_000));
  const diffEvery = Math.max(1, Math.floor(planesPerChannel / 40));
  const diffStride = Math.max(1, Math.ceil((Math.min(planesPerChannel, 40) * H * W) / 2_000_000));
  const profileDims = dims.slice(0, nd - 2).filter((d) => d !== "c");
  const profSum: Record<string, Float64Array[]> = {}, profCnt: Record<string, Float64Array[]> = {};
  for (const d of profileDims) {
    const n = shape[dims.indexOf(d)];
    profSum[d] = Array.from({ length: C }, () => new Float64Array(n));
    profCnt[d] = Array.from({ length: C }, () => new Float64Array(n));
  }
  const seenPerChannel = new Array<number>(C).fill(0);
  const totalPlanes = product(leadShape);
  let done = 0;
  // Preview and automatic regions (opt-in): the opening planes, downsampled, and the union of sampled masks.
  const opening = dims.slice(0, nd - 2).map((d) => (d === "c" ? -1 : input.defaults?.index?.[d] ?? (d === "z" ? Math.floor(shape[dims.indexOf(d)] / 2) : 0)));
  const previewPlanes: Array<Float64Array | null> = new Array(C).fill(null);
  const previewF = Math.max(1, Math.ceil(Math.max(H, W) / PREVIEW_SIDE));
  const regionPlanes = options.regions === "auto" ? evenPlanes(totalPlanes, REGION_PLANES) : null;
  let union: Uint8Array | null = null, missingSeen = false;
  for (const lead of ndindex(leadShape.length ? leadShape : [1])) {
    const leading = leadShape.length ? lead : [];
    const c = ci >= 0 ? leading[ci] : 0;
    const plane = await source.plane(leading);
    const takeDiffs = seenPerChannel[c]++ % diffEvery === 0;
    const { sum, count } = learnPlane(accs[c], plane, W, H, isFloat, nodata, sampleStride, takeDiffs ? diffStride : 0);
    for (const d of profileDims) {
      const i = leading[dims.indexOf(d)];
      profSum[d][c][i] += sum; profCnt[d][c][i] += count;
    }
    if (count < H * W) missingSeen = true;
    if (regionPlanes?.has(done)) {
      union ??= new Uint8Array(H * W);
      for (let i = 0; i < plane.length; i++) if (isFloat ? Number.isFinite(plane[i]) : plane[i] !== nodata) union[i] = 1;
    }
    if (options.preview && !previewPlanes[c] && opening.every((o, k) => o < 0 || leading[k] === o)) {
      const v = new Float64Array(plane.length);
      for (let i = 0; i < plane.length; i++) { const x = plane[i]; v[i] = (isFloat ? Number.isFinite(x) : x !== nodata) ? x : NaN; }
      previewPlanes[c] = previewF > 1 ? blockMean(v, W, H, previewF).data : v;
    }
    checkAbort(signal);
    onProgress?.({ phase: "learn", done: ++done, total: totalPlanes, bytesRead: bytesRead() });
  }
  const encoding = chooseEncoding(accs, dtype, input.lossless === true, threshold, notes, "pixels");
  const sDtype = storedDtype(dtype, encoding), sFill = storedFill(dtype, encoding, nodata);

  // ---- levels ------------------------------------------------------------------------------------
  const factors = [1];
  if (Math.max(H, W) > tileThreshold) {
    let f = FIRST_OVERVIEW;
    for (;;) { factors.push(f); if (Math.max(Math.ceil(H / f), Math.ceil(W / f)) <= overviewFloor) break; f *= 2; }
  }
  const pixelsPath = "pixels";
  const writers = factors.map((f, i) => {
    const lshape = [...leadShape, Math.ceil(H / f), Math.ceil(W / f)];
    return new ArrayWriter(io, codec, `${pixelsPath}/${i}`, lshape, sDtype, innerShape(lshape, tileThreshold, tileSize), sFill, dims, zstdLevel, maxShard, window);
  });

  // ---- pass 2: store -----------------------------------------------------------------------------
  // Overview scratch, allocated once: the plane's values and each level's block sums.
  const values = factors.length > 1 ? new Float64Array(W * H) : null;
  const scratch = factors.map((f) => (f === 1 ? null : { sum: new Float64Array(Math.ceil(W / f) * Math.ceil(H / f)), cnt: new Uint32Array(Math.ceil(W / f) * Math.ceil(H / f)) }));
  done = 0;
  for (const lead of ndindex(leadShape.length ? leadShape : [1])) {
    const leading = leadShape.length ? lead : [];
    const c = ci >= 0 ? leading[ci] : 0;
    const plane = await source.plane(leading);
    if (values) for (let i = 0; i < plane.length; i++) { const v = plane[i]; values[i] = (isFloat ? Number.isFinite(v) : v !== nodata) ? v : NaN; }
    for (let li = 0; li < factors.length; li++) {
      const w = writers[li], lw = w.shape[nd - 1], lh = w.shape[nd - 2];
      let stored: FluximgTypedArray;
      if (li === 0) stored = storePlane(plane, encoding, c);
      else {
        // Overviews are means of the VALUES, re-stored under the same encoding. Every branch hands the writer a new
        // array: chunks may still be compressing when the scratch is reused for the next plane.
        const m = blockMean(values!, W, H, factors[li], scratch[li]!).data;
        if (encoding.kind === "linear16") stored = storePlane(m, encoding, c);
        else if (dtype === "float64") stored = m.slice();
        else if (dtype === "float32") stored = Float32Array.from(m);
        else { stored = allocTyped(dtype, m.length); for (let i = 0; i < m.length; i++) stored[i] = m[i] === m[i] ? Math.round(m[i]) : (nodata ?? 0); }
      }
      for (const { ty, tx, chunk } of tilesOf(stored, lw, lh, w.inner[nd - 1], w.inner[nd - 2], sDtype, sFill)) {
        await w.add([...leading, ty, tx], chunk);
      }
    }
    checkAbort(signal);
    onProgress?.({ phase: "store", done: ++done, total: totalPlanes, bytesRead: bytesRead() });
  }
  const levels: FluximgLevel[] = [];
  for (let i = 0; i < writers.length; i++) {
    await writers[i].finish();
    levels.push({ path: String(i), shape: writers[i].shape, downsample: factors[i] });
    bytes += writers[i].bytes; files += writers[i].files;
  }

  // ---- channels, profiles ------------------------------------------------------------------------
  const stats = accs.map(finishStats);
  const defaults = defaultChannelColours(C);
  const channels: FluximgChannel[] = stats.map((st, i) => {
    const given = input.channels?.[i] ?? {};
    const lut = given.lut ?? null;
    const color = lut ? null : given.color ?? defaults[i];
    return { name: given.name ?? (C === 1 ? "image" : `channel ${i + 1}`), color, lut: lut ?? (color ? null : "gray"), range: given.range ?? defaultRange(st), stats: st,
      ...(given.visible === false ? { visible: false } : {}) };
  });
  const profiles: FluximgManifest["profiles"] = {};
  for (const d of profileDims) {
    profiles[d] = { mean: profSum[d].map((sums, c) => Array.from(sums, (s, i) => (profCnt[d][c][i] > 0 ? s / profCnt[d][c][i] : null))) };
  }
  const axes: Record<string, FluximgAxis> = {};
  for (const d of dims) {
    if (d === "c") continue;
    const a = input.axes?.[d] ?? {};
    axes[d] = a.coords ? { unit: a.unit ?? null, coords: a.coords, ...(a.labels ? { labels: a.labels } : {}) }
      : { unit: a.unit ?? null, scale: a.scale ?? 1, offset: a.offset ?? 0, ...(a.labels ? { labels: a.labels } : {}) };
    if (a.coords && a.coords.length !== shape[dims.indexOf(d)]) throw new Error(`fluximg: axis ${d} has ${a.coords.length} coords for ${shape[dims.indexOf(d)]} positions`);
    if ((d === "x" || d === "y") && a.coords) throw new Error("fluximg: x and y must be evenly spaced (scale / offset)");
  }

  // ---- OME-Zarr 0.5 metadata on the pixel group ------------------------------------------------------
  const ome = dims.every((d) => ["t", "c", "z", "y", "x"].includes(d));
  let groupAttrs: Record<string, unknown> = {};
  if (ome) {
    const omeAxes = dims.map((d) => {
      const type = d === "t" ? "time" : d === "c" ? "channel" : "space";
      const unit = axes[d]?.unit ? OME_UNITS[axes[d].unit as string] : undefined;
      return { name: d, type, ...(unit && type !== "channel" ? { unit } : {}) };
    });
    const scale0 = dims.map((d) => (d === "c" ? 1 : axes[d].scale ?? 1));
    const datasets = factors.map((f, i) => ({
      path: String(i),
      coordinateTransformations: [{ type: "scale", scale: dims.map((d, k) => scale0[k] * (d === "x" || d === "y" ? f : 1)) }],
    }));
    // OME tools apply the window to STORED numbers, so a compact image's window is given in codes.
    const toStored = (v: number, c: number): number => (encoding.kind === "linear16" ? 1 + (v - encoding.channels[c].offset) / encoding.channels[c].scale : v);
    groupAttrs = {
      ome: {
        version: "0.5",
        multiscales: [{ name: input.name, axes: omeAxes, datasets }],
        ...(ci >= 0 ? { omero: { channels: channels.map((ch, c) => ({
          label: ch.name, active: ch.visible !== false, color: (ch.color ?? "#ffffff").replace("#", "").toUpperCase(),
          window: { start: toStored(ch.range[0], c), end: toStored(ch.range[1], c), min: toStored(ch.stats.min, c), max: toStored(ch.stats.max, c) },
        })) } } : {}),
      },
    };
  }
  const groupText = JSON.stringify(groupMetaJson(groupAttrs), null, 1);
  await io.writeText(`${pixelsPath}/zarr.json`, groupText); bytes += groupText.length; files++;

  // ---- layers ------------------------------------------------------------------------------------
  const layers: FluximgLayer[] = [];
  const ids = new Set<string>();
  let objectLayers = 0;                                       // vector + label layers so far: their default colours cycle
  const nextLayerColour = (): string => DEFAULT_LAYER_COLOURS[objectLayers++ % DEFAULT_LAYER_COLOURS.length];
  for (const L of input.layers ?? []) {
    if (!ID_RE.test(L.id)) throw new Error(`fluximg: layer id ${JSON.stringify(L.id)} must match ${ID_RE}`);
    if (ids.has(L.id)) throw new Error(`fluximg: duplicate layer id ${L.id}`);
    ids.add(L.id);
    const base = { id: L.id, name: L.name ?? L.id, ...(L.visible !== undefined ? { visible: L.visible } : {}), ...(L.from ? { from: L.from } : {}) };
    if (L.kind === "intensity") {
      if (L.data.length !== W * H) throw new Error(`fluximg: layer ${L.id} must be ${H} x ${W}`);
      const acc = newAcc(), lf = isFloatDtype(L.dtype);
      learnPlane(acc, L.data, W, H, lf, null, Math.max(1, Math.ceil((W * H) / 1_000_000)), 1);
      const enc = chooseEncoding([acc], L.dtype, L.lossless === true, threshold, notes, `layer ${L.id}`);
      const w = new ArrayWriter(io, codec, `layers/${L.id}`, [H, W], storedDtype(L.dtype, enc), innerShape([H, W], tileThreshold, tileSize), storedFill(L.dtype, enc, null), ["y", "x"], zstdLevel, maxShard);
      const stored = storePlane(L.data, enc, 0);
      for (const { ty, tx, chunk } of tilesOf(stored, W, H, w.inner[1], w.inner[0], w.dtype, w.fill)) await w.add([ty, tx], chunk);
      await w.finish(); bytes += w.bytes; files += w.files;
      const st = finishStats(acc);
      layers.push({ ...base, kind: "intensity", path: `layers/${L.id}`, dtype: w.dtype, encoding: enc, color: L.lut ? null : L.color ?? "#ff00ff", lut: L.lut ?? null,
        range: L.range ?? [st.percentiles["50"], st.percentiles["99.8"] > st.percentiles["50"] ? st.percentiles["99.8"] : st.percentiles["50"] + 1], opacity: L.opacity ?? 1, stats: st });
    } else if (L.kind === "labels") {
      if (L.data.length !== W * H) throw new Error(`fluximg: layer ${L.id} must be ${H} x ${W}`);
      const ldtype: "uint16" | "uint32" = L.data instanceof Uint16Array ? "uint16" : "uint32";
      const w = new ArrayWriter(io, codec, `layers/${L.id}`, [H, W], ldtype, innerShape([H, W], tileThreshold, tileSize), 0, ["y", "x"], zstdLevel, maxShard);
      for (const { ty, tx, chunk } of tilesOf(L.data, W, H, w.inner[1], w.inner[0], ldtype, 0)) await w.add([ty, tx], chunk);
      await w.finish(); bytes += w.bytes; files += w.files;
      const outlines = labelOutlines(L.data, W, H);
      const table: FluximgTable = L.table ?? { key: "label", columns: { label: outlines.map((o) => o.label), pixels: outlines.map((o) => o.pixels) } };
      const key = L.key ?? table.key ?? "label";
      const labelCol = table.columns.label, keyCol = table.columns[key];
      if (!labelCol || !keyCol) throw new Error(`fluximg: layer ${L.id} table needs columns "label" and "${key}"`);
      const keyOf = new Map<number, string | number>();
      labelCol.forEach((l, i) => keyOf.set(Number(l), keyCol[i] as string | number));
      for (const o of outlines) if (!keyOf.has(o.label)) throw new Error(`fluximg: layer ${L.id}: label ${o.label} has no table row`);
      const colour = L.color ?? nextLayerColour();
      const body = outlines.map((o) => `<path id="${L.id}/${esc(String(keyOf.get(o.label)))}" data-key="${esc(String(keyOf.get(o.label)))}" data-label="${o.label}" d="${o.d}"/>`).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><g id="${L.id}" fill="${colour}" fill-opacity="0.12" fill-rule="evenodd" stroke="${colour}" stroke-width="1">${body}</g></svg>`;
      const tableText = JSON.stringify({ key, columns: table.columns });
      await io.writeText(`layers/${L.id}.svg`, svg); await io.writeText(`layers/${L.id}.table.json`, tableText);
      bytes += svg.length + tableText.length; files += 2;
      layers.push({ ...base, kind: "labels", path: `layers/${L.id}`, dtype: ldtype, outlines: `layers/${L.id}.svg`, table: `layers/${L.id}.table.json`, key, count: outlines.length, color: colour, weights: L.weights ?? null });
    } else {
      const colour = L.color ?? nextLayerColour();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><g id="${L.id}" fill="none" stroke="${colour}" stroke-width="1">${L.body}</g></svg>`;
      await io.writeText(`layers/${L.id}.svg`, svg); bytes += svg.length; files++;
      let tablePath: string | null = null;
      if (L.table) { tablePath = `layers/${L.id}.table.json`; const t = JSON.stringify({ key: L.key ?? L.table.key, columns: L.table.columns }); await io.writeText(tablePath, t); bytes += t.length; files++; }
      layers.push({ ...base, kind: "vector", path: `layers/${L.id}.svg`, table: tablePath, key: L.table ? L.key ?? L.table.key : null, count: L.count, color: colour });
    }
  }
  for (const L of layers) if (L.kind === "labels" && L.weights && !layers.some((x) => x.kind === "intensity" && x.id === L.weights)) throw new Error(`fluximg: layer ${L.id} names a weights layer that does not exist`);

  // ---- opt-in extras: automatic regions and preview.png ---------------------------------------------------
  const regions = [...(input.regions ?? [])];
  if (union && missingSeen) regions.push(...autoRegions(union, W, H, new Set(regions.map((r) => r.id)), options.regionMinPixels ?? REGION_MIN_PIXELS));
  if (options.preview && previewPlanes.some(Boolean)) {
    const pw = Math.ceil(W / previewF), ph = Math.ceil(H / previewF);
    const png = options.preview.encodePng(previewRgba(previewPlanes, channels, pw, ph), pw, ph);
    await io.writeFile("preview.png", png); bytes += png.byteLength; files++;
  }

  // ---- the manifest is written LAST: a bundle without it is an unfinished write -----------------------
  const manifest: FluximgManifest = {
    spec: FLUXIMG_SPEC, name: input.name,
    pixels: { path: pixelsPath, dims, shape, dtype: sDtype, levels, encoding, ...(isFloat || nodata === null ? {} : { nodata }), ome },
    axes, channels, ...(input.photometric ? { photometric: input.photometric } : {}),
    ...(profileDims.length ? { profiles } : {}), ...(input.defaults ? { defaults: input.defaults } : {}),
    layers, regions, ...(input.world ? { world: input.world } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
  const text = JSON.stringify(manifest, null, 1);
  await io.writeText(FLUXIMG_MANIFEST, text); bytes += text.length; files++;
  return { manifest, bytes, files, notes };
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** preview.png: at most this many pixels on the longer side (SPEC 8). */
export const PREVIEW_SIDE = 512;
/** Planes sampled for automatic regions, the smallest region, and the most regions kept (fluxplot's constants). */
export const REGION_PLANES = 16, REGION_MIN_PIXELS = 64, MAX_AUTO_REGIONS = 64;

function evenPlanes(total: number, k: number): Set<number> {
  k = Math.min(k, total);
  if (k <= 1) return new Set([0]);
  return new Set(Array.from({ length: k }, (_, i) => Math.round((i * (total - 1)) / (k - 1))));
}

/**
 * Regions from the connected valid areas (8-neighbour) of `mask`: areas under `minPixels` are ignored, a box
 * covering the whole image is never a region, and there are none when more than MAX_AUTO_REGIONS remain. Sorted
 * by (x, y, width, height); ids roi_1, roi_2, ... skipping ids already taken. Two-pass labelling with union-find.
 */
export function autoRegions(mask: Uint8Array, W: number, H: number, taken: Set<string> = new Set(), minPixels = REGION_MIN_PIXELS): FluximgRegion[] {
  const label = new Int32Array(W * H), parent: number[] = [0];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const join = (a: number, b: number): void => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!mask[i]) continue;
    let l = 0;
    const look = (j: number): void => { const m = label[j]; if (m) { if (!l) l = m; else join(l, m); } };
    if (x > 0) look(i - 1);
    if (y > 0) { if (x > 0) look(i - W - 1); look(i - W); if (x < W - 1) look(i - W + 1); }
    if (!l) { l = parent.length; parent.push(l); }
    label[i] = l;
  }
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l0 = label[y * W + x];
    if (!l0) continue;
    const l = find(l0), b = boxes.get(l);
    if (!b) boxes.set(l, { x0: x, y0: y, x1: x, y1: y, n: 1 });
    else { if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; b.n++; }
  }
  const rects = [...boxes.values()].filter((b) => b.n >= Math.max(1, Math.floor(minPixels)))
    .map((b) => [b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1] as const)
    .filter(([x, y, w, h]) => !(x === 0 && y === 0 && w === W && h === H));
  if (!rects.length || rects.length > MAX_AUTO_REGIONS) return [];
  rects.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  let k = 0;
  return rects.map(([x, y, width, height], i) => {
    let id: string;
    do { id = `roi_${++k}`; } while (taken.has(id));
    taken.add(id);
    return { id, name: `ROI ${i + 1}`, rect: { x, y, width, height } };
  });
}

/** The default view as straight RGBA: visible channels added (colour ramps; LUT channels drawn gray), no data transparent. */
function previewRgba(planes: Array<Float64Array | null>, channels: FluximgChannel[], w: number, h: number): Uint8Array {
  let shown = channels.map((_, c) => c).filter((c) => channels[c].visible !== false && planes[c]);
  if (!shown.length) shown = channels.map((_, c) => c).filter((c) => planes[c]).slice(0, 1);
  const rgb = new Float64Array(w * h * 3), any = new Uint8Array(w * h);
  for (const c of shown) {
    const v = planes[c]!, ch = channels[c], [lo, hi] = ch.range;
    const col = ch.color ? [1, 3, 5].map((k) => parseInt(ch.color!.slice(k, k + 2), 16) / 255) : [1, 1, 1];
    for (let i = 0; i < w * h; i++) {
      const x = v[i];
      if (x !== x) continue;
      any[i] = 1;
      const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
      rgb[i * 3] += t * col[0]; rgb[i * 3 + 1] += t * col[1]; rgb[i * 3 + 2] += t * col[2];
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(Math.min(1, Math.max(0, rgb[i * 3 + k])) * 255);
    out[i * 4 + 3] = any[i] ? 255 : 0;
  }
  return out;
}
