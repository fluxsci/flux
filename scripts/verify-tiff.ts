// Direct TIFF import (fluximg stage 2, W3): the pure reader, the metadata readers, inference, the converter and
// place-image / image-info with a TIFF.
//
// What is pinned:
//   A. Containers and layouts decode bit-exactly: classic and BigTIFF in both byte orders; strips of 1, 7 and all
//      rows; ragged tiles; planar RGB; IFDs before data, after it and all at the end; SHORT strip byte counts; two
//      description tags kept in order.
//   B. Codecs: none, LZW (8- and 16-bit, with code-table resets), Deflate, PackBits, predictor 2 at 8/16/32/64 bits,
//      predictor 3 for float32 and float64.
//   C. Sample types: uint8/16/32, int8/16/32, float32 with NaN, float64; 1 x 1; odd sizes; RGB 8/16; RGBA.
//   D. Metadata → proposals: ImageJ hyperstack (and its >4 GB one-IFD layout), OME-XML, shaped JSON with and without
//      axes, per-page JSON of two kinds, no metadata (interleaved brightness suggested, never decided), resolution
//      tags real and writer-default.
//   E. Refusals, each naming its cause: JPEG, complex samples, mixed shapes, multi-file OME, a truncated file, an IFD
//      loop, offsets past the end, empty strips, a million IFDs within a time and memory budget.
//   F. Answers: validation names every problem; a remembered rule re-applies to another page count; the fingerprint
//      ignores the page count.
//   G. Conversion: the bundle passes the contract validator and decodes back to the input within the encoding's
//      error (transpose, flips, de-interleave and no-data applied); axes, channels and coords from metadata;
//      progress monotone and complete; cancel leaves no staging folder and no bundle; the same input converts to the
//      same content id, which is the id the app's import computes.
//   H. place-image / image-info with a TIFF through the CLI: ready metadata places with no flags; a file without
//      metadata is refused with proposals and their flags, then placed with them; the element's source is the TIFF,
//      frozen; the scratch folder is gone.
//   I. (slow, opt-in: VERIFY_TIFF_SLOW=1) a ~1 GB synthetic stack converts in a child process whose peak RSS stays
//      under 1 GB.
//
// Pure tier, hermetic (scratch HOME/XDG before flux-core loads; every TIFF generated in code, invented values only).
// Run: node --import tsx scripts/verify-tiff.ts
import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";
import { writeTiff, writeStackFile, lzwEncode, rng, type TiffPageSpec, type TiffSpec } from "./lib/tiffFixtures";

const repo = path.resolve(import.meta.dirname, "..");

// ---- child mode (section I): convert one file and report peak RSS ---------------------------------------------------
if (process.argv[2] === "--child-convert") {
  const { convertTiff } = await import("../flux-core/tiffConvert");
  const [tif, out, answer] = process.argv.slice(3);
  const t0 = Date.now();
  const r = await convertTiff(tif, JSON.parse(answer), out, {});
  console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, bytes: r.bytes, read: r.bytesRead, maxRssKb: process.resourceUsage().maxRSS }));
  process.exit(0);
}

const h = harness("verify-tiff");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "verify-tiff-"));
Object.assign(process.env, isolatedEnv(path.join(scratch, "machine")), { FLUX_NO_MIGRATE: "1" });

const { memorySource, TiffError } = await import("../src/lib/tiff/io");
const { openTiff } = await import("../src/lib/tiff/ifd");
const { readPage } = await import("../src/lib/tiff/decode");
const { probeFile, probeTiff: probeMem } = await import("../src/lib/tiff/probe");
const { inferDims, validateAnswer, answerProblems, answerRule, applyRule, needsAsking } = await import("../src/lib/tiff/infer");
const { lzwDecode } = await import("../src/lib/tiff/lzw");
const { convertTiff, probeTiff, nodeTiffCodecs } = await import("../flux-core/tiffConvert");
const { nodeBundleReader, nodeZstd } = await import("../flux-core/fluximgIo");
const { validateFluximg } = await import("../src/lib/fluximg/validate");
const { readValues } = await import("./lib/fluximgFixtures");
const { importBundle } = await import("../electron/fluximgFiles.cjs");
const core = await import("../flux-core/index");
const { loadFigModel } = await import("../flux-core/model");
type DimsAnswer = import("../src/lib/tiff/types").DimsAnswer;
type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

const codecs = nodeTiffCodecs();
const zstd = await nodeZstd();
const CTOR = { uint8: Uint8Array, int8: Int8Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array, int32: Int32Array, float32: Float32Array, float64: Float64Array } as const;
type Dt = keyof typeof CTOR;

/** Invented sample values that use the type's range (and NaN for floats when asked). */
function values(dtype: Dt, n: number, seed: number, opts: { nan?: number; smooth?: boolean; offset?: number } = {}): TypedArray {
  const r = rng(seed), a = new CTOR[dtype](n);
  const span: Record<Dt, [number, number]> = { uint8: [0, 255], int8: [-128, 127], uint16: [0, 65535], int16: [-32768, 32767], uint32: [0, 4e9], int32: [-2e9, 2e9], float32: [-500, 1500], float64: [-1e6, 1e6] };
  const [lo, hi] = span[dtype];
  for (let i = 0; i < n; i++) {
    if (opts.nan && r() < opts.nan) { a[i] = NaN; continue; }
    const v = opts.smooth ? (opts.offset ?? 0) + 200 + 100 * Math.sin(i / 17) + 5 * r() : lo + r() * (hi - lo);
    a[i] = dtype.startsWith("float") ? v : Math.round(v);
  }
  return a;
}
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false; return true; };
const pageSpec = (over: Partial<TiffPageSpec> & { dtype: Dt; width: number; height: number; data: TypedArray }): TiffPageSpec => ({ ...over });

async function decodeAll(bytes: Uint8Array): Promise<TypedArray[]> {
  const f = await openTiff(memorySource(bytes));
  const out: TypedArray[] = [];
  for (const p of f.pages) out.push(await readPage(f, p, codecs) as TypedArray);
  return out;
}
async function exact(spec: TiffSpec, label: string, expect?: TypedArray[]): Promise<void> {
  try {
    const got = await decodeAll(writeTiff(spec));
    const want = expect ?? spec.pages.map((p) => p.data as TypedArray);
    h.ok(got.length === want.length && got.every((g, i) => same(g, want[i])), `${label}: ${want.length} page(s) decode bit-exactly`);
  } catch (e) { h.fail(`${label}: ${(e as Error).message}`); }
}
async function probeOf(bytes: Uint8Array, fileName?: string) {
  const { probe } = await probeMem(memorySource(bytes), { fileName, codecs, periodicity: true });
  return { probe, proposals: inferDims(probe) };
}
async function save(name: string, bytes: Uint8Array): Promise<string> { const p = path.join(scratch, "tiffs", name); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, bytes); return p; }
async function refused(bytes: Uint8Array, code: RegExp, words: RegExp, label: string): Promise<void> {
  try {
    const { probe } = await probeOf(bytes);
    const r = probe.refusals[0];
    h.ok(!!r && code.test(r.code) && words.test(r.message), `${label}: refused (${r ? `${r.code}: "${r.message}"` : "not refused"})`);
  } catch (e) {
    const err = e as InstanceType<typeof TiffError>;
    h.ok(code.test(err.code ?? "") && words.test(err.message), `${label}: refused on opening (${err.code}: "${err.message}")`);
  }
}

