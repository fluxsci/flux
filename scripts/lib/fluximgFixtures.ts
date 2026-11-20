// Synthetic fluximg bundles: the executable half of the fluximg/1 contract.
//
// Every bundle is written by the reference writer from deterministic pseudo-random data, so the same call
// always yields the same bytes. Beside each bundle the generator writes what a correct READER must return
// (`expected/<name>.npy`: level-0 values as float64, NaN where there is no data) and what a WRITER was given
// (`inputs/<name>.npy`), so another implementation can be checked in both directions.
import path from "node:path";
import fsp from "node:fs/promises";
import { nodeBundleReader, nodeBundleWriter, nodeZstd, writeNpy } from "../../flux-core/fluximgIo";
import { openFluximg } from "../../src/lib/fluximg/reader";
import { toValues, valueMaps } from "../../src/lib/fluximg/encoding";
import { arraySource, writeFluximg, type WriteInput, type WriteOptions, type WriteReport } from "../../src/lib/fluximg/writer";
import { allocTyped, type FluximgDtype, type FluximgTable, type FluximgTypedArray } from "../../src/lib/fluximg/types";
import { product } from "../../src/lib/fluximg/zarr";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

export interface Fixture {
  name: string;
  about: string;
  dims: string[];
  shape: number[];
  dtype: FluximgDtype;
  data: FluximgTypedArray;
  input: Omit<WriteInput, "source" | "name">;
  options?: WriteOptions;
  /** What the pixel encoding must turn out to be. */
  expectEncoding: "exact" | "linear16";
}

function blobs(r: () => number, lead: number[], H: number, W: number, dtype: FluximgDtype, opts: { amp: number; noise: number; mask?: (y: number, x: number) => boolean; perPlane?: (i: number) => number }): FluximgTypedArray {
  const n = product(lead), out = allocTyped(dtype, n * H * W);
  const float = dtype === "float32" || dtype === "float64";
  for (let p = 0; p < n; p++) {
    const cx = 0.3 + 0.4 * r(), cy = 0.3 + 0.4 * r(), s = 0.1 + 0.15 * r(), gain = opts.perPlane ? opts.perPlane(p) : 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (p * H + y) * W + x;
      if (opts.mask && !opts.mask(y, x)) { out[k] = float ? NaN : 0; continue; }
      const d2 = ((x / W - cx) ** 2 + (y / H - cy) ** 2) / (s * s);
      const v = gain * opts.amp * (0.08 + Math.exp(-d2)) + opts.noise * gauss(r);
      out[k] = float ? v : Math.max(0, Math.round(v));
    }
  }
  return out;
}

/** `n` planes of a smooth pattern plus noise (uint16): every plane compresses to nearly the same size. */
function wavyStack(seed: number, n: number, H: number, W: number): Uint16Array {
  const r = rng(seed), d = new Uint16Array(n * H * W);
  for (let p = 0; p < n; p++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    d[(p * H + y) * W + x] = Math.max(0, Math.round(800 * (1 + Math.sin(x / 5 + p) * Math.cos(y / 7)) + 60 * gauss(r)));
  }
  return d;
}

