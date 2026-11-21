/**
 * The TIFF container: header, the IFD chain, typed tag values. Pure (IO injected through `RangedSource`).
 *
 * Classic TIFF and BigTIFF, both byte orders. The chain is walked with batched reads: a window is read around an
 * IFD and every following IFD that falls inside it is parsed from it (some writers pack all IFDs at the end of
 * the file, so one read covers hundreds). Large arrays (strip offsets of a page with thousands of strips) are read
 * lazily, per page, when the page is decoded.
 *
 * Every file is treated as hostile: IFD loops, offsets and counts past the end of the file, absurd entry counts
 * and millions of pages are refused with a message, within a bounded time and memory.
 */
import type { FluximgDtype } from "../fluximg/types";
import { TiffError, throwIfAborted, type RangedSource } from "./io";

export const TAG = {
  NewSubfileType: 254, SubfileType: 255, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  Photometric: 262, FillOrder: 266, ImageDescription: 270, StripOffsets: 273, Orientation: 274, SamplesPerPixel: 277,
  RowsPerStrip: 278, StripByteCounts: 279, XResolution: 282, YResolution: 283, PlanarConfiguration: 284,
  ResolutionUnit: 296, Software: 305, Predictor: 317, ColorMap: 320, TileWidth: 322, TileLength: 323, TileOffsets: 324,
  TileByteCounts: 325, SubIFDs: 330, ExtraSamples: 338, SampleFormat: 339,
} as const;

/** Bytes per value of each TIFF field type (0 = unknown type). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];

/** Where a tag's values live, and the values themselves when they were cheap to take during the walk. */
export interface ValueRef { type: number; count: number; pos: number; values?: number[] }

/** Everything about a page that decides how its bytes become samples. Pages that share it share the object. */
export interface PageLayout {
  key: string;
  width: number;
  height: number;
  samples: number;
  bits: number;
  /** "uint8" … "float64" when Flux stores it; otherwise the name of what the file holds ("uint64", "float16", "complex64", "bit1", "mixed"). */
  sampleType: string;
  dtype: FluximgDtype | null;
  compression: number;
  predictor: number;
  planar: 1 | 2;
  photometric: number;
  fillOrder: number;
  orientation: number;
  extraSamples: number[];
  tiled: boolean;
  tileWidth: number;
  tileHeight: number;
  rowsPerStrip: number;
  /** Strips or tiles one page must have. */
  segments: number;
}

export interface TiffPage {
  /** Index among the image pages (reduced-resolution pages and masks are not pages). */
  index: number;
  /** Byte offset of its IFD (the first IFD's for pages implied by the ImageJ large-file layout). */
  ifd: number;
  layout: PageLayout;
  offsets: ValueRef;
  counts: ValueRef;
  /** Every ImageDescription in the IFD, in order (two occur in the wild). */
  descriptions: string[];
  /** Private per-page JSON some acquisition software writes in its own tag (kept as text, never interpreted here). */
  privateText?: string;
  resolution?: { x: number; y: number; unit: number };
  software?: string;
}

export interface TiffFile {
  source: RangedSource;
  littleEndian: boolean;
  bigTiff: boolean;
  size: number;
  pages: TiffPage[];
  /** IFDs walked (pages + skipped ones). */
  ifdCount: number;
  skipped: { reduced: number; masks: number; subIfds: number };
  /** Pages past the first that the ImageJ large-file layout implies (no IFD of their own). */
  impliedPages: number;
  /** Descriptions were kept for the first this-many pages only (memory bound); null = all. */
  descriptionsKeptFor: number | null;
}

export interface OpenOptions {
  /** Hard cap on IFDs walked; more is refused. */
  maxIfds?: number;
  /** Total description text kept, in characters. */
  maxDescriptionChars?: number;
  signal?: AbortSignal;
}

