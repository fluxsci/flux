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
}

export const FLUXIMG_ELEMENT = "fluximg" as const;
export const FLUXIMG_ASSET_KIND = "fluximg" as const;
