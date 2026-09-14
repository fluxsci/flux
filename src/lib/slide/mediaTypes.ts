/** Slide-only media. The shared editor reuses its ordinary geometry tools;
 * Figure serialization deliberately excludes this branch. */
import { newId } from "../ids";
import type { Asset, ElementBase, Id } from "../types";
export interface VideoElement extends ElementBase {
  type: "video";
  /** Prepared, portable H.264/AAC MP4 and its separate first-frame PNG. */
  assetId: Id;
  posterAssetId: Id;
  durationMs: number;
  /** Audio plays by default. Looping is opt-in. */
  muted?: boolean;
  loop?: boolean;
}

/** One constructor for GUI batch placement and headless imports. */
export function makeVideoElement(asset: Asset, posterAssetId: Id, stage: { width: number; height: number },
  opts: { x?: number; y?: number; width?: number; height?: number; muted?: boolean; loop?: boolean; name?: string } = {}): VideoElement {
  if (asset.kind !== "mp4" || !(asset.durationMs && Number.isFinite(asset.durationMs) && asset.durationMs > 0)
    || !(asset.naturalWidth > 0 && asset.naturalHeight > 0) || !posterAssetId) throw new Error("Invalid prepared video metadata");
  const fit = Math.min(1, stage.width * .8 / asset.naturalWidth, stage.height * .8 / asset.naturalHeight);
  const width = opts.width ?? (opts.height != null ? opts.height * asset.naturalWidth / asset.naturalHeight : asset.naturalWidth * fit);
  const height = opts.height ?? width * asset.naturalHeight / asset.naturalWidth;
  const x = opts.x ?? (stage.width - width) / 2, y = opts.y ?? (stage.height - height) / 2;
  if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Invalid video placement geometry");
  return { type: "video", id: newId("video"), assetId: asset.id, posterAssetId, durationMs: asset.durationMs,
    name: opts.name ?? asset.name.replace(/\.(mp4|mov)$/i, ""), x, y, width, height, rotation: 0, lockAspect: true,
    ...(opts.muted != null ? { muted: opts.muted } : {}), ...(opts.loop != null ? { loop: opts.loop } : {}),
  };
}
