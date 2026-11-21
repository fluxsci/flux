/**
 * A still: the pixels of one view of a bundle, drawn by the reference renderer.
 *
 * ONE function for every engine (twin-engine rule): the window's decode workers, flux-core, exports and Paper all
 * come through `renderStill`, so a view has the same pixels wherever it is drawn. It picks the stored level,
 * reads only the rectangle the crop covers, projects when the view asks for a projection, and hands the planes
 * to `renderView`. Pure apart from the reader it is given: no DOM, no Node, no Svelte. Encoding the result (PNG)
 * is the caller's job, since that is where the engines differ.
 */
import { valueMaps, type ValueMap } from "./encoding";
import { channelTable } from "./lut";
import { projector } from "./project";
import { pickLevel, type ArrayHandle, type FluximgReader } from "./reader";
import { decoderOf, renderView, type RenderInput, type RenderPlane } from "./render";
import type { FluximgManifest, FluximgTypedArray } from "./types";
import type { FluximgView, PixelRect } from "./view";
import { planeRequests, resolveView, type PlaneRequest } from "./viewOps";
import { fullCrop, clampCrop, tieredStillSize, stillSize, type StillSizeOptions } from "./crop";

/** The frame and size helpers live in crop.ts (pure callers import them from there); re-exported for everyone else. */
export { fullCrop, clampCrop, tieredStillSize, stillSize, type StillSizeOptions };

export interface StillSpec {
  view: FluximgView | null | undefined;
  /** Level-0 image pixels. Absent = the whole image. */
  crop: PixelRect | null | undefined;
  outWidth: number;
  outHeight: number;
}

export interface StillEnv {
  /** A colour map's 256 "#rrggbb" entries, or null when the name is unknown. */
  resolveLut: (name: string) => string[] | null;
  /** Asked between reads; true abandons the still (`StillCancelled`). */
  cancelled?: () => boolean;
  /** Decoded pieces by key, so a contrast change on the same plane decodes nothing. The caller owns the budget. */
  cache?: { get(key: string): FluximgTypedArray | undefined; set(key: string, value: FluximgTypedArray): void };
  /** Prefix for cache keys (the bundle's identity). */
  cacheScope?: string;
}

export interface Still { rgba: Uint8ClampedArray; width: number; height: number; level: number }

export class StillCancelled extends Error {
  constructor() { super("cancelled"); this.name = "StillCancelled"; }
}

const channelCount = (m: FluximgManifest): number => {
  const ci = m.pixels.dims.indexOf("c");
  return ci >= 0 ? m.pixels.shape[ci] : 1;
};

/** The value maps of a bundle's pixel array, one per channel. */
export function pixelMaps(m: FluximgManifest): ValueMap[] {
  return valueMaps(m.pixels.dtype, m.pixels.encoding, channelCount(m), m.pixels.nodata);
}

/**
 * One rectangle of one request: stored samples of a single plane, or VALUES of a projection over a run of planes
 * (read one plane at a time, so a thousand-frame movie never sits in memory at once).
 */
export async function readPiece(reader: FluximgReader, a: ArrayHandle, level: number, req: PlaneRequest, rect: PixelRect, env: Pick<StillEnv, "cache" | "cacheScope" | "cancelled">): Promise<RenderPlane> {
  const m = reader.manifest, map = pixelMaps(m)[req.channel];
  const base = `${env.cacheScope ?? ""}|${level}|${rect.x},${rect.y},${rect.width},${rect.height}|${req.leading.join(",")}`;
  if (!("dim" in req)) {
    const hit = env.cache?.get(base);
    if (hit) return { data: hit, map };
    const data = (await reader.readRegion(a, req.leading, rect)).data;
    env.cache?.set(base, data);
    return { data, map };
  }
  const key = `${base}|${req.dim}:${req.from}-${req.to}:${req.mode}`;
  const hit = env.cache?.get(key);
  if (hit) return { data: hit, map: null };
  const di = m.pixels.dims.indexOf(req.dim);
  const acc = projector(rect.width * rect.height, req.mode);
  const leading = req.leading.slice();
  for (let i = req.from; i < req.to; i++) {
    if (env.cancelled?.()) throw new StillCancelled();
    leading[di] = i;
    acc.add({ data: (await reader.readRegion(a, leading, rect)).data, map });
  }
  const data = acc.finish();
  env.cache?.set(key, data);
  return { data, map: null };
}

/**
 * A full-resolution raster reduced by `f` in both directions: the mean of the valid VALUES in each f x f block,
 * NaN where a block has none. The same rule the writer uses for overview levels, so a layer drawn over an
 * overview lines up with it.
 */
