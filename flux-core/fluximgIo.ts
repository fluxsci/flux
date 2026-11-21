/**
 * Node side of the fluximg IO seam: a bundle directory on disk, and zstd.
 *
 * The format logic is the pure `src/lib/fluximg/*`; this file only adapts `fs` and a zstd implementation to
 * the interfaces it asks for. Decompression prefers Node's built-in zstd and falls back to the same WASM
 * decoder the renderer uses, so a runtime without the built-in can still read. zstd decoding is deterministic,
 * so the two give identical bytes.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import type { BundleReadIO, ZstdCodec } from "../src/lib/fluximg/reader";
import type { BundleWriteIO } from "../src/lib/fluximg/writer";

const inside = (root: string, rel: string): string => {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`fluximg: path escapes the bundle: ${rel}`);
  return abs;
};

export function nodeBundleReader(dir: string): BundleReadIO {
  const root = path.resolve(dir);
  return {
    readText: (rel) => fsp.readFile(inside(root, rel), "utf8"),
    async readRange(rel, offset, length) {
      const fh = await fsp.open(inside(root, rel), "r");
      try {
        const start = offset < 0 ? (await fh.stat()).size + offset : offset;
        if (start < 0) throw new Error(`fluximg: ${rel} is shorter than ${-offset} bytes`);
        const buf = new Uint8Array(length);
        const { bytesRead } = await fh.read(buf, 0, length, start);
        if (bytesRead !== length) throw new Error(`fluximg: short read in ${rel} (${bytesRead} of ${length} bytes at ${start})`);
        return buf;
      } finally { await fh.close(); }
    },
    exists: (rel) => fsp.access(inside(root, rel)).then(() => true, () => false),
  };
}

export function nodeBundleWriter(dir: string): BundleWriteIO {
  const root = path.resolve(dir);
  const put = async (rel: string, data: Uint8Array | string): Promise<void> => {
    const abs = inside(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
  };
  return { writeFile: put, writeText: put };
}

type Zlib = typeof zlib & {
  zstdCompressSync?: (b: Uint8Array, o?: unknown) => Buffer;
  zstdCompress?: (b: Uint8Array, o: unknown, cb: (error: Error | null, out: Buffer) => void) => void;
  zstdDecompressSync?: (b: Uint8Array, o?: unknown) => Buffer;
};

let cached: Promise<ZstdCodec> | null = null;
/** One codec per process. */
export function nodeZstd(): Promise<ZstdCodec> {
  if (cached) return cached;
  cached = (async (): Promise<ZstdCodec> => {
    const z = zlib as Zlib;
    const compress = z.zstdCompressSync
      ? (src: Uint8Array, level: number): Uint8Array => {
          const out = z.zstdCompressSync!(src, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
          return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        }
      : undefined;
    // The same compressor on libuv's thread pool (UV_THREADPOOL_SIZE threads, 4 by default). `pledgedSrcSize`
    // puts the content size in the frame header as the one-shot call does. The stream API still ends some frames
    // differently (an incompressible 256 KiB chunk gets a separate empty last block: 3 bytes more), so its files
    // are valid and deterministic but not always byte-identical to `compress`'s: the writer uses it only when a
    // caller asks for concurrency (the TIFF converter), never for the pinned fixtures.
    const compressAsync = z.zstdCompress
      ? (src: Uint8Array, level: number): Promise<Uint8Array> => new Promise((resolve, reject) => {
          z.zstdCompress!(src, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level }, pledgedSrcSize: src.byteLength }, (error, out) => {
            if (error) reject(error); else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
          });
        })
      : undefined;
    if (z.zstdDecompressSync) {
      return {
        compress, compressAsync,
        decompress(src) { const out = z.zstdDecompressSync!(src); return new Uint8Array(out.buffer, out.byteOffset, out.byteLength); },
      };
    }
    const { ZSTDDecoder } = await import("three/examples/jsm/libs/zstddec.module.js");
    const dec = new ZSTDDecoder();
    await dec.init();
    return { compress, compressAsync, decompress: (src, outBytes) => dec.decode(src, outBytes) };
  })();
  return cached;
}

/** Write a C-order array as a NumPy .npy file (version 1.0). */
export async function writeNpy(file: string, data: Float64Array | Float32Array | Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Int8Array, shape: number[]): Promise<void> {
  const descr =
    data instanceof Float64Array ? "<f8" : data instanceof Float32Array ? "<f4" : data instanceof Uint16Array ? "<u2" : data instanceof Int16Array ? "<i2"
    : data instanceof Uint32Array ? "<u4" : data instanceof Int32Array ? "<i4" : data instanceof Int8Array ? "|i1" : "|u1";
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += " ".repeat(pad === 64 ? 0 : pad) + "\n";
  const head = Buffer.alloc(10);
  head.write("\x93NUMPY", 0, "latin1"); head[6] = 1; head[7] = 0; head.writeUInt16LE(header.length, 8);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.concat([head, Buffer.from(header, "latin1"), Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
}
