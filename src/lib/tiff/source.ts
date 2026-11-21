/**
 * A TIFF and an answer → what the fluximg writer takes: a `PixelSource` in canonical dimension order and the rest
 * of `WriteInput` (axes, channels, provenance). Pure.
 *
 * The writer pulls every plane twice (learn, then store); each pull decodes its page through ranged reads, so
 * memory stays at a few planes whatever the file's size. Pages are addressed through the answer's strides, so a
 * channel-fastest file is read in the canonical t, c, z order without ever holding more than the page at hand
 * (and, for multi-sample pixels, a small cache so the samples of one page are decoded once).
 */
import { canonicalDims, isFloatDtype, allocTyped, type FluximgDtype, type FluximgTypedArray } from "../fluximg/types";
import type { PixelSource, WriteInput } from "../fluximg/writer";
import type { TiffFile } from "./ifd";
import { readPage, layoutProblem, type Codecs } from "./decode";
import { TiffError } from "./io";
import { answerProblems, keyCoords, planAnswer } from "./infer";
import { normaliseLengthUnit } from "./meta/imagej";
import type { DimsAnswer, TiffProbe } from "./types";

export interface TiffPixelSource extends PixelSource {
  /** Bytes of decoded pages so far (both passes): what a progress line shows as "read". */
  readonly bytesRead: number;
  readonly pagesRead: number;
}

export interface SourceOptions {
  signal?: AbortSignal;
  /** Decoded pages kept for multi-sample pixels (bytes). */
  cacheBytes?: number;
}

/**
 * The pixels of `file` as the answer reads them. Throws `TiffError` with every problem of the answer when it does
 * not fit the file (call `validateAnswer` first to show them without throwing).
 */
export function tiffPixelSource(file: TiffFile, probe: TiffProbe, answer: DimsAnswer, codecs: Codecs, opts: SourceOptions = {}): TiffPixelSource {
  const problems = answerProblems(probe, answer);
  if (problems.length) throw new TiffError("answer", `The answer does not fit this file: ${problems.join("; ")}`);
  const { plan } = planAnswer(probe, answer);
  const p = plan!;
  const L = file.pages[p.first].layout;
  const bad = layoutProblem(L, codecs);
  if (bad) throw bad;
  const dtype = L.dtype as FluximgDtype;
  const W0 = L.width, H0 = L.height, n = W0 * H0;
  const transpose = answer.transpose === true, flipX = answer.flipX === true, flipY = answer.flipY === true;
  const W = transpose ? H0 : W0, H = transpose ? W0 : H0;
  const float = isFloatDtype(dtype);
  const nodata = float && answer.nodata !== undefined && answer.nodata !== null && Number.isFinite(answer.nodata) ? answer.nodata : null;
  const sampleC = p.samples ? p.sampleChannels : 0;

  const names = p.dims.map((d) => d.name);
  const all = [...names, ...(sampleC ? ["c"] : []), "y", "x"];
  const dims = canonicalDims(all);
  const sizeOf = (d: string): number => (d === "c" && sampleC ? sampleC : d === "y" ? H : d === "x" ? W : p.dims.find((x) => x.name === d)!.size);
  const shape = dims.map(sizeOf);
  const lead = dims.slice(0, -2);
  // For each canonical leading dim: its page stride (0 for the samples' c) and whether it picks the sample.
  const role = lead.map((d) => (d === "c" && sampleC ? { stride: 0, sample: true } : { stride: p.dims.find((x) => x.name === d)!.stride, sample: false }));

  const cache = new Map<number, FluximgTypedArray>();
  const cacheBytes = opts.cacheBytes ?? 256 * 1024 * 1024;
  const pageBytes = n * L.samples * (L.bits / 8);
  const maxCached = sampleC ? Math.max(1, Math.floor(cacheBytes / pageBytes)) : 0;
  let bytesRead = 0, pagesRead = 0;

  async function page(i: number): Promise<FluximgTypedArray> {
    const hit = cache.get(i);
    if (hit) { cache.delete(i); cache.set(i, hit); return hit; }
    const data = await readPage(file, file.pages[i], codecs, opts.signal);
    bytesRead += pageBytes; pagesRead++;
    if (maxCached) {
      cache.set(i, data);
      while (cache.size > maxCached) cache.delete(cache.keys().next().value!);
    }
    return data;
  }

  return {
    dims, shape, dtype,
    get bytesRead() { return bytesRead; },
    get pagesRead() { return pagesRead; },
    async plane(leading) {
      let pageIndex = p.first, sample = 0;
      for (let k = 0; k < lead.length; k++) {
        if (role[k].sample) sample = leading[k];
        else pageIndex += leading[k] * role[k].stride;
      }
      const data = await page(pageIndex);
      const src = L.samples > 1 ? data.subarray(sample * n, (sample + 1) * n) as FluximgTypedArray : data;
      if (!transpose && !flipX && !flipY && nodata === null) return src;
      const out = allocTyped(dtype, n);
      for (let y = 0; y < H; y++) {
        const sy = flipY ? H - 1 - y : y;
        for (let x = 0; x < W; x++) {
          const sx = flipX ? W - 1 - x : x;
          // Output (sx, sy) in the transposed frame is stored pixel (row sx, column sy).
          out[y * W + x] = transpose ? src[sx * W0 + sy] : src[sy * W0 + sx];
        }
      }
      if (nodata !== null) for (let i = 0; i < n; i++) if (out[i] === nodata) out[i] = NaN;
      return out;
    },
  };
}

