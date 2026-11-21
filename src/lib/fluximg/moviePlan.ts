/**
 * An image's movie as a file (stage 2, W10): what one image element, played along one dimension, writes as an MP4.
 *
 * Pure (twin-engine rule): flux-core plans and bakes the file with it, the board previews it (the facts in its readout,
 * the ghost on the rail) with it, and the gates check both against it. No DOM, no Node, no Svelte.
 *
 * The frames are the deck clips' frames, never a second definition of what a frame shows:
 *   - planes STEP (blend off): `clipPlan.planPlaybackClip`, one frame per plane at the plane rate (bounce: there and
 *     back, ending on the first plane again), exactly what a running movie on a slide plays;
 *   - planes BLEND: the Change a "Play through" with Blend planes writes (`viewTween.planViewTween` with `blend`, linear,
 *     at the data's pace) sampled by `clipPlan.planImageClip` on the 60 Hz clock (bounce: the walk back appended).
 *
 * The walk: `dim` (default: the element's playback dimension, else time, else depth, else the first walkable one),
 * planes `from` (inclusive) to `to` (exclusive; default: the playback's range on that dimension, else all of it), at
 * the data's own rate (a time axis in seconds plays in real time) else the playback's fps else 12 planes a second,
 * `fps` replacing that rate, times `speed`.
 *
 * Size: the cropped picture at the image's own pixels times `scale`; never smaller than the element's box at one pixel
 * per canvas px while it shows furniture, layer names or vectors (the furniture keeps the proportion to the picture it has
 * on the canvas, so the movie is the element as drawn and its words stay at least the size they are drawn at); the
 * longest side at most 2160; each side made even by one pixel of matte (never stretched).
 */
import type { FluximgManifest } from "./types";
import type { FluximgPlayback } from "./element";
import type { FluximgView, PixelRect, ResolvedView } from "./view";
import { walkableDims } from "./playback";
import { framePeriod } from "./live/rail";
import { clampCrop } from "./crop";
import { CLIP_TICK_HZ, clipTicks, planImageClip, planPlaybackClip, playbackRate, type ClipFrame, type ClipPlayback } from "./clipPlan";
import { planViewTween, type TweenPicture } from "./viewTween";

/** The longest side a movie file may have (4K UHD's height; PowerPoint and Keynote play it). */
export const MOVIE_MAX_SIDE = 2160;
/** The most frames one movie may have (the slide video's limit: 30 minutes at 60 fps). */
export const MOVIE_MAX_FRAMES = 108_000;
export const MOVIE_MODES = ["once", "bounce"] as const;
export type MovieMode = (typeof MOVIE_MODES)[number];

/** What a request may say (every field optional; the CLI flags map onto it). */
export interface MovieOptions {
  dim?: string;
  from?: number;
  to?: number;
  speed?: number;
  /** Planes a second (replaces the data's own rate; `speed` still applies). */
  fps?: number;
  mode?: MovieMode;
  blend?: boolean;
  scale?: number;
}

/** The element the movie is made of: its view and crop at the state exported, its box, its playback setting. */
export interface MovieSource {
  view?: FluximgView | null;
  crop?: PixelRect | null;
  /** The element's box in canvas px (the furniture is laid out in it). */
  width: number;
  height: number;
  playback?: Partial<FluximgPlayback> | null;
}

export interface MovieSettings {
  dim: string;
  /** Planes `from` (inclusive) to `to` (exclusive). */
  from: number;
  to: number;
  planes: number;
  mode: MovieMode;
  blend: boolean;
  speed: number;
  /** Planes a second, speed applied. */
  planeRate: number;
  /** One plane, in ms (speed applied). */
  periodMs: number;
  /** Movie pixels per image pixel, as applied (after the legibility floor and the size cap). */
  scale: number;
  /** The drawn picture's size, and the file's (each side even: the picture plus at most one pixel of matte). */
  picture: { width: number; height: number };
  width: number;
  height: number;
  /** The box the vectors and furniture are laid out in (the element's, at the picture's aspect). */
  box: { width: number; height: number };
  /** The requested scale was raised so the furniture stays legible, or lowered to the size cap. */
  raised: boolean;
  capped: boolean;
  crop: PixelRect;
}

/** A request that does not fit the image (the message says what would). */
export class MovieRequestError extends Error {
  constructor(message: string) { super(message); this.name = "MovieRequestError"; }
}

