/**
 * OME-XML in the first page's description (OME-TIFF). Pure.
 *
 * Parsed by a small tag scanner rather than a DOM parser: the reader needs only the attributes of a handful of
 * elements (Image, Pixels, Channel, TiffData, UUID, Plane, BinaryOnly), and a scanner keeps the pure core free of a
 * dependency that the worker and CLI bundles would otherwise carry. Comments, CDATA and processing instructions
 * are skipped; entities in attribute values are decoded.
 */
import type { DimSpec, Hint } from "../types";
import { fmt, normaliseLengthUnit, secondsPer } from "./imagej";

export const isOme = (d: string | undefined): boolean => !!d && /<OME[\s>]/.test(d.slice(0, 4096));

interface Tag { name: string; attrs: Record<string, string>; depth: number; text?: string }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e]);

/** Every start tag, with its local name (prefix dropped), attributes and nesting depth; text of UUID elements kept. */
export function scanXml(xml: string, keep: ReadonlySet<string>): Tag[] {
  const out: Tag[] = [];
  let depth = 0, i = 0, last: Tag | null = null;
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (last && last.text === "") last.text = decodeEntities(xml.slice(i, lt).trim());
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt + 4); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") { const e = xml.indexOf(">", lt); i = e < 0 ? xml.length : e + 1; continue; }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) break;
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith("/")) { depth--; last = null; continue; }
    const selfClosing = body.endsWith("/");
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const name = m[1].includes(":") ? m[1].slice(m[1].indexOf(":") + 1) : m[1];
    last = null;
    if (keep.has(name)) {
      const attrs: Record<string, string> = {};
      for (const a of body.slice(m[1].length).matchAll(attrRe)) attrs[a[1].includes(":") ? a[1].slice(a[1].indexOf(":") + 1) : a[1]] = decodeEntities(a[3] ?? a[4] ?? "");
      const tag: Tag = { name, attrs, depth };
      if (name === "UUID" && !selfClosing) tag.text = "";
      out.push(tag);
      if (!selfClosing) last = tag;
    }
    if (!selfClosing) depth++;
  }
  return out;
}

export interface OmeImage {
  name: string | null;
  order: string;
  sizes: { X: number; Y: number; Z: number; C: number; T: number };
  /** Channel planes (SizeC divided by each channel's samples per pixel). */
  channelPlanes: number;
  channels: Array<{ name: string | null; color: string | null; samples: number }>;
  physical: { x: number | null; y: number | null; z: number | null; xUnit: string | null; zUnit: string | null };
  timeIncrement: number | null;
  /** First IFD of the image's planes, and the planes TiffData accounts for. */
  firstIfd: number;
  planeCount: number;
  /** Per-plane TiffData that disagrees with DimensionOrder. */
  orderMismatch: boolean;
  /** Files other than the one holding the description that TiffData points into. */
  otherFiles: string[];
  /** One time per t index when the Planes give DeltaT (seconds). */
  deltaT: number[] | null;
}

export interface OmeInfo { images: OmeImage[]; binaryOnly: string | null }

const int = (s: string | undefined, d: number): number => { const v = Number(s); return s !== undefined && Number.isFinite(v) ? Math.round(v) : d; };
const numOrNull = (s: string | undefined): number | null => { const v = Number(s); return s !== undefined && s !== "" && Number.isFinite(v) ? v : null; };

