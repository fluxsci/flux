/**
 * The slide player's image host: what the player asks of whoever can decode and draw a fluximg (stage 2, D3-D5).
 *
 * Pure types, like `model3d/host.ts`: the player (`slide/player/fluximg.ts`) imports only these, so a host with a
 * decoder and WebGL (`appSlideHost.ts`, in the app) or none at all (static documents, the exported deck) is injected
 * through `SlideRenderCtx`. A player without a host never allocates GPU and shows each image as its still.
 */
import type { FluximgManifest, FluximgTable } from "./types";
import type { TweenPicture, ViewTweenFrame, ViewTweenPlan } from "./viewTween";

/**
 * The Change a frame belongs to, as the player knows it (optional 5th argument of `FluximgSurface.draw`). A live host
 * draws the frame itself and ignores it; a host that plays BAKED clips (the exported deck: no decoder) finds the clip
 * of this Change by it (`clipPlan.clipLookupKey`) and the clip time by `raw`.
 */
export interface FluximgSurfaceMotion {
  /** The Change (absent when only a movie drives the frame). */
  plan?: ViewTweenPlan;
  /** Linear progress of the Change, 0..1. */
  raw?: number;
  /** A running image movie (plan D7) overriding `index[movie.dim]` of this frame: its pure clock, so a host playing
   *  baked clips plays the movie's own clip natively from the same clock. */
  movie?: FluximgMovieClock;
  track?: string;
  durationMs?: number;
  /** `ResolvedCurve.key` of the track. */
  curve?: string;
  blend?: boolean;
}

/** Where an image movie stands (`mediaTimeline.playbackPlane` maps it to a plane), sampled at `at` (performance.now). */
export interface FluximgMovieClock {
  dim: string;
  mode: "loop" | "bounce" | "once";
  /** Planes `from` (inclusive) to `to` (exclusive), each `periodMs` long (speed applied). */
  from: number;
  to: number;
  periodMs: number;
  /** ms since Start, at `at`. */
  positionMs: number;
  /** True while the movie's clock runs (Start, not paused by Pause, the player or the document). */
  running: boolean;
  at: number;
}

export interface FluximgSlideHost {
  /** The image's manifest when it is already known (sync), else undefined; `need` loads it. */
  manifest(assetId: string): FluximgManifest | undefined;
  need(assetId: string): Promise<FluximgManifest>;
  /**
   * A still for a picture at an output size, as a data URL, when cached; otherwise undefined and it is rendered in
   * the background (`onChange` fires when it lands). Never allocates GPU.
   */
  still(assetId: string, picture: TweenPicture, outWidth: number, outHeight: number): string | undefined;
  /** A live surface over a canvas the binding owns. Up to `maxLive` surfaces draw on their own WebGL context, straight
   *  into their canvas; later ones share one offscreen renderer. A surface may REPLACE its canvas element (a canvas
   *  keeps the first kind of context it had): read `surface.canvas`. */
  surface(canvas: HTMLCanvasElement): FluximgSurface;
  /** How many surfaces may hold their own context at once. */
  readonly maxLive?: number;
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
  draw(assetId: string, frame: ViewTweenFrame, outWidth: number, outHeight: number, motion?: FluximgSurfaceMotion): boolean;
  /** The canvas the surface draws on now (the binding's, or the one that replaced it in the same place). */
  readonly canvas: HTMLCanvasElement;
  /** Make the surface's own GL context now, ahead of its first frame (idle time); a no-op when no slot is free. */
  prepare(): void;
  /** True once any frame has reached the canvas since the last `release`. A surface may hand the picture back to the
   *  still (false again): the binding then shows the still of the frame it asked for. */
  readonly shown: boolean;
  /** A surface that plays baked clips is told the clock of EVERY frame a Change drives it, even when the picture is the
   *  same as the last one (it keeps its decoder in step with the clock). Absent: draw only when the picture changes. */
  readonly clocked?: boolean;
  /** A clocked surface (baked clips) says whether it can play this running movie (its clip is in the payload). False:
   *  the movie cannot be shown (an export without the encoder), so the image stays the step's still and nothing runs
   *  for it. Absent: the surface draws every plane itself (the live host). */
  movie?(assetId: string, picture: TweenPicture, clock: FluximgMovieClock): boolean;
  /** True when the last frame passed to `draw()` is exactly on the canvas (it may land after `draw` returned false). */
  readonly exact: boolean;
  /** Capture: resolves when the last frame passed to `draw()` is exactly on the canvas. */
  settled(): Promise<void>;
  /** Give back GPU memory (offscreen or hidden): its context is lost at once, the canvas is emptied, and the next draw
   *  renders afresh. */
  release(keepContext?: boolean): void;
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
  /** Colour-map tables for the calibration bar and colour-by-number styles (absent: gray). */
  fluximgLut?: (name: string) => string[] | null;
  /** A layer's object table (styled layers only: `styleBy`): undefined while it loads (a miss starts loading it; the
   *  overlay holds the styled layer back until it lands, as the element at rest does), null when it cannot be read (the
   *  layer then draws unstyled). */
  fluximgTable?: (assetId: string, path: string) => FluximgTable | null | undefined;
}
