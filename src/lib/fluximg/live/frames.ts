/**
 * What a GPU frame of one view needs, and how it is assembled: shared by the live view's driver (`driver.ts`) and the
 * slide player's image host (`appSlideHost.ts` / `slideSurfaces.ts`), so both ask for the same planes at the same level
 * and build the same `LiveFrame` (the GL parity law holds for both by construction).
 *
 * Pure apart from the plane source it is handed: no DOM, no WebGL, no Svelte.
 */
import { MAX_LIVE_CHANNELS, MAX_LIVE_LAYERS, type LiveChannel, type LiveFrame, type LiveLayer } from "../gl/liveRenderer";
import { channelTable } from "../lut";
import { pickLevel } from "../reader";
import { layerKey, planeKey, projectionKey, type ServicePlane } from "../service";
import type { FluximgManifest } from "../types";
import type { PixelRect, ResolvedView } from "../view";
import { planeRequests, type PlaneRequest } from "../viewOps";

/** One plane a frame needs: its cache key (the service's and the texture cache's) and how to ask for it. */
export interface PlaneWant { key: string; request: PlaneRequest | { layerId: string } }

/** Where planes come from: the window's `FluximgService` satisfies it (gates inject their own). */
export interface PlaneSource {
  plane(bundle: string, level: number, leading: readonly number[]): Promise<ServicePlane>;
  projection(bundle: string, level: number, leading: readonly number[], dim: string, from: number, to: number, mode: import("../view").FluximgProjectionMode, slot?: string): Promise<ServicePlane>;
  layer(bundle: string, layerId: string, downsample: number): Promise<ServicePlane>;
}

/** The stored level that matches the screen (`sharp`) and the coarsest overview (`coarse`). */
export function frameLevels(manifest: FluximgManifest, crop: PixelRect, outWidth: number, outHeight: number): { sharp: number; coarse: number } {
  const levels = manifest.pixels.levels;
  const sharp = pickLevel(levels, Math.min(crop.width / Math.max(1, outWidth), crop.height / Math.max(1, outHeight)));
  let coarse = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i].downsample > levels[coarse].downsample) coarse = i;
  return { sharp, coarse };
}

/** Every plane a frame of `view` at `level` needs: the contributing channels (at most MAX_LIVE_CHANNELS), then the
 *  visible intensity layers (at most MAX_LIVE_LAYERS). */
export function wantedPlanes(manifest: FluximgManifest, bundle: string, view: ResolvedView, level: number): PlaneWant[] {
  const out: PlaneWant[] = [];
  for (const r of planeRequests(manifest, view).slice(0, MAX_LIVE_CHANNELS)) {
    out.push({ key: "dim" in r ? projectionKey(bundle, level, r.leading, r.dim, r.from, r.to, r.mode) : planeKey(bundle, level, r.leading), request: r });
  }
  const f = manifest.pixels.levels[level].downsample;
  let n = 0;
  for (const L of view.layers) {
    if (L.kind !== "intensity" || !L.visible || !(L.opacity > 0) || n >= MAX_LIVE_LAYERS) continue;
    out.push({ key: layerKey(bundle, L.id, f), request: { layerId: L.id } });
    n++;
  }
  return out;
}

/** Ask the source for one wanted plane. `slot` (projections only) replaces an earlier request in the same slot. */
export function requestPlane(source: PlaneSource, bundle: string, manifest: FluximgManifest, level: number, want: PlaneWant, slot?: string): Promise<ServicePlane> {
  const r = want.request;
  return "layerId" in r ? source.layer(bundle, r.layerId, manifest.pixels.levels[level].downsample)
    : "dim" in r ? source.projection(bundle, level, r.leading, r.dim, r.from, r.to, r.mode, slot)
    : source.plane(bundle, level, r.leading);
}

/** Colour tables by (colour, map, invert), built once each: a row is re-uploaded only when a different array is passed. */
export class TableCache {
  private tables = new Map<string, Uint8Array>();
  constructor(private resolveLut: (name: string) => string[] | null) {}
  get(spec: { color: string | null; lut: string | null; invert: boolean }): Uint8Array {
    const key = `${spec.color ?? ""}|${spec.lut ?? ""}|${spec.invert ? 1 : 0}`;
    let t = this.tables.get(key);
    if (!t) { t = channelTable(spec, this.resolveLut); this.tables.set(key, t); if (this.tables.size > 64) this.tables.delete(this.tables.keys().next().value as string); }
    return t;
  }
  clear(): void { this.tables.clear(); }
}

/**
 * The GPU frame of `view` over `crop` (level-0 px) at `level`, from planes in hand (`have`, all present in `plane`).
 * Also returns which channel each `frame.channels` entry is.
 */
export function liveFrameOf(manifest: FluximgManifest, view: ResolvedView, crop: PixelRect, level: number, have: readonly PlaneWant[], plane: (key: string) => ServicePlane, tables: TableCache, outWidth: number, outHeight: number): { frame: LiveFrame; channels: number[]; f: number } {
  const f = manifest.pixels.levels[level].downsample;
  const first = have.length ? plane(have[0].key) : null;
  const nd = manifest.pixels.levels[level].shape.length;
  const width = first ? first.width : manifest.pixels.levels[level].shape[nd - 1];
  const height = first ? first.height : manifest.pixels.levels[level].shape[nd - 2];
  const channels: LiveChannel[] = [], layers: LiveLayer[] = [], channelIndices: number[] = [];
  for (const w of have) {
    const p = plane(w.key);
    if ("layerId" in w.request) {
      const id = w.request.layerId;
      const L = view.layers.find((l) => l.id === id), entry = manifest.layers.find((l) => l.id === id);
      if (!L || !entry || entry.kind !== "intensity") continue;
      layers.push({ plane: p, table: tables.get({ color: L.color, lut: L.lut, invert: false }), range: L.range ?? entry.range, norm: "linear", gamma: 1, opacity: L.opacity, opacityFromValue: L.opacityFromValue });
    } else {
      const c = view.channels[w.request.channel];
      channels.push({ plane: p, table: tables.get(c), range: c.range, norm: c.norm, gamma: c.gamma });
      channelIndices.push(w.request.channel);
    }
  }
  const frame: LiveFrame = {
    width, height, channels, layers, background: view.background, smooth: view.smooth,
    crop: { x: crop.x / f, y: crop.y / f, width: crop.width / f, height: crop.height / f },
    outWidth, outHeight,
  };
  return { frame, channels: channelIndices, f };
}
