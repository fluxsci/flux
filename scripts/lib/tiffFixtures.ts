// Synthetic TIFFs for the TIFF reader's gate: a small, deterministic TIFF WRITER (no Python, no dependency).
//
// It writes classic TIFF and BigTIFF in either byte order; strips (any RowsPerStrip) or tiles (ragged edges
// padded); chunky or planar samples; no compression, LZW (with table resets), Deflate or PackBits; predictor 2
// or 3; IFDs before their data, after it, or all at the end of the file; SHORT strip byte counts; repeated tags.
// Every value it writes is invented by the gate: nothing here comes from a real file.
import zlib from "node:zlib";
import type { FluximgDtype, FluximgTypedArray } from "../../src/lib/fluximg/types";

export interface TiffPageSpec {
  width: number;
  height: number;
  dtype: FluximgDtype;
  /** Planar samples: `samples` planes of height x width (the decoder's output layout). */
  data: FluximgTypedArray;
  samples?: number;
  planar?: 1 | 2;
  compression?: "none" | "lzw" | "deflate" | "packbits";
  /** A raw compression code written instead (refusal tests); the data is then stored uncompressed. */
  compressionCode?: number;
  predictor?: 1 | 2 | 3;
  rowsPerStrip?: number;
  tile?: [number, number];
  photometric?: number;
  extraSamples?: number[];
  descriptions?: string[];
  software?: string;
  resolution?: { x: number; y: number; unit: number };
  newSubfileType?: number;
  /** StripByteCounts as SHORT (some writers do). */
  shortCounts?: boolean;
  /** Override SampleFormat / BitsPerSample (refusal tests: complex, 64-bit ints). */
  sampleFormat?: number;
  bits?: number;
  extraTags?: Array<{ tag: number; type: number; values: number[] | string }>;
  /** Corruptions: zero byte counts, offsets past the end. */
  zeroCounts?: boolean;
  offsetPastEnd?: boolean;
}

export interface TiffSpec {
  bigTiff?: boolean;
  littleEndian?: boolean;
  /** Where IFDs go: before their page's data, after it, or all together at the end of the file. */
  layout?: "ifd-first" | "data-first" | "ifds-at-end";
  pages: TiffPageSpec[];
  /** Point the last IFD's "next" back at the first (an IFD loop). */
  loop?: boolean;
}

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SBYTE: 6, UNDEFINED: 7, SSHORT: 8, SLONG: 9, SRATIONAL: 10, FLOAT: 11, DOUBLE: 12, LONG8: 16 };
const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
const BITS: Record<FluximgDtype, number> = { uint8: 8, int8: 8, uint16: 16, int16: 16, uint32: 32, int32: 32, float32: 32, float64: 64 };
const FORMAT: Record<FluximgDtype, number> = { uint8: 1, uint16: 1, uint32: 1, int8: 2, int16: 2, int32: 2, float32: 3, float64: 3 };

// ---- codecs (encoders; the reader under test has the decoders) ------------------------------------------------

/** TIFF LZW: MSB-first, early change, a Clear code whenever the table fills (so long strips reset it). */
export function lzwEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0, nacc = 0;
  const put = (code: number, width: number): void => {
    acc = (acc << width) | code; nacc += width;
    while (nacc >= 8) { out.push((acc >>> (nacc - 8)) & 255); nacc -= 8; }
    acc &= (1 << nacc) - 1;
  };
  let dict = new Map<number, number>(), next = 258, width = 9;
  put(256, width);
  if (!src.length) { put(257, width); if (nacc) out.push((acc << (8 - nacc)) & 255); return Uint8Array.from(out); }
  let w = src[0];
  for (let i = 1; i < src.length; i++) {
    const b = src[i], key = w * 256 + b, hit = dict.get(key);
    if (hit !== undefined) { w = hit; continue; }
    put(w, width);
    dict.set(key, next++);
    if (next === 4094) { put(256, width); dict = new Map(); next = 258; width = 9; }
    else if (next > (1 << width) - 1) width++;
    w = b;
  }
  put(w, width);
  next++;
  if (next > (1 << width) - 1 && width < 12) width++;
  put(257, width);
  if (nacc) out.push((acc << (8 - nacc)) & 255);
  return Uint8Array.from(out);
}