export const MAX_IFDS = 200_000;
const MAX_ENTRIES = 4096;
const FIRST_WINDOW = 16 * 1024;
const MAX_WINDOW = 1024 * 1024;
/** Tag arrays taken eagerly when they are in the window already and at most this many values. */
const EAGER_VALUES = 4096;
/** A description longer than this is not metadata a reader needs (and could be a memory attack). */
const MAX_DESCRIPTION = 1 << 20;
/** Tags whose text the per-page readers look at. */
const PRIVATE_TEXT_TAG = 51123;

/** Reads through a small cache of windows: the IFD walk and lazy tag arrays rarely touch the same bytes twice. */
class Bytes {
  private windows: Array<{ start: number; bytes: Uint8Array }> = [];
  constructor(readonly src: RangedSource, readonly le: boolean) {}

  cached(offset: number, length: number): Uint8Array | null {
    for (const w of this.windows) if (offset >= w.start && offset + length <= w.start + w.bytes.byteLength) return w.bytes.subarray(offset - w.start, offset - w.start + length);
    return null;
  }

  async at(offset: number, length: number, window = 0, signal?: AbortSignal): Promise<Uint8Array> {
    const hit = this.cached(offset, length);
    if (hit) return hit;
    if (offset < 0 || length < 0 || offset + length > this.src.size) throw pastEnd(offset, length, this.src.size);
    const n = Math.min(this.src.size - offset, Math.max(length, window));
    const bytes = await this.src.read(offset, n, signal);
    this.windows.unshift({ start: offset, bytes });
    if (this.windows.length > 4) this.windows.pop();
    return bytes.subarray(0, length);
  }
}

const pastEnd = (offset: number, length: number, size: number): TiffError =>
  new TiffError("past-eof", `The file points at bytes ${offset}..${offset + length}, past its end (${size} bytes): it is truncated or damaged`, "Copy the file again from its source");

function view(b: Uint8Array): DataView { return new DataView(b.buffer, b.byteOffset, b.byteLength); }

function u64(dv: DataView, at: number, le: boolean): number {
  const lo = dv.getUint32(at + (le ? 0 : 4), le), hi = dv.getUint32(at + (le ? 4 : 0), le);
  if (hi > 0x1fffff) return Number.MAX_SAFE_INTEGER;     // past 2^53: certainly past the end of any file
  return hi * 4294967296 + lo;
}

/** Decode `count` values of `type` from `b` (integers, rationals and floats as numbers; 64-bit ints clamped). */
export function decodeValues(b: Uint8Array, type: number, count: number, le: boolean): number[] {
  const dv = view(b), out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1: case 7: out[i] = dv.getUint8(i); break;
      case 6: out[i] = dv.getInt8(i); break;
      case 3: out[i] = dv.getUint16(i * 2, le); break;
      case 8: out[i] = dv.getInt16(i * 2, le); break;
      case 4: case 13: out[i] = dv.getUint32(i * 4, le); break;
      case 9: out[i] = dv.getInt32(i * 4, le); break;
      case 5: { const d = dv.getUint32(i * 8 + 4, le); out[i] = d ? dv.getUint32(i * 8, le) / d : NaN; break; }
      case 10: { const d = dv.getInt32(i * 8 + 4, le); out[i] = d ? dv.getInt32(i * 8, le) / d : NaN; break; }
      case 11: out[i] = dv.getFloat32(i * 4, le); break;
      case 12: out[i] = dv.getFloat64(i * 8, le); break;
      case 16: case 18: out[i] = u64(dv, i * 8, le); break;
      case 17: { const v = dv.getBigInt64(i * 8, le); out[i] = Number(v); break; }
      default: out[i] = NaN;
    }
  }
  return out;
}

const decodeAscii = (b: Uint8Array): string => {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, end));
};

/** The values of a tag, read now if the walk did not take them. Validated against the file size. */
export async function refValues(file: TiffFile, ref: ValueRef, signal?: AbortSignal): Promise<number[]> {
  if (ref.values) return ref.values;
  const size = TYPE_SIZE[ref.type] ?? 0;
  if (!size) throw new TiffError("bad-tag", `A tag has an unknown value type (${ref.type})`);
  const n = ref.count * size;
  if (ref.pos + n > file.size) throw pastEnd(ref.pos, n, file.size);
  const bytes = await file.source.read(ref.pos, n, signal);
  return decodeValues(bytes, ref.type, ref.count, file.littleEndian);
}

