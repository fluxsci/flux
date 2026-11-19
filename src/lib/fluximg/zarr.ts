/**
 * The Zarr v3 profile fluximg/1 uses, and nothing more.
 *
 * Every array is stored through the `sharding_indexed` codec: a file ("shard") holds many independently
 * zstd-compressed inner chunks followed by an index of their byte ranges. That is the whole random-access
 * story: read the index once, then one ranged read per chunk. Pure: no IO here.
 */
import { DTYPE_BYTES, type FluximgDtype } from "./types";

export class FluximgFormatError extends Error {
  constructor(message: string, readonly where = "") {
    super(where ? `${where}: ${message}` : message);
    this.name = "FluximgFormatError";
  }
}

export interface ZarrArrayMeta {
  shape: number[];
  dtype: FluximgDtype;
  /** Shape of one independently compressed chunk. */
  inner: number[];
  /** Shape of one shard (a file): a whole number of inner chunks along every dimension. */
  outer: number[];
  /** NaN for float arrays whose missing value is NaN, otherwise a number. */
  fill: number;
  dims: string[];
  zstdLevel: number;
}

const DTYPES = Object.keys(DTYPE_BYTES) as FluximgDtype[];

export function arrayMetaJson(meta: ZarrArrayMeta, attributes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: meta.shape,
    data_type: meta.dtype,
    chunk_grid: { name: "regular", configuration: { chunk_shape: meta.outer } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: Number.isNaN(meta.fill) ? "NaN" : meta.fill,
    codecs: [
      {
        name: "sharding_indexed",
        configuration: {
          chunk_shape: meta.inner,
          codecs: [
            { name: "bytes", configuration: { endian: "little" } },
            { name: "zstd", configuration: { level: meta.zstdLevel, checksum: false } },
          ],
          index_codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "crc32c" }],
          index_location: "end",
        },
      },
    ],
    dimension_names: meta.dims,
    attributes,
  };
}

export function groupMetaJson(attributes: Record<string, unknown> = {}): Record<string, unknown> {
  return { zarr_format: 3, node_type: "group", attributes };
}

const isIntArray = (v: unknown, n?: number): v is number[] =>
  Array.isArray(v) && (n === undefined || v.length === n) && v.every((x) => Number.isInteger(x) && x >= 0);

/** Parse a `zarr.json`, refusing anything outside the fluximg/1 profile. */
export function parseArrayMeta(json: unknown, where = "zarr.json"): ZarrArrayMeta {
  const bad = (m: string): never => { throw new FluximgFormatError(m, where); };
  if (!json || typeof json !== "object") bad("not an object");
  const j = json as Record<string, any>;
  if (j.zarr_format !== 3 || j.node_type !== "array") bad("not a Zarr v3 array");
  if (!isIntArray(j.shape) || j.shape.length < 2) bad("shape must have at least y and x");
  const nd = j.shape.length;
  if (!DTYPES.includes(j.data_type)) bad(`unsupported data_type ${JSON.stringify(j.data_type)}`);
  if (j.chunk_grid?.name !== "regular" || !isIntArray(j.chunk_grid?.configuration?.chunk_shape, nd)) bad("chunk_grid must be regular");
  const enc = j.chunk_key_encoding;
  if (enc?.name !== "default" || (enc.configuration?.separator ?? "/") !== "/") bad('chunk_key_encoding must be default with "/"');
  if (!Array.isArray(j.codecs) || j.codecs.length !== 1 || j.codecs[0]?.name !== "sharding_indexed") bad("codecs must be exactly [sharding_indexed]");
  const sc = j.codecs[0].configuration ?? {};
  if (!isIntArray(sc.chunk_shape, nd)) bad("sharding chunk_shape missing");
  const inner: number[] = sc.chunk_shape;
  const outer: number[] = j.chunk_grid.configuration.chunk_shape;
  for (let i = 0; i < nd; i++) {
    if (inner[i] < 1 || outer[i] < 1 || outer[i] % inner[i] !== 0) bad("a shard must hold a whole number of inner chunks");
  }
  const codecs = sc.codecs;
  if (!Array.isArray(codecs) || codecs.length !== 2 || codecs[0]?.name !== "bytes" || codecs[1]?.name !== "zstd") bad("inner codecs must be [bytes, zstd]");
  if ((codecs[0].configuration?.endian ?? "little") !== "little") bad("bytes codec must be little-endian");
  const ic = sc.index_codecs;
  if (!Array.isArray(ic) || ic.length !== 2 || ic[0]?.name !== "bytes" || ic[1]?.name !== "crc32c") bad("index codecs must be [bytes, crc32c]");
  if ((sc.index_location ?? "end") !== "end") bad("index_location must be end");
  const fv = j.fill_value;
  const fill = fv === "NaN" ? NaN : typeof fv === "number" ? fv : bad("fill_value must be a number or \"NaN\"");
  const dims = j.dimension_names;
  if (!Array.isArray(dims) || dims.length !== nd || !dims.every((d: unknown) => typeof d === "string")) bad("dimension_names missing");
  return { shape: j.shape, dtype: j.data_type, inner, outer, fill: fill as number, dims, zstdLevel: Number(codecs[1].configuration?.level ?? 0) };
}