const dimLen = (m: FluximgManifest, d: string): number => { const i = m.pixels.dims.indexOf(d); return i >= 0 ? m.pixels.shape[i] : 0; };
const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The movie a request describes, checked against the image. `decorated`: the element shows furniture, names or
 * vector layers (the legibility floor applies).
 */
export function resolveMovie(m: FluximgManifest, src: MovieSource, o: MovieOptions = {}, decorated = true): MovieSettings {
  const dims = walkableDims(m);
  if (!dims.length) throw new MovieRequestError(`image "${m.name}" has one plane on every dimension: there is nothing to play`);
  const pb = src.playback ?? null;
  if (o.dim !== undefined && !dims.includes(o.dim)) throw new MovieRequestError(`dim "${o.dim}" is not a dimension this image can play (${dims.join(", ")})`);
  const dim = o.dim ?? (pb?.dim && dims.includes(pb.dim) ? pb.dim : dims[0]);
  const n = dimLen(m, dim);
  // The playback's range is the default only on the dimension it plays.
  const own = pb?.dim === dim;
  const whole = (v: unknown): boolean => Number.isInteger(v);
  let from = own && whole(pb!.from) && pb!.from! >= 0 && pb!.from! < n ? pb!.from! : 0;
  let to = own && whole(pb!.to) && pb!.to! > from && pb!.to! <= n ? pb!.to! : n;
  if (o.from !== undefined) {
    if (!whole(o.from) || o.from < 0 || o.from >= n) throw new MovieRequestError(`from must be a whole plane 0..${n - 1} of ${dim}`);
    from = o.from;
    if (o.to === undefined && to <= from) to = n;
  }
  if (o.to !== undefined) {
    if (!whole(o.to) || o.to <= from || o.to > n) throw new MovieRequestError(`to must be a whole plane after from (${from}), at most ${n} (exclusive)`);
    to = o.to;
  }
  if (o.speed !== undefined && !(pos(o.speed) && o.speed <= 16)) throw new MovieRequestError("speed is a multiple of the data's own rate, above 0 and at most 16");
  if (o.fps !== undefined && !(pos(o.fps) && o.fps <= 240)) throw new MovieRequestError("fps is planes a second, above 0 and at most 240");
  if (o.scale !== undefined && !(pos(o.scale) && o.scale <= 16)) throw new MovieRequestError("scale is movie pixels per image pixel, above 0 and at most 16");
  if (o.mode !== undefined && !MOVIE_MODES.includes(o.mode)) throw new MovieRequestError("mode is once or bounce");
  const speed = o.speed ?? 1;
  const period = framePeriod(m.axes?.[dim]);
  const baseRate = o.fps ?? (period ? 1 / period : own && pos(pb!.fps) ? pb!.fps! : 12);
  const planeRate = baseRate * speed, periodMs = 1000 / planeRate;

  const crop = clampCrop(m, src.crop);
  let bw = pos(src.width) ? src.width : crop.width, bh = pos(src.height) ? src.height : crop.height;
  // The furniture is laid out in a box of the picture's aspect (an element normally keeps it; one that does not would
  // stretch its words).
  if (Math.abs(bw / bh - crop.width / crop.height) > 0.01 * (crop.width / crop.height)) bh = (bw * crop.height) / crop.width;
  let scale = o.scale ?? 1, raised = false, capped = false;
  if (decorated && crop.width * scale < bw - 1e-6) { scale = bw / crop.width; raised = true; }
  const longest = Math.max(crop.width, crop.height) * scale;
  if (longest > MOVIE_MAX_SIDE) { scale = MOVIE_MAX_SIDE / Math.max(crop.width, crop.height); capped = true; raised = false; }
  const pw = Math.max(2, Math.round(crop.width * scale)), ph = Math.max(2, Math.round(crop.height * scale));
  const settings: MovieSettings = {
    dim, from, to, planes: to - from, mode: o.mode ?? "once", blend: !!o.blend, speed, planeRate, periodMs,
    scale, picture: { width: pw, height: ph }, width: pw + (pw % 2), height: ph + (ph % 2), box: { width: bw, height: bh }, raised, capped, crop,
  };
  const frames = movieSummary(settings).frames;
  if (frames > MOVIE_MAX_FRAMES) throw new MovieRequestError(`the movie would have ${frames.toLocaleString("en-US")} frames (at most ${MOVIE_MAX_FRAMES.toLocaleString("en-US")}): play fewer planes, faster (speed) or without blending`);
  return settings;
}