interface RawEntry { tag: number; type: number; count: number; pos: number; bytes: Uint8Array | null }

/** Parse the IFD at `offset`: its entries (value bytes attached when they lie in `window`) and the next offset. */
function parseIfd(win: Uint8Array, winStart: number, offset: number, big: boolean, le: boolean, fileSize: number): { entries: RawEntry[]; next: number; end: number } | null {
  const rel = offset - winStart;
  const head = big ? 8 : 2, entrySize = big ? 20 : 12;
  if (rel < 0 || rel + head > win.byteLength) return null;
  const dv = view(win);
  const n = big ? u64(dv, rel, le) : dv.getUint16(rel, le);
  if (n === 0 || n > MAX_ENTRIES) throw new TiffError("bad-ifd", `An IFD at byte ${offset} claims ${n} entries; the file is damaged or not a TIFF`);
  const tableEnd = rel + head + n * entrySize + (big ? 8 : 4);
  if (offset + head + n * entrySize + (big ? 8 : 4) > fileSize) throw pastEnd(offset, head + n * entrySize, fileSize);
  if (tableEnd > win.byteLength) return null;
  const entries: RawEntry[] = [];
  let end = offset + (tableEnd - rel);
  for (let i = 0; i < n; i++) {
    const e = rel + head + i * entrySize;
    const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le);
    const count = big ? u64(dv, e + 4, le) : dv.getUint32(e + 4, le);
    const vsize = TYPE_SIZE[type] ?? 0;
    if (!vsize) continue;                                  // unknown type: a reader skips the entry
    const bytes = count * vsize, inlineSize = big ? 8 : 4;
    const valueAt = e + (big ? 12 : 8);
    let pos: number;
    if (bytes <= inlineSize) pos = winStart + valueAt;
    else {
      pos = big ? u64(dv, valueAt, le) : dv.getUint32(valueAt, le);
      if (pos + bytes > fileSize || !Number.isFinite(bytes)) throw pastEnd(pos, bytes, fileSize);
    }
    const r = pos - winStart;
    const inWin = r >= 0 && r + bytes <= win.byteLength;
    if (inWin && bytes > inlineSize) end = Math.max(end, pos + bytes);
    entries.push({ tag, type, count, pos, bytes: inWin ? win.subarray(r, r + bytes) : null });
  }
  const nextAt = rel + head + n * entrySize;
  const next = big ? u64(dv, nextAt, le) : dv.getUint32(nextAt, le);
  return { entries, next, end };
}

function sampleTypeOf(bitsList: number[], formats: number[]): { sampleType: string; dtype: FluximgDtype | null } {
  const bits = bitsList[0], fmt = formats[0] ?? 1;
  if (bitsList.some((b) => b !== bits) || formats.some((f) => f !== fmt)) return { sampleType: "mixed", dtype: null };
  if (fmt === 5 || fmt === 6) return { sampleType: `complex${bits}`, dtype: null };
  if (fmt === 3) {
    if (bits === 32) return { sampleType: "float32", dtype: "float32" };
    if (bits === 64) return { sampleType: "float64", dtype: "float64" };
    return { sampleType: `float${bits}`, dtype: null };
  }
  const signed = fmt === 2;
  if (bits === 1) return { sampleType: "bit1", dtype: null };
  const name = `${signed ? "int" : "uint"}${bits}`;
  const ok: Record<string, FluximgDtype> = { uint8: "uint8", int8: "int8", uint16: "uint16", int16: "int16", uint32: "uint32", int32: "int32" };
  return { sampleType: name, dtype: ok[name] ?? null };
}

