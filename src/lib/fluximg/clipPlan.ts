/**
 * What a baked image clip IS (stage 2, W7): the frames an exported deck plays for a Change that moves an image's pixels.
 *
 * Pure (twin-engine rule): flux-core bakes clips with it in Node, the exported player looks them up with it, and the
 * gates check both against it. No DOM, no Node, no Svelte.
 *
 * A clip is the tween `viewTween.planViewTween` defines, sampled on the slide's own clock:
 *   - clip time τ (seconds from the Change's first frame) ↔ the track's linear progress raw = τ / duration;
 *   - frame k sits at τ = k / fps, shows `plan.frame(ease(raw), raw)` with `ease` the track's resolved curve (the
 *     unclamped `ResolvedCurve.fn`, exactly what the player hands the Change's driver; viewTween clamps where a value
 *     has bounds), and is drawn by the reference renderer (`still.renderStill`, one picture at a time) and MIXED the
 *     way the W2 gate's CPU reference and the GL surface mix: `a` and `b` by a straight per-component lerp at `mix`,
 *     then the blend neighbour(s) the same way at the blend weight (`frameLayers`, `mixRgba`);
 *   - the last frame is the end picture (raw = 1): the element's own still (viewTween law 4);
 *   - RATE: 60 fps, unless a lower rate that divides 60 shows, at every 1/60 s tick, exactly the picture the 60 fps
 *     clip shows there (the lowest such rate wins). A walk of 20 planes in 2 s with a linear curve bakes at 10 fps;
 *     anything continuous (contrast, a zoom, a fade that changes pixels, an eased walk) needs 60. So every plane is
 *     shown for exactly its share of the time, at the 60 Hz granularity a 60 fps clip has.
 *   - Consecutive frames with the same picture are repeats: rendered once, encoded again.
 *
 * Later (media playback, plan D7): a playback clip is another `kind` of request with the same frame machinery; the
 * key already names its kind.
 */
import type { FluximgManifest } from "./types";
import type { ViewEnd, ViewTweenFrame, ViewTweenPlan, TweenPicture } from "./viewTween";
import type { FluximgView, ResolvedView } from "./view";
import { pixelKey } from "./viewOps";

/** The clip rates a baker may choose: the divisors of 60, lowest first. */
export const CLIP_RATES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] as const;
export const CLIP_TICK_HZ = 60;
/** Bumped when what a clip's frames ARE changes (renderer law, mixing, rate rule, matte): old cache entries miss. */
export const IMAGE_CLIP_FORMAT = 1;

/** One baked clip as the payload carries it. */
export interface ImageClip {
  /** `data:video/mp4;base64,…` in portable exports, a `file:` URL in a capture document. */
  url: string;
  fps: number;
  frames: number;
  /** The Change's duration (the clip itself lasts `frames / fps`, its last frame being the end picture). */
  durationMs: number;
  width: number;
  height: number;
  /** A movie clip (loop and bounce play with the decoder's own loop). */
  loop?: boolean;
}

/** A running movie's setting as a clip needs it (`playback.resolvePlayback`, speed applied to `periodMs`). */
export interface ClipPlayback { dim: string; mode: "loop" | "bounce" | "once"; from: number; to: number; periodMs: number;
  /** Bounce only: end back ON the first plane (a movie file plays there and back once; a looped clip must not, or the
   *  first plane would show twice at every turn). */
  close?: boolean }

/** What one running movie asks of a baker: ONE pass of its range at its rate, drawn with the picture the image has
 *  while it runs (`state`: its view and crop at the step; only `index[dim]` walks). Loop: the pass, looped natively;
 *  bounce: there and back (the end planes once), looped natively; once: the pass, its last frame held. */
export interface ImagePlaybackRequest {
  kind: "playback";
  assetId: string;
  contentId: string;
  state: ViewEnd;
  playback: ClipPlayback;
  width: number;
  height: number;
  matte: string;
  lookup: string;
}

/** What one Change asks of a baker (everything its pixels depend on; `key` names it in caches). */
export interface ImageClipRequest {
  kind: "change";
  assetId: string;
  /** The bundle's content id (asset.sha256, else its id): a re-imported bundle is a new clip. */
  contentId: string;
  pre: ViewEnd;
  end: ViewEnd;
  blend: boolean;
  /** `ResolvedCurve.key` of the track: the curve whose `fn` is baked in. */
  curve: string;
  durationMs: number;
  /** Pixel size of the clip (even: H.264 4:2:0 needs it). */
  width: number;
  height: number;
  /** The colour transparent pixels are composited over (the slide's background): MP4 has no alpha. */
  matte: string;
  /** The lookup key the exported player finds this clip by (`clipLookupKey`). */
  lookup: string;
}

