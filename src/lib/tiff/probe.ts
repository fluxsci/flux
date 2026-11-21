/**
 * Probe a TIFF: a small serialisable summary of what it is, what its metadata says and whether Flux can convert
 * it. Pure. Costs the IFD walk plus, optionally, a few small reads for the brightness suggestion; never a plane.
 */
import { compressionName, openTiff, refValues, type OpenOptions, type PageLayout, type TiffFile } from "./ifd";
import { layoutProblem, type Codecs } from "./decode";
import { TiffError, type RangedSource } from "./io";
import { imagejHint, isImageJ } from "./meta/imagej";
import { isOme, omeHints } from "./meta/ome";
import { findShaped, shapedHint } from "./meta/shaped";
import { pageJsonHint, pageObjects } from "./meta/pagejson";
import type { Hint, TiffProbe } from "./types";

export interface ProbeOptions extends OpenOptions {
  /** The file's base name: OME-XML may name its own file; the fingerprint uses its pattern (digit runs → N). */
  fileName?: string;
  /** Codecs are not needed to probe; given, compressed pages are not refused for want of one. */
  codecs?: Partial<Codecs>;
  /** Read a little of the first pages to suggest interleaved channels when no metadata says anything (low confidence). */
  periodicity?: boolean;
}

/** Writer-default resolutions that say nothing physical (pixels per unit). */
const DEFAULT_RES_INCH = [1, 72, 96, 150, 300, 600];
const DEFAULT_RES_CM = [1, 72, 96, 72 / 2.54, 96 / 2.54, 300 / 2.54];

export function resolutionInfo(res: { x: number; y: number; unit: number } | undefined): TiffProbe["resolution"] {
  if (!res || !(res.x > 0)) return null;
  const unit = res.unit === 2 ? "inch" : res.unit === 3 ? "cm" : "none";
  if (unit === "none") return { x: res.x, y: res.y, unit, pixelSize: null, trusted: false, reason: "resolution without a unit (a writer default)" };
  const um = (unit === "inch" ? 25400 : 10000) / res.x;
  const near = (list: number[]): boolean => list.some((d) => Math.abs(res.x - d) < 1e-3 * d);
  if (near(unit === "inch" ? DEFAULT_RES_INCH : DEFAULT_RES_CM)) return { x: res.x, y: res.y, unit, pixelSize: um, trusted: false, reason: `${fmtRes(res.x)} pixels per ${unit} is a writer default, not a measurement` };
  if (!(um >= 0.001 && um <= 1000)) return { x: res.x, y: res.y, unit, pixelSize: um, trusted: false, reason: `${fmtRes(res.x)} pixels per ${unit} gives ${um.toPrecision(3)} µm pixels, outside microscopy` };
  return { x: res.x, y: res.y, unit, pixelSize: um, trusted: true, reason: `${fmtRes(res.x)} pixels per ${unit} = ${Number(um.toPrecision(6))} µm pixels` };
}
const fmtRes = (v: number): string => String(Number(v.toPrecision(6)));

/** 64-bit FNV-1a of a string, as 16 hex digits (stable across engines; no crypto needed for a fingerprint). */
export function fnv64(s: string): string {
  let h1 = 0x811c9dc5 >>> 0, h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c * 31 + i), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** A file name with its digit runs replaced, so "run_007_80Hz.tif" and "run_012_80Hz.tif" share one pattern. */
export const namePattern = (name: string): string => name.replace(/\d+/g, "N");

function descriptionKind(file: TiffFile): TiffProbe["description"]["kind"] {
  const d = file.pages[0].descriptions;
  if (!d.length && !file.pages[0].privateText) return "none";
  if (d.some(isImageJ)) return "imagej";
  if (d.some(isOme)) return "ome";
  if (findShaped(d)) return "shaped";
  if (pageObjects([file.pages[0]])[0]) return "json";
  return "text";
}

