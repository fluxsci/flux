/**
 * From an imported bundle to an asset record (pure: no DOM, no Node, no Svelte).
 *
 * The asset keeps a small digest of the manifest (`FluximgInfo`) so lists, the Inspector and agents can describe
 * an image without opening its bundle. Both engines build the record with these functions.
 */
import type { Asset } from "../types";
import type { FluximgImportResult } from "./bridge";
import type { FluximgInfo } from "./element";
import type { FluximgManifest } from "./types";
import { FLUXIMG_SUFFIX } from "./types";

/** The digest of a manifest that an asset record keeps. */
export function fluximgInfo(manifest: FluximgManifest): FluximgInfo {
  const p = manifest.pixels, ax = manifest.axes?.x, ay = manifest.axes?.y;
  const info: FluximgInfo = {
    dims: [...p.dims],
    shape: [...p.shape],
    dtype: p.dtype,
    encoding: p.encoding.kind,
    channels: manifest.channels.map((c) => c.name),
    levels: p.levels.map((l) => l.downsample),
    layers: manifest.layers.map((l) => ({ id: l.id, kind: l.kind, name: l.name, ...(l.kind !== "intensity" && typeof l.count === "number" ? { count: l.count } : {}) })),
    regions: manifest.regions?.length ?? 0,
  };
  if (ax && ay && typeof ax.scale === "number" && ax.scale > 0 && typeof ay.scale === "number" && ay.scale > 0) {
    info.pixelSize = { x: ax.scale, y: ay.scale, unit: ax.unit ?? null };
  }
  if (manifest.photometric === "rgb") info.photometric = "rgb";
  return info;
}

/** A display name for a bundle: the manifest's own name, else the folder's, without the `.fluximg` suffix. */
export function fluximgDisplayName(manifest: FluximgManifest, sourcePath?: string): string {
  const strip = (s: string): string => (s.toLowerCase().endsWith(FLUXIMG_SUFFIX) ? s.slice(0, -FLUXIMG_SUFFIX.length) : s);
  const own = typeof manifest.name === "string" ? strip(manifest.name.trim()) : "";
  if (own) return own;
  const base = (sourcePath ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return strip(base) || "image";
}

/** The asset record of an imported bundle. `naturalWidth` / `naturalHeight` are its x / y sizes in image pixels. */
export function fluximgAsset(assetId: string, result: Pick<FluximgImportResult, "path" | "sha256" | "bytes" | "manifest">, sourcePath?: string): Asset {
  const m = result.manifest, s = m.pixels.shape, nd = s.length;
  return {
    id: assetId,
    name: fluximgDisplayName(m, sourcePath),
    kind: "fluximg",
    path: result.path,
    naturalWidth: s[nd - 1],
    naturalHeight: s[nd - 2],
    sha256: result.sha256,
    bytes: result.bytes,
    fluximg: fluximgInfo(m),
  };
}

/** Where an asset's bundle lives, relative to `fig/` (the way `Asset.path` is written): `assets/<assetId>.fluximg`. A bundle
 *  always lives there, in figures and decks alike: a deck never owns one and refers to it by id. */
export const fluximgAssetPath = (assetId: string): string => `assets/${assetId}${FLUXIMG_SUFFIX}`;

/**
 * The asset record of a bundle that a DECK places but `fig/index.json` does not list (an image imported onto a slide never
 * writes the figure index): rebuilt from the bundle's own manifest at its one place, `fig/assets/<assetId>.fluximg`. The
 * content id is the one the placing element recorded (`source.sha256`, the same bytes) when it has one; the byte count is
 * unknown (only an import measures it). Both engines resolve a deck's images through this.
 */
export function fluximgResolvedAsset(assetId: string, manifest: FluximgManifest, sha256?: string): Asset {
  const s = manifest.pixels.shape, nd = s.length;
  return {
    id: assetId,
    name: fluximgDisplayName(manifest),
    kind: "fluximg",
    path: fluximgAssetPath(assetId),
    naturalWidth: s[nd - 1],
    naturalHeight: s[nd - 2],
    ...(sha256 && /^[a-f0-9]{64}$/.test(sha256) ? { sha256 } : {}),
    fluximg: fluximgInfo(manifest),
  };
}

/** An asset id for a new import: readable, unique, and inside the file side's safe alphabet. */
export function fluximgAssetId(name: string, unique: string): string {
  const stem = name.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "image";
  const tail = unique.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "0";
  return `img-${stem}-${tail}`;
}

/** "2 channels · 25 z · 2048 x 2048 · uint16": what an image is, in one line, for lists and headers. */
export function describeFluximg(info: Pick<FluximgInfo, "dims" | "shape" | "dtype" | "channels" | "encoding">): string {
  const parts: string[] = [];
  const size = (d: string): number => { const i = info.dims.indexOf(d); return i >= 0 ? info.shape[i] : 0; };
  const nc = info.dims.includes("c") ? size("c") : 1;
  if (nc > 1) parts.push(`${nc} channels`);
  for (let i = 0; i < info.dims.length; i++) {
    const d = info.dims[i];
    if (d === "c" || d === "y" || d === "x") continue;
    parts.push(`${info.shape[i].toLocaleString("en-US")} ${d}`);
  }
  parts.push(`${size("x").toLocaleString("en-US")} × ${size("y").toLocaleString("en-US")}`);
  parts.push(info.encoding === "linear16" ? "compact 16-bit" : info.dtype);
  return parts.join(" · ");
}