/** Frames, output rate and length of a movie, without planning its frames (the board's hover facts; the gate checks
 *  these against the plan). A blend between planes is continuous: it runs on the 60 Hz clock. */
export function movieSummary(s: MovieSettings): { frames: number; fps: number; durationMs: number } {
  const n = s.planes;
  if (s.blend && n > 1) {
    const ticks = clipTicks((n - 1) * s.periodMs), frames = s.mode === "bounce" ? 2 * ticks + 1 : ticks + 1;
    return { frames, fps: CLIP_TICK_HZ, durationMs: (frames * 1000) / CLIP_TICK_HZ };
  }
  const frames = s.mode === "bounce" && n > 1 ? 2 * n - 1 : n;
  return { frames, fps: s.planeRate, durationMs: frames * s.periodMs };
}

/** "412 frames · 34 s at 12 fps · 1024×768": what a movie would be, in the board's words (short: it is one line of the
 *  board's readout). */
export function movieFacts(s: MovieSettings): string {
  const { frames, fps, durationMs } = movieSummary(s);
  const secs = durationMs / 1000;
  const time = secs >= 100 ? `${Math.round(secs / 60)} min` : secs >= 10 ? `${Math.round(secs)} s` : `${Number(secs.toPrecision(2))} s`;
  const rate = fps >= 10 ? String(Math.round(fps * 10) / 10) : String(Number(fps.toPrecision(2)));
  return `${frames.toLocaleString("en-US")} frame${frames === 1 ? "" : "s"} · ${time} at ${rate} fps · ${s.width}×${s.height}`;
}

/** The planned frames of a movie, its encoder rate (an exact rational) and its length. `state` is the element's
 *  resolved picture (for stepped planes); `end` its stored view and crop (for a blend's Change). */
export function planMovieClip(m: FluximgManifest, state: TweenPicture, stored: { view?: FluximgView | null; crop?: PixelRect | null }, s: MovieSettings): { frames: ClipFrame[]; fps: number; rate: string; durationMs: number; distinct: number } {
  const { width: W, height: H } = s.picture;
  if (s.blend && s.planes > 1) {
    const at = (i: number) => ({ view: { ...(stored.view ?? {}), index: { ...(stored.view?.index ?? {}), [s.dim]: i } }, crop: stored.crop ?? null });
    const dur = (s.planes - 1) * s.periodMs, linear = (r: number) => r;
    const there = planImageClip(m, planViewTween(m, at(s.from), at(s.to - 1), { blend: true }), linear, dur, W, H);
    let frames = there.frames, fps = there.fps;
    if (s.mode === "bounce") {
      const back = planImageClip(m, planViewTween(m, at(s.to - 1), at(s.from), { blend: true }), linear, dur, W, H);
      // A linear walk and its reverse choose the same rate (the same ticks, mirrored); anything else is a planner bug.
      if (back.fps !== there.fps) throw new MovieRequestError("a blended bounce could not be planned on one clock");
      frames = frames.concat(back.frames.slice(1));
      fps = there.fps;
    }
    let distinct = 0;
    for (let i = 0; i < frames.length; i++) if (!i || frames[i].key !== frames[i - 1].key) distinct++;
    return { frames, fps, rate: String(fps), durationMs: (frames.length * 1000) / fps, distinct };
  }
  const p: ClipPlayback = { dim: s.dim, mode: s.mode === "bounce" ? "bounce" : "once", from: s.from, to: s.to, periodMs: s.periodMs, ...(s.mode === "bounce" ? { close: true } : {}) };
  const clip = planPlaybackClip(m, state, p, W, H);
  return { frames: clip.frames, fps: clip.fps, rate: playbackRate(s.periodMs), durationMs: clip.frames.length * s.periodMs, distinct: clip.distinct };
}

/** Whether anything is drawn over the pixels (furniture, layer names, vector or label layers): the legibility floor
 *  of `resolveMovie` applies. */
export function hasDecorationView(m: FluximgManifest, rv: ResolvedView): boolean {
  const f = rv.furniture;
  if (f.scalebar || f.stamp || f.channelLabels || f.colorbar || f.key || f.names) return true;
  return rv.layers.some((l) => l.visible && l.opacity > 0 && l.kind !== "intensity" && m.layers.some((x) => x.id === l.id));
}

/** A file name from an image's name: letters, digits, dash, underscore and dot; never empty. */
export function movieFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  return `${base || "image"}.mp4`;
}