/** A frame of a clip: its picture recipe, its key (identical keys = the same pixels) and its linear progress. */
export interface ClipFrame { raw: number; frame: ViewTweenFrame; key: string }

export interface ImageClipPlan {
  fps: number;
  frames: ClipFrame[];
  /** Distinct consecutive pictures (what a baker renders). */
  distinct: number;
}

/** The pixel size of a clip from the still's size: each side made even by drawing ONE pixel more (scaled, never padded:
 *  a padded column would be stretched into the element's box). */
export function evenClipSize(width: number, height: number): { width: number; height: number } {
  const even = (n: number) => { const r = Math.max(2, Math.round(n)); return r % 2 ? r + 1 : r; };
  return { width: even(width), height: even(height) };
}

const pictureKeys = new WeakMap<TweenPicture, string>();
function picKey(manifest: FluximgManifest, p: TweenPicture, w: number, h: number): string {
  let k = pictureKeys.get(p);
  if (k === undefined) { k = pixelKey(manifest, p.view, p.crop, w, h); pictureKeys.set(p, k); }
  return k;
}
/** The identity of a frame's pixels at a size: the same rule the live binding uses (player/fluximg.ts frameKey). */
export function clipFrameKey(manifest: FluximgManifest, f: ViewTweenFrame, w: number, h: number): string {
  const b = f.b && f.mix > 0 ? picKey(manifest, f.b, w, h) : "";
  const bl = f.blend && f.blend.weight > 0 ? `${f.blend.dim}:${f.blend.other}:${f.blend.end ?? ""}:${f.blend.weight}` : "";
  return `${picKey(manifest, f.a, w, h)}#${b}#${b ? f.mix : 0}#${bl}`;
}

/** The ticks (1/60 s) a Change of `durationMs` spans, the last one at its end. */
export function clipTicks(durationMs: number): number {
  return Math.max(1, Math.ceil((Math.max(0, durationMs) * CLIP_TICK_HZ) / 1000 - 1e-9));
}

/**
 * The frames of the clip of `plan` over `durationMs` with curve `ease` at `width` x `height`. See the header for the
 * rate rule. A Change that moves no pixels has no clip (callers check `plan.pixels`).
 */
export function planImageClip(manifest: FluximgManifest, plan: ViewTweenPlan, ease: (raw: number) => number, durationMs: number, width: number, height: number): ImageClipPlan {
  const n = clipTicks(durationMs), dur = Math.max(1e-9, durationMs);
  const at = (tick: number): ClipFrame => {
    const raw = Math.min(1, Math.max(0, (tick * 1000) / CLIP_TICK_HZ / dur));
    const frame = plan.frame(ease(raw), raw);
    return { raw, frame, key: clipFrameKey(manifest, frame, width, height) };
  };
  const ticks: ClipFrame[] = [];
  for (let j = 0; j <= n; j++) ticks.push(at(j));
  let fps: number = CLIP_TICK_HZ;
  for (const r of CLIP_RATES) {
    const s = CLIP_TICK_HZ / r;
    let ok = true;
    for (let j = 0; j <= n && ok; j++) ok = ticks[j].key === ticks[Math.floor(j / s) * s].key;
    if (ok) { fps = r; break; }
  }
  const step = CLIP_TICK_HZ / fps, frames: ClipFrame[] = [];
  for (let j = 0; j <= n; j += step) frames.push(ticks[j]);
  // The last tick (the end picture) is a frame of its own when the rate's grid does not land on it.
  if ((n % step) !== 0) frames.push(ticks[n]);
  let distinct = 0;
  for (let i = 0; i < frames.length; i++) if (!i || frames[i].key !== frames[i - 1].key) distinct++;
  return { fps, frames, distinct };
}