/** Probe an open file. */
export async function probeFile(file: TiffFile, opts: ProbeOptions = {}): Promise<TiffProbe> {
  const p0 = file.pages[0], L = p0.layout;
  const pages = file.pages.length;
  const series: TiffProbe["series"] = [];
  for (const p of file.pages) {
    const last = series[series.length - 1];
    if (last && file.pages[last.first].layout === p.layout) last.count++;
    else series.push({ first: p.index, count: 1, width: p.layout.width, height: p.layout.height, sampleType: p.layout.sampleType, samples: p.layout.samples });
  }
  const refusals: TiffProbe["refusals"] = [];
  const hints: Hint[] = [];
  const kind = descriptionKind(file);
  const desc0 = p0.descriptions;
  const res = resolutionInfo(p0.resolution);

  // Decodability, per series: a file is refused only when no series can be read.
  const problems = series.map((s) => layoutProblem(file.pages[s.first].layout, opts.codecs));
  if (problems.every(Boolean)) refusals.push({ code: problems[0]!.code, message: problems[0]!.message });
  // Strip and tile offsets the walk already holds: a truncated file is refused here, not half way through a conversion.
  for (const p of file.pages) {
    const o = p.offsets.values, c = p.counts.values;
    if (!o || !c) continue;
    let bad: string | null = null;
    for (let i = 0; i < Math.min(o.length, c.length) && !bad; i++) {
      if (!(c[i] > 0)) bad = `Page ${p.index + 1} has an empty ${p.layout.tiled ? "tile" : "strip"} (0 bytes): the file is damaged or was not finished`;
      else if (o[i] + c[i] > file.size) bad = `Page ${p.index + 1} points past the end of the file (${file.size} bytes): the file is truncated`;
    }
    if (bad) { refusals.push({ code: bad.includes("truncated") ? "truncated" : "bad-ifd", message: `${bad}. Copy it again from its source` }); break; }
  }

  if (desc0.some(isOme)) {
    const r = omeHints(desc0.find(isOme)!, pages, L.samples, opts.fileName);
    if (r.refusal) refusals.push({ code: "multi-file", message: r.refusal });
    hints.push(...r.hints);
  }
  if (desc0.some(isImageJ)) hints.push(imagejHint(desc0.find(isImageJ)!, pages, L.samples, p0.resolution ? p0.resolution.x : null));
  const shaped = findShaped(desc0);
  if (shaped) hints.push(shapedHint(shaped, series[0].count, L.width, L.height, L.samples));
  const pj = pageJsonHint(pageObjects(file.descriptionsKeptFor === null ? file.pages : file.pages.slice(0, file.descriptionsKeptFor)), pages);
  if (pj.hint) hints.push(pj.hint);
  if (res?.trusted && res.pixelSize) hints.push({ source: "resolution", confidence: "medium", pixelSize: { x: res.pixelSize, y: (res.unit === "inch" ? 25400 : 10000) / res.y, unit: "µm" }, reasons: [`resolution tags: ${res.reason}`] });
  if (L.samples > 1) {
    const rgb = L.photometric === 2 && L.samples >= 3;
    hints.push({ source: "samples", confidence: "high", samples: rgb ? "rgb" : "c", reasons: [rgb ? `RGB${L.samples === 4 ? "A" : ""} pixels (${L.samples} samples, photometric RGB)${L.samples === 4 ? "; the alpha sample is dropped" : ""}` : `${L.samples} samples per pixel, read as channels`] });
  }
  if (opts.periodicity && pages >= 8 && !hints.some((h) => h.dims?.length)) {
    const period = await brightnessPeriod(file, series[0].first, series[0].count, opts.signal).catch(() => null);
    if (period) hints.push({ source: "periodicity", confidence: "low", dims: [{ name: "t", size: "rest" }, { name: "c", size: period.period }], reasons: [`the first pages alternate in brightness with a period of ${period.period} (ratio ${period.ratio.toPrecision(3)}): perhaps ${period.period} interleaved channels, channel fastest`] });
  }

  const keyNames = pj.keys ? pj.keys.keys.map((k) => k.key).sort() : [];
  const fingerprintParts: Record<string, unknown> = {
    byteOrder: file.littleEndian ? "II" : "MM", bigTiff: file.bigTiff, sampleType: L.sampleType, plane: `${L.width}x${L.height}`, samples: L.samples,
    photometric: L.photometric, compression: L.compression, predictor: L.predictor, description: kind, keys: keyNames,
    software: p0.software ?? null, resolution: p0.resolution ? [p0.resolution.x, p0.resolution.y, p0.resolution.unit] : null,
    ...(opts.fileName ? { name: namePattern(opts.fileName) } : {}),
  };
  const fingerprint = fnv64(JSON.stringify(fingerprintParts));
  const s0 = series[0];
  return {
    probe: 1,
    container: { bigTiff: file.bigTiff, littleEndian: file.littleEndian, bytes: file.size, ifds: file.ifdCount, skippedReduced: file.skipped.reduced, skippedMasks: file.skipped.masks, subIfds: file.skipped.subIfds, impliedPages: file.impliedPages },
    pages,
    plane: planeInfo(L),
    series,
    description: { kind, pages: file.pages.filter((p) => p.descriptions.length).length, twoTags: desc0.length > 1 },
    software: p0.software ?? null,
    resolution: res,
    hints,
    keys: pj.keys,
    fingerprint, fingerprintParts,
    refusals,
    previewPage: s0.first + Math.floor(s0.count / 2),
  };
}