try {
  // ------------------------------------------------------------------------------------------------------------------
  h.section("A. containers and layouts");
  const W = 37, H = 23;
  const u16 = [values("uint16", W * H, 1), values("uint16", W * H, 2), values("uint16", W * H, 3)];
  for (const bigTiff of [false, true]) for (const littleEndian of [true, false]) for (const rps of [1, 7, H]) {
    await exact({ bigTiff, littleEndian, pages: u16.map((data) => pageSpec({ width: W, height: H, dtype: "uint16", data, rowsPerStrip: rps })) }, `${bigTiff ? "BigTIFF" : "classic"} ${littleEndian ? "II" : "MM"}, RowsPerStrip ${rps}`);
  }
  for (const layout of ["ifd-first", "data-first", "ifds-at-end"] as const) {
    await exact({ layout, bigTiff: layout === "ifds-at-end", pages: u16.map((data) => pageSpec({ width: W, height: H, dtype: "uint16", data, rowsPerStrip: 5 })) }, `IFDs ${layout}`);
  }
  await exact({ littleEndian: false, pages: [pageSpec({ width: W, height: H, dtype: "float32", data: values("float32", W * H, 4), tile: [16, 16] })] }, "tiles 16 x 16 with ragged edges (MM, float32)");
  await exact({ bigTiff: true, pages: [pageSpec({ width: 40, height: 33, dtype: "uint16", data: values("uint16", 40 * 33, 5), tile: [16, 32], compression: "deflate", predictor: 2 })] }, "tiles 16 x 32, Deflate + predictor 2");
  const rgbPlanar = values("uint8", 3 * W * H, 6);
  await exact({ pages: [pageSpec({ width: W, height: H, dtype: "uint8", data: rgbPlanar, samples: 3, planar: 2, rowsPerStrip: 4 })] }, "planar configuration 2 RGB, 4-row strips");
  await exact({ pages: [pageSpec({ width: W, height: H, dtype: "uint16", data: u16[0], rowsPerStrip: 3, shortCounts: true })] }, "SHORT strip byte counts");
  {
    const two = writeTiff({ pages: [pageSpec({ width: W, height: H, dtype: "uint16", data: u16[0], descriptions: ["first: a free text line", '{"shape": [23, 37]}'] })] });
    const f = await openTiff(memorySource(two));
    h.eq(f.pages[0].descriptions, ["first: a free text line", '{"shape": [23, 37]}'], "two ImageDescription tags: both kept, in order");
    const { probe, proposals } = await probeOf(two);
    h.ok(probe.description.twoTags && probe.description.kind === "shaped" && proposals[0].ready && proposals[0].answer.dims.length === 0, "and the shaped one among them is found (a single plane, ready)");
  }
  {
    // A window-crossing chain: many IFDs at the end, walked with few reads.
    const pages = Array.from({ length: 300 }, (_, i) => pageSpec({ width: 8, height: 6, dtype: "uint8", data: values("uint8", 48, 100 + i) }));
    const bytes = writeTiff({ bigTiff: true, layout: "ifds-at-end", pages });
    let reads = 0;
    const src = memorySource(bytes), counted = { size: src.size, read: (o: number, l: number) => { reads++; return src.read(o, l); } };
    const f = await openTiff(counted);
    h.ok(f.pages.length === 300 && reads <= 12, `300 IFDs packed at the end of the file are walked in ${reads} reads`);
    const dec = await Promise.all(f.pages.map((p) => readPage(f, p, codecs)));
    h.ok(dec.every((d, i) => same(d, pages[i].data)), "and every page decodes");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("B. codecs and predictors");
  for (const compression of ["none", "lzw", "deflate", "packbits"] as const) {
    for (const dt of ["uint8", "uint16"] as const) {
      const data = values(dt, 61 * 47, 7, dt === "uint8" ? {} : { smooth: true });
      await exact({ pages: [pageSpec({ width: 61, height: 47, dtype: dt, data, compression, rowsPerStrip: 9 })] }, `${compression} ${dt}`);
      await exact({ littleEndian: false, pages: [pageSpec({ width: 61, height: 47, dtype: dt, data, compression, predictor: 2, rowsPerStrip: 9 })] }, `${compression} ${dt} + predictor 2 (MM)`);
    }
  }
  {
    const noise = values("uint16", 200 * 200, 8);
    const raw = new Uint8Array(noise.buffer);
    const enc = lzwEncode(raw);
    h.ok(enc.length * 8 / 12 > 4 * 4094, `16-bit noise needs ${Math.floor(enc.length * 8 / 12)} LZW codes, so the 4,094-entry table resets several times`);
    h.ok(same(lzwDecode(enc, raw.length), raw), "LZW with table resets decodes bit-exactly");
    h.eq(lzwDecode(enc, 1000).length, 1000, "LZW output stops at the expected size (a strip cannot expand past its page)");
    await exact({ bigTiff: true, littleEndian: false, pages: [pageSpec({ width: 200, height: 200, dtype: "uint16", data: noise, compression: "lzw" })] }, "LZW 16-bit noise in a BigTIFF MM page");
  }
  for (const dt of ["uint32", "int32", "float64"] as const) await exact({ pages: [pageSpec({ width: 29, height: 11, dtype: dt, data: values(dt, 29 * 11, 9, { smooth: true }), compression: "deflate", predictor: 2 })] }, `predictor 2 at ${dt === "float64" ? 64 : 32} bits (${dt})`);
  for (const dt of ["float32", "float64"] as const) for (const le of [true, false]) {
    await exact({ littleEndian: le, pages: [pageSpec({ width: 31, height: 13, dtype: dt, data: values(dt, 31 * 13, 10, { nan: 0.05 }), compression: "deflate", predictor: 3, rowsPerStrip: 5 })] }, `predictor 3 ${dt} ${le ? "II" : "MM"} (NaN included)`);
  }
  await exact({ pages: [pageSpec({ width: 31, height: 13, dtype: "float32", data: values("float32", 31 * 13, 11), compression: "lzw", predictor: 3, tile: [16, 16] })] }, "predictor 3 in LZW tiles");
  {
    // A Deflate strip that inflates past its page is refused, not followed.
    const bomb = writeTiff({ pages: [pageSpec({ width: 4, height: 4, dtype: "uint8", data: new Uint8Array(16), compression: "deflate" })] });
    const f = await openTiff(memorySource(bomb));
    const big = zlib.deflateSync(Buffer.alloc(1 << 20));
    const realCodecs = { inflate: (s: Uint8Array, n: number) => codecs.inflate(big, n) };
    await readPage(f, f.pages[0], realCodecs).then(() => h.fail("a strip that inflates past its page: accepted"), (e) => h.ok(/expands to more bytes/.test((e as Error).message), `a strip that inflates 1 MiB into a 16-byte page is refused: "${(e as Error).message}"`));
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("C. sample types and shapes");
  for (const dt of ["uint8", "uint16", "uint32", "int8", "int16", "int32", "float64"] as const) await exact({ pages: [pageSpec({ width: 13, height: 7, dtype: dt, data: values(dt, 91, 12) })] }, `${dt}, 13 x 7`);
  await exact({ pages: [pageSpec({ width: 13, height: 7, dtype: "float32", data: values("float32", 91, 13, { nan: 0.2 }) })] }, "float32 with NaN");
  await exact({ pages: [pageSpec({ width: 1, height: 1, dtype: "uint16", data: Uint16Array.of(4242) })] }, "1 x 1");
  await exact({ pages: [pageSpec({ width: 13, height: 7, dtype: "uint8", data: values("uint8", 3 * 91, 14), samples: 3 })] }, "RGB 8-bit, chunky");
  await exact({ littleEndian: false, pages: [pageSpec({ width: 13, height: 7, dtype: "uint16", data: values("uint16", 3 * 91, 15), samples: 3, compression: "lzw", predictor: 2 })] }, "RGB 16-bit MM, LZW + predictor 2 (stride 3)");
  await exact({ pages: [pageSpec({ width: 13, height: 7, dtype: "uint8", data: values("uint8", 4 * 91, 16), samples: 4, extraSamples: [2] })] }, "RGBA 8-bit");

  // ------------------------------------------------------------------------------------------------------------------
  h.section("D. metadata → proposals");
  // ImageJ hyperstack: C=2 Z=3 T=4, pages in XYCZT order.
  const ijPages = Array.from({ length: 24 }, (_, i) => values("uint16", 20 * 16, 200 + i));
  const ijDesc = "ImageJ=1.54f\nimages=24\nchannels=2\nslices=3\nframes=4\nhyperstack=true\nmode=composite\nunit=micron\nspacing=0.5\nfinterval=0.05\nloop=false\n";
  const ijBytes = writeTiff({ littleEndian: false, pages: ijPages.map((data, i) => pageSpec({ width: 20, height: 16, dtype: "uint16", data, ...(i === 0 ? { descriptions: [ijDesc], resolution: { x: 5, y: 5, unit: 1 } } : {}) })) });
  {
    const { probe, proposals } = await probeOf(ijBytes);
    const top = proposals[0];
    h.eq([probe.description.kind, top.from, top.confidence, top.ready], ["imagej", "imagej", "high", true], "ImageJ hyperstack: the top proposal is ImageJ's, high confidence, ready");
    h.eq(top.answer.dims, [{ name: "t", size: 4 }, { name: "z", size: 3 }, { name: "c", size: 2 }], "dims in ImageJ order: t 4 × z 3 × c 2 (channel fastest)");
    h.eq([top.answer.pixelSize, top.answer.z, top.answer.time], [{ x: 0.2, unit: "µm" }, { step: 0.5, unit: "µm" }, { interval: 0.05, unit: "s" }], "pixel size 1/XResolution in the unit, z spacing, frame interval");
    h.ok(!needsAsking(proposals), "nothing to ask");
  }
  {
    // ImageJ's large-file layout: one IFD, images=N, the planes contiguous after the first.
    const planes = Array.from({ length: 6 }, (_, i) => values("int16", 12 * 9, 300 + i));
    const one = writeTiff({ pages: [pageSpec({ width: 12, height: 9, dtype: "int16", data: planes[0], descriptions: ["ImageJ=1.54f\nimages=6\nslices=6\nunit=micron\n"] })] });
    const rest = new Uint8Array(planes.slice(1).reduce((n, p) => n + p.byteLength, 0));
    planes.slice(1).reduce((at, p) => { rest.set(new Uint8Array(p.buffer), at); return at + p.byteLength; }, 0);
    // writeTiff puts the IFD first and the data last, so the other planes simply follow the first one.
    const big = new Uint8Array(one.length + rest.length); big.set(one); big.set(rest, one.length);
    const f = await openTiff(memorySource(big));
    h.eq([f.ifdCount, f.pages.length, f.impliedPages], [1, 6, 5], "ImageJ >4 GB layout: 1 IFD, images=6 → 6 pages (5 implied)");
    const dec = await Promise.all(f.pages.map((p) => readPage(f, p, codecs)));
    h.ok(dec.every((d, i) => same(d, planes[i])), "the implied planes decode bit-exactly at offset0 + i × plane bytes");
    const { proposals } = await probeOf(big);
    h.ok(proposals[0].ready && JSON.stringify(proposals[0].answer.dims) === JSON.stringify([{ name: "z", size: 6 }]), `and are proposed as z 6 (${proposals[0].summary})`);
    const cut = big.subarray(0, big.length - 50);
    const fc = await openTiff(memorySource(cut));
    h.eq(fc.pages.length, 1, "a truncated large-file layout implies no pages past the end");
  }
  // OME-XML, DimensionOrder XYZTC: Z fastest, then T, then C.
  const omeXml = (sizes: { Z: number; T: number; C: number }, extra = ""): string => `<?xml version="1.0" encoding="UTF-8"?><!-- a comment with <tags> --><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0" Name="synthetic &amp; invented"><Pixels ID="Pixels:0" DimensionOrder="XYZTC" Type="uint8" SizeX="10" SizeY="8" SizeZ="${sizes.Z}" SizeT="${sizes.T}" SizeC="${sizes.C}" PhysicalSizeX="0.325" PhysicalSizeY="0.325" PhysicalSizeZ="1.5" TimeIncrement="250" TimeIncrementUnit="ms"><Channel ID="Channel:0:0" Name="alpha" Color="-16776961" SamplesPerPixel="1"/><Channel ID="Channel:0:1" Name="beta" Color="16711935" SamplesPerPixel="1"/><TiffData IFD="0" PlaneCount="${sizes.Z * sizes.T * sizes.C}">${extra}</TiffData></Pixels></Image></OME>`;
  const omePages = Array.from({ length: 12 }, (_, i) => values("uint8", 80, 400 + i));
  const omeBytes = writeTiff({ pages: omePages.map((data, i) => pageSpec({ width: 10, height: 8, dtype: "uint8", data, ...(i === 0 ? { descriptions: [omeXml({ Z: 3, T: 2, C: 2 })] } : {}) })) });
  {
    const { probe, proposals } = await probeOf(omeBytes);
    const top = proposals[0];
    h.eq([probe.description.kind, top.from, top.ready], ["ome", "ome", true], "OME-XML: proposal from OME, ready");
    h.eq(top.answer.dims, [{ name: "c", size: 2 }, { name: "t", size: 2 }, { name: "z", size: 3 }], "XYZTC → c 2 × t 2 × z 3 (z fastest)");
    h.eq([top.answer.pixelSize, top.answer.z, top.answer.time], [{ x: 0.325, unit: "µm" }, { step: 1.5, unit: "µm" }, { interval: 0.25, unit: "s" }], "physical sizes and the time increment (ms → s)");
    h.eq(top.answer.channels, [{ name: "alpha", color: "#ff0000" }, { name: "beta", color: "#00ff00" }], "channel names and colours (signed RGBA ints)");
  }
  // tifffile's shaped JSON, with and without axes.
  const shPages = Array.from({ length: 6 }, (_, i) => values("float32", 30, 500 + i));
  const shaped = (desc: string) => writeTiff({ pages: shPages.map((data, i) => pageSpec({ width: 6, height: 5, dtype: "float32", data, ...(i === 0 ? { descriptions: [desc], software: "a python writer" } : {}) })) });
  {
    const a = await probeOf(shaped('{"shape": [3, 2, 5, 6], "axes": "TCYX"}'));
    h.ok(a.proposals[0].ready && JSON.stringify(a.proposals[0].answer.dims) === JSON.stringify([{ name: "t", size: 3 }, { name: "c", size: 2 }]), `shaped JSON with axes TCYX: t 3 × c 2, ready (${a.proposals[0].summary})`);
    const b = await probeOf(shaped('{"shape": [6, 5, 6]}'));
    h.ok(!b.proposals[0].ready && b.proposals[0].confidence === "medium" && b.proposals[0].missing.some((m) => /name of the dimension of size 6/.test(m)), `shaped JSON without axes: the sizes, not the names: ask (${b.proposals[0].missing[0]})`);
    const c = await probeOf(shaped('{"shape": [3, 2, 5, 6], "axes": "QCYX"}'));
    h.ok(!c.proposals[0].ready, "axis letter Q (a sequence): ask");
  }
  // Per-page JSON shaped like a reference z stack: a float depth constant over runs of 2, a 1-based alternating channel.
  const refPages = 2 * 7;
  const refDesc = (i: number) => JSON.stringify({ formatVersion: 3, depth: -20 + 2.5 * Math.floor(i / 2), channel: (i % 2) + 1, pathIdx: 0, transform: [[1, 0, 0, 5], [0, 1, 0, 6], [0, 0, 1, 0], [0, 0, 0, 1]] });
  const refBytes = writeTiff({ bigTiff: true, pages: Array.from({ length: refPages }, (_, i) => pageSpec({ width: 9, height: 7, dtype: "float32", data: values("float32", 63, 600 + i, { smooth: true }), rowsPerStrip: 1, shortCounts: true, descriptions: [refDesc(i)] })) });
  {
    const { probe, proposals } = await probeOf(refBytes);
    const top = proposals[0];
    h.eq([top.from, top.confidence, top.ready], ["pagejson", "high", true], "per-page JSON (depth runs + alternating channel): high confidence, ready");
    h.eq(top.answer.dims, [{ name: "z", size: 7 }, { name: "c", size: 2 }], "dims z 7 × c 2 (channel fastest)");
    h.eq(top.answer.z?.coords, Array.from({ length: 7 }, (_, i) => -20 + 2.5 * i), "z positions read from the depth key");
    h.ok(top.missing.includes("pixel size") && !top.answer.pixelSize, "the pixel size is not in the file: listed as unknown, not invented");
    h.ok(!!top.answer.world && top.answer.world.matrix.length === 4, "a 4 x 4 matrix key is offered as the world matrix");
    const keyKinds = Object.fromEntries(probe.keys!.keys.map((k) => [k.key, k.kind]));
    h.eq(keyKinds, { formatVersion: "constant", depth: "coordinate", channel: "index", pathIdx: "constant", transform: "constant" }, "the key summary: constants, an index and a coordinate");
  }
  // Per-page JSON shaped like a raw acquisition: channel index, a timestamp per page, a pixel size with a unit suffix.
  const acqN = 2 * 9;
  const acqDesc = (i: number) => JSON.stringify({ numChannels: 2, frameChannel: (i % 2) + 1, frameNumber: Math.floor(i / 2) + 1, timestamp: 1000 + 0.0125 * Math.floor(i / 2) + 0.0001 * (i % 2), pixelSize_um: 0.4, shiftX: Math.sin(i) * 0.1 });
  const acqBytes = writeTiff({ bigTiff: true, pages: Array.from({ length: acqN }, (_, i) => pageSpec({ width: 8, height: 6, dtype: "int16", data: values("int16", 48, 700 + i), descriptions: [acqDesc(i)], resolution: { x: 72, y: 72, unit: 3 }, software: "" })) });
  {
    const { probe, proposals } = await probeOf(acqBytes);
    const top = proposals[0];
    h.ok(top.ready && JSON.stringify(top.answer.dims) === JSON.stringify([{ name: "t", size: 9 }, { name: "c", size: 2 }]), `per-page JSON (channel, frame number, timestamp): t 9 × c 2, ready (${top.summary})`);
    h.ok(Math.abs((top.answer.time?.interval ?? 0) - 0.0125) < 1e-9, `the frame interval from the timestamps: ${top.answer.time?.interval} s (80 Hz)`);
    h.eq(top.answer.pixelSize, { x: 0.4, unit: "µm" }, "the pixel size from a key with a µm suffix");
    h.ok(probe.resolution?.trusted === false && /writer default/.test(probe.resolution.reason), `72 pixels per cm is a writer default, not trusted (${probe.resolution?.reason})`);
  }
  // No metadata: two interleaved channels of different brightness, stored column-major. Never decided silently.
  const movT = 40, movW = 12, movH = 30;
  const movPages = Array.from({ length: movT * 2 }, (_, i) => values("float32", movW * movH, 800 + i, { smooth: true, offset: i % 2 ? 900 : 0, nan: 0.02 }));
  const movBytes = writeTiff({ bigTiff: true, layout: "ifds-at-end", pages: movPages.map((data) => pageSpec({ width: movW, height: movH, dtype: "float32", data, resolution: { x: 40000, y: 40000, unit: 3 } })) });
  {
    const { probe, proposals } = await probeOf(movBytes, "run_007_80Hz.tif");
    h.ok(needsAsking(proposals) && proposals.every((p) => !p.ready && p.confidence === "low"), `no metadata: every proposal is low confidence and none is ready (${proposals.length} offered)`);
    const period = probe.hints.find((h2) => h2.source === "periodicity");
    h.ok(!!period && JSON.stringify(period.dims) === JSON.stringify([{ name: "t", size: "rest" }, { name: "c", size: 2 }]), "alternating brightness is suggested as two interleaved channels (low confidence)");
    h.ok(proposals.some((p) => JSON.stringify(p.answer.dims) === JSON.stringify([{ name: "t", size: "rest" }, { name: "c", size: 2 }])), "and offered among the proposals");
    h.ok(probe.resolution?.trusted === true && Math.abs(probe.resolution.pixelSize! - 0.25) < 1e-12 && proposals[0].answer.pixelSize?.x === 0.25, "40000 pixels per cm → 0.25 µm, trusted, prefilled");
    h.ok(probe.fingerprintParts.name === "run_N_NHz.tif" && !JSON.stringify(probe.fingerprintParts).includes("007"), "the fingerprint keeps the file name's pattern, never the name");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("E. refusals");
  const tiny = (over: Partial<TiffPageSpec> = {}) => pageSpec({ width: 6, height: 4, dtype: "uint8", data: values("uint8", 24, 900), ...over });
  await refused(writeTiff({ pages: [tiny({ compressionCode: 7 })] }), /compression/, /JPEG.*cannot read.*Re-save/, "JPEG");
  await refused(writeTiff({ pages: [tiny({ compressionCode: 34887 })] }), /compression/, /LERC/, "LERC");
  await refused(writeTiff({ pages: [pageSpec({ width: 6, height: 4, dtype: "float32", data: values("float32", 24, 901), sampleFormat: 6 })] }), /sample-type/, /complex/, "complex samples");
  await refused(writeTiff({ pages: [pageSpec({ width: 6, height: 4, dtype: "uint32", data: new Uint32Array(48), bits: 64, sampleFormat: 1 })] }), /sample-type/, /uint64/, "64-bit integers");
  await refused(writeTiff({ pages: [tiny({ photometric: 3 })] }), /photometric/, /palette/, "a palette image");
  await refused(writeTiff({ pages: [tiny({ descriptions: [omeXml({ Z: 1, T: 1, C: 1 }, '<UUID FileName="part_2.ome.tif">urn:uuid:00000000-0000-0000-0000-000000000000</UUID>')] })] }), /multi-file/, /several files \(part_2\.ome\.tif\)/, "a multi-file OME dataset (naming the other file)");
  {
    const mixed = writeTiff({ pages: [tiny(), tiny(), pageSpec({ width: 9, height: 4, dtype: "uint16", data: values("uint16", 36, 902) })] });
    const { probe, proposals } = await probeOf(mixed);
    h.eq(probe.series.map((s) => [s.first, s.count]), [[0, 2], [2, 1]], "mixed shapes: two series");
    const why = validateAnswer(probe, { dims: [{ name: "z", size: 3 }] });
    h.ok(!!why && /mix 2 different plane shapes/.test(why), `an answer over every page is refused: "${why}"`);
    h.ok(validateAnswer(probe, { dims: [{ name: "z", size: 2 }], pages: { first: 0, count: 2 } }) === null && proposals[0].answer.pages?.count === 2, "the pages of one series are accepted, and proposed");
  }
  {
    const whole = writeTiff({ pages: [tiny(), tiny()] });                 // IFD first, data last
    await refused(whole.subarray(0, whole.length - 10), /truncated/, /truncated/, "a truncated file (data cut)");
    const atEnd = writeTiff({ layout: "data-first", pages: [tiny(), tiny()] });
    await refused(atEnd.subarray(0, atEnd.length - 20), /past-eof|truncated/, /past its end|truncated/, "a truncated file (IFD cut)");
  }
  await refused(writeTiff({ loop: true, pages: [tiny(), tiny(), tiny()] }), /ifd-loop/, /loops back/, "an IFD loop");
  await refused(writeTiff({ pages: [tiny({ offsetPastEnd: true })] }), /truncated|past-eof/, /past the end/, "strip offsets past the end of the file");
  await refused(writeTiff({ pages: [tiny({ zeroCounts: true })] }), /bad-ifd/, /empty strip \(0 bytes\)/, "zero strip byte counts");
  {
    // A million tiny IFDs: refused at the cap, fast and in bounded memory.
    const n = 1_000_000, ifd = 2 + 12 + 4, buf = new Uint8Array(8 + n * ifd), dv = new DataView(buf.buffer);
    buf[0] = buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
    for (let i = 0; i < n; i++) { const at = 8 + i * ifd; dv.setUint16(at, 1, true); dv.setUint16(at + 2, 256, true); dv.setUint16(at + 4, 4, true); dv.setUint32(at + 6, 1, true); dv.setUint32(at + 10, 1, true); dv.setUint32(at + 14, i + 1 < n ? at + ifd : 0, true); }
    const heap0 = process.memoryUsage().heapUsed, t0 = Date.now();
    await openTiff(memorySource(buf)).then(() => h.fail("a million IFDs: accepted"), (e) => {
      const ms = Date.now() - t0, mb = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;
      h.ok((e as InstanceType<typeof TiffError>).code === "too-many-pages" && ms < 5000 && mb < 400, `a million IFDs are refused at the cap in ${ms} ms, heap +${mb.toFixed(0)} MB: "${(e as Error).message}"`);
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("F. answers and rules");
  {
    const { probe } = await probeOf(movBytes, "run_007_80Hz.tif");
    const cases: Array<[DimsAnswer, RegExp, string]> = [
      [{ dims: [{ name: "t", size: 30 }, { name: "c", size: 2 }] }, /multiply to 60 pages.*has 80/, "a product that is not the page count"],
      [{ dims: [{ name: "t", size: "rest" }, { name: "c", size: "rest" }] }, /only one dimension may be "the rest"/, "two rests"],
      [{ dims: [{ name: "t", size: "rest" }, { name: "c", size: 3 }] }, /80 \/ 3 is not whole/, "a rest that is not whole"],
      [{ dims: [{ name: "Time", size: 80 }] }, /not a valid dimension name/, "an invalid name"],
      [{ dims: [{ name: "t", size: 40 }, { name: "t", size: 2 }] }, /names repeat: t/, "a repeated name"],
      [{ dims: [{ name: "y", size: 80 }] }, /is the plane itself/, "y as a page dimension"],
      [{ dims: [{ name: "t", size: 80 }], pixelSize: { x: -1, unit: "µm" } }, /pixel size must be a finite number above 0/, "a negative pixel size"],
      [{ dims: [{ name: "t", size: 80 }], time: { coords: [0, 1, 2] } }, /3 positions for 80 t indices/, "coords of the wrong length"],
      [{ dims: [{ name: "t", size: 80 }], z: { step: 1 } }, /there is no z dimension/, "a z step without z"],
      [{ dims: [{ name: "t", size: 80 }], time: { interval: 1, rate: 2 } }, /an interval or a rate, not both/, "interval and rate"],
      [{ dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }], channels: [{ name: "a" }, { name: "a" }] }, /channel names repeat/, "repeated channel names"],
      [{ dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }], channels: [{ color: "green" }] }, /not #rrggbb/, "a colour that is not #rrggbb"],
      [{ dims: [{ name: "t", size: 80 }], nodata: Infinity }, /nodata must be a finite number/, "an infinite no-data value"],
    ];
    for (const [a, re, label] of cases) { const why = validateAnswer(probe, a); h.ok(!!why && re.test(why), `${label}: "${why}"`); }
    const { probe: ip } = await probeOf(writeTiff({ pages: [tiny(), tiny()] }));
    h.ok(/nodata 300 cannot occur in uint8/.test(validateAnswer(ip, { dims: [{ name: "z", size: 2 }], nodata: 300 }) ?? ""), "a no-data value the integer type cannot hold");
    h.ok(answerProblems(probe, { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }], transpose: true, pixelSize: { x: 0.25, unit: "µm" }, time: { rate: 80 }, nodata: -1 }).length === 0, "a full answer (rest, transpose, rate, no data) is accepted");

    // A remembered rule fits a file of the same structure with another page count.
    const answer: DimsAnswer = { dims: [{ name: "t", size: 40 }, { name: "c", size: 2 }], transpose: true, pixelSize: { x: 0.25, unit: "µm" }, time: { rate: 80 } };
    const rule = answerRule(answer, probe);
    h.eq(rule.answer.dims, [{ name: "t", size: "rest" }, { name: "c", size: 2 }], "the rule keeps c = 2 and makes t the rest");
    const longer = writeTiff({ bigTiff: true, layout: "ifds-at-end", pages: Array.from({ length: 66 }, (_, i) => pageSpec({ width: movW, height: movH, dtype: "float32", data: movPages[i % movPages.length], resolution: { x: 40000, y: 40000, unit: 3 } })) });
    const { probe: p2 } = await probeOf(longer, "run_012_80Hz.tif");
    h.eq(p2.fingerprint, probe.fingerprint, "the fingerprint ignores the page count and the digits of the name");
    const applied = applyRule(rule, p2);
    h.ok(applied.answer !== null && applied.problems.length === 0, "the rule applies to 66 pages (t = 33)");
    const props = inferDims(p2, { rules: [rule] });
    h.ok(props[0].from === "remembered" && props[0].ready && /t 33 × c 2/.test(props[0].summary), `and is proposed first, ready: ${props[0].summary}`);
    const { probe: p3 } = await probeOf(writeTiff({ pages: Array.from({ length: 66 }, () => tiny()) }));
    h.ok(applyRule(rule, p3).answer === null, "a file of another structure does not take the rule");
    const odd = writeTiff({ bigTiff: true, layout: "ifds-at-end", pages: Array.from({ length: 67 }, (_, i) => pageSpec({ width: movW, height: movH, dtype: "float32", data: movPages[i % movPages.length], resolution: { x: 40000, y: 40000, unit: 3 } })) });
    const { probe: p4 } = await probeOf(odd, "run_013_80Hz.tif");
    h.ok(applyRule(rule, p4).problems.some((p) => /67 \/ 2 is not whole/.test(p)), "nor one whose page count the rule cannot split");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("G. conversion");
  /** Convert, validate, and compare the bundle's values to the pages read through the answer. */
  async function roundTrip(label: string, bytes: Uint8Array, answer: DimsAnswer, pages: TypedArray[], W0: number, H0: number, expect: (manifest: any) => void = () => {}): Promise<{ manifest: any; sha256: string } | null> {
    const file = await save(`${label.replace(/\W+/g, "_")}.tif`, bytes);
    const out = path.join(scratch, "bundles", `${label.replace(/\W+/g, "_")}.fluximg`);
    try {
      const r = await convertTiff(file, answer, out, {});
      const v = await validateFluximg(nodeBundleReader(out), zstd);
      h.ok(v.ok, `${label}: the bundle passes the contract validator${v.ok ? "" : ": " + v.issues.map((i) => i.message).join("; ")}`);
      const got = await readValues(out);
      const m = r.manifest, nd = m.pixels.dims.length, Hh = m.pixels.shape[nd - 2], Ww = m.pixels.shape[nd - 1];
      const enc = m.pixels.encoding, ci = m.pixels.dims.indexOf("c");
      const tr = answer.transpose === true;
      h.eq([Ww, Hh], tr ? [H0, W0] : [W0, H0], `${label}: plane ${Ww} x ${Hh}${tr ? " (transposed)" : ""}`);
      // Strides of the answer's page dims.
      const sizes = m.pixels.dims.slice(0, nd - 2).map((d: string, i: number) => [d, m.pixels.shape[i]] as const);
      const pd = answer.dims.map((d) => ({ name: d.name, size: sizes.find((s: readonly [string, number]) => s[0] === d.name)![1] }));
      const strides = pd.map((_, i) => pd.slice(i + 1).reduce((a, b) => a * b.size, 1));
      const lead = m.pixels.shape.slice(0, nd - 2), nPlanes = lead.reduce((a: number, b: number) => a * b, 1);
      const spp = pages[0].length / (W0 * H0);
      let worst = 0, nanOk = true;
      for (let k = 0; k < nPlanes; k++) {
        const idx: number[] = []; let rem = k;
        for (let d = lead.length - 1; d >= 0; d--) { idx[d] = rem % lead[d]; rem = Math.floor(rem / lead[d]); }
        let page = 0, sample = 0;
        m.pixels.dims.slice(0, nd - 2).forEach((d: string, j: number) => { const a = pd.findIndex((x) => x.name === d); if (a >= 0) page += idx[j] * strides[a]; else if (d === "c") sample = idx[j]; });
        const src = pages[page].subarray(sample * W0 * H0, (sample + 1) * W0 * H0);
        const bound = enc.kind === "linear16" ? enc.channels[ci >= 0 ? idx[ci] : 0].scale / 2 + 1e-9 : 0;
        for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) {
          const sx = answer.flipX ? Ww - 1 - x : x, sy = answer.flipY ? Hh - 1 - y : y;
          let want = tr ? src[sx * W0 + sy] : src[sy * W0 + sx];
          if (answer.nodata !== undefined && answer.nodata !== null && want === answer.nodata) want = NaN;     // no data, float or integer
          const g = got.values[k * Hh * Ww + y * Ww + x];
          if (Number.isNaN(want) !== Number.isNaN(g)) { nanOk = false; continue; }
          if (!Number.isNaN(want)) worst = Math.max(worst, Math.abs(g - want) - bound);
        }
      }
      h.ok(nanOk && worst <= 0, `${label}: values within the encoding's error (${enc.kind}${enc.kind === "linear16" ? ", ≤ scale/2" : ", exact"}), no data in the same places`);
      expect(m);
      return { manifest: m, sha256: r.sha256 };
    } catch (e) { h.fail(`${label}: ${(e as Error).stack}`); return null; }
  }
  await roundTrip("ImageJ hyperstack", ijBytes, inferDims((await probeOf(ijBytes)).probe)[0].answer, ijPages, 20, 16, (m) => {
    h.eq(m.pixels.dims, ["t", "c", "z", "y", "x"], "ImageJ: canonical dims t, c, z, y, x");
    h.eq([m.axes.x.scale, m.axes.x.unit, m.axes.z.scale, m.axes.t.scale, m.axes.t.unit], [0.2, "µm", 0.5, 0.05, "s"], "axes from the metadata");
    h.eq(m.provenance.meta.tiff.answer.dims, [{ name: "t", size: 4 }, { name: "z", size: 3 }, { name: "c", size: 2 }], "provenance records the answer used");
    h.ok(!m.provenance.created && m.provenance.source[0].path.endsWith(".tif") && !path.isAbsolute(m.provenance.source[0].path), "provenance: the source's base name, no timestamp");
  });
  await roundTrip("OME", omeBytes, inferDims((await probeOf(omeBytes)).probe)[0].answer, omePages, 10, 8, (m) => {
    h.eq(m.channels.map((c: any) => [c.name, c.color]), [["alpha", "#ff0000"], ["beta", "#00ff00"]], "OME: channel names and colours in the bundle");
  });
  await roundTrip("per-page JSON z stack", refBytes, { ...inferDims((await probeOf(refBytes)).probe)[0].answer, nodata: -1, pixelSize: { x: 0.5, unit: "µm" } }, Array.from({ length: refPages }, (_, i) => { const p = values("float32", 63, 600 + i, { smooth: true }); return p; }), 9, 7, (m) => {
    h.eq(m.axes.z.coords, Array.from({ length: 7 }, (_, i) => -20 + 2.5 * i), "per-page JSON: z coords in the bundle");
    h.ok(Array.isArray(m.world?.matrix) && m.world.matrix.length === 4, "the world matrix in the bundle");
  });
  const movAnswer: DimsAnswer = { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }], transpose: true, pixelSize: { x: 0.25, unit: "µm" }, time: { rate: 80 } };
  const mov = await roundTrip("interleaved movie, transposed", movBytes, movAnswer, movPages, movW, movH, (m) => {
    h.eq([m.pixels.dims, m.pixels.shape], [["t", "c", "y", "x"], [40, 2, movW, movH]], "de-interleaved: t 40 × c 2, transposed plane");
    h.eq([m.axes.t.scale, m.axes.x.scale], [1 / 80, 0.25], "80 Hz → 0.0125 s per frame; 0.25 µm pixels");
  });
  await roundTrip("RGB planar, flipped", writeTiff({ pages: [pageSpec({ width: W, height: H, dtype: "uint8", data: rgbPlanar, samples: 3, planar: 2 })] }), { dims: [], flipX: true, flipY: true }, [rgbPlanar], W, H, (m) => {
    h.eq([m.photometric, m.channels.map((c: any) => c.name), m.channels[0].range], ["rgb", ["red", "green", "blue"], [0, 255]], "RGB: photometric rgb, red/green/blue, 0..255");
  });
  {
    const rgba = values("uint16", 4 * 91, 16);
    await roundTrip("RGBA, alpha dropped", writeTiff({ pages: [pageSpec({ width: 13, height: 7, dtype: "uint16", data: rgba, samples: 4, extraSamples: [2] })] }), { dims: [] }, [rgba], 13, 7, (m) => h.eq(m.pixels.shape, [3, 7, 13], "RGBA → three channels"));
    const ints = Array.from({ length: 4 }, (_, i) => values("int16", 50, 950 + i));
    ints[1][3] = -7;
    await roundTrip("int16 with a no-data value", writeTiff({ pages: ints.map((data) => pageSpec({ width: 10, height: 5, dtype: "int16", data })) }), { dims: [{ name: "z", size: 4 }], nodata: -7 }, ints, 10, 5, (m) => h.eq(m.pixels.nodata, -7, "an integer no-data value becomes the bundle's nodata"));
  }

  // Progress, cancel, determinism, the app's content id.
  {
    const file = await save("progress.tif", movBytes);
    const seen: Array<{ phase: string; done: number; total: number; fraction: number; bytesRead: number }> = [];
    const out = path.join(scratch, "bundles", "progress.fluximg");
    const r = await convertTiff(file, movAnswer, out, { onProgress: (p) => seen.push({ phase: p.phase, done: p.done, total: p.total, fraction: p.fraction, bytesRead: p.bytesRead }) });
    const mono = seen.every((p, i) => i === 0 || (p.fraction >= seen[i - 1].fraction && p.bytesRead >= seen[i - 1].bytesRead));
    h.ok(mono && seen.length === 160 && seen[seen.length - 1].fraction === 1 && seen[0].phase === "learn" && seen[seen.length - 1].phase === "store", `progress: ${seen.length} calls, learn then store, monotone, ends at 1`);
    h.ok(seen[seen.length - 1].bytesRead >= 2 * movBytes.length * 0.9, `bytes read are reported (${seen[seen.length - 1].bytesRead} for a ${movBytes.length}-byte file read twice)`);
    const again = await convertTiff(file, movAnswer, path.join(scratch, "bundles", "progress-again.fluximg"));
    h.eq(again.sha256, r.sha256, "the same file and answer convert to the same content id, whatever the output folder");
    h.ok(!!mov && mov.sha256 !== r.sha256, "(a file of another name is another bundle: its name is in the manifest)");
    // The app's import computes the same id.
    const proj = path.join(scratch, "id-project");
    await core.scaffold(proj, { title: "tiff ids" });
    const imp = await importBundle({ root: proj, sourcePath: out, assetId: "img-progress" });
    h.eq(imp.sha256, r.sha256, "the content id is the one the app's import computes (dedupe works)");

    for (const at of [0.2, 0.7]) {
      const ac = new AbortController();
      const dest = path.join(scratch, "cancel", `cut-${at}.fluximg`);
      let error: unknown = null;
      await convertTiff(file, movAnswer, dest, { signal: ac.signal, onProgress: (p) => { if (p.fraction >= at) ac.abort(); } }).catch((e) => { error = e; });
      const left = await fs.readdir(path.dirname(dest)).catch(() => []);
      h.ok((error as Error)?.name === "AbortError" && left.length === 0, `cancel at ${at * 100}%: an AbortError, and no staging folder or bundle left (${left.length} entries)`);
    }
    await convertTiff(file, { dims: [{ name: "t", size: 7 }] }, path.join(scratch, "cancel", "bad.fluximg")).then(() => h.fail("a bad answer converted"), (e) => h.ok(/multiply to 7 pages/.test((e as Error).message) && !fss.existsSync(path.join(scratch, "cancel", "bad.fluximg")), `a bad answer is refused before anything is written: "${(e as Error).message.slice(0, 90)}"`));
    const pr = await probeTiff(file);
    h.ok(pr.probe.pages === 80 && pr.proposals.length >= 2, "probeTiff(path) probes a file on disk");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("H. place-image and image-info with a TIFF (CLI)");
  {
    const root = path.join(scratch, "project");
    await core.scaffold(root, { title: "tiff import" });
    const { figureId } = await core.createFigure(root, { id: "fig-t", name: "TIFFs", width: 900, height: 700 });
    const ij = await save("data/hyper.tif", ijBytes);
    const movie = await save("data/movie_80Hz.tif", movBytes);
    await fs.mkdir(path.join(root, "data"), { recursive: true });
    await fs.copyFile(ij, path.join(root, "data", "hyper.tif"));
    const cli = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(repo, "flux-cli.ts"), ...args, "--root", root], { cwd: repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; child.stdout.on("data", (b) => (out += b)); child.stderr.on("data", (b) => (err += b));
      child.once("error", reject); child.once("close", (code) => resolve({ code: code ?? -1, out, err }));
    });
    const a = await cli(["place-image", figureId, path.join(root, "data", "hyper.tif"), "--width", "200"]);
    const ra = a.code === 0 ? JSON.parse(a.out) : null;
    h.ok(!!ra && ra.tiff?.read && /t 4 × z 3 × c 2/.test(ra.tiff.read) && !ra.reused, `an ImageJ TIFF is placed with no flags (${ra?.tiff?.read ?? a.err.slice(0, 200)})`);
    const { project } = await loadFigModel(root);
    const el = project.figures.flatMap((f) => f.elements).find((e) => e.id === ra?.elementId) as any;
    h.ok(el?.source?.bundlePath === "data/hyper.tif" && el.source.frozen === true && /^[0-9a-f]{64}$/.test(el.source.sha256 ?? ""), "the element's source is the TIFF (project-relative), frozen, with the content id");
    const leftovers = (await fs.readdir(path.join(root, "fig", "assets"))).filter((n) => n.startsWith(".tiff-") || n.includes(".tmp-"));
    h.eq(leftovers, [], "no scratch or staging folder is left in fig/assets");
    const again = await cli(["place-image", figureId, path.join(root, "data", "hyper.tif"), "--x", "400"]);
    h.ok(again.code === 0 && JSON.parse(again.out).reused === true, "the same TIFF placed again reuses its asset");

    const no = await cli(["place-image", figureId, movie]);
    h.ok(no.code !== 0 && /no metadata says how the pages are ordered/.test(no.err) && /--dims t=rest,c=2/.test(no.err) && /Proposals, best first/.test(no.err), "a TIFF without metadata is refused with the proposals and the flags that choose each");
    const assetsBefore = (await fs.readdir(path.join(root, "fig", "assets"))).length;
    h.eq(assetsBefore, 1, "and nothing was converted or copied");
    const yes = await cli(["place-image", figureId, movie, "--dims", "t,c=2", "--transpose", "--pixel-size", "0.25", "--rate", "80"]);
    const ry = yes.code === 0 ? JSON.parse(yes.out) : null;
    h.ok(!!ry && ry.tiff.answer.transpose === true && /t 40 × c 2/.test(ry.tiff.read), `with --dims t,c=2 --transpose --pixel-size 0.25 --rate 80 it is placed (${ry?.tiff?.read ?? yes.err.slice(0, 300)})`);
    const { project: p2 } = await loadFigModel(root);
    const movEl = p2.figures.flatMap((f) => f.elements).find((e) => e.id === ry?.elementId) as any;
    h.ok(movEl?.source?.external === true && path.isAbsolute(movEl.source.bundlePath), "a TIFF outside the project is recorded with its absolute path, marked external");
    const bad = await cli(["place-image", figureId, movie, "--dims", "t=30,c=2"]);
    h.ok(bad.code !== 0 && /multiply to 60 pages/.test(bad.err), "flags that do not fit are refused with the reason");
    const info = await cli(["image-info", movie]);
    const ri = info.code === 0 ? JSON.parse(info.out) : null;
    h.ok(!!ri && ri.needsAnswer === true && ri.proposals.length >= 2 && ri.proposals.every((p: any) => typeof p.flags === "string") && ri.probe.pages === 80, "image-info on a TIFF: the probe, needsAnswer and proposals with their flags");
    const nope = await cli(["place-image", "no-such-figure", path.join(root, "data", "hyper.tif")]);
    h.ok(nope.code !== 0 && /Figure or slide not found/.test(nope.err), "an unknown target is refused before converting");
    await core.createDeck(root, { id: "talk" });
    const deck = await core.addSlide(root, "talk");
    const onSlide = await cli(["place-image", `talk/${deck.slideId}`, path.join(root, "data", "hyper.tif")]);
    const rs = onSlide.code === 0 ? JSON.parse(onSlide.out) : null;
    h.ok(!!rs && rs.deckId === "talk" && rs.reused === true, `a TIFF goes onto a slide by the same path (${rs ? "reused its asset" : onSlide.err.slice(0, 200)})`);
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("I. memory on a large stack (slow)");
  if (process.env.VERIFY_TIFF_SLOW !== "1") console.log("  skipped: set VERIFY_TIFF_SLOW=1 to convert a ~1 GB synthetic stack in a child process");
  else {
    const big = path.join(scratch, "big", "stack.tif");
    await fs.mkdir(path.dirname(big), { recursive: true });
    const W1 = 640, H1 = 512, N = 800;                   // 2 x 800 pages of 640 x 512 uint16 = 1.05 GB
    const r = rng(77);
    const size = await writeStackFile(big, { width: W1, height: H1, pages: 2 * N, dtype: "uint16", fill: (p, plane) => { for (let i = 0; i < plane.length; i++) plane[i] = 500 + ((i * 7 + p * 13) & 1023) + Math.floor(r() * 40); } });
    const out = path.join(scratch, "big", "stack.fluximg");
    const res = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(repo, "scripts", "verify-tiff.ts"), "--child-convert", big, out, JSON.stringify({ dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }] })], { cwd: repo, env: { ...process.env, UV_THREADPOOL_SIZE: "8" }, stdio: ["ignore", "pipe", "pipe"] });
      let o = "", e = ""; child.stdout.on("data", (b) => (o += b)); child.stderr.on("data", (b) => (e += b));
      child.once("close", (code) => resolve({ code: code ?? -1, out: o, err: e }));
    });
    const stats = res.code === 0 ? JSON.parse(res.out.trim().split("\n").pop()!) : null;
    h.ok(!!stats && stats.maxRssKb < 1024 * 1024, `a ${(size / 1e9).toFixed(2)} GB stack converts with peak RSS ${stats ? (stats.maxRssKb / 1024).toFixed(0) : "?"} MB (< 1 GB) in ${stats?.ms} ms (${stats ? (size / 1e6 / (stats.ms / 1000)).toFixed(0) : "?"} MB/s)${stats ? "" : `: ${res.err.slice(0, 300)}`}`);
    await fs.rm(path.join(scratch, "big"), { recursive: true, force: true });
  }
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(() => fs.rm(scratch, { recursive: true, force: true }));