export function blockMeanValues(plane: RenderPlane, width: number, height: number, f: number, outWidth: number, outHeight: number): Float32Array {
  const out = new Float32Array(outWidth * outHeight);
  const d = plane.data, dec = decoderOf(plane.map);
  const nd = dec.nodata === null ? NaN : dec.nodata;
  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = oy * f, y1 = Math.min(height, y0 + f);
    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = ox * f, x1 = Math.min(width, x0 + f);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          const s = d[row + x];
          if (s === nd || s !== s) continue;
          sum += dec.ident ? s : dec.add + dec.mul * (s - dec.sub);
          n++;
        }
      }
      out[oy * outWidth + ox] = n ? sum / n : NaN;
    }
  }
  return out;
}

/** Draw one view. Reads only what the crop and the chosen level need. */
export async function renderStill(reader: FluximgReader, spec: StillSpec, env: StillEnv): Promise<Still> {
  const m = reader.manifest, p = m.pixels, nd = p.dims.length;
  const outWidth = Math.max(1, Math.round(spec.outWidth)), outHeight = Math.max(1, Math.round(spec.outHeight));
  const rv = resolveView(m, spec.view);
  const full = fullCrop(m), crop = clampCrop(m, spec.crop);
  const li = pickLevel(p.levels, Math.min(crop.width / outWidth, crop.height / outHeight));
  const f = p.levels[li].downsample;
  const a = await reader.level(li);
  const LW = a.meta.shape[nd - 1], LH = a.meta.shape[nd - 2];
  // The whole level pixels the crop touches, and the crop measured from that rectangle's corner.
  const x0 = Math.min(LW - 1, Math.max(0, Math.floor(crop.x / f))), y0 = Math.min(LH - 1, Math.max(0, Math.floor(crop.y / f)));
  const x1 = Math.min(LW, Math.max(x0 + 1, Math.ceil((crop.x + crop.width) / f))), y1 = Math.min(LH, Math.max(y0 + 1, Math.ceil((crop.y + crop.height) / f)));
  const rect: PixelRect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const check = (): void => { if (env.cancelled?.()) throw new StillCancelled(); };

  const channels: RenderInput["channels"] = [];
  for (const req of planeRequests(m, rv)) {
    check();
    const view = rv.channels[req.channel];
    channels.push({ plane: await readPiece(reader, a, li, req, rect, env), view, table: channelTable(view, env.resolveLut) });
  }

  const layers: RenderInput["layers"] = [];
  for (const L of rv.layers) {
    if (L.kind !== "intensity" || !L.visible || !(L.opacity > 0)) continue;
    const entry = m.layers.find((x) => x.id === L.id);
    if (!entry || entry.kind !== "intensity") continue;
    check();
    const la = await reader.array(entry.path);
    const lmap = valueMaps(entry.dtype, entry.encoding, 1, null)[0];
    // A layer has one stored resolution (the image's own grid). Read the pixels under the level rectangle.
    const lrect: PixelRect = { x: rect.x * f, y: rect.y * f, width: Math.min(full.width - rect.x * f, rect.width * f), height: Math.min(full.height - rect.y * f, rect.height * f) };
    const key = `${env.cacheScope ?? ""}|layer:${entry.id}|${f}|${lrect.x},${lrect.y},${lrect.width},${lrect.height}`;
    let plane: RenderPlane;
    const hit = env.cache?.get(key);
    if (hit) plane = { data: hit, map: f === 1 ? lmap : null };
    else {
      const raw = (await reader.readRegion(la, [], lrect)).data;
      const data = f === 1 ? raw : blockMeanValues({ data: raw, map: lmap }, lrect.width, lrect.height, f, rect.width, rect.height);
      env.cache?.set(key, data);
      plane = { data, map: f === 1 ? lmap : null };
    }
    layers.push({ plane, range: L.range ?? entry.range, table: channelTable({ color: L.color, lut: L.lut, invert: false }, env.resolveLut), opacity: L.opacity, opacityFromValue: L.opacityFromValue });
  }
  check();
  const rgba = renderView({
    width: rect.width, height: rect.height, channels, layers,
    composite: rv.composite, solo: rv.solo, background: rv.background, smooth: rv.smooth,
    crop: { x: crop.x / f - rect.x, y: crop.y / f - rect.y, width: crop.width / f, height: crop.height / f },
    outWidth, outHeight,
  });
  return { rgba, width: outWidth, height: outHeight, level: li };
}
