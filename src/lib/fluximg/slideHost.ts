/**
 * The slide player's image host: what the player asks of whoever can decode and draw a fluximg (stage 2, D3-D5).
 *
 * Pure types, like `model3d/host.ts`: the player (`slide/player/fluximg.ts`) imports only these, so a host with a
 * decoder and WebGL (`appSlideHost.ts`, in the app) or none at all (static documents, the exported deck) is injected
 * through `SlideRenderCtx`. A player without a host never allocates GPU and shows each image as its still.
 */
import type { FluximgManifest } from "./types";
import type { TweenPicture, ViewTweenFrame } from "./viewTween";

export interface FluximgSlideHost {
  /** The image's manifest when it is already known (sync), else undefined; `need` loads it. */
  manifest(assetId: string): FluximgManifest | undefined;
  need(assetId: string): Promise<FluximgManifest>;
  /**
   * A still for a picture at an output size, as a data URL, when cached; otherwise undefined and it is rendered in
   * the background (`onChange` fires when it lands). Never allocates GPU.
   */
  still(assetId: string, picture: TweenPicture, outWidth: number, outHeight: number): string | undefined;
  /** A live surface over a canvas the binding owns. All surfaces of a host share ONE WebGL context. */
  surface(canvas: HTMLCanvasElement): FluximgSurface;
  /** Decode ahead: make these pictures drawable soon. Safe to call often; safe to ignore. */
  warm(assetId: string, pictures: readonly TweenPicture[], outWidth: number, outHeight: number): void;
  /** Resolves when every picture is drawable (its planes decoded and in hand). */
  ready(assetId: string, pictures: readonly TweenPicture[], outWidth: number, outHeight: number): Promise<void>;
  /** Something the host was asked for landed (a plane, a still, the colour maps): a frame that waited may now draw.
   *  Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export interface FluximgSurface {
  /**
   * Draw this frame at this pixel size. Returns true when exactly this frame is now on the canvas; false when planes
   * are still decoding, in which case the canvas keeps the newest complete earlier frame (D4: never a blend of
   * planes the frame did not ask for, never a blank).
   */
  draw(assetId: string, frame: ViewTweenFrame, outWidth: number, outHeight: number): boolean;
  /** True once any frame has reached the canvas since the last `release`. */
  readonly shown: boolean;
  /** True when the last frame passed to `draw()` is exactly on the canvas (it may land after `draw` returned false). */
  readonly exact: boolean;
  /** Capture: resolves when the last frame passed to `draw()` is exactly on the canvas. */
  settled(): Promise<void>;
  /** Give back GPU memory (offscreen or hidden): the canvas is emptied and the next draw renders afresh. */
  release(): void;
  /** The binding is gone: release, and the host forgets this surface. */
  dispose(): void;
}

/** What `SlideRenderCtx` carries for images (live hosts and static ones alike). */
export interface FluximgSlideContext {
  /** Live hosts only (preview, Present). Absent: every image is its still and nothing allocates GPU. */
  fluximg?: FluximgSlideHost;
  /** A manifest by asset id when known (static hosts load none: they show what is cached). */
  fluximgManifest?: (assetId: string) => FluximgManifest | undefined;
  /** A cached still of a picture (static hosts); a miss may be rendered in the background for the host's next render. */
  fluximgStill?: (assetId: string, picture: TweenPicture, outWidth: number, outHeight: number) => string | undefined;
  /** Layer SVG text (outlines, vector layers) by asset id and bundle path, when loaded; a miss draws no shapes. */
  fluximgLayerText?: (assetId: string, path: string) => string | undefined;
  /** Colour-map tables for the calibration bar (absent: a colour map's bar is gray). */
  fluximgLut?: (name: string) => string[] | null;
}
