/**
 * The exported player's image host (stage 2, W7; plan D8): W2's `FluximgSlideHost` contract with NO decoder. The
 * mirror of `model3dPayloadHost.ts` for images. An exported or captured document cannot run the image decoder (its
 * CSP has no workers, no WASM, no fetch), so:
 *   - `manifest()`, layer texts, tables and colour tables come from the payload (`payload.images`);
 *   - `still()` is the payload's still of a picture (every evaluated step state was rendered at export);
 *   - a surface plays the Change's baked CLIP (`payload.imageClips`, `fluximg/clipPlan.ts`) in a `<video>` placed where
 *     the live canvas would be: native playback at rate 1 from the Change's first presented frame, re-synced when it
 *     drifts more than a frame and a half (of the 60 Hz clock) from the player's clock, seeked when the clock is seeked,
 *     scrubbed or reversed (animated Back), paused when the clock stops, and handed back to the END STILL at the end
 *     (the last frame of a tween is the element's own still: viewTween law 4). Until the video has presented the
 *     frame asked for, the still under it stays (never a blank between still, clip and still).
 * Overlays (vector and label layers, names, furniture, styled objects, the key) are not baked: the player's own
 * overlay draws them from the payload exactly as in the app.
 *
 * Without images in the payload `payloadImageContext` returns `{}`: a deck without images builds nothing here.
 */
import type { FluximgMovieClock, FluximgSlideContext, FluximgSlideHost, FluximgSurface, FluximgSurfaceMotion } from "../../fluximg/slideHost";
import type { FluximgManifest } from "../../fluximg/types";
import type { TweenPicture, ViewTweenFrame } from "../../fluximg/viewTween";
import { pixelKey } from "../../fluximg/viewOps";
import { clipLookupKey, clipSeekTime, playbackClipTime, playbackLookupKey, type ImageClip } from "../../fluximg/clipPlan";
import { IMAGE_STILL_PREFIX, lutOf } from "../imageExport";
import type { ExportPayload } from "./runtime";

/** Re-sync a playing clip when it is further than this from the clock (1.5 frames of the 60 Hz clock). */
const DRIFT_S = 1.5 / 60;
/** After a re-sync the decoder needs a moment: no second re-sync within this time. */
const RESYNC_COOLDOWN_MS = 250;
/** Frames further apart than this are not one running clock (a rAF cadence is 16.7 ms; a dropped frame or two pass). */
const RUN_GAP_MS = 60;
/** No frame from the player for this long: its clock stopped (paused, at rest mid-Change), so the video pauses. */
const STALL_MS = 120;

/** How often (ms) a natively playing movie clip is compared with the slide's clock (a timer, never an animation frame). */
const DRIFT_CHECK_MS = 2000;
/** Re-sync a natively playing movie clip past this drift (s) from the slide's clock: half a plane (the picture stays within
 *  half a plane of the clock and of a stamp naming it), at least two display frames, at most 100 ms. Measured (review
 *  C7): a natively looped clip in headless Chrome loses ~3 ms per loop seam (88 ms over 30 loops of a 1 s clip), so a
 *  10-plane-a-second movie re-syncs (one seek: one frame's hitch) about once in 16 s, and never before. */
const movieDriftS = (c: FluximgMovieClock): number => Math.max(2 / 60, Math.min(0.1, c.periodMs / 2000));
/** The clip time (s) of a running movie `positionMs` after its Start: the clip is one frame per plane at the movie's
 *  period (loop: the pass; bounce: there and back, end planes once; once: the pass, its last frame held), so the clip
 *  runs at the movie's own rate and its time is the clock's, wrapped. */
function movieSpan(c: FluximgMovieClock): number {
  const n = Math.max(1, c.to - c.from);
  return ((c.mode === "bounce" ? Math.max(1, 2 * (n - 1)) : n) * c.periodMs) / 1000;
}
function movieClipTime(positionMs: number, c: FluximgMovieClock): number {
  const t = Math.max(0, positionMs) / 1000, span = movieSpan(c);
  return c.mode === "once" ? Math.min(t, span - c.periodMs / 2000) : t % span;
}

