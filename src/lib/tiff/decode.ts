/**
 * One TIFF page → a typed array of samples in host byte order. Pure; codecs Flux does not own (Deflate, Zstandard)
 * are injected, so Node uses its zlib and a worker can use fflate.
 *
 * Output layout is PLANAR: `samples` planes of height x width, whatever the file's planar configuration, so a
 * caller takes sample s of a page as one contiguous run. Contiguous strips and tiles are read with one read each
 * (a page of 800 one-row strips is one read, not 800). Every decompressor's output is capped at the segment's
 * expected size: a crafted file cannot make a strip expand without limit.
 */
import { allocTyped, type FluximgTypedArray } from "../fluximg/types";
import { HOST_LITTLE_ENDIAN, TiffError, throwIfAborted } from "./io";
import { compressionName, refValues, type PageLayout, type TiffFile, type TiffPage } from "./ifd";
import { lzwDecode } from "./lzw";
import { packbitsDecode } from "./packbits";
import { swapBytes, undoFloat, undoHorizontal } from "./predictor";

/** Decompressors Flux does not implement itself. `outBytes` is the most a segment may expand to: return at most that. */
export interface Codecs {
  inflate(src: Uint8Array, outBytes: number): Uint8Array | Promise<Uint8Array>;
  zstd?(src: Uint8Array, outBytes: number): Uint8Array | Promise<Uint8Array>;
}

/** A plane larger than this (bytes, all samples) is refused: whole-slide images need tiles on demand. */
export const MAX_PLANE_BYTES = 1024 ** 3;
/** Contiguous segments are merged into reads of at most this many bytes. */
const MAX_READ = 256 * 1024 * 1024;

const DEFLATE = new Set([8, 32946]), ZSTD = new Set([50000, 34926]);
const SUPPORTED = new Set([1, 5, 32773, ...DEFLATE, ...ZSTD]);

/** Why pages of this layout cannot be decoded (null: they can). Each message names the cause and a way out. */
export function layoutProblem(L: PageLayout, codecs?: Partial<Codecs>): TiffError | null {
  const resave = "Re-save it uncompressed or with LZW (in Fiji: File > Save As > Tiff)";
  if (!(L.width > 0 && L.height > 0)) return new TiffError("bad-ifd", "A page has no width or height");
  if (L.tiled && !(L.tileWidth > 0 && L.tileHeight > 0)) return new TiffError("bad-ifd", "A tiled page has no tile size");
  if (!SUPPORTED.has(L.compression)) return new TiffError("compression", `This TIFF is compressed with ${compressionName(L.compression)}, which Flux cannot read yet`, resave);
  if (ZSTD.has(L.compression) && codecs && !codecs.zstd) return new TiffError("compression", "This TIFF is compressed with Zstandard, which this engine cannot read", resave);
  if (L.sampleType.startsWith("complex")) return new TiffError("sample-type", "This TIFF holds complex numbers; Flux images hold real values", "Save the magnitude or the real and imaginary parts as separate images");
  if (L.sampleType === "bit1") return new TiffError("sample-type", "This TIFF is a 1-bit (black and white) image, which Flux cannot import yet", "Save it as 8-bit");
  if (L.sampleType === "mixed") return new TiffError("sample-type", "The samples of one pixel have different types or bit depths", "Save every channel with the same type");
  if (!L.dtype) return new TiffError("sample-type", `This TIFF holds ${L.sampleType} samples; Flux stores 8-, 16- and 32-bit integers and 32- and 64-bit floats`, "Convert it to one of those types (for 64-bit integers, to 32-bit when the values fit)");
  if (L.fillOrder === 2) return new TiffError("layout", "This TIFF stores bits in reversed order (FillOrder 2)", resave);
  if (![0, 1, 2].includes(L.photometric) || (L.photometric === 2 && L.samples < 3)) {
    const kind: Record<number, string> = { 3: "a palette (indexed colour) image", 4: "a transparency mask", 5: "a CMYK image", 6: "a YCbCr image", 8: "a CIELab image", 9: "a CIELab image", 10: "a CIELab image" };
    return new TiffError("photometric", `This TIFF is ${kind[L.photometric] ?? `in colour space ${L.photometric}`}, which Flux cannot import yet`, "Save it as RGB or grayscale");
  }
  if (![1, 2, 3].includes(L.predictor)) return new TiffError("compression", `This TIFF uses predictor ${L.predictor}, which is not part of the TIFF standard`, resave);
  if (L.predictor === 3 && !L.dtype.startsWith("float")) return new TiffError("compression", "This TIFF applies the floating-point predictor to integer samples", resave);
  if (L.width * L.height * L.samples * (L.bits / 8) > MAX_PLANE_BYTES) {
    return new TiffError("too-large", "One plane of this TIFF is larger than 1 GiB; whole-slide images are not supported yet", "Crop or downsample it first");
  }
  return null;
}