export function packbitsEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) { out.push((1 - run) & 255, src[i]); i += run; continue; }
    let j = i + 1;
    while (j < src.length && j - i < 128 && !(j + 1 < src.length && src[j] === src[j + 1])) j++;
    out.push(j - i - 1);
    for (let k = i; k < j; k++) out.push(src[k]);
    i = j;
  }
  return Uint8Array.from(out);
}

function swap(buf: Uint8Array, bytes: number): void {
  if (bytes === 1) return;
  for (let i = 0; i + bytes <= buf.length; i += bytes) for (let j = 0; j < bytes >> 1; j++) { const t = buf[i + j]; buf[i + j] = buf[i + bytes - 1 - j]; buf[i + bytes - 1 - j] = t; }
}

/** Apply a predictor to `rows` rows of `rowPixels` pixels x `stride` samples (host-order input, file-order output). */
function predict(buf: Uint8Array, predictor: number, bits: number, rowPixels: number, rows: number, stride: number, le: boolean): Uint8Array {
  const bytes = bits / 8, n = rowPixels * stride, rowBytes = n * bytes;
  const out = buf.slice();
  if (predictor === 3) {
    for (let r = 0; r < rows; r++) {
      const row = out.subarray(r * rowBytes, (r + 1) * rowBytes), tmp = new Uint8Array(rowBytes);
      for (let k = 0; k < n; k++) for (let j = 0; j < bytes; j++) tmp[(bytes - 1 - j) * n + k] = row[k * bytes + j];
      for (let i = rowBytes - 1; i >= stride; i--) tmp[i] = (tmp[i] - tmp[i - stride]) & 255;
      row.set(tmp);
    }
    return out;
  }
  if (predictor === 2) {
    if (bits === 64) {
      const w = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
      for (let r = 0; r < rows; r++) for (let i = n - 1; i >= stride; i--) {
        const a = (r * n + i) * 2, b = (r * n + i - stride) * 2;
        const lo = w[a] - w[b], borrow = lo < 0 ? 1 : 0;
        w[a] = lo >>> 0; w[a + 1] = (w[a + 1] - w[b + 1] - borrow) >>> 0;
      }
    } else {
      const a = bits === 8 ? out : bits === 16 ? new Uint16Array(out.buffer, out.byteOffset, out.byteLength >> 1) : new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
      for (let r = 0; r < rows; r++) for (let i = n - 1; i >= stride; i--) a[r * n + i] = a[r * n + i] - a[r * n + i - stride];
    }
  }
  if (!le) swap(out, bytes);
  return out;
}

function compress(kind: TiffPageSpec["compression"], raw: Uint8Array): Uint8Array {
  switch (kind) {
    case "lzw": return lzwEncode(raw);
    case "deflate": return new Uint8Array(zlib.deflateSync(raw));
    case "packbits": return packbitsEncode(raw);
    default: return raw;
  }
}

/** The encoded strips or tiles of a page, in file order. */
function encodePage(p: TiffPageSpec, le: boolean): Uint8Array[] {
  const spp = p.samples ?? 1, planar = spp > 1 ? p.planar ?? 1 : 1, bps = BITS[p.dtype] / 8;
  const W = p.width, H = p.height, plane = W * H;
  const host = new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  const pix = planar === 1 ? spp : 1;
  const segs: Uint8Array[] = [];
  const region = (s: number | null, x0: number, y0: number, w: number, h: number): Uint8Array => {
    // Host-order bytes of a w x h region (zero-padded past the page), samples interleaved unless one sample `s`.
    const out = new Uint8Array(w * h * pix * bps);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sy = y0 + y, sx = x0 + x;
      if (sy >= H || sx >= W) continue;
      for (let c = 0; c < pix; c++) {
        const sample = s ?? c;
        const from = (sample * plane + sy * W + sx) * bps, to = ((y * w + x) * pix + c) * bps;
        for (let b = 0; b < bps; b++) out[to + b] = host[from + b];
      }
    }
    return out;
  };
  const encode = (raw: Uint8Array, w: number, h: number): Uint8Array => {
    const pred = predict(raw, p.predictor ?? 1, BITS[p.dtype], w, h, pix, le);
    return p.compressionCode ? pred : compress(p.compression, pred);
  };
  for (let s = 0; s < (planar === 2 ? spp : 1); s++) {
    const sample = planar === 2 ? s : null;
    if (p.tile) {
      const [tw, th] = p.tile;
      for (let ty = 0; ty < H; ty += th) for (let tx = 0; tx < W; tx += tw) segs.push(encode(region(sample, tx, ty, tw, th), tw, th));
    } else {
      const rps = p.rowsPerStrip ?? H;
      for (let y = 0; y < H; y += rps) { const h = Math.min(rps, H - y); segs.push(encode(region(sample, 0, y, W, h), W, h)); }
    }
  }
  return segs;
}