/** The plane sequence of a movie clip: loop and once = the range; bounce = there and back, the end planes once. */
export function playbackPlanes(p: ClipPlayback): number[] {
  const n = Math.max(1, p.to - p.from), out: number[] = [];
  for (let k = 0; k < n; k++) out.push(p.from + k);
  if (p.mode === "bounce") for (let k = n - 2; k >= 1; k--) out.push(p.from + k);
  if (p.mode === "bounce" && p.close && n > 1) out.push(p.from);
  return out;
}

/** The frames of a movie clip: one per plane of `playbackPlanes`, the state's picture at that plane, at the movie's
 *  own rate (one frame per plane period). */
export function planPlaybackClip(manifest: FluximgManifest, state: TweenPicture, p: ClipPlayback, width: number, height: number): ImageClipPlan & { planes: number[] } {
  const planes = playbackPlanes(p), frames: ClipFrame[] = [];
  for (const i of planes) {
    const pic: TweenPicture = { view: { ...state.view, index: { ...state.view.index, [p.dim]: i } }, crop: state.crop };
    const frame: ViewTweenFrame = { a: pic, b: null, mix: 0, blend: null, overlay: pic, furnitureOpacity: {} };
    frames.push({ raw: 0, frame, key: clipFrameKey(manifest, frame, width, height) });
  }
  let distinct = 0;
  for (let i = 0; i < frames.length; i++) if (!i || frames[i].key !== frames[i - 1].key) distinct++;
  return { fps: 1000 / p.periodMs, frames, distinct, planes };
}

/** The encoder's frame rate of a movie clip as an exact rational (one frame per plane period, microsecond grid). */
export const playbackRate = (periodMs: number): string => `1000000/${Math.max(1, Math.round(periodMs * 1000))}`;

/** Clip time (seconds, mid-frame) of a movie `positionMs` after its Start: the same planes `mediaTimeline.playbackPlane`
 *  gives, as positions in the clip (loop: modulo the pass; bounce: modulo there-and-back; once: clamped to the last). */
export function playbackClipTime(positionMs: number, p: ClipPlayback): number {
  const n = Math.max(1, p.to - p.from), k = Math.floor(Math.max(0, positionMs) / p.periodMs + 1e-9);
  const frames = p.mode === "bounce" ? Math.max(1, 2 * (n - 1)) : n;
  const i = p.mode === "once" ? Math.min(n - 1, k) : k % frames;
  return ((i + 0.5) * p.periodMs) / 1000;
}

/** How the exported player finds a running movie's clip: the asset, the picture it runs with (its index on the movie's
 *  dimension set to the range start), and the movie's setting. */
export function playbackLookupKey(manifest: FluximgManifest, assetId: string, picture: TweenPicture, p: ClipPlayback): string {
  const at = { ...picture.view, index: { ...picture.view.index, [p.dim]: p.from } };
  return `fxp-${shortHash(`${assetId}|${pixelKey(manifest, at, picture.crop, 0, 0)}|${p.dim}|${p.mode}|${p.from}|${p.to}|${Math.round(p.periodMs * 1000)}`)}`;
}

/** Clip time (seconds) of the frame the clock shows at linear progress `raw` (the middle of that frame's interval, so a
 *  decoder seek never lands on the frame before it). */
export function clipSeekTime(raw: number, durationMs: number, fps: number, frames: number): number {
  const k = Math.min(frames - 1, Math.max(0, Math.floor((Math.min(1, Math.max(0, raw)) * durationMs / 1000) * fps + 1e-6)));
  return (k + 0.5) / fps;
}

/** The picture `p` drawn at the blend neighbour's position along `dim` (viewTween's `ViewTweenFrame.blend`): the same
 *  rule as the GL surface (`slideSurfaces.neighbourPicture`). */
export function blendNeighbour(p: TweenPicture, blend: { dim: string; other: number; end?: "from" | "to" }): TweenPicture {
  const pr = p.view.projection;
  if (pr && pr.dim === blend.dim && blend.end) return { crop: p.crop, view: { ...p.view, projection: { ...pr, [blend.end]: blend.other } } };
  return { crop: p.crop, view: { ...p.view, index: { ...p.view.index, [blend.dim]: blend.other } } };
}

/** A resolved picture as the stored view `still.renderStill` takes (it resolves it again to the same values). The same
 *  conversion as the GL host's `slideSurfaces.pictureView` (kept here so Node never imports the GL module; the export
 *  gate checks the two agree). */