export interface SourceRecord { path: string; bytes?: number; mtime?: string }

/**
 * Everything but the pixels: axes from the answer (and page keys), channels, no data, encoding choice, the world
 * matrix and provenance noting the source's structure and the answer used.
 */
export function tiffWriteInput(probe: TiffProbe, answer: DimsAnswer, opts: { name: string; source?: SourceRecord }): Omit<WriteInput, "source"> {
  const { plan } = planAnswer(probe, answer);
  if (!plan) throw new TiffError("answer", "The answer does not fit this file");
  const dtype = probe.plane.dtype!;
  const axes: NonNullable<WriteInput["axes"]> = {};
  const ps = answer.pixelSize;
  const unit = ps ? normaliseLengthUnit(ps.unit) ?? ps.unit : null;
  axes.x = { unit, scale: ps ? ps.x : 1, offset: 0 };
  axes.y = { unit, scale: ps ? ps.y ?? ps.x : 1, offset: 0 };
  const names = plan.dims.map((d) => d.name);
  const fromKey = (dim: string, key: string | undefined): number[] | null => (key ? keyCoords(probe, plan, dim, key) : null);
  const t = answer.time;
  if (names.includes("t")) {
    if (t?.coords) axes.t = { unit: "s", coords: t.coords.slice() };
    else if (t && (t.interval || t.rate)) axes.t = { unit: t.unit ?? "s", scale: t.interval ?? 1 / t.rate!, offset: t.t0 ?? 0 };
    else if (t?.key && fromKey("t", t.key)) { const c = fromKey("t", t.key)!; axes.t = { unit: "s", coords: c.map((v) => v - c[0]) }; }
    else axes.t = { unit: null, scale: 1, offset: 0 };
  }
  const z = answer.z;
  if (names.includes("z")) {
    const zu = z?.unit === undefined ? unit : z.unit === null ? null : normaliseLengthUnit(z.unit) ?? z.unit;
    if (z?.coords) axes.z = { unit: zu, coords: z.coords.slice() };
    else if (z?.step) axes.z = { unit: zu, scale: z.step, offset: z.origin ?? 0 };
    else if (z?.key && fromKey("z", z.key)) axes.z = { unit: zu, coords: fromKey("z", z.key)! };
    else axes.z = { unit: null, scale: 1, offset: 0 };
  }
  for (const d of names) {
    if (d === "c" || axes[d]) continue;
    const a = answer.axes?.[d];
    const coords = a?.coords ?? fromKey(d, a?.key) ?? undefined;
    axes[d] = coords ? { unit: a?.unit ?? null, coords, ...(a?.labels ? { labels: a.labels } : {}) } : { unit: a?.unit ?? null, scale: a?.scale ?? 1, offset: a?.offset ?? 0, ...(a?.labels ? { labels: a.labels } : {}) };
  }
  // Extra-dim settings given for t / z in `axes` win over nothing at all.
  for (const d of ["t", "z"]) { const a = answer.axes?.[d]; if (a && names.includes(d) && !(d === "t" ? t : z)) axes[d] = a.coords ? { unit: a.unit ?? null, coords: a.coords } : { unit: a.unit ?? null, scale: a.scale ?? 1, offset: a.offset ?? 0 }; }

  const rgb = plan.samples === "rgb";
  const max = dtype === "uint8" ? 255 : dtype === "uint16" ? 65535 : null;
  const channels: NonNullable<WriteInput["channels"]> = rgb
    ? ["red", "green", "blue"].map((name, i) => ({ name, color: ["#ff0000", "#00ff00", "#0000ff"][i], ...(max ? { range: [0, max] as [number, number] } : {}) }))
    : (answer.channels ?? []).map((c) => ({ ...(c.name !== undefined ? { name: c.name } : {}), ...(c.lut ? { lut: c.lut } : c.color ? { color: c.color } : {}), ...(c.visible === false ? { visible: false } : {}) }));
  const isFloat = dtype === "float32" || dtype === "float64";
  const structure = {
    container: `${probe.container.bigTiff ? "BigTIFF" : "TIFF"}, ${probe.container.littleEndian ? "little" : "big"}-endian`,
    pages: probe.pages, plane: `${probe.plane.width} x ${probe.plane.height}`, samples: probe.plane.samples, sampleType: probe.plane.sampleType,
    compression: probe.plane.compression, description: probe.description.kind,
  };
  const meta: Record<string, unknown> = { tiff: { ...structure, answer: JSON.parse(JSON.stringify(answer)) } };
  const constants = probe.hints.find((h) => h.source === "pagejson")?.meta;
  if (constants) (meta.tiff as Record<string, unknown>).constants = constants;
  return {
    name: opts.name,
    axes,
    channels,
    ...(!isFloat && answer.nodata !== undefined && answer.nodata !== null ? { nodata: answer.nodata } : {}),
    ...(answer.lossless ? { lossless: true } : {}),
    ...(rgb ? { photometric: "rgb" as const } : {}),
    ...(answer.world ? { world: { matrix: answer.world.matrix.map((r) => r.slice()), ...(answer.world.unit !== undefined ? { unit: answer.world.unit } : {}), ...(answer.world.note ? { note: answer.world.note } : {}) } } : {}),
    provenance: {
      writer: "flux tiff import",
      ...(opts.source ? { source: [{ path: opts.source.path, ...(opts.source.bytes !== undefined ? { bytes: opts.source.bytes } : {}), ...(opts.source.mtime ? { mtime: opts.source.mtime } : {}) }] } : {}),
      meta,
    },
  };
}