interface Entry { tag: number; type: number; values: number[] | Uint8Array }

function encodeValues(e: Entry, le: boolean): Uint8Array {
  const vals = e.values;
  if (vals instanceof Uint8Array) return vals;
  const size = SIZE[e.type], out = new Uint8Array(vals.length * size), dv = new DataView(out.buffer);
  vals.forEach((v, i) => {
    switch (e.type) {
      case T.BYTE: case T.UNDEFINED: case T.ASCII: dv.setUint8(i, v); break;
      case T.SBYTE: dv.setInt8(i, v); break;
      case T.SHORT: dv.setUint16(i * 2, v, le); break;
      case T.SSHORT: dv.setInt16(i * 2, v, le); break;
      case T.LONG: dv.setUint32(i * 4, v, le); break;
      case T.SLONG: dv.setInt32(i * 4, v, le); break;
      case T.FLOAT: dv.setFloat32(i * 4, v, le); break;
      case T.DOUBLE: dv.setFloat64(i * 8, v, le); break;
      case T.LONG8: dv.setBigUint64(i * 8, BigInt(v), le); break;
      case T.RATIONAL: { let d = 1; while (d < 1e6 && Math.abs(Math.round(v * d) - v * d) > 1e-9) d *= 10; dv.setUint32(i * 8, Math.round(v * d), le); dv.setUint32(i * 8 + 4, d, le); break; }
    }
  });
  return out;
}

const ascii = (s: string): Uint8Array => { const b = new TextEncoder().encode(s); const o = new Uint8Array(b.length + 1); o.set(b); return o; };