/** Open a TIFF: the header and the whole IFD chain (pages, their layouts, descriptions). */
export async function openTiff(src: RangedSource, opts: OpenOptions = {}): Promise<TiffFile> {
  const maxIfds = opts.maxIfds ?? MAX_IFDS, maxDesc = opts.maxDescriptionChars ?? 32 * 1024 * 1024;
  if (src.size < 8) throw new TiffError("not-tiff", "The file is too short to be a TIFF");
  const head = await src.read(0, Math.min(16, src.size), opts.signal);
  const bo = String.fromCharCode(head[0], head[1]);
  if (bo !== "II" && bo !== "MM") throw new TiffError("not-tiff", "This is not a TIFF file (it does not start with II or MM)");
  const le = bo === "II";
  const hv = view(head);
  const magic = hv.getUint16(2, le);
  let big = false, first: number;
  if (magic === 42) first = hv.getUint32(4, le);
  else if (magic === 43) {
    if (head.length < 16) throw new TiffError("truncated", "The BigTIFF header is cut off: the file is truncated");
    if (hv.getUint16(4, le) !== 8) throw new TiffError("not-tiff", "This BigTIFF uses an offset size other than 8 bytes, which no TIFF reader supports");
    big = true;
    first = u64(hv, 8, le);
  } else throw new TiffError("not-tiff", `This is not a TIFF file (version ${magic}, expected 42 or 43)`);

  const bytes = new Bytes(src, le);
  const file: TiffFile = { source: src, littleEndian: le, bigTiff: big, size: src.size, pages: [], ifdCount: 0, skipped: { reduced: 0, masks: 0, subIfds: 0 }, impliedPages: 0, descriptionsKeptFor: null };
  const seen = new Set<number>();
  const layouts = new Map<string, PageLayout>();
  let descChars = 0;
  let offset = first, window = FIRST_WINDOW;
  let win: Uint8Array | null = null, winStart = 0;

  while (offset !== 0) {
    if (seen.has(offset)) throw new TiffError("ifd-loop", "The file's chain of images loops back on itself: it is damaged", "Re-save it from the program that made it");
    if (file.ifdCount >= maxIfds) throw new TiffError("too-many-pages", `The file has more than ${maxIfds.toLocaleString("en-US")} images (IFDs); Flux reads at most that many from one TIFF`, "Split it into several files");
    if (offset < 8 || offset >= src.size) throw pastEnd(offset, 2, src.size);
    seen.add(offset);
    if ((file.ifdCount & 255) === 0) throwIfAborted(opts.signal);
    let parsed = win ? parseIfd(win, winStart, offset, big, le, src.size) : null;
    if (!parsed) {
      // Not in the current window: read a new one here. IFDs that follow each other closely (all at the end of
      // the file, or many tiny ones) make the window grow, so walking them costs few reads.
      const prevEnd = win ? winStart + win.byteLength : -1;
      window = prevEnd >= 0 && offset >= prevEnd && offset - prevEnd < MAX_WINDOW ? Math.min(MAX_WINDOW, window * 2) : FIRST_WINDOW;
      winStart = offset;
      win = await src.read(offset, Math.min(src.size - offset, window), opts.signal);
      parsed = parseIfd(win, winStart, offset, big, le, src.size);
      if (!parsed) {
        // One IFD larger than the window: read exactly it.
        const dv0 = view(win);
        const n = big ? u64(dv0, 0, le) : dv0.getUint16(0, le);
        const need = (big ? 16 : 6) + n * (big ? 20 : 12);
        if (n === 0 || n > MAX_ENTRIES) throw new TiffError("bad-ifd", `An IFD at byte ${offset} claims ${n} entries; the file is damaged or not a TIFF`);
        if (offset + need > src.size) throw pastEnd(offset, need, src.size);
        win = await src.read(offset, need, opts.signal);
        parsed = parseIfd(win, winStart, offset, big, le, src.size)!;
      }
    }
    file.ifdCount++;
    const { entries, next } = parsed;
    const byTag = new Map<number, RawEntry>();
    const descs: RawEntry[] = [];
    for (const e of entries) {
      if (e.tag === TAG.ImageDescription) descs.push(e);
      else if (!byTag.has(e.tag)) byTag.set(e.tag, e);
    }
    const small = async (tag: number): Promise<number[] | null> => {
      const e = byTag.get(tag);
      if (!e) return null;
      if (e.count > EAGER_VALUES && !e.bytes) return null;
      const b = e.bytes ?? await bytes.at(e.pos, e.count * TYPE_SIZE[e.type], 0, opts.signal);
      return decodeValues(b, e.type, e.count, le);
    };
    const one = async (tag: number, dflt: number): Promise<number> => (await small(tag))?.[0] ?? dflt;
    const text = async (e: RawEntry | undefined): Promise<string | undefined> => {
      if (!e || (e.type !== 2 && e.type !== 1 && e.type !== 7) || e.count > MAX_DESCRIPTION) return undefined;
      return decodeAscii(e.bytes ?? await bytes.at(e.pos, e.count, 0, opts.signal));
    };

    if (byTag.has(TAG.SubIFDs)) file.skipped.subIfds += byTag.get(TAG.SubIFDs)!.count;
    const nst = await one(TAG.NewSubfileType, 0), ost = await one(TAG.SubfileType, 1);
    if (nst & 1 || ost === 2) { file.skipped.reduced++; offset = next; continue; }
    if (nst & 4 || ost === 3) { file.skipped.masks++; offset = next; continue; }

    const width = await one(TAG.ImageWidth, 0), height = await one(TAG.ImageLength, 0);
    const samples = await one(TAG.SamplesPerPixel, 1);
    const bitsList = (await small(TAG.BitsPerSample)) ?? [1];
    const formats = (await small(TAG.SampleFormat)) ?? [1];
    const compression = await one(TAG.Compression, 1);
    const photometric = await one(TAG.Photometric, samples >= 3 ? 2 : 1);
    const planar = (await one(TAG.PlanarConfiguration, 1)) === 2 && samples > 1 ? 2 : 1;
    const tiled = byTag.has(TAG.TileWidth) || byTag.has(TAG.TileOffsets);
    const tileWidth = tiled ? await one(TAG.TileWidth, 0) : width;
    const tileHeight = tiled ? await one(TAG.TileLength, 0) : height;
    let rowsPerStrip = tiled ? tileHeight : await one(TAG.RowsPerStrip, height);
    if (!(rowsPerStrip > 0) || rowsPerStrip > height) rowsPerStrip = height;
    const st = sampleTypeOf(bitsList.length >= samples ? bitsList.slice(0, samples) : bitsList, formats.length >= samples ? formats.slice(0, samples) : formats);
    const perPlane = tiled
      ? (tileWidth > 0 && tileHeight > 0 ? Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight) : 0)
      : Math.ceil(height / Math.max(1, rowsPerStrip));
    const layout: PageLayout = {
      key: "", width, height, samples, bits: bitsList[0], sampleType: st.sampleType, dtype: st.dtype,
      compression,
      predictor: await one(TAG.Predictor, 1), planar, photometric,
      fillOrder: await one(TAG.FillOrder, 1), orientation: await one(TAG.Orientation, 1),
      extraSamples: (await small(TAG.ExtraSamples)) ?? [],
      tiled, tileWidth, tileHeight, rowsPerStrip, segments: perPlane * (planar === 2 ? samples : 1),
    };
    layout.key = [width, height, samples, layout.sampleType, compression, layout.predictor, planar, photometric, layout.fillOrder, tiled ? `t${tileWidth}x${tileHeight}` : `s${rowsPerStrip}`, layout.extraSamples.join(".")].join("|");
    const shared = layouts.get(layout.key) ?? (layouts.set(layout.key, layout), layout);

    const ref = (tag: number): ValueRef => {
      const e = byTag.get(tag);
      if (!e) return { type: 4, count: 0, pos: 0, values: [] };
      return { type: e.type, count: e.count, pos: e.pos, ...(e.bytes && e.count <= EAGER_VALUES ? { values: decodeValues(e.bytes, e.type, e.count, le) } : {}) };
    };
    const page: TiffPage = {
      index: file.pages.length, ifd: offset, layout: shared,
      offsets: ref(tiled ? TAG.TileOffsets : TAG.StripOffsets), counts: ref(tiled ? TAG.TileByteCounts : TAG.StripByteCounts),
      descriptions: [],
    };
    if (descChars < maxDesc) {
      for (const d of descs) { const t = await text(d); if (t !== undefined) { page.descriptions.push(t); descChars += t.length; } }
      const priv = await text(byTag.get(PRIVATE_TEXT_TAG));
      if (priv !== undefined) { page.privateText = priv; descChars += priv.length; }
    } else if (file.descriptionsKeptFor === null) file.descriptionsKeptFor = file.pages.length;
    const xr = byTag.has(TAG.XResolution) ? await one(TAG.XResolution, NaN) : NaN;
    if (Number.isFinite(xr)) page.resolution = { x: xr, y: await one(TAG.YResolution, xr), unit: await one(TAG.ResolutionUnit, 2) };
    if (file.pages.length === 0) { const sw = await text(byTag.get(TAG.Software)); if (sw !== undefined) page.software = sw; }
    file.pages.push(page);
    offset = next;
  }
  if (!file.pages.length) throw new TiffError("no-pages", "The file holds no full-resolution image");
  impliedImageJPages(file);
  return file;
}