export const product = (a: readonly number[]): number => a.reduce((p, v) => p * v, 1);

/** Number of inner chunks along each dimension. */
export const chunkCounts = (shape: readonly number[], inner: readonly number[]): number[] => shape.map((s, i) => Math.ceil(s / inner[i]));
/** Number of shards along each dimension. */
export const shardCounts = (shape: readonly number[], outer: readonly number[]): number[] => shape.map((s, i) => Math.ceil(s / outer[i]));
/** Inner chunks per shard along each dimension. */
export const chunksPerShard = (meta: Pick<ZarrArrayMeta, "inner" | "outer">): number[] => meta.outer.map((o, i) => o / meta.inner[i]);

export const shardKey = (shardCoords: readonly number[]): string => `c/${shardCoords.join("/")}`;

/** Which shard holds an inner chunk, and its C-order position in that shard's index. */
export function locateChunk(meta: Pick<ZarrArrayMeta, "inner" | "outer">, chunkCoords: readonly number[]): { shard: number[]; local: number } {
  const per = chunksPerShard(meta);
  const shard: number[] = [];
  let local = 0;
  for (let i = 0; i < per.length; i++) {
    shard.push(Math.floor(chunkCoords[i] / per[i]));
    local = local * per[i] + (chunkCoords[i] % per[i]);
  }
  return { shard, local };
}

/** Bytes of a shard's trailing index: 16 per inner chunk plus the crc32c. */
export const shardIndexBytes = (nChunks: number): number => nChunks * 16 + 4;

export interface ShardIndex { offsets: Float64Array; lengths: Float64Array }

/** `offsets[i] < 0` marks an inner chunk that was never written (all fill). */
export function decodeShardIndex(bytes: Uint8Array, nChunks: number, verify = false, where = "shard index"): ShardIndex {
  if (bytes.byteLength !== shardIndexBytes(nChunks)) throw new FluximgFormatError(`expected ${shardIndexBytes(nChunks)} bytes, got ${bytes.byteLength}`, where);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (verify) {
    const want = dv.getUint32(nChunks * 16, true);
    const got = crc32c(bytes.subarray(0, nChunks * 16));
    if (want !== got) throw new FluximgFormatError("crc32c mismatch", where);
  }
  const offsets = new Float64Array(nChunks);
  const lengths = new Float64Array(nChunks);
  for (let i = 0; i < nChunks; i++) {
    const ol = dv.getUint32(i * 16, true), oh = dv.getUint32(i * 16 + 4, true);
    const ll = dv.getUint32(i * 16 + 8, true), lh = dv.getUint32(i * 16 + 12, true);
    if (ol === 0xffffffff && oh === 0xffffffff && ll === 0xffffffff && lh === 0xffffffff) { offsets[i] = -1; lengths[i] = 0; }
    else { offsets[i] = oh * 4294967296 + ol; lengths[i] = lh * 4294967296 + ll; }
  }
  return { offsets, lengths };
}

export function encodeShardIndex(index: ShardIndex): Uint8Array {
  const n = index.offsets.length;
  const out = new Uint8Array(shardIndexBytes(n));
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    if (index.offsets[i] < 0) { dv.setUint32(i * 16, 0xffffffff, true); dv.setUint32(i * 16 + 4, 0xffffffff, true); dv.setUint32(i * 16 + 8, 0xffffffff, true); dv.setUint32(i * 16 + 12, 0xffffffff, true); }
    else {
      dv.setUint32(i * 16, index.offsets[i] % 4294967296, true); dv.setUint32(i * 16 + 4, Math.floor(index.offsets[i] / 4294967296), true);
      dv.setUint32(i * 16 + 8, index.lengths[i] % 4294967296, true); dv.setUint32(i * 16 + 12, Math.floor(index.lengths[i] / 4294967296), true);
    }
  }
  dv.setUint32(n * 16, crc32c(out.subarray(0, n * 16)), true);
  return out;
}

let CRC_TABLE: Uint32Array | null = null;
/** CRC-32C (Castagnoli), as the Zarr `crc32c` codec defines it. */
export function crc32c(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Iterate C-order coordinates of a grid: (0,0,…), (0,0,…,1), … */
export function* ndindex(counts: readonly number[]): Generator<number[]> {
  const n = counts.length;
  if (counts.some((c) => c <= 0)) return;
  const idx = new Array<number>(n).fill(0);
  for (;;) {
    yield idx.slice();
    let d = n - 1;
    while (d >= 0 && ++idx[d] === counts[d]) { idx[d] = 0; d--; }
    if (d < 0) return;
  }
}

export const OME_UNITS: Record<string, string> = {
  "µm": "micrometer", um: "micrometer", "μm": "micrometer", nm: "nanometer", mm: "millimeter", cm: "centimeter", m: "meter",
  s: "second", ms: "millisecond", "µs": "microsecond", us: "microsecond", min: "minute", h: "hour",
};