/** A still's key without its output size (`out=WxH`) or the size-dependent `smooth` flag: a picture's identity. */
const sizeless = (key: string): string => key.replace(/;out=\d+x\d+/, "").replace(/;smooth(?=;|$)/, "");

interface StillEntry { ref: string; width: number; height: number }

export interface PayloadImageHost extends FluximgSlideHost {
  /** Gates: what the surfaces are doing. */
  stats(): { surfaces: number; videos: number; seeks: number; resyncs: number; plays: number; drift: number };
}

export function payloadImageHost(payload: ExportPayload, options: { capture?: boolean } = {}): PayloadImageHost | undefined {
  const images = payload.images;
  if (!images || !Object.keys(images).length) return undefined;
  // Every still by (asset, picture), whatever size it was drawn at.
  const stills = new Map<string, StillEntry[]>();
  for (const [ref] of Object.entries(payload.assets ?? {})) {
    if (!ref.startsWith(IMAGE_STILL_PREFIX)) continue;
    const key = ref.slice(IMAGE_STILL_PREFIX.length), out = /;out=(\d+)x(\d+)/.exec(key);
    const id = sizeless(key), list = stills.get(id) ?? [];
    list.push({ ref, width: out ? +out[1] : 0, height: out ? +out[2] : 0 });
    stills.set(id, list);
  }
  const stillRef = (assetId: string, p: TweenPicture, w: number, h: number): string | undefined => {
    const m = images[assetId]?.manifest;
    if (!m) return undefined;
    const list = stills.get(sizeless(`${assetId}|${pixelKey(m, p.view, p.crop, w, h)}`));
    if (!list?.length) return undefined;
    let best = list[0];
    for (const e of list) if (Math.abs(e.width - w) + Math.abs(e.height - h) < Math.abs(best.width - w) + Math.abs(best.height - h)) best = e;
    return best.ref;
  };
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of [...listeners]) l(); };
  const decoded = new Map<string, Promise<void>>();
  const decode = (url: string): Promise<void> => {
    let p = decoded.get(url);
    if (!p) { const img = new Image(); img.src = url; p = img.decode().catch(() => undefined); decoded.set(url, p); }
    return p;
  };
  // Clips become blob URLs once (a data URL re-parsed per video element would be held twice).
  const blobs = new Map<string, string>();
  const clipUrl = (clip: ImageClip): string => {
    if (!clip.url.startsWith("data:")) return clip.url;
    let url = blobs.get(clip.url);
    if (!url) {
      const comma = clip.url.indexOf(","), bin = atob(clip.url.slice(comma + 1)), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      blobs.set(clip.url, url);
    }
    return url;
  };
  const counters = { seeks: 0, resyncs: 0, plays: 0, drift: 0 };
  const surfaces = new Set<ClipSurface>();
  let disposed = false;

  class ClipSurface implements FluximgSurface {
    readonly clocked = true;
    shown = false;
    exact = true;
    private video: HTMLVideoElement | null = null;
    private clip: ImageClip | null = null;
    private src = "";
    private target = 0;
    private wantVisible = false;
    private presented = false;
    private lastDraw = 0;
    private lastRaw = -1;
    private resyncAt = 0;
    private stall: ReturnType<typeof setTimeout> | undefined;
    private waiters: Array<() => void> = [];
    constructor(readonly canvas: HTMLCanvasElement) { surfaces.add(this); }
    /** No GL context to make: a clip surface is a <video> and the canvas stays empty. */
    prepare(): void {}

    private ensureVideo(): HTMLVideoElement {
      if (this.video) return this.video;
      const v = document.createElement("video");
      v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = "auto"; v.controls = false; v.disableRemotePlayback = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.dataset.slideFluximgClip = this.canvas.dataset.slideFluximg ?? "";
      v.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;display:none;pointer-events:none";
      const landed = () => this.landed();
      v.addEventListener("seeked", landed); v.addEventListener("playing", landed); v.addEventListener("loadeddata", landed);
      this.canvas.after(v);
      this.video = v;
      return v;
    }
    /** The decoder has a frame for where we asked: show it (from its first presented frame). */
    private landed(): void {
      const v = this.video;
      if (!v || disposed || v.readyState < 2 || v.seeking) return;
      const fresh = !this.presented;
      this.presented = true;
      this.exact = v.paused ? Math.abs(v.currentTime - this.target) < 0.5 / (this.clip?.fps ?? 60) + 1e-3 : true;
      if (this.exact) { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
      // The binding learns that the clip can be shown now (it waits for `shown` before hiding the still).
      if (fresh && this.wantVisible && !this.shown) emit();
    }
    private hide(): void {
      this.wantVisible = false;
      if (this.video) { if (!this.video.paused) this.video.pause(); if (this.video.style.display !== "none") this.video.style.display = "none"; }
      this.shown = false;
    }
    private seekTo(t: number): void {
      const v = this.video!;
      this.target = t;
      if (Math.abs(v.currentTime - t) < 1e-4 && !v.seeking) return;
      v.currentTime = t; counters.seeks++;
      this.presented = false; this.exact = false;
    }

    draw(assetId: string, frame: ViewTweenFrame, _w: number, _h: number, motion?: FluximgSurfaceMotion): boolean {
      clearTimeout(this.stall);
      // A running image movie takes precedence: its own clip, on its own clock (a Change under it moves the box only).
      if (motion?.movie) return this.drawMovie(assetId, frame, motion.movie);
      this.movieKey = ""; this.unwatch();
      const now = performance.now();
      const raw = motion?.raw, clip = motion?.plan && raw !== undefined ? this.clipFor(assetId, motion) : null;
      if (!clip || raw === undefined || !(raw > 0 && raw < 1)) {
        // At rest, before the Change starts, at its end or without a clip: the still is the picture (D5, law 4). A clip
        // that waits at its first frame stays loaded (the next draw plays it without a fetch).
        if (clip && raw !== undefined && raw <= 0) { this.load(clip); this.seekTo(clipSeekTime(0, clip.durationMs, clip.fps, clip.frames)); }
        this.hide(); this.exact = true; this.lastRaw = -1;
        { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
        return true;
      }
      const v = this.load(clip);
      const tau = (raw * clip.durationMs) / 1000;
      // The clock RUNS (play, at rate ~1) when consecutive frames come at frame cadence and advance the Change by about the
      // wall time between them; anything else is a seek: a scripted seek, a jump, a reversed or warped clock, a capture.
      const dWall = now - this.lastDraw, dClip = (raw - this.lastRaw) * clip.durationMs;
      const forward = !options.capture && this.lastRaw >= 0 && dWall > 0 && dWall < RUN_GAP_MS && dClip > 0 && dClip / dWall > 0.5 && dClip / dWall < 2;
      this.lastRaw = raw; this.lastDraw = now;
      if (forward) {
        // Native playback at rate 1, in step with the clock.
        if (v.paused) { this.seekTo(tau); v.play().catch(() => undefined); counters.plays++; }
        else if (Math.abs(v.currentTime - tau) > DRIFT_S && now - this.resyncAt > RESYNC_COOLDOWN_MS) { this.resyncAt = now; this.seekTo(tau); counters.resyncs++; }
        else this.target = v.currentTime;
        // The clock stopped (pause, rest mid-Change): so does the video, exactly where the clock is.
        this.stall = setTimeout(() => { if (this.video && !this.video.paused) { this.video.pause(); this.seekTo(clipSeekTime(this.lastRaw, clip.durationMs, clip.fps, clip.frames)); } }, STALL_MS);
      } else {
        // A seek, a scrub, a reversed clock or a capture frame: the decoder shows exactly the frame of this time.
        if (!v.paused) v.pause();
        this.seekTo(clipSeekTime(raw, clip.durationMs, clip.fps, clip.frames));
      }
      return this.reveal(v);
    }
    /** Show the video once it presents what was asked (until then the still under it stays: D4, never blank). */
    private reveal(v: HTMLVideoElement): boolean {
      this.wantVisible = true;
      if (this.presented && v.readyState >= 2) {
        if (v.style.display !== "block") v.style.display = "block";
        this.shown = true;
      }
      return this.shown && this.exact;
    }
    private movieKey = "";
    /** The running movie this surface plays natively, for the low-rate drift check (no animation frames: C7). */
    private running: { clock: FluximgMovieClock; clip: ImageClip } | null = null;
    private driftTimer: ReturnType<typeof setInterval> | undefined;
    movie(assetId: string, picture: TweenPicture, clock: FluximgMovieClock): boolean {
      const m = images![assetId]?.manifest, clips = payload.imageClips;
      if (!m || !clips) return false;
      return !!clips[playbackLookupKey(m, assetId, picture, clock)] || (!!this.movieKey && !!clips[this.movieKey]);
    }
    /**
     * A running movie (plan D7): its baked clip (one pass, looped natively for loop and bounce) placed at the movie's
     * pure clock. The clock's owner (`player/fluximgMedia.ts`) calls this when its state changes (Start, Pause, a seek,
     * the player pausing) and, only where the overlay names the plane, at each plane; between those calls the video
     * plays natively. The video's own clock and the slide's drift apart a little: a timer compares them every
     * DRIFT_CHECK_MS and re-syncs past `movieDriftS` (review C7: measured, see there).
     * A pixel-setting Change under a running movie keeps the clip it started with and switches to the clip baked for its
     * end state at its end (the exported deck's limit; the export warns naming the step).
     */
    private drawMovie(assetId: string, frame: ViewTweenFrame, clock: FluximgMovieClock): boolean {
      this.lastRaw = -1;
      const m = images![assetId]?.manifest;
      const key = m ? playbackLookupKey(m, assetId, frame.a, clock) : "";
      let clip = payload.imageClips?.[key] ?? null;
      if (clip) this.movieKey = key;
      else if (this.movieKey && this.clip) clip = payload.imageClips?.[this.movieKey] ?? null;
      if (!clip) { this.unwatch(); this.hide(); this.exact = true; return true; }
      const v = this.load(clip);
      if (v.loop !== !!clip.loop) v.loop = !!clip.loop;
      const now = performance.now(), position = clock.positionMs + (clock.running ? now - clock.at : 0);
      if (clock.running && !options.capture) {
        // Running: the clip at the clock's own time (not a frame's middle: the video runs on from there).
        if (v.paused) { this.seekTo(movieClipTime(position, clock) + 1e-3); v.play().catch(() => undefined); counters.plays++; }
        else this.resync(position, clock, now);
        this.watch(clock, clip);
      } else {
        this.unwatch();
        if (!v.paused) v.pause();
        this.seekTo(playbackClipTime(position, clock));
      }
      return this.reveal(v);
    }
    /** Re-sync a natively playing movie clip only when it is further than `movieDriftS` from the slide's clock. */
    private resync(position: number, clock: FluximgMovieClock, now: number): void {
      const v = this.video;
      if (!v || v.paused || v.seeking) return;
      const truth = movieClipTime(position, clock), span = movieSpan(clock);
      let off = Math.abs(v.currentTime - truth);
      if (clock.mode !== "once") off = Math.min(off, span - off);
      counters.drift = Math.max(counters.drift, off);
      if (off > movieDriftS(clock) && now - this.resyncAt > RESYNC_COOLDOWN_MS) { this.resyncAt = now; this.seekTo(truth + 1e-3); counters.resyncs++; }
      else this.target = v.currentTime;
    }
    private watch(clock: FluximgMovieClock, clip: ImageClip): void {
      this.running = { clock, clip };
      this.driftTimer ??= setInterval(() => {
        const r = this.running;
        if (!r || disposed) { this.unwatch(); return; }
        const now = performance.now();
        this.resync(r.clock.positionMs + now - r.clock.at, r.clock, now);
      }, DRIFT_CHECK_MS);
    }
    private unwatch(): void {
      this.running = null;
      if (this.driftTimer !== undefined) { clearInterval(this.driftTimer); this.driftTimer = undefined; }
    }
    private clipFor(assetId: string, motion: FluximgSurfaceMotion): ImageClip | null {
      const m = images![assetId]?.manifest, clips = payload.imageClips;
      if (!m || !clips || !motion.plan) return null;
      return clips[clipLookupKey(m, assetId, motion.plan, motion)] ?? null;
    }
    private load(clip: ImageClip): HTMLVideoElement {
      const v = this.ensureVideo(), url = clipUrl(clip);
      if (this.src !== url) { this.src = url; this.clip = clip; this.presented = false; this.shown = false; v.style.display = "none"; v.src = url; v.load(); }
      return v;
    }
    settled(): Promise<void> {
      if (this.exact || !this.wantVisible) return Promise.resolve();
      return new Promise((resolve) => { this.waiters.push(resolve); this.landed(); });
    }
    release(): void { clearTimeout(this.stall); this.unwatch(); this.hide(); this.lastRaw = -1; }
    dispose(): void {
      this.release();
      if (this.video) { this.video.removeAttribute("src"); this.video.load(); this.video.remove(); this.video = null; }
      surfaces.delete(this);
      { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
    }
    get hasVideo(): boolean { return !!this.video; }
  }

  return {
    manifest: (id) => images[id]?.manifest,
    need: (id) => (images[id] ? Promise.resolve(images[id].manifest) : Promise.reject(new Error(`Image ${id} is not in this export`))),
    still: (id, p, w, h) => { const ref = stillRef(id, p, w, h); return ref ? payload.assets?.[ref] : undefined; },
    surface: (canvas) => new ClipSurface(canvas),
    warm: () => {},
    ready: async (id, pictures, w, h) => {
      await Promise.all(pictures.map((p) => { const ref = stillRef(id, p, w, h), url = ref ? payload.assets?.[ref] : undefined; return url ? decode(url) : undefined; }));
    },
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => {
      disposed = true;
      for (const s of [...surfaces]) s.dispose();
      for (const url of blobs.values()) URL.revokeObjectURL(url);
      blobs.clear(); listeners.clear();
    },
    stats: () => ({ surfaces: surfaces.size, videos: [...surfaces].filter((s) => s.hasVideo).length, ...counters }),
  };
}

/** Everything the player's render context needs for the payload's images: the host (`fluximg`) for players, and the
 *  still / text / table / colour lookups for static renders (the presenter's next-slide view). `{}` without images. */
export function payloadImageContext(payload: ExportPayload, host?: FluximgSlideHost): FluximgSlideContext {
  const images = payload.images;
  if (!images || !Object.keys(images).length) return {};
  const statics = host ?? payloadImageHost(payload)!;
  return {
    ...(host ? { fluximg: host } : {}),
    fluximgManifest: (id: string): FluximgManifest | undefined => images[id]?.manifest,
    fluximgStill: (id, p, w, h) => statics.still(id, p, w, h),
    fluximgLayerText: (id, path) => images[id]?.texts?.[path],
    fluximgTable: (id, path) => images[id]?.tables?.[path] ?? null,
    fluximgLut: (name) => lutOf(images, name),
  };
}