/**
 * ImageJ writes files over 4 GB as a classic TIFF with one IFD: the description says `images=N` and the other
 * planes follow the first one contiguously. Detected when N exceeds the pages walked, the first page is one
 * uncompressed contiguous plane, and the planes fit in the file; the implied pages are then appended.
 */
function impliedImageJPages(file: TiffFile): void {
  const p0 = file.pages[0], d = p0.descriptions[0] ?? "";
  if (!d.startsWith("ImageJ=")) return;
  const m = /(?:^|\n)images=(\d+)/.exec(d);
  const n = m ? Number(m[1]) : 0;
  if (!(n > file.pages.length) || file.pages.length > 1 && file.pages.some((p) => p.layout !== p0.layout)) return;
  const L = p0.layout;
  if (L.compression !== 1 || L.tiled || L.planar !== 1 || !L.dtype || !p0.offsets.values || !p0.counts.values) return;
  const planeBytes = L.width * L.height * L.samples * (L.bits / 8);
  const offs = p0.offsets.values, cnts = p0.counts.values;
  for (let i = 1; i < offs.length; i++) if (offs[i] !== offs[i - 1] + cnts[i - 1]) return;
  if (cnts.reduce((a, b) => a + b, 0) < planeBytes) return;
  const start = offs[0];
  // The planes the IFDs walked already describe come first; the rest follow plane 0 at a fixed stride.
  if (start + n * planeBytes > file.size) return;      // truncated: the IFD pages alone are read; probe says so
  const have = file.pages.length;
  for (let i = have; i < n; i++) {
    file.pages.push({ index: i, ifd: p0.ifd, layout: L, offsets: { type: 16, count: 1, pos: 0, values: [start + i * planeBytes] }, counts: { type: 16, count: 1, pos: 0, values: [planeBytes] }, descriptions: [] });
  }
  file.impliedPages = n - have;
}

/** Name of a compression code, for messages. */
export function compressionName(code: number): string {
  const names: Record<number, string> = {
    1: "none", 2: "CCITT RLE", 3: "CCITT fax 3", 4: "CCITT fax 4", 5: "LZW", 6: "old-style JPEG", 7: "JPEG", 8: "Deflate", 32946: "Deflate",
    32773: "PackBits", 34712: "JPEG 2000", 33003: "JPEG 2000 (Aperio)", 33005: "JPEG 2000 (Aperio)", 34887: "LERC", 34925: "LZMA",
    50000: "Zstandard", 34926: "Zstandard", 50001: "WebP", 34927: "WebP", 50002: "JPEG XL", 52546: "JPEG XL",
  };
  return names[code] ?? `compression code ${code}`;
}