/** Bytes a page's samples take once decoded. */
export const pageBytes = (L: PageLayout): number => L.width * L.height * L.samples * (L.bits / 8);

interface Segment { offset: number; bytes: number; plane: number; x: number; y: number; w: number; h: number; full: number }

/** The strips or tiles of a page, with where each lands. Validated against the file. */
async function segments(file: TiffFile, page: TiffPage, signal?: AbortSignal): Promise<Segment[]> {
  const L = page.layout;
  const [offs, cnts] = await Promise.all([refValues(file, page.offsets, signal), refValues(file, page.counts, signal)]);
  const what = L.tiled ? "tiles" : "strips";
  if (offs.length < L.segments || cnts.length < L.segments) {
    throw new TiffError("bad-ifd", `Page ${page.index + 1} lists ${Math.min(offs.length, cnts.length)} ${what}; its size needs ${L.segments}: the file is damaged`);
  }
  const bps = L.bits / 8, pix = L.planar === 1 ? L.samples * bps : bps;
  const perPlane = L.segments / (L.planar === 2 ? L.samples : 1);
  const across = L.tiled ? Math.ceil(L.width / L.tileWidth) : 1;
  const out: Segment[] = [];
  for (let s = 0; s < L.segments; s++) {
    const offset = offs[s], bytes = cnts[s];
    if (!(bytes > 0)) throw new TiffError("bad-ifd", `Page ${page.index + 1} has an empty ${what.slice(0, -1)} (0 bytes): the file is damaged or was not finished`, "Copy it again from its source");
    if (!(offset >= 0) || offset + bytes > file.size) {
      throw new TiffError("past-eof", `Page ${page.index + 1} points at bytes ${offset}..${offset + bytes}, past the end of the file (${file.size} bytes): it is truncated or damaged`, "Copy the file again from its source");
    }
    const j = s % perPlane, plane = Math.floor(s / perPlane);
    if (L.tiled) {
      const tx = j % across, ty = Math.floor(j / across);
      out.push({ offset, bytes, plane, x: tx * L.tileWidth, y: ty * L.tileHeight, w: L.tileWidth, h: L.tileHeight, full: L.tileWidth * L.tileHeight * pix });
    } else {
      const y = j * L.rowsPerStrip;
      out.push({ offset, bytes, plane, x: 0, y, w: L.width, h: Math.min(L.rowsPerStrip, L.height - y), full: L.rowsPerStrip * L.width * pix });
    }
  }
  return out;
}

/** An 8-byte-aligned copy when `b` is not aligned (typed views need it). */
const aligned = (b: Uint8Array): Uint8Array => (b.byteOffset % 8 === 0 ? b : b.slice());

/**
 * Decode one page. Returns `samples` planes of height x width (planar), host byte order, in the page's dtype.
 * `out`, when given, must have exactly that length and is filled instead of a new array.
 */
