/** The placed element and what an asset record keeps about its bundle. Pure types. */
import type { CropRect, ElementBase } from "../types";
import type { FluximgDtype } from "./types";
import type { FluximgView } from "./view";

/** A digest of the manifest kept on the Asset, so lists, the Inspector and agents need not open the bundle. */
export interface FluximgInfo {
  dims: string[];
  shape: number[];
  dtype: FluximgDtype;
  encoding: "exact" | "linear16";
  channels: string[];
  /** Downsampling factor of each stored level. */
  levels: number[];
  layers: Array<{ id: string; kind: "intensity" | "labels" | "vector"; name: string; count?: number }>;
  regions: number;
  /** Physical size of a pixel, when the bundle states it. */
  pixelSize?: { x: number; y: number; unit: string | null };
  photometric?: "rgb" | null;
}

export interface FluximgElement extends ElementBase {
  type: "fluximg";
  assetId: string;
  /** The viewport in image pixels (level 0). Absent = the whole image. Same meaning as an image's crop. */
  crop?: CropRect;
  view?: FluximgView;
  /** Where the bundle came from: `sha256` is the content id of the source at import. */
  source?: { bundlePath: string; sha256?: string; recipePath?: string; external?: boolean; frozen?: boolean };
  /**
   * How the image plays as a movie on a slide once a step Starts it (stage 2, plan D7): along one dimension, looping,
   * bouncing or once, at a multiple of the data's own rate (or `fps` planes a second), over planes `from` (inclusive)
   * to `to` (exclusive, as a projection's run). Design-level like a video's `loop`: never a step's Change. Absent =
   * the defaults (`fluximg/playback.resolvePlayback`).
   */
  playback?: FluximgPlayback;
}

export type FluximgPlaybackMode = "loop" | "bounce" | "once";
export interface FluximgPlayback {
  dim: string;
  mode: FluximgPlaybackMode;
  speed?: number;
  fps?: number;
  from?: number;
  to?: number;
}

export const FLUXIMG_ELEMENT = "fluximg" as const;
export const FLUXIMG_ASSET_KIND = "fluximg" as const;