/** Write a TIFF. Deterministic: the same spec gives the same bytes. */
export function writeTiff(spec: TiffSpec): Uint8Array {
  const big = spec.bigTiff === true, le = spec.littleEndian !== false;
  const layout = spec.layout ?? "ifd-first";
  const head = big ? 16 : 8, entrySize = big ? 20 : 12, inline = big ? 8 : 4, offType = big ? T.LONG8 : T.LONG;
  const pages = spec.pages.map((p) => {
    const segs = encodePage(p, le);
    const spp = p.samples ?? 1;
    const tags: Entry[] = [];
    const add = (tag: number, type: number, values: number[] | Uint8Array): void => { tags.push({ tag, type, values }); };
    if (p.newSubfileType !== undefined) add(254, T.LONG, [p.newSubfileType]);
    add(256, T.LONG, [p.width]); add(257, T.LONG, [p.height]);
    add(258, T.SHORT, new Array(spp).fill(p.bits ?? BITS[p.dtype]));
    add(259, T.SHORT, [p.compressionCode ?? ({ none: 1, lzw: 5, deflate: 8, packbits: 32773 } as const)[p.compression ?? "none"]]);
    add(262, T.SHORT, [p.photometric ?? (spp >= 3 ? 2 : 1)]);
    for (const d of p.descriptions ?? []) add(270, T.ASCII, ascii(d));
    add(p.tile ? 324 : 273, offType, new Array(segs.length).fill(0));      // patched once data is placed
    add(277, T.SHORT, [spp]);
    if (!p.tile) add(278, T.LONG, [p.rowsPerStrip ?? p.height]);
    add(p.tile ? 325 : 279, p.shortCounts ? T.SHORT : offType, segs.map((s) => (p.zeroCounts ? 0 : s.length)));
    if (p.resolution) { add(282, T.RATIONAL, [p.resolution.x]); add(283, T.RATIONAL, [p.resolution.y]); }
    if (spp > 1) add(284, T.SHORT, [p.planar ?? 1]);
    if (p.resolution) add(296, T.SHORT, [p.resolution.unit]);
    if (p.software) add(305, T.ASCII, ascii(p.software));
    if (p.predictor && p.predictor > 1) add(317, T.SHORT, [p.predictor]);
    if (p.tile) { add(322, T.LONG, [p.tile[0]]); add(323, T.LONG, [p.tile[1]]); }
    if (p.extraSamples) add(338, T.SHORT, p.extraSamples);
    add(339, T.SHORT, new Array(spp).fill(p.sampleFormat ?? FORMAT[p.dtype]));
    for (const x of p.extraTags ?? []) add(x.tag, x.type, typeof x.values === "string" ? ascii(x.values) : x.values);
    tags.sort((a, b) => a.tag - b.tag);                                       // stable: repeated 270s keep their order
    const encoded = tags.map((t) => encodeValues(t, le));
    const outOfLine = encoded.reduce((n, b) => n + (b.length > inline ? b.length + (b.length & 1) : 0), 0);
    const ifdBytes = (big ? 8 : 2) + tags.length * entrySize + (big ? 8 : 4) + outOfLine;
    return { spec: p, segs, tags, ifdBytes: ifdBytes + (ifdBytes & 1), dataBytes: segs.reduce((n, s) => n + s.length + (s.length & 1), 0) };
  });

  // Place blocks.
  let at = head;
  const ifdAt: number[] = [], dataAt: number[] = [];
  const placeData = (i: number): void => { dataAt[i] = at; at += pages[i].dataBytes; };
  const placeIfd = (i: number): void => { ifdAt[i] = at; at += pages[i].ifdBytes; };
  if (layout === "ifds-at-end") { pages.forEach((_, i) => placeData(i)); pages.forEach((_, i) => placeIfd(i)); }
  else pages.forEach((_, i) => { if (layout === "ifd-first") { placeIfd(i); placeData(i); } else { placeData(i); placeIfd(i); } });
  const total = at;
  const buf = new Uint8Array(total), dv = new DataView(buf.buffer);
  buf[0] = buf[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, big ? 43 : 42, le);
  if (big) { dv.setUint16(4, 8, le); dv.setUint16(6, 0, le); dv.setBigUint64(8, BigInt(ifdAt[0]), le); } else dv.setUint32(4, ifdAt[0], le);

  pages.forEach((pg, i) => {
    // Data, and the offsets it lands at.
    let d = dataAt[i];
    const offsets: number[] = [];
    for (const s of pg.segs) { buf.set(s, d); offsets.push(pg.spec.offsetPastEnd ? total + 1000 : d); d += s.length + (s.length & 1); }
    const offTag = pg.tags.find((t) => t.tag === 273 || t.tag === 324)!;
    offTag.values = offsets;
    // The IFD.
    let p = ifdAt[i];
    if (big) { dv.setBigUint64(p, BigInt(pg.tags.length), le); p += 8; } else { dv.setUint16(p, pg.tags.length, le); p += 2; }
    let extra = p + pg.tags.length * entrySize + (big ? 8 : 4);
    for (const t of pg.tags) {
      const v = encodeValues(t, le);
      const count = t.values instanceof Uint8Array ? t.values.length : t.values.length;
      dv.setUint16(p, t.tag, le); dv.setUint16(p + 2, t.type, le);
      if (big) dv.setBigUint64(p + 4, BigInt(count), le); else dv.setUint32(p + 4, count, le);
      const vp = p + (big ? 12 : 8);
      if (v.length <= inline) buf.set(v, vp);
      else {
        buf.set(v, extra);
        if (big) dv.setBigUint64(vp, BigInt(extra), le); else dv.setUint32(vp, extra, le);
        extra += v.length + (v.length & 1);
      }
      p += entrySize;
    }
    const next = i + 1 < pages.length ? ifdAt[i + 1] : spec.loop ? ifdAt[0] : 0;
    if (big) dv.setBigUint64(p, BigInt(next), le); else dv.setUint32(p, next, le);
  });
  return buf;
}

/** Deterministic pseudo-random numbers (the same generator as the fluximg fixtures). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