export async function readPage(file: TiffFile, page: TiffPage, codecs: Codecs, signal?: AbortSignal, out?: FluximgTypedArray): Promise<FluximgTypedArray> {
  if (!HOST_LITTLE_ENDIAN) throw new TiffError("host", "This reader needs a little-endian machine");
  const L = page.layout;
  const problem = layoutProblem(L, codecs);
  if (problem) throw problem;
  throwIfAborted(signal);
  const segs = await segments(file, page, signal);
  const n = L.width * L.height, bps = L.bits / 8;
  const result = out ?? allocTyped(L.dtype!, n * L.samples);
  if (result.length !== n * L.samples) throw new Error("tiff: output array has the wrong length");
  const dst = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  const swap = !file.littleEndian && bps > 1 && L.predictor !== 3;
  const stride = L.planar === 1 ? L.samples : 1;

  // The common case of acquisition files: one uncompressed strip per plane (or all strips contiguous) holding the
  // whole page, little-endian, one sample: one read straight into the output.
  if (L.compression === 1 && L.samples === 1 && !L.tiled && L.predictor === 1 && contiguous(segs) && segs.reduce((a, s) => a + Math.min(s.bytes, s.h * s.w * bps), 0) >= n * bps) {
    const bytes = await file.source.read(segs[0].offset, n * bps, signal);
    dst.set(bytes);
    if (swap) swapBytes(dst, bps);
    return result;
  }

  // Group contiguous segments into reads.
  let i = 0;
  while (i < segs.length) {
    let j = i + 1, total = segs[i].bytes;
    while (j < segs.length && segs[j].offset === segs[j - 1].offset + segs[j - 1].bytes && total + segs[j].bytes <= MAX_READ) { total += segs[j].bytes; j++; }
    throwIfAborted(signal);
    const run = await file.source.read(segs[i].offset, total, signal);
    let at = 0;
    for (let k = i; k < j; k++) {
      const s = segs[k];
      const raw = run.subarray(at, at + s.bytes);
      at += s.bytes;
      const need = s.h * s.w * (L.planar === 1 ? L.samples : 1) * bps;
      let work = await decompress(L, raw, s.full, codecs);
      if (work.length < need) throw new TiffError("codec", `A ${L.tiled ? "tile" : "strip"} of page ${page.index + 1} decodes to ${work.length} bytes instead of ${need}: the file is damaged`);
      work = aligned(work.length > need && !L.tiled ? work.subarray(0, need) : work);
      if (swap) swapBytes(work, bps);
      if (L.predictor === 2) undoHorizontal(work, L.bits, s.w, s.h, stride);
      else if (L.predictor === 3) undoFloat(work, bps, s.w, s.h, stride);
      place(work, s, L, dst, bps);
    }
    i = j;
  }
  return result;
}

const contiguous = (segs: Segment[]): boolean => segs.every((s, k) => k === 0 || s.offset === segs[k - 1].offset + segs[k - 1].bytes);

async function decompress(L: PageLayout, raw: Uint8Array, full: number, codecs: Codecs): Promise<Uint8Array> {
  switch (L.compression) {
    case 1: return raw.length > full ? raw.subarray(0, full) : raw;
    case 5: return lzwDecode(raw, full);
    case 32773: return packbitsDecode(raw, full);
    case 8: case 32946: return codecs.inflate(raw, full);
    default: return codecs.zstd!(raw, full);
  }
}

/** Copy a decoded segment into the planar output (ragged tiles clipped to the page). */
function place(work: Uint8Array, s: Segment, L: PageLayout, dst: Uint8Array, bps: number): void {
  const W = L.width, H = L.height, plane = W * H * bps;
  const w = Math.min(s.w, W - s.x), h = Math.min(s.h, H - s.y);
  if (L.planar === 2 || L.samples === 1) {
    const base = s.plane * plane;
    for (let r = 0; r < h; r++) {
      const from = r * s.w * bps;
      dst.set(work.subarray(from, from + w * bps), base + ((s.y + r) * W + s.x) * bps);
    }
    return;
  }
  // Interleaved samples: split into the planes.
  const spp = L.samples;
  for (let r = 0; r < h; r++) {
    for (let x = 0; x < w; x++) {
      const from = ((r * s.w + x) * spp) * bps, to = ((s.y + r) * W + s.x + x) * bps;
      for (let c = 0; c < spp; c++) for (let b = 0; b < bps; b++) dst[c * plane + to + b] = work[from + c * bps + b];
    }
  }
}