/** OME colours are signed 32-bit RGBA integers. */
export function omeColour(v: string | undefined): string | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const u = (n >>> 0);
  return `#${((u >>> 8) & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function parseOme(xml: string, ownFileName?: string): OmeInfo {
  const tags = scanXml(xml, new Set(["Image", "Pixels", "Channel", "TiffData", "UUID", "Plane", "BinaryOnly"]));
  const binary = tags.find((t) => t.name === "BinaryOnly");
  const images: OmeImage[] = [];
  let cur: OmeImage | null = null, curTiffData: Tag | null = null;
  const files = new Set<string>();
  const tiffData: Array<{ img: OmeImage; ifd: number; c: number; z: number; t: number; count: number }> = [];
  const planes: Array<{ img: OmeImage; c: number; z: number; t: number; dt: number | null; unit: string | null }> = [];
  for (const t of tags) {
    if (t.name === "Image") {
      cur = { name: t.attrs.Name ?? null, order: "XYZCT", sizes: { X: 0, Y: 0, Z: 1, C: 1, T: 1 }, channelPlanes: 1, channels: [], physical: { x: null, y: null, z: null, xUnit: null, zUnit: null }, timeIncrement: null, firstIfd: 0, planeCount: 0, orderMismatch: false, otherFiles: [], deltaT: null };
      images.push(cur);
    } else if (!cur) continue;
    else if (t.name === "Pixels") {
      const a = t.attrs;
      cur.order = (a.DimensionOrder ?? "XYZCT").toUpperCase();
      cur.sizes = { X: int(a.SizeX, 0), Y: int(a.SizeY, 0), Z: Math.max(1, int(a.SizeZ, 1)), C: Math.max(1, int(a.SizeC, 1)), T: Math.max(1, int(a.SizeT, 1)) };
      cur.physical = { x: numOrNull(a.PhysicalSizeX), y: numOrNull(a.PhysicalSizeY), z: numOrNull(a.PhysicalSizeZ), xUnit: a.PhysicalSizeXUnit ?? "µm", zUnit: a.PhysicalSizeZUnit ?? "µm" };
      const ti = numOrNull(a.TimeIncrement), tu = secondsPer(a.TimeIncrementUnit ?? "s");
      cur.timeIncrement = ti !== null && tu !== null ? ti * tu : null;
    } else if (t.name === "Channel") {
      cur.channels.push({ name: t.attrs.Name ?? null, color: omeColour(t.attrs.Color), samples: Math.max(1, int(t.attrs.SamplesPerPixel, 1)) });
    } else if (t.name === "TiffData") {
      curTiffData = t;
      tiffData.push({ img: cur, ifd: int(t.attrs.IFD, 0), c: int(t.attrs.FirstC, 0), z: int(t.attrs.FirstZ, 0), t: int(t.attrs.FirstT, 0), count: int(t.attrs.PlaneCount, t.attrs.IFD !== undefined ? 1 : -1) });
    } else if (t.name === "UUID" && curTiffData) {
      const f = t.attrs.FileName;
      if (f && (!ownFileName || f !== ownFileName)) { files.add(f); if (!cur.otherFiles.includes(f)) cur.otherFiles.push(f); }
    } else if (t.name === "Plane") {
      planes.push({ img: cur, c: int(t.attrs.TheC, 0), z: int(t.attrs.TheZ, 0), t: int(t.attrs.TheT, 0), dt: numOrNull(t.attrs.DeltaT), unit: t.attrs.DeltaTUnit ?? "s" });
    }
  }
  for (const img of images) {
    // An RGB channel is one plane of several samples; otherwise SizeC counts planes.
    img.channelPlanes = img.channels.some((c) => c.samples > 1) ? Math.max(1, img.channels.length) : img.sizes.C;
    const total = img.sizes.Z * img.sizes.T * img.channelPlanes;
    const mine = tiffData.filter((d) => d.img === img);
    img.firstIfd = mine.length ? Math.min(...mine.map((d) => d.ifd)) : 0;
    img.planeCount = mine.length ? mine.reduce((n, d) => n + (d.count < 0 ? total : d.count), 0) : total;
    // TiffData that places a plane somewhere other than DimensionOrder would: the reader would have to permute.
    for (const d of mine) if (d.count === 1 && d.ifd - img.firstIfd !== planeIndex(img, d.c, d.z, d.t)) img.orderMismatch = true;
    const mp = planes.filter((p) => p.img === img && p.c === 0 && p.z === 0 && p.dt !== null);
    if (img.sizes.T > 1 && mp.length === img.sizes.T) {
      const sorted = mp.sort((a, b) => a.t - b.t);
      img.deltaT = sorted.map((p) => p.dt! * (secondsPer(p.unit) ?? 1));
    }
  }
  return { images, binaryOnly: binary ? binary.attrs.MetadataFile ?? "another file" : null };
}

/** Page index (from the image's first IFD) of plane (c, z, t) under the image's DimensionOrder. */
function planeIndex(img: OmeImage, c: number, z: number, t: number): number {
  const order = img.order.slice(2).split("");                 // fastest first, e.g. Z C T
  const size: Record<string, number> = { Z: img.sizes.Z, C: img.channelPlanes, T: img.sizes.T };
  const at: Record<string, number> = { Z: z, C: c, T: t };
  let idx = 0, stride = 1;
  for (const d of order) { idx += at[d] * stride; stride *= size[d]; }
  return idx;
}

/** One hint per OME image (series). */
export function omeHints(xml: string, pages: number, samples: number, ownFileName?: string): { hints: Hint[]; refusal: string | null } {
  const info = parseOme(xml, ownFileName);
  if (info.binaryOnly) return { hints: [], refusal: `This OME-TIFF holds only pixels; its metadata lives in ${info.binaryOnly}. Import the file that holds the metadata, or convert the whole dataset to one OME-TIFF first` };
  const others = [...new Set(info.images.flatMap((i) => i.otherFiles))];
  if (others.length) return { hints: [], refusal: `This OME-TIFF is part of a dataset spread over several files (${others.slice(0, 4).join(", ")}${others.length > 4 ? ", ..." : ""}). Flux imports single-file OME-TIFF; save the dataset as one file first (Fiji: Bio-Formats Exporter)` };
  const hints: Hint[] = [];
  info.images.forEach((img, k) => {
    const order = img.order.slice(2).split("").reverse();     // slowest first
    const size: Record<string, number> = { Z: img.sizes.Z, C: img.channelPlanes, T: img.sizes.T };
    const dims: DimSpec[] = order.filter((d) => size[d] > 1).map((d) => ({ name: d.toLowerCase(), size: size[d] }));
    const count = img.sizes.Z * img.sizes.T * img.channelPlanes;
    const reasons = [`OME-XML${info.images.length > 1 ? ` image ${k + 1} of ${info.images.length}${img.name ? ` (${img.name})` : ""}` : ""}: DimensionOrder ${img.order}${dims.length ? `, ${dims.map((d) => `${d.name} ${d.size}`).join(" × ")}` : ""}`];
    const problems: string[] = [];
    if (img.firstIfd + count > pages) problems.push(`OME-XML describes ${count} planes from page ${img.firstIfd + 1}; the file has ${pages} pages`);
    if (img.orderMismatch) problems.push("TiffData places planes in an order other than DimensionOrder");
    if (info.images.length === 1 && count !== pages && !problems.length) problems.push(`OME-XML describes ${count} planes; the file has ${pages} pages`);
    const hint: Hint = { source: "ome", confidence: problems.length ? "medium" : "high", dims, pages: { first: img.firstIfd, count }, reasons, ...(problems.length ? { problems } : {}) };
    if (samples >= 3 && img.channels.some((c) => c.samples >= 3)) hint.samples = "rgb";
    else if (samples > 1) hint.samples = "c";
    const unit = normaliseLengthUnit(img.physical.xUnit);
    if (img.physical.x && img.physical.x > 0 && unit) {
      hint.pixelSize = { x: img.physical.x, y: img.physical.y && img.physical.y > 0 ? img.physical.y : img.physical.x, unit };
      reasons.push(`pixel size ${fmt(img.physical.x)} ${unit}`);
    }
    if (img.physical.z && img.physical.z > 0 && img.sizes.Z > 1) { hint.z = { step: img.physical.z, unit: normaliseLengthUnit(img.physical.zUnit) }; reasons.push(`z step ${fmt(img.physical.z)} ${hint.z.unit ?? ""}`.trim()); }
    if (img.sizes.T > 1 && img.timeIncrement && img.timeIncrement > 0) { hint.time = { interval: img.timeIncrement, unit: "s" }; reasons.push(`time increment ${fmt(img.timeIncrement)} s`); }
    else if (img.deltaT) { hint.time = { coords: img.deltaT, unit: "s" }; reasons.push("frame times from the planes' DeltaT"); }
    if (img.channels.length && !hint.samples) hint.channels = img.channels.map((c) => ({ name: c.name ?? undefined, color: c.color }));
    hints.push(hint);
  });
  return { hints, refusal: null };
}
