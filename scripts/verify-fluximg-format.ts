// fluximg/1, the on-disk contract: the reference writer and reader agree with each other and with the
// fixtures, the validator accepts what conforms and names what does not.
//
// Pure tier. Hermetic: every bundle is generated into a scratch directory from deterministic data.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harness } from "./lib/harness.mjs";
import { fixtures, readValues, rng, writeFixture } from "./lib/fluximgFixtures";
import { nodeBundleReader, nodeBundleWriter, nodeZstd } from "../flux-core/fluximgIo";
import { openFluximg, pickLevel } from "../src/lib/fluximg/reader";
import { arraySource, blockMean, shardChunks, writeFluximg } from "../src/lib/fluximg/writer";
import { resolveView } from "../src/lib/fluximg/viewOps";
import { validateFluximg } from "../src/lib/fluximg/validate";
import { crc32c, decodeShardIndex, encodeShardIndex, locateChunk, ndindex, product } from "../src/lib/fluximg/zarr";
import { encodeLinear16, guardRatio, linear16Params, toValues, valueMaps } from "../src/lib/fluximg/encoding";
import { labelOutlines, outlineArea } from "../src/lib/fluximg/outlines";
import { canonicalDims, GUARD_THRESHOLD } from "../src/lib/fluximg/types";

const h = harness("verify-fluximg-format");
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "fluximg-format-"));
const codec = await nodeZstd();
const fx = fixtures();
const byName = Object.fromEntries(fx.map((f) => [f.name, f]));
const dirOf = (name: string): string => path.join(tmp, `${name}.fluximg`);