function planeInfo(L: PageLayout): TiffProbe["plane"] {
  return {
    width: L.width, height: L.height, samples: L.samples, dtype: L.dtype, sampleType: L.sampleType,
    compression: compressionName(L.compression), compressionCode: L.compression, predictor: L.predictor, planar: L.planar, photometric: L.photometric,
    tiled: L.tiled, tileWidth: L.tiled ? L.tileWidth : null, tileHeight: L.tiled ? L.tileHeight : null, orientation: L.orientation, extraSamples: L.extraSamples,
  };
}

/** Open and probe. Refusals of the container itself (not a TIFF, a loop in the chain, too many pages) are thrown as `TiffError`. */
export async function probeTiff(src: RangedSource, opts: ProbeOptions = {}): Promise<{ file: TiffFile; probe: TiffProbe }> {
  const file = await openTiff(src, opts);
  return { file, probe: await probeFile(file, opts) };
}

/**
 * Mean brightness of a sample of each of the first pages (uncompressed files only: 64 KB from the middle of each),
 * and the smallest period 2..4 whose groups differ far more than they vary. A suggestion, never a decision.
 */
async function brightnessPeriod(file: TiffFile, first: number, count: number, signal?: AbortSignal): Promise<{ period: number; ratio: number } | null> {
  const L = file.pages[first].layout;
  if (L.compression !== 1 || !L.dtype || L.samples !== 1) return null;
  const bps = L.bits / 8, n = Math.min(64, count);
  const means: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = file.pages[first + i];
    const offs = await refValues(file, p.offsets, signal), cnts = await refValues(file, p.counts, signal);
    const k = offs.length >> 1;
    const len = Math.min(cnts[k], 65536) - (Math.min(cnts[k], 65536) % bps);
    if (!(len > 0) || offs[k] + len > file.size) return null;
    const b = await file.source.read(offs[k], len, signal);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), le = file.littleEndian;
    let s = 0, c = 0;
    for (let j = 0; j + bps <= len; j += bps) {
      const v = L.dtype === "float32" ? dv.getFloat32(j, le) : L.dtype === "float64" ? dv.getFloat64(j, le) : L.dtype === "uint16" ? dv.getUint16(j, le) : L.dtype === "int16" ? dv.getInt16(j, le)
        : L.dtype === "uint32" ? dv.getUint32(j, le) : L.dtype === "int32" ? dv.getInt32(j, le) : L.dtype === "int8" ? dv.getInt8(j) : dv.getUint8(j);
      if (Number.isFinite(v)) { s += v; c++; }
    }
    means.push(c ? s / c : NaN);
  }
  if (means.some((m) => !Number.isFinite(m))) return null;
  for (const period of [2, 3, 4]) {
    const usable = means.length - (means.length % period);
    if (usable < period * 3) continue;
    const groups = Array.from({ length: period }, (_, g) => means.slice(0, usable).filter((_, i) => i % period === g));
    const gm = groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
    const within = groups.reduce((a, g, gi) => a + g.reduce((x, v) => x + (v - gm[gi]) ** 2, 0), 0) / (usable - period);
    const all = gm.reduce((a, b) => a + b, 0) / period;
    const between = gm.reduce((a, m) => a + (m - all) ** 2, 0) / Math.max(1, period - 1);
    const ratio = between / Math.max(within, 1e-12 * Math.abs(all) + 1e-30);
    if (ratio > 25 && new Set(gm.map((m) => m.toPrecision(3))).size === period) return { period, ratio };
  }
  return null;
}

export { TiffError };
