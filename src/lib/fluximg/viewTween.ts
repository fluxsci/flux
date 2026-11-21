/**
 * The tween of an image's view between two states of a slide (stage 2: fluximg in Slides).
 *
 * A placed image stores how it is shown as numbers (`view.ts`), so a slide step that changes any of them is a
 * Change like any other: `to.state` holds the end's `view` and `crop`, and this module says what every frame in
 * between shows. It is the ONE definition: the slide tween core (`slide/tween.ts`), the compiler, the player's
 * live surface, the export bakers and flux-core all call it. Pure: no DOM, no service, no Svelte, no Node.
 *
 * THE LAW (owner-approved plan, feature 10: "Time, depth, contrast, crop and layer opacity all animate. Planes
 * step; they are never blended unless you ask for a crossfade."):
 *   1. CONTINUOUS numbers lerp on the eased time `t`: each channel's black and white points (in log space when
 *      both ends use the log norm) and gamma, an intensity layer's window and opacity, a vector or label layer's
 *      opacity, stroke width and fill opacity, the crop rectangle (the frame: zoom and pan), furniture sizes.
 *      Colours lerp in OKLab (`color/interp.lerpColor`): a channel's ramp colour, a layer's colour, the background.
 *   2. PLANE POSITIONS STEP. `index[dim]` walks the whole planes from the start's to the end's, each shown for an
 *      equal share of the (eased) time; the end's own plane arrives exactly at the end. A projection's run ends
 *      (`from`, `to`) step the same way. Nothing is ever shown that is not a plane of the data, unless the track
 *      asks for a crossfade (`options.blend`): then the neighbouring plane is mixed in by the fractional position.
 *   3. SWITCHES FADE, they never pop. A layer or a furniture piece switched on or off is a fade of its opacity.
 *      A discrete PIXEL setting that differs between the ends (a channel shown or hidden, a colour map swapped for
 *      another, the norm kind, invert, composite/solo, a projection switched on, off or to another mode or
 *      dimension, an intensity layer's colour map) makes TWO pictures of each frame: the same moment drawn with
 *      the start's settings and with the end's, mixed by `t`. Everything continuous is the same in both.
 *   4. EXACT ENDS: at `raw <= 0` the frame is exactly the start, at `raw >= 1` exactly the end (so the last frame
 *      of a tween is the element's own still, and nothing pops when the player hands over).
 *   5. Absent means default: both ends are completed from the manifest (`viewOps.resolveView`; an absent crop is
 *      the whole image) before anything is compared, so "as placed" glides to an explicit value.
 *   6. What does not animate steps at `raw` 0.5: `smooth`, the layer order, a furniture piece's corner, `insetOf`,
 *      `link`.
 *
 * Callers pass the eased `t` (which may overshoot 0..1 on a spring: clamp where a value has hard bounds) and the
 * linear progress `raw` (0..1), exactly as the slide engine's `MorphController.seek(u, raw)` receives them.
 */
import type { CropRect } from "../types";
import type { FluximgManifest } from "./types";
import type { FluximgView, PixelRect, ResolvedFurniture, ResolvedView } from "./view";

/** One end of a Change: what the element stores at that state. */
export interface ViewEnd {
  view?: FluximgView | null;
  /** Level-0 image pixels; absent = the whole image. */
  crop?: CropRect | null;
}

/** One picture: a resolved view over a concrete frame (never absent: the whole image when the element has no crop). */
export interface TweenPicture {
  view: ResolvedView;
  crop: PixelRect;
}

export interface TweenOptions {
  /** Crossfade neighbouring planes instead of stepping them (law 2). Default false. */
  blend?: boolean;
}

