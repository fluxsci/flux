/**
 * The Node engine of TIFF import: positional file reads, Node's zlib codecs, and a conversion that writes a
 * `.fluximg` bundle into a STAGING directory and publishes it by one rename. The format logic is the pure
 * `src/lib/tiff/*` and `src/lib/fluximg/writer.ts`; this file only adapts `fs` and `zlib` to them.
 *
 * Guarantees: the input is read in ranges (never whole), so memory is bounded by a few planes plus the writer's
 * shard; a cancelled or failed conversion leaves neither a staging directory nor a bundle; a published bundle has
 * passed the contract validator, and its content id is computed as `electron/fluximgFiles.cjs` computes it, so the
 * app's dedupe recognises it. The output is deterministic (no timestamps), so converting the same file with the
 * same answer twice gives the same content id.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { fluximgContentIdText } from "../electron/fluximgRules.js";
import { nodeBundleReader, nodeZstd } from "./fluximgIo";
import { encodePng } from "./fluximgPng";
import { writeFluximg, type WriteOptions, type WriteProgress } from "../src/lib/fluximg/writer";
import { validateFluximg } from "../src/lib/fluximg/validate";
import type { FluximgManifest } from "../src/lib/fluximg/types";
import { TiffError, type RangedSource } from "../src/lib/tiff/io";
import { openTiff, type TiffFile } from "../src/lib/tiff/ifd";
import { probeFile } from "../src/lib/tiff/probe";
import { inferDims, answerProblems, type InferOptions } from "../src/lib/tiff/infer";
import { tiffPixelSource, tiffWriteInput } from "../src/lib/tiff/source";
import type { Codecs } from "../src/lib/tiff/decode";
import type { DimsAnswer, DimsProposal, TiffProbe } from "../src/lib/tiff/types";

/** A file read by position. `close()` releases the descriptor. */
export interface FileSource extends RangedSource { close(): Promise<void>; readonly bytesRead: number }

export async function fsSource(file: string): Promise<FileSource> {
  const fh = await fsp.open(file, "r");
  const size = (await fh.stat()).size;
  let bytesRead = 0;
  return {
    size,
    get bytesRead() { return bytesRead; },
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new TiffError("past-eof", `A read of ${length} bytes at ${offset} is past the end of the file (${size} bytes): it is truncated`);
      const buf = new Uint8Array(length);
      for (let at = 0; at < length;) {
        const { bytesRead: n } = await fh.read(buf, at, length - at, offset + at);
        if (!n) throw new TiffError("truncated", `The file ended after ${offset + at} bytes while reading it: it is truncated or was changed`);
        at += n;
      }
      bytesRead += length;
      return buf;
    },
    close: () => fh.close(),
  };
}

type Zlib = typeof zlib & { zstdDecompressSync?: (b: Uint8Array, o?: unknown) => Buffer };

/** Deflate (and Zstandard where Node has it), each capped at the segment's expected size. */
export function nodeTiffCodecs(): Codecs {
  const cap = (fn: () => Buffer): Uint8Array => {
    try { const out = fn(); return new Uint8Array(out.buffer, out.byteOffset, out.byteLength); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new TiffError("codec", "A strip expands to more bytes than its page holds: the file is damaged or crafted");
      throw new TiffError("codec", `A compressed strip cannot be decoded (${(error as Error).message}): the file is damaged`);
    }
  };
  const z = zlib as Zlib;
  return {
    inflate: (src, outBytes) => cap(() => zlib.inflateSync(src, { maxOutputLength: Math.max(1, outBytes), finishFlush: zlib.constants.Z_SYNC_FLUSH })),
    ...(z.zstdDecompressSync ? { zstd: (src: Uint8Array, outBytes: number) => cap(() => z.zstdDecompressSync!(src, { maxOutputLength: Math.max(1, outBytes) })) } : {}),
  };
}

export interface ProbeResult { probe: TiffProbe; proposals: DimsProposal[] }

/** Probe a TIFF on disk (the IFD walk and a few small reads) and rank the proposals. */
export async function probeTiff(file: string, opts: InferOptions & { signal?: AbortSignal } = {}): Promise<ProbeResult> {
  const src = await fsSource(file);
  try {
    const tf = await openTiff(src, { signal: opts.signal });
    const probe = await probeFile(tf, { fileName: path.basename(file), codecs: nodeTiffCodecs(), periodicity: true, signal: opts.signal });
    return { probe, proposals: inferDims(probe, opts) };
  } finally { await src.close(); }
}

export interface ConvertProgress extends WriteProgress {
  /** 0..1 over both passes. */
  fraction: number;
  /** Bytes read from the TIFF so far. */
  bytesRead: number;
  elapsedMs: number;
}

