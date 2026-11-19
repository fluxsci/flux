/**
 * Read a fluximg bundle through an injected IO. Pure: the same code runs in a renderer worker (ranged
 * fetches + WASM zstd), in flux-core (fs + zstd) and in scripts.
 *
 * Opening a bundle reads only `fluximg.json`. An array's `zarr.json` and a shard's index are read on first
 * use and kept; after that every chunk costs exactly one ranged read and one decompression.
 */
import {
  DTYPE_BYTES, FLUXIMG_MANIFEST, FLUXIMG_SPEC, allocTyped, typedArrayFor,
  type FluximgDtype, type FluximgManifest, type FluximgTable, type FluximgTypedArray,
} from "./types";
import {
  FluximgFormatError, chunkCounts, chunksPerShard, decodeShardIndex, locateChunk, parseArrayMeta, product, shardIndexBytes, shardKey,
  type ShardIndex, type ZarrArrayMeta,
} from "./zarr";

/** Bundle-relative POSIX paths. `readRange` with a negative offset reads that many bytes from the end. */
export interface BundleReadIO {
  readText(path: string): Promise<string>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  exists?(path: string): Promise<boolean>;
}

export interface ZstdCodec {
  decompress(src: Uint8Array, outBytes: number): Uint8Array;
  compress?(src: Uint8Array, level: number): Uint8Array;
}

export interface ArrayHandle {
  /** Bundle-relative path of the array directory. */
  path: string;
  meta: ZarrArrayMeta;
  /** Inner chunks along each dimension. */
  counts: number[];
  /** Samples in one inner chunk. */
  chunkLength: number;
}

export interface OpenOptions {
  /** Check each shard index against its crc32c (the validator does; interactive readers need not). */
  verifyIndex?: boolean;
}

export interface FluximgReader {
  manifest: FluximgManifest;
  /** A pixel level by index into `manifest.pixels.levels`. */
  level(i: number): Promise<ArrayHandle>;
  /** Any Zarr array of the bundle by path (a raster layer). */
  array(path: string): Promise<ArrayHandle>;
  /** One inner chunk, or null when it was never written (entirely fill). */
  readChunk(a: ArrayHandle, chunkCoords: readonly number[]): Promise<FluximgTypedArray | null>;
  /** A whole (y, x) plane of an array at the given leading indices, tiles assembled, missing chunks filled. */
  readPlane(a: ArrayHandle, leading: readonly number[]): Promise<FluximgTypedArray>;
  /** A rectangle of a plane, clipped to the array: returns row-major samples of `width` x `height`. */
  readRegion(a: ArrayHandle, leading: readonly number[], rect: { x: number; y: number; width: number; height: number }): Promise<{ data: FluximgTypedArray; x: number; y: number; width: number; height: number }>;
  readTable(path: string): Promise<FluximgTable>;
  readText(path: string): Promise<string>;
}

const join = (...parts: string[]): string => parts.filter(Boolean).join("/").replace(/\/+/g, "/");

export function parseManifest(text: string): FluximgManifest {
  let m: any;
  try { m = JSON.parse(text); } catch { throw new FluximgFormatError("not JSON", FLUXIMG_MANIFEST); }
  if (!m || m.spec !== FLUXIMG_SPEC) throw new FluximgFormatError(`spec must be "${FLUXIMG_SPEC}", got ${JSON.stringify(m?.spec)}`, FLUXIMG_MANIFEST);
  const p = m.pixels;
  if (!p || !Array.isArray(p.dims) || !Array.isArray(p.shape) || p.dims.length !== p.shape.length || !Array.isArray(p.levels) || p.levels.length < 1) {
    throw new FluximgFormatError("pixels.dims / shape / levels are malformed", FLUXIMG_MANIFEST);
  }
  if (!Array.isArray(m.channels) || !Array.isArray(m.layers) || !Array.isArray(m.regions) || typeof m.axes !== "object") {
    throw new FluximgFormatError("channels, layers, regions and axes are required", FLUXIMG_MANIFEST);
  }
  return m as FluximgManifest;
}