/** What one frame of the tween shows. */
export interface ViewTweenFrame {
  /** The picture: continuous values lerped, plane positions stepped, discrete pixel settings as at the START. */
  a: TweenPicture;
  /** Law 3: the same moment with the END's discrete pixel settings, while they differ; otherwise null. */
  b: TweenPicture | null;
  /** Weight of `b` over `a`, 0..1 (0 when `b` is null). */
  mix: number;
  /**
   * Law 2 with `options.blend`: the neighbouring plane to mix over the picture(s), i.e. `a` (and `b`) drawn with
   * `index[dim] = other` (or, for a stepping projection run, with that run end), at `weight` 0..1. Null when
   * planes step or the position is whole.
   */
  blend: { dim: string; other: number; weight: number } | null;
  /** What the vector and label layers, the names and the furniture draw: ONE resolved view over the frame's crop. */
  overlay: TweenPicture;
  /** Law 3 for furniture: the opacity (0..1) of each piece that is fading in or out; absent = 1. */
  furnitureOpacity: Partial<Record<keyof ResolvedFurniture, number>>;
}

/** A tween between two ends, prepared once (both ends resolved and compared). */
export interface ViewTweenPlan {
  /** False when both ends draw the same pixels: the surface need not be redrawn per frame. */
  readonly pixels: boolean;
  /** False when the vector layers, the names and the furniture do not change. */
  readonly overlay: boolean;
  /** True when some frame needs two pictures (law 3). */
  readonly twoPictures: boolean;
  /** The start and the end, resolved (what `frame` returns at raw 0 and raw 1). */
  readonly start: TweenPicture;
  readonly end: TweenPicture;
  /** The frame at eased time `t` and linear progress `raw`. */
  frame(t: number, raw: number): ViewTweenFrame;
  /**
   * The distinct pictures (as `frame(...).a`, plus `b` and blend neighbours where they apply) the tween shows
   * while linear progress goes from `rawFrom` to `rawTo` (either direction), in order of first use, for decoding
   * ahead. `ease` maps raw to the eased time as the track's curve does. At most `limit` entries (default 64).
   */
  upcoming(rawFrom: number, rawTo: number, ease: (raw: number) => number, limit?: number): TweenPicture[];
}

/** One thing a Change does to an image, in words (the animator's chips, diagnostics, agents). */
export interface ViewChange {
  kind: "position" | "projection" | "window" | "colour" | "channel" | "frame" | "layer" | "furniture" | "other";
  /** The dimension walked (kind "position" / "projection"). */
  dim?: string;
  /** Plane indices at the start and the end (kind "position"). */
  from?: number;
  to?: number;
  /** A short phrase: "t 0 → 400", "channel 1 contrast", "zooms in", "footprints fade in". */
  label: string;
}

/** Prepare the tween between two ends of one image. */
export function planViewTween(manifest: FluximgManifest, pre: ViewEnd, end: ViewEnd, options?: TweenOptions): ViewTweenPlan {
  void manifest; void pre; void end; void options;
  throw new Error("fluximg/viewTween.planViewTween: not implemented yet (stage 2, work package W1a)");
}

/**
 * The same tween as a sparse RECIPE, for callers that hold no manifest (`slide/tween.lerpElement`, and through it
 * `compile.sample`). Numbers present at both ends lerp, plane positions present at both ends step by law 2,
 * colours present at both ends lerp, everything else steps at `raw` 0.5. Exact ends (law 4). Returns undefined
 * for "no view" (the default view).
 */
export function lerpFluximgView(a: FluximgView | null | undefined, b: FluximgView | null | undefined, t: number, raw: number): FluximgView | undefined {
  void t;
  const v = raw < 0.5 ? a : b;
  return v ? structuredClone(v) : undefined;
}

/** What a Change does to an image, as a short list of phrases, most telling first. Empty when nothing changes. */
export function describeViewChange(manifest: FluximgManifest | undefined, pre: ViewEnd, end: ViewEnd): ViewChange[] {
  void manifest; void pre; void end;
  return [];
}

/**
 * How long a walk from plane `from` to plane `to` along `dim` takes at the data's own pace, in milliseconds:
 * real time for a time axis (its frame period), 12 planes a second otherwise; divided by `speed`.
 */
export function naturalDurationMs(manifest: FluximgManifest, dim: string, from: number, to: number, speed = 1): number {
  void manifest; void dim;
  return (Math.abs(to - from) / 12) * 1000 / (speed > 0 ? speed : 1);
}