export function fixtures(): Fixture[] {
  const list: Fixture[] = [];
  const inRois = (y: number, x: number): boolean => (y >= 4 && y < 18 && x >= 6 && x < 40) || (y >= 22 && y < 36 && x >= 20 && x < 56);
  {
    const r = rng(1);
    list.push({ name: "gray2d_u8", about: "one 8-bit plane, stored exactly", dims: ["y", "x"], shape: [48, 64], dtype: "uint8", expectEncoding: "exact",
      data: blobs(r, [], 48, 64, "uint8", { amp: 180, noise: 6 }), input: { axes: { y: { unit: "µm", scale: 0.5 }, x: { unit: "µm", scale: 0.5 } } } });
  }
  {
    const r = rng(2);
    list.push({ name: "rgb_u8", about: "an RGB photograph: three 8-bit channels", dims: ["c", "y", "x"], shape: [3, 40, 56], dtype: "uint8", expectEncoding: "exact",
      data: blobs(r, [3], 40, 56, "uint8", { amp: 200, noise: 4 }),
      input: { photometric: "rgb", channels: [{ name: "red", color: "#ff0000", range: [0, 255] }, { name: "green", color: "#00ff00", range: [0, 255] }, { name: "blue", color: "#0000ff", range: [0, 255] }] } });
  }
  {
    const r = rng(3);
    list.push({ name: "stack_u16", about: "a two-channel z-stack with explicit z positions", dims: ["c", "z", "y", "x"], shape: [2, 7, 48, 64], dtype: "uint16", expectEncoding: "exact",
      data: blobs(r, [2, 7], 48, 64, "uint16", { amp: 3000, noise: 40, perPlane: (i) => 0.4 + 0.6 * Math.sin(((i % 7) + 1) / 8 * Math.PI) }),
      input: { axes: { z: { unit: "µm", coords: [-61.5, -60.5, -59.5, -58.5, -57.5, -56.5, -55.5] }, y: { unit: "µm", scale: 0.25 }, x: { unit: "µm", scale: 0.25 } },
        channels: [{ name: "structure", color: "#ff00ff" }, { name: "signal", color: "#00ff00" }], defaults: { index: { z: 3 } } } });
  }
  {
    const r = rng(4), H = 40, W = 60, d = allocTyped("int16", H * W);
    for (let i = 0; i < d.length; i++) d[i] = inRois(Math.floor(i / W), i % W) ? Math.round(200 * r()) - 20 : -1;
    list.push({ name: "masked_i16", about: "signed integers with a no-data value", dims: ["y", "x"], shape: [H, W], dtype: "int16", data: d, input: { nodata: -1 }, expectEncoding: "exact" });
  }
  {
    const r = rng(5);
    const data = blobs(r, [24, 2], 40, 60, "float32", { amp: 40, noise: 2.5, mask: inRois, perPlane: (i) => 0.6 + 0.4 * Math.sin(Math.floor(i / 2) / 3) });
    const base = { axes: { t: { unit: "s", scale: 0.0125 }, y: { unit: "µm", scale: 0.25 }, x: { unit: "µm", scale: 0.25 } }, channels: [{ name: "channel 1", color: "#ff2bd6" }, { name: "iGluSnFR", lut: "gray" }] };
    list.push({ name: "movie_f32", about: "a noisy float movie, unscanned outside two rectangles: stored at 16 bits per channel range", dims: ["t", "c", "y", "x"], shape: [24, 2, 40, 60], dtype: "float32", data, input: base, expectEncoding: "linear16" });
    list.push({ name: "movie_f32_lossless", about: "the same movie stored exactly", dims: ["t", "c", "y", "x"], shape: [24, 2, 40, 60], dtype: "float32", data, input: { ...base, lossless: true }, expectEncoding: "exact" });
  }
  {
    const r = rng(6), H = 64, W = 64, d = new Float32Array(H * W);
    for (let i = 0; i < d.length; i++) d[i] = 2 + 0.4 * Math.sin((i % W) / 9) + 0.05 * gauss(r);
    d[20 * W + 20] = 2e5;
    list.push({ name: "hdr_f32", about: "faint structure plus one extreme value: the 16-bit copy is refused and the floats are kept", dims: ["y", "x"], shape: [H, W], dtype: "float32", data: d, input: {}, expectEncoding: "exact" });
  }
  {
    const r = rng(7), H = 60, W = 90;
    const mask = (y: number, x: number): boolean => y >= 8 && y < 52 && x >= 10 && x < 80;
    const data = blobs(r, [2], H, W, "float64", { amp: 30, noise: 0.6, mask });
    const act = blobs(rng(71), [], H, W, "float64", { amp: 0.02, noise: 0.0015, mask });
    const weights = new Float64Array(H * W).fill(NaN);
    const lab = new Uint16Array(H * W);
    const put = (l: number, pts: Array<[number, number]>): void => { for (const [y, x] of pts) { lab[y * W + x] = l; weights[y * W + x] = 0.01 + 0.09 * r(); } };
    const rect = (y0: number, x0: number, h: number, w: number): Array<[number, number]> => { const o: Array<[number, number]> = []; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) o.push([y, x]); return o; };
    put(1, rect(12, 14, 4, 5));
    put(2, rect(20, 30, 6, 6).filter(([y, x]) => !(y >= 22 && y < 24 && x >= 32 && x < 34)));       // a hole
    put(3, [...rect(30, 50, 3, 3), ...rect(33, 53, 3, 3)]);                                          // two squares touching at a corner
    put(7, [[40, 20], [40, 21], [41, 21], [42, 21], [42, 22]]);                                      // a thin bent shape, non-contiguous label number
    const table: FluximgTable = { key: "source_id", columns: { label: [1, 2, 3, 7], source_id: ["s1", "s2", "s3", "s7"], dendrite: ["d1", "d1", "d2", null], pixels: [20, 32, 18, 5] } };
    list.push({ name: "mean_f64_layers", about: "a float64 image with every kind of layer, a table, and regions", dims: ["c", "y", "x"], shape: [2, H, W], dtype: "float64", data, expectEncoding: "linear16",
      input: {
        axes: { y: { unit: "µm", scale: 0.25 }, x: { unit: "µm", scale: 0.25 } }, channels: [{ name: "channel 1", color: "#ff2bd6" }, { name: "iGluSnFR", lut: "gray" }],
        world: { matrix: [[0.25, 0, 0, -160.125], [0, 0.25, 0, -100.125], [0, 0, 1, -61.5], [0, 0, 0, 1]], unit: "µm" },
        regions: [{ id: "roi1", name: "ROI 1", rect: { x: 10, y: 8, width: 70, height: 44 } }],
        layers: [
          { kind: "intensity", id: "activity", name: "activity", data: act, dtype: "float64", color: "#ff2bd6", opacity: "value" },
          { kind: "intensity", id: "footprint_weights", name: "footprint weights", data: weights, dtype: "float64", color: "#ffd400", lossless: true },
          { kind: "labels", id: "footprints", name: "synapse footprints", data: lab, table, key: "source_id", weights: "footprint_weights", visible: true },
          { kind: "vector", id: "prox_lines", name: "prox lines", count: 2, table: { key: "dendrite_id", columns: { dendrite_id: ["d1", "d2"], length_um: [14.5, 9.25] } },
            body: '<polyline id="prox_lines/d1" data-key="d1" points="14.5,14.5 30.5,22.5 44.5,24.5"/><polyline id="prox_lines/d2" data-key="d2" points="50.5,31.5 56.5,36.5"/>' },
          { kind: "vector", id: "discs", name: "shaft discs", count: 3, body: '<circle id="discs/a" data-key="a" cx="16.5" cy="15.5" r="2"/><circle id="discs/b" data-key="b" cx="22.5" cy="18.5" r="2"/><circle id="discs/c" data-key="c" cx="28.5" cy="21.5" r="2"/>' },
        ],
      } });
  }
  {
    const H = 2300, W = 2600, d = new Uint16Array(H * W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = y < 40 || x >= W - 30 ? 0 : 400 + ((x >> 3) + (y >> 2)) % 3000 + (((x * 7919) ^ (y * 104729)) & 15);
    list.push({ name: "big_tiled_u16", about: "a large plane: 512 px tiles and overview levels at 4x and 8x", dims: ["y", "x"], shape: [H, W], dtype: "uint16", data: d, input: { nodata: 0 }, expectEncoding: "exact" });
  }
  {
    // 1100 x 1300: just over the 1024 px threshold, so it must be tiled and get exactly one 4x overview.
    const H = 1100, W = 1300, data = new Uint16Array(2 * H * W);
    for (let c = 0; c < 2; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[(c * H + y) * W + x] = 200 + c * 900 + (((x >> 2) + (y >> 3) * (c + 1)) % 2000) + (((x * 31) ^ (y * 17)) & 7);
    list.push({ name: "mid_tiled_u16", about: "a 1100 x 1300 two-channel image: tiled, with one overview level", dims: ["c", "y", "x"], shape: [2, H, W], dtype: "uint16", data, expectEncoding: "exact",
      input: { axes: { y: { unit: "µm", scale: 0.2158 }, x: { unit: "µm", scale: 0.2158 } }, channels: [{ name: "405", color: "#001eff" }, { name: "488", color: "#2bff00" }] } });
  }
  {
    const r = rng(9);
    list.push({ name: "trials_f32", about: "an extra dimension OME-Zarr has no name for", dims: ["trial", "t", "c", "y", "x"], shape: [3, 5, 2, 20, 30], dtype: "float32", expectEncoding: "linear16",
      data: blobs(r, [3, 5, 2], 20, 30, "float32", { amp: 25, noise: 1.5 }), input: { axes: { trial: { labels: ["a", "b", "c"] }, t: { unit: "s", scale: 0.1 } } } });
  }
  {
    const r = rng(10), d = new Uint8Array(40 * 32 * 32);
    for (let i = 0; i < d.length; i++) d[i] = 1 + Math.floor(255 * r());
    list.push({ name: "sharded_u8", about: "incompressible data with a small file cap: many shard files", dims: ["t", "y", "x"], shape: [40, 32, 32], dtype: "uint8", data: d, input: {}, options: { maxShardBytes: 8 * 1024 }, expectEncoding: "exact" });
  }
  {
    const r = rng(11), d = blobs(r, [6], 32, 32, "float32", { amp: 10, noise: 0.5 });
    d.fill(NaN, 1 * 1024, 3 * 1024); d.fill(NaN, 5 * 1024, 6 * 1024);
    list.push({ name: "sparse_f32", about: "whole planes without data are not stored at all", dims: ["t", "y", "x"], shape: [6, 32, 32], dtype: "float32", data: d, input: { lossless: true }, expectEncoding: "exact" });
  }
  // Contract update 2: shard shapes. Each plane compresses to about 3040 bytes (zstd 5); the small caps below
  // sit mid-way between run lengths, so a writer whose zstd differs by a few bytes still picks the same shape.
  {
    // Channel-first: one channel's whole z run (10 planes, ~30 kB) is over the 15 000-byte cap, so z (the
    // SECOND leading dimension) is split into runs of floor(0.9 * 15000 / 3040) = 4 planes, c gets 1.
    const d = wavyStack(12, 3 * 10, 40, 48);
    list.push({ name: "stack_cz_split_u16", about: "a channel-first stack over a small cap: shards of 4 z planes of one channel", dims: ["c", "z", "y", "x"], shape: [3, 10, 40, 48], dtype: "uint16", data: d,
      input: { axes: { z: { unit: "µm", scale: 0.5 }, y: { unit: "µm", scale: 0.2 }, x: { unit: "µm", scale: 0.2 } } }, options: { maxShardBytes: 15_000 }, expectEncoding: "exact" });
  }
  {
    // Three leading dimensions: z is split into runs of floor(0.9 * 8400 / 3040) = 2, so t AND c get 1.
    const d = wavyStack(13, 2 * 2 * 6, 40, 48);
    list.push({ name: "stack_tcz_split_u16", about: "t, c and z over a small cap: t and c have shard extent 1, z runs of 2", dims: ["t", "c", "z", "y", "x"], shape: [2, 2, 6, 40, 48], dtype: "uint16", data: d,
      input: { axes: { t: { unit: "s", scale: 2 } } }, options: { maxShardBytes: 8_400 }, expectEncoding: "exact" });
  }
  {
    // One tiled plane over the cap: y is split into runs of rows of 512 px tiles (x stays whole). A row of
    // tiles is ~307 kB; sampling stops after 3 rows (~921 kB > 800 000), so runs of floor(0.9 * 800000 * 3 / 921k) = 2.
    const r = rng(14), H = 2100, W = 600, d = new Uint8Array(H * W);
    for (let i = 0; i < d.length; i++) d[i] = 1 + Math.floor(255 * r());
    list.push({ name: "rows_split_u8", about: "one large plane over a small cap: shards of two rows of tiles", dims: ["y", "x"], shape: [H, W], dtype: "uint8", data: d, input: {}, options: { maxShardBytes: 800_000 }, expectEncoding: "exact" });
  }
  {
    // A channel that starts hidden, and the default colours of three channels (gray, green, magenta).
    const r = rng(15);
    list.push({ name: "hidden_channel_u8", about: "three channels with default colours; the second starts hidden", dims: ["c", "y", "x"], shape: [3, 24, 32], dtype: "uint8", expectEncoding: "exact",
      data: blobs(r, [3], 24, 32, "uint8", { amp: 150, noise: 5 }), input: { channels: [{ name: "nuclei" }, { name: "background", visible: false }, { name: "marker" }] } });
  }
  return list;
}

/** Level-0 values of a bundle as float64 (NaN where there is no data), in stored dimension order. */
export async function readValues(dir: string): Promise<{ values: Float64Array; shape: number[]; dims: string[] }> {
  const reader = await openFluximg(nodeBundleReader(dir), await nodeZstd());
  const p = reader.manifest.pixels, nd = p.dims.length, H = p.shape[nd - 2], W = p.shape[nd - 1];
  const ci = p.dims.indexOf("c"), C = ci >= 0 ? p.shape[ci] : 1;
  const maps = valueMaps(p.dtype, p.encoding, C, p.nodata);
  const a = await reader.level(0);
  const values = new Float64Array(product(p.shape));
  const lead = p.shape.slice(0, nd - 2);
  let k = 0;
  const total = product(lead);
  for (let i = 0; i < total; i++) {
    const leading: number[] = [];
    let rem = i;
    for (let d = lead.length - 1; d >= 0; d--) { leading[d] = rem % lead[d]; rem = Math.floor(rem / lead[d]); }
    const plane = await reader.readPlane(a, leading);
    toValues(plane, maps[ci >= 0 ? leading[ci] : 0], values.subarray(k, k + H * W));
    k += H * W;
  }
  return { values, shape: p.shape, dims: p.dims };
}

export async function writeFixture(outDir: string, f: Fixture): Promise<WriteReport> {
  const dir = path.join(outDir, `${f.name}.fluximg`);
  await fsp.rm(dir, { recursive: true, force: true });
  return writeFluximg(nodeBundleWriter(dir), await nodeZstd(), { name: f.name, source: arraySource(f.data, f.dims, f.shape, f.dtype), ...f.input }, f.options);
}

/** Write every fixture bundle plus the cross-implementation sidecars. */
export async function writeAllFixtures(outDir: string): Promise<Array<{ fixture: Fixture; report: WriteReport }>> {
  const done: Array<{ fixture: Fixture; report: WriteReport }> = [];
  const index: Record<string, unknown> = {};
  for (const f of fixtures()) {
    const report = await writeFixture(outDir, f);
    const got = await readValues(path.join(outDir, `${f.name}.fluximg`));
    await writeNpy(path.join(outDir, "expected", `${f.name}.npy`), got.values, got.shape);
    await writeNpy(path.join(outDir, "inputs", `${f.name}.npy`), f.data as never, f.shape);
    const enc = report.manifest.pixels.encoding;
    index[f.name] = {
      about: f.about, dims: f.dims, shape: f.shape, inputDtype: f.dtype, storedDtype: report.manifest.pixels.dtype, encoding: enc.kind,
      nodata: (f.input.nodata ?? null), lossless: f.input.lossless === true,
      // A writer given inputs/<name>.npy must produce values within this of expected/<name>.npy, per channel.
      maxAbsError: enc.kind === "linear16" ? enc.channels.map((c) => c.scale / 2) : [0],
      options: f.options ?? {}, levels: report.manifest.pixels.levels.map((l) => l.downsample), layers: report.manifest.layers.map((l) => ({ id: l.id, kind: l.kind })),
      // Contract update 2: the shard shape (zarr chunk_grid chunk_shape) of every pixel level. Two writers given
      // the same input and maxShardBytes choose the same one (SPEC 3.3).
      chunkShapes: await Promise.all(report.manifest.pixels.levels.map(async (l) =>
        JSON.parse(await fsp.readFile(path.join(outDir, `${f.name}.fluximg`, "pixels", l.path, "zarr.json"), "utf8")).chunk_grid.configuration.chunk_shape as number[])),
    };
    done.push({ fixture: f, report });
  }
  await fsp.writeFile(path.join(outDir, "fixtures.json"), JSON.stringify(index, null, 1));
  return done;
}