export async function openFluximg(io: BundleReadIO, codec: ZstdCodec, options: OpenOptions = {}): Promise<FluximgReader> {
  const manifest = parseManifest(await io.readText(FLUXIMG_MANIFEST));
  const arrays = new Map<string, Promise<ArrayHandle>>();
  const indexes = new Map<string, Promise<ShardIndex>>();

  const array = (path: string): Promise<ArrayHandle> => {
    let h = arrays.get(path);
    if (!h) {
      h = io.readText(join(path, "zarr.json")).then((t) => {
        const meta = parseArrayMeta(JSON.parse(t), join(path, "zarr.json"));
        return { path, meta, counts: chunkCounts(meta.shape, meta.inner), chunkLength: product(meta.inner) };
      });
      arrays.set(path, h);
    }
    return h;
  };

  const shardIndex = (a: ArrayHandle, shard: readonly number[]): Promise<ShardIndex> => {
    const file = join(a.path, shardKey(shard));
    let p = indexes.get(file);
    if (!p) {
      const n = product(chunksPerShard(a.meta));
      const bytes = shardIndexBytes(n);
      p = io.readRange(file, -bytes, bytes).then((b) => decodeShardIndex(b, n, options.verifyIndex === true, file));
      indexes.set(file, p);
    }
    return p;
  };

  const readChunk = async (a: ArrayHandle, chunkCoords: readonly number[]): Promise<FluximgTypedArray | null> => {
    const { shard, local } = locateChunk(a.meta, chunkCoords);
    const file = join(a.path, shardKey(shard));
    let index: ShardIndex;
    try { index = await shardIndex(a, shard); } catch (e) {
      // A shard that was never written is entirely fill. Only a missing FILE means that; a bad index is an error.
      if (e instanceof FluximgFormatError) throw e;
      if (io.exists && !(await io.exists(file))) return null;
      throw e;
    }
    const off = index.offsets[local];
    if (off < 0) return null;
    const compressed = await io.readRange(file, off, index.lengths[local]);
    const bytes = a.chunkLength * DTYPE_BYTES[a.meta.dtype];
    const raw = codec.decompress(compressed, bytes);
    if (raw.byteLength !== bytes) throw new FluximgFormatError(`chunk decodes to ${raw.byteLength} bytes, expected ${bytes}`, `${file}#${local}`);
    return view(a.meta.dtype, raw, a.chunkLength);
  };

  const readRegion: FluximgReader["readRegion"] = async (a, leading, rect) => {
    const nd = a.meta.shape.length, H = a.meta.shape[nd - 2], W = a.meta.shape[nd - 1];
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(W, Math.ceil(rect.x + rect.width)), y1 = Math.min(H, Math.ceil(rect.y + rect.height));
    const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
    const out = allocTyped(a.meta.dtype, w * h);
    const fill = a.meta.fill;
    if (fill !== 0) out.fill(fill as never);
    if (w === 0 || h === 0) return { data: out, x: x0, y: y0, width: w, height: h };
    const ch = a.meta.inner[nd - 2], cw = a.meta.inner[nd - 1];
    const lead = leading.map((v, i) => Math.floor(v / a.meta.inner[i]));
    // Leading dimensions always have an inner chunk extent of 1 in fluximg/1; the offset keeps this general.
    let leadOffset = 0;
    for (let i = 0; i < nd - 2; i++) leadOffset = leadOffset * a.meta.inner[i] + (leading[i] % a.meta.inner[i]);
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(y0 / ch); ty * ch < y1; ty++) {
      for (let tx = Math.floor(x0 / cw); tx * cw < x1; tx++) {
        jobs.push(readChunk(a, [...lead, ty, tx]).then((tile) => {
          if (!tile) return;
          const base = leadOffset * ch * cw;
          const sx0 = Math.max(x0, tx * cw), sx1 = Math.min(x1, (tx + 1) * cw);
          const sy0 = Math.max(y0, ty * ch), sy1 = Math.min(y1, (ty + 1) * ch);
          for (let y = sy0; y < sy1; y++) {
            const src = base + (y - ty * ch) * cw + (sx0 - tx * cw);
            out.set(tile.subarray(src, src + (sx1 - sx0)) as never, (y - y0) * w + (sx0 - x0));
          }
        }));
      }
    }
    await Promise.all(jobs);
    return { data: out, x: x0, y: y0, width: w, height: h };
  };

  const readPlane: FluximgReader["readPlane"] = async (a, leading) => {
    const nd = a.meta.shape.length, H = a.meta.shape[nd - 2], W = a.meta.shape[nd - 1];
    if (a.meta.inner[nd - 2] >= H && a.meta.inner[nd - 1] >= W && a.meta.inner.slice(0, nd - 2).every((v) => v === 1)) {
      // One chunk per plane and no padding: hand the decoded chunk back without a copy.
      if (a.meta.inner[nd - 2] === H && a.meta.inner[nd - 1] === W) {
        const c = await readChunk(a, [...leading, 0, 0]);
        if (c) return c;
        const blank = allocTyped(a.meta.dtype, H * W);
        if (a.meta.fill !== 0) blank.fill(a.meta.fill as never);
        return blank;
      }
    }
    return (await readRegion(a, leading, { x: 0, y: 0, width: W, height: H })).data;
  };

  return {
    manifest,
    level: (i) => {
      const lv = manifest.pixels.levels[i];
      if (!lv) throw new FluximgFormatError(`no level ${i}`, FLUXIMG_MANIFEST);
      return array(join(manifest.pixels.path, lv.path));
    },
    array,
    readChunk,
    readPlane,
    readRegion,
    readTable: async (path) => {
      const t = JSON.parse(await io.readText(path));
      if (!t || typeof t.columns !== "object" || typeof t.key !== "string") throw new FluximgFormatError("table must have key and columns", path);
      return t as FluximgTable;
    },
    readText: (path) => io.readText(path),
  };
}

/** A typed view over decoded bytes, copying only when the bytes are not aligned for the type. */
function view(dtype: FluximgDtype, raw: Uint8Array, length: number): FluximgTypedArray {
  const size = DTYPE_BYTES[dtype];
  if (raw.byteOffset % size === 0) return typedArrayFor(dtype, raw.buffer, raw.byteOffset, length);
  const copy = raw.slice();
  return typedArrayFor(dtype, copy.buffer, 0, length);
}

/**
 * The pixel level to draw from: the coarsest one that still has at least one stored pixel per screen pixel.
 * `pixelsPerScreenPixel` is how many level-0 pixels one output pixel covers along an axis.
 */
export function pickLevel(levels: ReadonlyArray<{ downsample: number }>, pixelsPerScreenPixel: number): number {
  let best = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].downsample <= pixelsPerScreenPixel && levels[i].downsample >= levels[best].downsample) best = i;
  }
  return best;
}
