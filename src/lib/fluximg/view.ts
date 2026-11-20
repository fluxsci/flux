/**
 * The view recipe: everything a placed fluximg stores about how it is shown.
 *
 * Pixels are never changed; a view is a handful of numbers on the element. It is persisted in canvas JSON, so
 * every field is optional and absent means "the default" (`viewOps.resolveView` fills them in from the manifest).
 * Pure types.
 */

/** How one channel is shown. Absent fields fall back to the manifest's channel entry. */
export interface FluximgChannelView {
  visible?: boolean;
  /** `#rrggbb`: the ramp from black to this colour. Setting `color` clears `lut` and vice versa. */
  color?: string | null;
  /** A colour-map name known to Flux (`gray`, `viridis`, `cmasher.ember`, …). */
  lut?: string | null;
  /** Display window in VALUE units: black point, white point. */
  range?: [number, number];
  /** How values map across the window. `gamma` uses `gamma` below (1 = linear). */
  norm?: "linear" | "log" | "gamma";
  gamma?: number;
  /** Reverse the colour map. */
  invert?: boolean;
}

export type FluximgProjectionMode = "max" | "mean" | "min" | "sum" | "std";

/** Show a statistic over a run of planes along one dimension instead of a single plane. */
export interface FluximgProjection {
  dim: string;
  mode: FluximgProjectionMode;
  /** Plane indices: `from` inclusive, `to` exclusive. */
  from: number;
  to: number;
}

/** How one layer is shown. Absent fields fall back to the layer's own defaults. */
export interface FluximgLayerView {
  visible?: boolean;
  /** 0..1, multiplies whatever the layer does on its own. */
  opacity?: number;
  /** Stroke (and fill tint) for vector and label layers; ramp colour for intensity layers. */
  color?: string | null;
  lut?: string | null;
  /** Stroke width in screen pixels (vector and label layers). */
  strokeWidth?: number;
  /** Fill opacity 0..1 (vector and label layers). */
  fillOpacity?: number;
  /** Display window (intensity layers). */
  range?: [number, number];
}

export type FurnitureCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export interface FluximgScalebarView {
  /** Length in the x axis' unit. Absent = a round length chosen for the current crop. */
  length?: number;
  corner?: FurnitureCorner;
  color?: string;
  /** Show the "20 µm" label. */
  label?: boolean;
  /** Bar thickness and label size in points. */
  thickness?: number;
  fontSize?: number;
}

export interface FluximgStampView {
  /** Which dimension's position to print. Absent = every non-spatial, non-channel dimension. */
  dims?: string[];
  corner?: FurnitureCorner;
  color?: string;
  fontSize?: number;
}

export interface FluximgFurnitureView {
  scalebar?: FluximgScalebarView | false;
  /** The depth / time stamp ("z −50.5 µm", "t 3.20 s", "max z 8–15"). */
  stamp?: FluximgStampView | false;
  /** Channel names, each in its channel's colour. */
  channelLabels?: { corner?: FurnitureCorner; fontSize?: number } | false;
  /** Names of layer objects drawn beside them. */
  names?: { layers?: string[]; fontSize?: number } | false;
  /** The intensity calibration bar: each shown channel's colours laid from its black point to its white point, with both values. */
  colorbar?: { corner?: FurnitureCorner; color?: string; fontSize?: number } | false;
}

export interface FluximgView {
  /** Position along each dimension other than c, y, x. */
  index?: Record<string, number>;
  projection?: FluximgProjection | null;
  /** Sparse: entry i overrides channel i. */
  channels?: Array<FluximgChannelView | null>;
  /** `blend` adds every visible channel; `single` shows only channel `solo`. */
  composite?: "blend" | "single";
  solo?: number;
  /** Interpolate between pixels when magnified. Default false: true pixels. */
  smooth?: boolean;
  /** Colour behind pixels without data: a hex colour or "transparent". Default "#000000". */
  background?: string;
  /** Overrides per layer id. */
  layers?: Record<string, FluximgLayerView>;
  /** Layer ids from bottom to top. Absent = manifest order. */
  layerOrder?: string[];
  furniture?: FluximgFurnitureView;
  /** This element is a blow-out of that element (same asset): the parent draws this element's crop as a rectangle. */
  insetOf?: string;
  /**
   * Panels of one image that move together (split channels, a blow-out): elements of the same asset carrying the
   * same link share their position, projection and each channel's window, norm and gamma. What a panel SHOWS
   * (which channels, their colours, its frame, its annotations) stays its own.
   */
  link?: string;
}

// ---------------------------------------------------------------------------------------------
// The resolved view: the recipe with every default filled in from the manifest (viewOps.resolveView).
// Renderers, furniture and the UI read THIS, never the sparse recipe.
// ---------------------------------------------------------------------------------------------

export interface ResolvedChannel {
  /** Index into the manifest's channels (and along the `c` dimension). */
  index: number;
  name: string;
  visible: boolean;
  color: string | null;
  lut: string | null;
  range: [number, number];
  norm: "linear" | "log" | "gamma";
  gamma: number;
  invert: boolean;
}

export interface ResolvedLayer {
  id: string;
  kind: "intensity" | "labels" | "vector";
  name: string;
  visible: boolean;
  opacity: number;
  /** null = keep the colours written in the layer. */
  color: string | null;
  lut: string | null;
  /** Screen pixels. */
  strokeWidth: number;
  fillOpacity: number;
  /** Intensity layers only. */
  range: [number, number] | null;
  /** Intensity layers only: opacity follows the normalized value. */
  opacityFromValue: boolean;
}

export interface ResolvedFurniture {
  scalebar: Required<Omit<FluximgScalebarView, "length">> & { length: number | null } | false;
  stamp: Required<FluximgStampView> | false;
  channelLabels: { corner: FurnitureCorner; fontSize: number } | false;
  names: { layers: string[]; fontSize: number } | false;
  colorbar: { corner: FurnitureCorner; color: string; fontSize: number } | false;
}

export interface ResolvedView {
  index: Record<string, number>;
  projection: FluximgProjection | null;
  channels: ResolvedChannel[];
  composite: "blend" | "single";
  solo: number;
  smooth: boolean;
  background: string;
  /** Bottom to top. */
  layers: ResolvedLayer[];
  furniture: ResolvedFurniture;
  insetOf: string | null;
  link: string | null;
}

/** A crop in image pixels (level 0), or in the pixels of whichever level a renderer was handed. */
export interface PixelRect { x: number; y: number; width: number; height: number }