async function hashTree(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await fsp.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}:${crypto.createHash("sha256").update(await fsp.readFile(p)).digest("hex")}`);
    }
  };
  await walk(dir);
  return crypto.createHash("sha256").update(out.join("\n")).digest("hex");
}
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const files = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(path.relative(dir, p).split(path.sep).join("/")); } };
  await walk(dir);
  return out.sort();
};

h.section("A. every fixture: written, valid, and read back");
for (const f of fx) {
  const report = await writeFixture(tmp, f);
  const res = await validateFluximg(nodeBundleReader(dirOf(f.name)), codec);
  h.ok(res.ok, `${f.name}: the validator accepts it${res.ok ? "" : " — " + res.issues.map((i) => `[${i.code}] ${i.message}`).join("; ")}`);
  h.eq(report.manifest.pixels.encoding.kind, f.expectEncoding, `${f.name}: pixels are stored ${f.expectEncoding}`);
  const got = await readValues(dirOf(f.name));
  h.eq(got.shape, f.shape, `${f.name}: shape survives`);
  const enc = report.manifest.pixels.encoding;
  const nd = f.dims.length, plane = f.shape[nd - 2] * f.shape[nd - 1], ci = f.dims.indexOf("c"), C = ci >= 0 ? f.shape[ci] : 1;
  const stridesAfterC = ci >= 0 ? product(f.shape.slice(ci + 1)) : 1;
  let worst = 0, maskOk = true;
  const isFloat = f.dtype === "float32" || f.dtype === "float64";
  for (let i = 0; i < f.data.length; i++) {
    const src = f.data[i], v = got.values[i];
    const missing = isFloat ? !Number.isFinite(src) : src === (f.input.nodata ?? null);
    if (missing !== Number.isNaN(v)) { maskOk = false; break; }
    if (missing) continue;
    const c = ci >= 0 ? Math.floor(i / stridesAfterC) % C : 0;
    const bound = enc.kind === "linear16" ? enc.channels[c].scale / 2 : 0;
    const e = Math.abs(v - src) - bound * (1 + 1e-9);
    if (e > worst) worst = e;
  }
  h.ok(maskOk, `${f.name}: "no data" comes back exactly where it went in`);
  h.ok(worst <= 1e-12, `${f.name}: every value is ${enc.kind === "exact" ? "exact" : "within half a step"} (excess ${worst})`);
  void plane;
}

h.section("B. the writer is deterministic");
{
  const again = path.join(tmp, "again");
  for (const name of ["movie_f32", "mean_f64_layers", "big_tiled_u16"]) {
    const f = byName[name];
    await writeFluximg(nodeBundleWriter(path.join(again, `${name}.fluximg`)), codec, { name: f.name, source: arraySource(f.data, f.dims, f.shape, f.dtype), ...f.input }, f.options);
    h.eq(await hashTree(path.join(again, `${name}.fluximg`)), await hashTree(dirOf(name)), `${name}: two writes give identical bytes`);
  }
}

h.section("C. structure on disk");
{
  const sharded = (await files(dirOf("sharded_u8"))).filter((p) => p.startsWith("pixels/0/c/"));
  h.ok(sharded.length > 1, `a small file cap splits the array into ${sharded.length} shard files`);
  const cap = byName.sharded_u8.options!.maxShardBytes!;
  let over = 0;
  for (const p of sharded) if ((await fsp.stat(path.join(dirOf("sharded_u8"), p))).size > cap * 1.25) over++;
  h.eq(over, 0, "no shard is far over the cap");
  const sparse = await validateFluximg(nodeBundleReader(dirOf("sparse_f32")), codec);
  h.eq(sparse.chunks, 3, "planes with no data are not stored (3 of 6 planes written)");
  const big = JSON.parse(await fsp.readFile(path.join(dirOf("big_tiled_u16"), "fluximg.json"), "utf8"));
  h.eq(big.pixels.levels.map((l: any) => l.downsample), [1, 4, 8], "a 2300 x 2600 plane gets overviews at 4x and 8x, and no 2x level");
  h.eq(big.pixels.levels.map((l: any) => l.shape), [[2300, 2600], [575, 650], [288, 325]], "overview shapes are ceil(size / factor)");
  const z0 = JSON.parse(await fsp.readFile(path.join(dirOf("big_tiled_u16"), "pixels/0/zarr.json"), "utf8"));
  h.eq(z0.codecs[0].configuration.chunk_shape, [512, 512], "large planes are tiled at 512 px");
  h.ok(z0.chunk_grid.configuration.chunk_shape.every((v: number, i: number) => v % [512, 512][i] === 0), "a shard holds whole tiles");
  const mid = JSON.parse(await fsp.readFile(path.join(dirOf("mid_tiled_u16"), "fluximg.json"), "utf8"));
  h.eq(mid.pixels.levels.map((l: any) => [l.downsample, l.shape]), [[1, [2, 1100, 1300]], [4, [2, 275, 325]]], "a plane over 1024 px is tiled and gets one 4x overview");
  const midZ = JSON.parse(await fsp.readFile(path.join(dirOf("mid_tiled_u16"), "pixels/0/zarr.json"), "utf8"));
  h.eq(midZ.codecs[0].configuration.chunk_shape, [1, 512, 512], "its inner chunks are 512 px tiles of one plane");
  const small = JSON.parse(await fsp.readFile(path.join(dirOf("stack_u16"), "pixels/0/zarr.json"), "utf8"));
  h.eq(small.codecs[0].configuration.chunk_shape, [1, 1, 48, 64], "a plane up to 1024 px is one chunk");
  const trials = JSON.parse(await fsp.readFile(path.join(dirOf("trials_f32"), "pixels/zarr.json"), "utf8"));
  h.ok(!trials.attributes.ome, "an extra dimension means no OME-Zarr claim");
  const stack = JSON.parse(await fsp.readFile(path.join(dirOf("stack_u16"), "pixels/zarr.json"), "utf8"));
  h.eq(stack.attributes.ome.multiscales[0].axes.map((a: any) => a.name), ["c", "z", "y", "x"], "OME axes are in OME order");
  h.eq(stack.attributes.ome.version, "0.5", "OME-Zarr 0.5");
  h.eq(canonicalDims(["z", "trial", "x", "c", "y", "t"]), ["trial", "t", "c", "z", "y", "x"], "canonical order: extras, then t, c, z, y, x");
  const mov = JSON.parse(await fsp.readFile(path.join(dirOf("movie_f32"), "fluximg.json"), "utf8"));
  h.eq(mov.profiles.t.mean.length, 2, "a profile per channel along time");
  h.eq(mov.profiles.t.mean[0].length, 24, "one mean per frame");
}

h.section("D. reading regions, tiles and levels");
{
  const f = byName.big_tiled_u16, W = f.shape[1];
  const reader = await openFluximg(nodeBundleReader(dirOf(f.name)), codec);
  const a0 = await reader.level(0);
  const r = await reader.readRegion(a0, [], { x: 500, y: 1000, width: 700, height: 300 });
  let same = r.width === 700 && r.height === 300;
  for (let y = 0; same && y < 300; y++) for (let x = 0; x < 700; x++) if (r.data[y * 700 + x] !== f.data[(1000 + y) * W + 500 + x]) { same = false; break; }
  h.ok(same, "a region spanning several tiles equals the source pixels");
  const edge = await reader.readRegion(a0, [], { x: 2500, y: 2200, width: 400, height: 400 });
  h.eq([edge.width, edge.height], [100, 100], "a region is clipped to the image");
  const a1 = await reader.level(1);
  const plane1 = await reader.readPlane(a1, []);
  const values = Float64Array.from(f.data, (v) => (v === 0 ? NaN : v));
  const want = blockMean(values, W, f.shape[0], 4).data;
  let ovOk = plane1.length === want.length;
  for (let i = 0; ovOk && i < want.length; i++) if (plane1[i] !== (Number.isNaN(want[i]) ? 0 : Math.round(want[i]))) ovOk = false;
  h.ok(ovOk, "an overview pixel is the rounded mean of the valid pixels in its 4 x 4 block");
  h.eq([pickLevel(reader.manifest.pixels.levels, 1), pickLevel(reader.manifest.pixels.levels, 3.9), pickLevel(reader.manifest.pixels.levels, 4), pickLevel(reader.manifest.pixels.levels, 20)], [0, 0, 1, 2], "the level drawn never has fewer stored pixels than screen pixels");
  const sp = await openFluximg(nodeBundleReader(dirOf("sparse_f32")), codec);
  const blank = await sp.readPlane(await sp.level(0), [1]);
  h.ok(blank.length === 1024 && Number.isNaN(blank[0]) && Number.isNaN(blank[1023]), "a plane that was never stored reads as no data");
  h.eq(await sp.readChunk(await sp.level(0), [2, 0, 0]), null, "its chunk reads as null");
}

h.section("E. outlines enclose exactly the labelled pixels");
{
  const f = byName.mean_f64_layers, layer = f.input.layers!.find((l) => l.kind === "labels")! as Extract<NonNullable<typeof f.input.layers>[number], { kind: "labels" }>;
  const outs = labelOutlines(layer.data, 90, 60);
  h.eq(outs.map((o) => o.label), [1, 2, 3, 7], "one outline per label, in label order");
  h.ok(outs.every((o) => outlineArea(o.d) === o.pixels), "each outline's signed area equals its pixel count");
  h.eq(outs[1].d.split("M").length - 1, 2, "a shape with a hole has an outer loop and an inner loop");
  h.eq(outs[2].d.split("M").length - 1, 2, "two squares touching at a corner stay two loops");
  const svg = await fsp.readFile(path.join(dirOf(f.name), "layers/footprints.svg"), "utf8");
  h.ok(/<path id="footprints\/s7" data-key="s7" data-label="7"/.test(svg), "each outline carries its key and its label");
  h.ok(/viewBox="0 0 90 60"/.test(svg), "the SVG is in image-pixel coordinates");
  const one = labelOutlines(Uint16Array.from([0, 0, 0, 0, 5, 0, 0, 0, 0]), 3, 3)[0];
  h.eq(one.d, "M1,1 L2,1 L2,2 L1,2 Z", "a single pixel is a unit square, clockwise on screen");
}

h.section("F. the 16-bit encoding and its guard");
{
  const p = linear16Params(-2, 30), out = new Uint16Array(5);
  encodeLinear16([-2, 30, NaN, 14, Infinity], p.scale, p.offset, out);
  h.eq(Array.from(out), [1, 65535, 0, 32768, 0], "the range maps to codes 1..65535 and missing values to 0");
  const back = toValues(out, valueMaps("uint16", { kind: "linear16", channels: [p], nodataCode: 0 }, 1)[0]);
  h.ok(back[0] === -2 && Math.abs(back[1] - 30) < 1e-9 && Number.isNaN(back[2]), "codes decode to offset + scale * (code - 1)");
  h.eq(linear16Params(7, 7), { scale: 1, offset: 7 }, "a constant channel gets scale 1");
  h.eq(guardRatio(0.5, 0), null, "no variation between neighbours: no ratio, so the guard refuses");
  const hdr = JSON.parse(await fsp.readFile(path.join(dirOf("hdr_f32"), "fluximg.json"), "utf8")).pixels.encoding;
  h.ok(hdr.kind === "exact" && hdr.fallback === "guard" && hdr.guard.stepOverNeighbour[0] > GUARD_THRESHOLD, `one extreme value: step is ${hdr.guard.stepOverNeighbour[0].toFixed(1)}x the neighbour difference, so the floats are kept`);
  const mov = JSON.parse(await fsp.readFile(path.join(dirOf("movie_f32"), "fluximg.json"), "utf8")).pixels.encoding;
  h.ok(mov.kind === "linear16" && mov.guard.stepOverNeighbour.every((r: number) => r < GUARD_THRESHOLD), "a noisy movie passes the guard on both channels");
  const flat = new Float32Array(32 * 32).fill(3.5);
  const rep = await writeFluximg(nodeBundleWriter(path.join(tmp, "flat.fluximg")), codec, { name: "flat", source: arraySource(flat, ["y", "x"], [32, 32], "float32") });
  h.eq(rep.manifest.pixels.encoding.kind, "exact", "a constant float image is stored exactly");
  h.ok(rep.notes.some((n) => /too coarse|no variation/.test(n)), "and the report says why");
}

h.section("G. the validator names what is wrong");
{
  const broken = async (name: string, mutate: (dir: string) => Promise<void>, code: string, what: string): Promise<void> => {
    const dir = path.join(tmp, `broken-${code}-${Math.floor(rng(what.length)() * 1e6)}.fluximg`);
    await fsp.cp(dirOf(name), dir, { recursive: true });
    await mutate(dir);
    const res = await validateFluximg(nodeBundleReader(dir), codec);
    h.ok(!res.ok && res.issues.some((i) => i.code === code), `${what} → [${code}]${res.ok ? " (accepted!)" : ""}`);
  };
  const editJson = (rel: string, fn: (j: any) => void) => async (dir: string): Promise<void> => { const p = path.join(dir, rel); const j = JSON.parse(await fsp.readFile(p, "utf8")); fn(j); await fsp.writeFile(p, JSON.stringify(j)); };
  await broken("movie_f32", editJson("fluximg.json", (j) => { j.spec = "fluximg/9"; }), "manifest", "an unknown spec version");
  await broken("movie_f32", editJson("fluximg.json", (j) => { j.pixels.shape[0] = 25; }), "levels", "a manifest shape the arrays do not have");
  await broken("movie_f32", editJson("fluximg.json", (j) => { j.channels.pop(); }), "channels", "a missing channel");
  await broken("movie_f32", editJson("fluximg.json", (j) => { j.pixels.encoding.channels[0].scale = 0; }), "encoding", "a zero scale");
  await broken("stack_u16", editJson("fluximg.json", (j) => { j.pixels.dims = ["z", "c", "y", "x"]; }), "dims", "dimensions out of canonical order");
  await broken("stack_u16", editJson("fluximg.json", (j) => { j.axes.z.coords.pop(); }), "axes", "too few z positions");
  await broken("movie_f32", async (dir) => { const p = path.join(dir, "pixels/0/c/0/0/0/0"); const b = await fsp.readFile(p); b[b.length - 20] ^= 0xff; await fsp.writeFile(p, b); }, "shard", "a damaged shard index");
  await broken("movie_f32", async (dir) => { const p = path.join(dir, "pixels/0/c/0/0/0/0"); const b = await fsp.readFile(p); b.fill(0, 4, 400); await fsp.writeFile(p, b); }, "chunk", "a damaged chunk");
  await broken("movie_f32", editJson("pixels/0/zarr.json", (j) => { j.codecs[0].configuration.codecs[1].name = "gzip"; }), "levels", "a codec outside the profile");
  await broken("mean_f64_layers", async (dir) => { await fsp.rm(path.join(dir, "layers/prox_lines.svg")); }, "layers", "a missing layer file");
  await broken("mean_f64_layers", async (dir) => { const p = path.join(dir, "layers/discs.svg"); await fsp.writeFile(p, (await fsp.readFile(p, "utf8")).replace("<circle", '<script>1</script><circle')); }, "svg", "a script inside a layer");
  await broken("mean_f64_layers", editJson("layers/footprints.table.json", (j) => { j.columns.source_id[0] = "other"; }), "layers", "an outline whose key is not in its table");
  await broken("mean_f64_layers", editJson("fluximg.json", (j) => { j.regions[0].rect.width = 500; }), "regions", "a region outside the image");
  await broken("trials_f32", editJson("pixels/zarr.json", (j) => { j.attributes.ome = { version: "0.5" }; }), "ome", "an OME claim on a bundle with an extra dimension");
}

h.section("H. Zarr arithmetic");
{
  h.eq(crc32c(new TextEncoder().encode("123456789")), 0xe3069283, "crc32c matches the standard check value");
  const idx = { offsets: Float64Array.from([0, -1, 5_000_000_000]), lengths: Float64Array.from([10, 0, 7]) };
  const dec = decodeShardIndex(encodeShardIndex(idx), 3, true);
  h.eq([Array.from(dec.offsets), Array.from(dec.lengths)], [[0, -1, 5_000_000_000], [10, 0, 7]], "a shard index round-trips, including a missing chunk and an offset past 4 GB");
  h.eq(locateChunk({ inner: [1, 1, 512, 512], outer: [4, 2, 1024, 1536] }, [9, 1, 1, 2]), { shard: [2, 0, 0, 0], local: ((1 * 2 + 1) * 2 + 1) * 3 + 2 }, "a chunk's shard and its place in that shard's index");
  h.eq([...ndindex([2, 2])], [[0, 0], [0, 1], [1, 0], [1, 1]], "C-order iteration");
}

h.section("I. contract update 2: shard shapes, hidden channels, label tables, world");
{
  const MiB = 1048576, cap = 64 * MiB;
  const est = (planes: number, planeBytes: number, rows = 0, rowBytes = 0) => ({ planes, planeBytes, rows, rowBytes });
  h.eq(shardChunks([2, 7, 1, 1], est(8, 8 * 3_000_000), cap), [2, 7, 1, 1], "a stack under the cap is one shard, as before");
  h.eq(shardChunks([3, 25, 1, 1], est(8, 8 * 5_000_000), cap), [1, 12, 1, 1], "channel-first (c 3, z 25, 5 MB planes): runs of floor(0.9 x 64 MiB / 5 MB) = 12 z planes of ONE channel");
  h.eq(shardChunks([10, 3, 4, 1, 1], est(8, 8 * 6_000_000), cap), [1, 2, 4, 1, 1], "t, c, z: z fits whole (24 MB), c does not: runs of 2 channels, t gets 1");
  h.eq(shardChunks([816, 2, 1, 1], est(8, 8 * 150_000), cap), [201, 2, 1, 1], "a t-first movie splits along t as before: floor(0.9 x 64 MiB / (2 planes of 150 kB)) = 201 frames");
  h.eq(shardChunks([5, 9, 4], est(0, 0, 3, 90_000_000), cap), [1, 2, 4], "one plane over the cap: runs of rows of tiles, x whole, leading dims 1");
  h.eq(shardChunks([5, 9, 4], est(1, 100_000_000, 9, 100_000_000), cap), [1, 5, 4], "a sampled plane over the cap also splits y");
  h.eq(shardChunks([4, 1, 1], est(4, 0), cap), [4, 1, 1], "nothing stored in the sample: one shard (empty shards are not written anyway)");
  h.eq(shardChunks([3, 25, 1, 1], est(8, 8 * 64 * MiB), cap), [1, 1, 1, 1], "a plane just at the cap: one plane per shard");

  const outer = async (name: string, level = "0"): Promise<number[]> => JSON.parse(await fsp.readFile(path.join(dirOf(name), "pixels", level, "zarr.json"), "utf8")).chunk_grid.configuration.chunk_shape;
  h.eq(await outer("stack_cz_split_u16"), [1, 4, 40, 48], "channel-first fixture: shard = 1 channel x 4 z planes (the SECOND leading dimension is split)");
  h.eq(await outer("stack_tcz_split_u16"), [1, 1, 2, 40, 48], "t, c, z fixture: t and c have shard extent 1, z runs of 2");
  h.eq(await outer("rows_split_u8"), [1024, 1024], "one plane over the cap: shards of two rows of 512 px tiles");
  h.eq(await outer("sharded_u8"), [7, 32, 32], "the existing small-cap fixture keeps its layout (runs of 7 planes)");
  h.eq([await outer("big_tiled_u16"), await outer("mid_tiled_u16"), await outer("stack_u16"), await outer("movie_f32")], [[2560, 3072], [2, 1536, 1536], [2, 7, 48, 64], [24, 2, 40, 60]], "arrays under the cap keep their one-shard layout");
  const czFiles = (await files(dirOf("stack_cz_split_u16"))).filter((p) => p.startsWith("pixels/0/c/"));
  h.eq(czFiles.length, 9, "channel-first fixture: 3 channels x 3 runs (4, 4, 2) = 9 shard files");
  const czCap = byName.stack_cz_split_u16.options!.maxShardBytes!;
  let biggest = 0;
  for (const p of czFiles) biggest = Math.max(biggest, (await fsp.stat(path.join(dirOf("stack_cz_split_u16"), p))).size);
  h.ok(biggest <= czCap, `no shard is over the cap (largest ${biggest} of ${czCap} bytes)`);
  {
    // Round trip through the split layout: a plane from the middle of the middle shard, and a whole channel.
    const f = byName.stack_cz_split_u16, r = await openFluximg(nodeBundleReader(dirOf(f.name)), codec), a = await r.level(0);
    const plane = await r.readPlane(a, [1, 5]), at = (1 * 10 + 5) * 40 * 48;
    h.ok(same(plane, f.data.subarray(at, at + 40 * 48)), "a plane in a split shard reads back exactly (c 1, z 5)");
    const reg = await r.readRegion(a, [2, 9], { x: 7, y: 3, width: 30, height: 20 });
    let ok = true;
    for (let y = 0; ok && y < 20; y++) for (let x = 0; x < 30; x++) if (reg.data[y * 30 + x] !== f.data[(2 * 10 + 9) * 1920 + (3 + y) * 48 + 7 + x]) { ok = false; break; }
    h.ok(ok, "a region of the last, partial shard reads back exactly (c 2, z 9)");
    const rr = await openFluximg(nodeBundleReader(dirOf("rows_split_u8")), codec), ra = await rr.level(0);
    const band = await rr.readRegion(ra, [], { x: 100, y: 1000, width: 300, height: 60 });       // straddles shards 0 and 1
    let bandOk = true;
    for (let y = 0; bandOk && y < 60; y++) for (let x = 0; x < 300; x++) if (band.data[y * 300 + x] !== byName.rows_split_u8.data[(1000 + y) * 600 + 100 + x]) { bandOk = false; break; }
    h.ok(bandOk, "a region across a y shard boundary reads back exactly");
  }
  {
    // Streaming: shard files are written while the planes are still coming, not at the end.
    const f = byName.stack_cz_split_u16, n = 30;
    let pulled = 0, firstShardAt = -1;
    const base = arraySource(f.data, f.dims, f.shape, f.dtype);
    const src = { ...base, plane(lead: readonly number[]) { pulled++; return base.plane(lead); } };
    const io = nodeBundleWriter(path.join(tmp, "stream.fluximg"));
    await writeFluximg({ writeText: io.writeText, async writeFile(p, b) { if (firstShardAt < 0 && p.startsWith("pixels/0/c/")) firstShardAt = pulled; await io.writeFile(p, b); } }, codec, { name: "stream", source: src, ...f.input }, f.options);
    h.ok(firstShardAt > n && firstShardAt <= n + 9, `the first shard is written after ${firstShardAt - n} of ${n} planes are stored (the sample is at most 8 planes)`);
  }
  {
    // Validator: a shard far over the cap is a WARNING, not an issue.
    const strict = await validateFluximg(nodeBundleReader(dirOf("sharded_u8")), codec, { maxShardBytes: 4096 });
    h.ok(strict.ok && strict.warnings.some((w) => w.code === "shard-size"), `a shard over 1.5 x the cap is warned about and still conforms (${strict.warnings.length} warning(s))`);
    const usual = await validateFluximg(nodeBundleReader(dirOf("sharded_u8")), codec, { maxShardBytes: byName.sharded_u8.options!.maxShardBytes });
    h.eq(usual.warnings, [], "at the cap it was written for: no warning");
    let warned = 0;
    for (const g of fx) warned += (await validateFluximg(nodeBundleReader(dirOf(g.name)), codec, { quick: true, maxShardBytes: g.options?.maxShardBytes })).warnings.length;
    h.eq(warned, 0, "no fixture has a warning at its own cap");
  }
  {
    const m = JSON.parse(await fsp.readFile(path.join(dirOf("hidden_channel_u8"), "fluximg.json"), "utf8"));
    h.eq(m.channels.map((c: any) => c.visible), [undefined, false, undefined], "visible: false is written for the hidden channel only");
    h.eq(m.channels.map((c: any) => c.color ?? c.lut), ["gray", "#00ff00", "#ff00ff"], "three channels default to gray, green, magenta");
    const g = JSON.parse(await fsp.readFile(path.join(dirOf("hidden_channel_u8"), "pixels/zarr.json"), "utf8"));
    h.eq(g.attributes.ome.omero.channels.map((c: any) => c.active), [true, false, true], "OME active follows visible");
    h.eq(resolveView(m).channels.map((c) => c.visible), [true, false, true], "resolveView: the hidden channel resolves hidden");
    const lm = JSON.parse(await fsp.readFile(path.join(dirOf("mean_f64_layers"), "fluximg.json"), "utf8"));
    h.eq(lm.layers.filter((l: any) => l.kind !== "intensity").map((l: any) => l.color), ["#ffd400", "#ff8000", "#ffffff"], "vector and label layers without a colour take distinct defaults, yellow first");
  }
}

h.section("J. the validator: label tables and world");
{
  const check = async (name: string, mutate: (dir: string) => Promise<void>): Promise<Awaited<ReturnType<typeof validateFluximg>>> => {
    const dir = path.join(tmp, `case-${Math.random().toString(36).slice(2)}.fluximg`);
    await fsp.cp(dirOf(name), dir, { recursive: true });
    await mutate(dir);
    return validateFluximg(nodeBundleReader(dir), codec);
  };
  const editJson = (rel: string, fn: (j: any) => void) => async (dir: string): Promise<void> => { const p = path.join(dir, rel); const j = JSON.parse(await fsp.readFile(p, "utf8")); fn(j); await fsp.writeFile(p, JSON.stringify(j)); };
  const zeroBased = await check("mean_f64_layers", editJson("layers/footprints.table.json", (j) => { j.columns.label = j.columns.label.map((l: number) => l - 1); }));
  h.ok(!zeroBased.ok && zeroBased.issues.some((i) => i.code === "table" && /0 means no object/.test(i.message)), "a 0-based label column (a row for label 0) is refused → [table]");
  const extraRow = await check("mean_f64_layers", editJson("layers/footprints.table.json", (j) => { for (const k of Object.keys(j.columns)) j.columns[k].push(k === "label" ? 9 : k === "source_id" ? "s9" : null); }));
  h.ok(extraRow.ok && extraRow.warnings.some((w) => w.code === "table" && /no object/.test(w.message)), "a table row without an object is a warning, not an issue");
  const w3 = await check("mean_f64_layers", editJson("fluximg.json", (j) => { j.world = { matrix: [[0.25, 0, -160], [0, 0.25, -100], [0, 0, 1]], unit: "µm" }; }));
  h.ok(w3.ok, "a 3 x 3 world matrix (a 2-D mapping) is accepted");
  const w23 = await check("mean_f64_layers", editJson("fluximg.json", (j) => { j.world.matrix = [[1, 0, 0], [0, 1, 0]]; }));
  h.ok(!w23.ok && w23.issues.some((i) => i.code === "world"), "a 2 x 3 world matrix is refused → [world]");
  const vis = await check("hidden_channel_u8", editJson("fluximg.json", (j) => { j.channels[1].visible = "no"; }));
  h.ok(!vis.ok && vis.issues.some((i) => i.code === "channels"), "a channel visible that is not a boolean is refused → [channels]");
}

await fsp.rm(tmp, { recursive: true, force: true });
await h.done();