export function tweenPictureView(rv: ResolvedView): FluximgView {
  const layers: NonNullable<FluximgView["layers"]> = {};
  for (const l of rv.layers) layers[l.id] = { visible: l.visible, opacity: l.opacity, color: l.color, lut: l.lut, strokeWidth: l.strokeWidth, fillOpacity: l.fillOpacity, ...(l.range ? { range: [l.range[0], l.range[1]] as [number, number] } : {}) };
  return {
    index: { ...rv.index },
    projection: rv.projection ? { ...rv.projection } : null,
    channels: rv.channels.map((c) => ({ visible: c.visible, color: c.color, lut: c.lut, range: [c.range[0], c.range[1]] as [number, number], norm: c.norm, gamma: c.gamma, invert: c.invert })),
    composite: rv.composite, solo: rv.solo, smooth: rv.smooth, background: rv.background,
    layers, layerOrder: rv.layers.map((l) => l.id),
  };
}

/** A frame as pictures and weights: `here = a ⊕ b@mix`, `there` = the same at the blend neighbour, `out = here ⊕ there@weight`. */
export interface FrameLayers { a: TweenPicture; b: TweenPicture | null; mix: number; there: { a: TweenPicture; b: TweenPicture | null } | null; weight: number }
export function frameLayers(f: ViewTweenFrame): FrameLayers {
  const mix = f.b ? Math.min(1, Math.max(0, f.mix)) : 0, b = f.b && mix > 0 ? f.b : null;
  const weight = f.blend ? Math.min(1, Math.max(0, f.blend.weight)) : 0;
  const there = f.blend && weight > 0 ? { a: blendNeighbour(f.a, f.blend), b: b ? blendNeighbour(b, f.blend) : null } : null;
  return { a: f.a, b, mix, there, weight };
}

/** The reference meaning of a mix: per component `round((1 - w)·x + w·y)` (the W2 gate's CPU reference). */
export function mixRgba(x: Uint8ClampedArray, y: Uint8ClampedArray, w: number): Uint8ClampedArray {
  const o = new Uint8ClampedArray(x.length);
  for (let i = 0; i < x.length; i++) o[i] = Math.round(x[i] * (1 - w) + y[i] * w);
  return o;
}

/** Composite straight-alpha pixels over an opaque colour (in place, alpha becomes 255). */
export function matteRgba(rgba: Uint8ClampedArray, hex: string): Uint8ClampedArray {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0, mr = (v >> 16) & 255, mg = (v >> 8) & 255, mb = v & 255;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    rgba[i] = Math.round(rgba[i] * k + mr * (1 - k)); rgba[i + 1] = Math.round(rgba[i + 1] * k + mg * (1 - k)); rgba[i + 2] = Math.round(rgba[i + 2] * k + mb * (1 - k)); rgba[i + 3] = 255;
  }
  return rgba;
}

/** A short stable hash (FNV-1a, 52 bits as hex) for keys that end up in file names and payload keys. */
export function shortHash(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}

/**
 * How the exported player finds the clip of the Change it is playing: from what the live binding knows at a frame
 * (the asset, the plan's two resolved ends, the track's id, duration, curve and blend). Two Changes with the same key
 * draw the same frames.
 */
export function clipLookupKey(manifest: FluximgManifest, assetId: string, plan: Pick<ViewTweenPlan, "start" | "end">, motion: { track?: string; durationMs?: number; curve?: string; blend?: boolean }): string {
  const ends = `${pixelKey(manifest, plan.start.view, plan.start.crop, 0, 0)}>${pixelKey(manifest, plan.end.view, plan.end.crop, 0, 0)}`;
  return `fxc-${shortHash(`${assetId}|${motion.track ?? ""}|${ends}|${motion.blend ? 1 : 0}|${motion.durationMs ?? 0}|${motion.curve ?? ""}`)}`;
}

/** The cache identity of a baked clip: everything its bytes depend on, plus the encoder and its settings. */
export function imageClipCacheKey(request: ImageClipRequest | ImagePlaybackRequest, fps: number, frames: number, encoder: string, settings: string): string {
  const what = request.kind === "playback" ? [request.state, request.playback] : [request.pre, request.end, request.blend, request.curve, request.durationMs];
  return `fxc-${shortHash(JSON.stringify([IMAGE_CLIP_FORMAT, request.kind, request.contentId, ...what, fps, frames, request.width, request.height, request.matte, encoder, settings]))}`;
}