export interface ConvertOptions {
  signal?: AbortSignal;
  onProgress?: (p: ConvertProgress) => void;
  /** The bundle's name (default: the TIFF's base name). */
  name?: string;
  /** How the source is recorded in the manifest's provenance (default: its base name; never more than the caller passes). */
  sourcePath?: string;
  /** Chunks compressed at once on the libuv pool (default 8; its threads are UV_THREADPOOL_SIZE, 4 unless set at start). */
  concurrency?: number;
  /** Writer options (preview and automatic regions are on unless overridden). */
  writeOptions?: Omit<WriteOptions, "signal" | "onProgress" | "concurrency">;
}

export interface ConvertResult {
  path: string;
  /** The content id (as `electron/fluximgFiles.cjs` computes it). */
  sha256: string;
  bytes: number;
  files: number;
  manifest: FluximgManifest;
  notes: string[];
  bytesRead: number;
  ms: number;
}

/** A bundle writer into `dir` that hashes every file as it writes it and fsyncs it. */
function stagingWriter(dir: string) {
  const entries: Array<{ path: string; sha256: string }> = [];
  let bytes = 0;
  const put = async (rel: string, data: Uint8Array | string): Promise<void> => {
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw new Error(`fluximg: path escapes the bundle: ${rel}`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const fh = await fsp.open(abs, "wx");
    try {
      for (let at = 0; at < buf.byteLength;) at += (await fh.write(buf, at, buf.byteLength - at)).bytesWritten;
      await fh.sync();
    } finally { await fh.close(); }
    entries.push({ path: rel.split(path.sep).join("/"), sha256: createHash("sha256").update(buf).digest("hex") });
    bytes += buf.byteLength;
  };
  return { io: { writeFile: put, writeText: put }, entries, get bytes() { return bytes; } };
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const fh = await fsp.open(dir, "r");
  try { await fh.sync(); } finally { await fh.close(); }
}

/**
 * Convert `tiffPath` with `answer` into the bundle directory `outDir` (which must not exist). Throws `TiffError`
 * (code "answer") listing every problem when the answer does not fit, and an AbortError when `signal` aborts.
 */
export async function convertTiff(tiffPath: string, answer: DimsAnswer, outDir: string, opts: ConvertOptions = {}): Promise<ConvertResult> {
  const t0 = Date.now();
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) throw new TiffError("exists", `${out} already exists; choose another name`);
  const src = await fsSource(tiffPath);
  const parent = path.dirname(out);
  await fsp.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(out)}.tmp-${randomUUID()}`);
  let created = false;
  try {
    const st = await fsp.stat(tiffPath);
    const tf: TiffFile = await openTiff(src, { signal: opts.signal });
    const probe = await probeFile(tf, { fileName: path.basename(tiffPath), codecs: nodeTiffCodecs(), signal: opts.signal });
    const problems = answerProblems(probe, answer);
    if (problems.length) throw new TiffError("answer", `The answer does not fit ${path.basename(tiffPath)}: ${problems.join("; ")}`);
    const pixels = tiffPixelSource(tf, probe, answer, nodeTiffCodecs(), { signal: opts.signal });
    const name = opts.name ?? path.basename(tiffPath).replace(/\.(ome\.)?tiff?$/i, "");
    const input = tiffWriteInput(probe, answer, { name, source: { path: opts.sourcePath ?? path.basename(tiffPath), bytes: st.size, mtime: st.mtime.toISOString() } });
    await fsp.mkdir(staging);
    created = true;
    const w = stagingWriter(staging);
    const codec = await nodeZstd();
    const report = await writeFluximg(w.io, codec, { ...input, source: pixels }, {
      // A preview and automatic regions, as fluxplot's writer makes them (the rail shows the preview; unscanned
      // areas become regions for "Split by region").
      preview: { encodePng }, regions: "auto",
      ...(opts.writeOptions ?? {}), signal: opts.signal, concurrency: opts.concurrency ?? 8,
      onProgress: opts.onProgress ? (p) => opts.onProgress!({
        ...p, bytesRead: src.bytesRead, elapsedMs: Date.now() - t0,
        fraction: (p.phase === "learn" ? p.done : p.total + p.done) / (2 * Math.max(1, p.total)),
      }) : undefined,
    });
    const check = await validateFluximg(nodeBundleReader(staging), codec, { quick: true, maxShardBytes: opts.writeOptions?.maxShardBytes });
    if (!check.ok) throw new Error(`The converted image does not pass the fluximg/1 check: ${check.issues.map((i) => i.message).join("; ")}`);
    if (opts.signal?.aborted) throw Object.assign(new Error("The TIFF conversion was cancelled"), { name: "AbortError" });
    const sha256 = createHash("sha256").update(fluximgContentIdText(w.entries), "utf8").digest("hex");
    if (fs.existsSync(out)) throw new TiffError("exists", `${out} appeared while converting; nothing was replaced`);
    await fsp.rename(staging, out);
    created = false;
    await syncDirectory(parent);
    return { path: out, sha256, bytes: w.bytes, files: w.entries.length, manifest: report.manifest, notes: report.notes, bytesRead: src.bytesRead, ms: Date.now() - t0 };
  } finally {
    await src.close().catch(() => {});
    if (created) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
