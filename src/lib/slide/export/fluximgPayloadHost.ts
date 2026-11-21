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
import type { FluximgSlideContext, FluximgSlideHost, FluximgSurface, FluximgSurfaceMotion } from "../../fluximg/slideHost";
import type { FluximgManifest } from "../../fluximg/types";
import type { TweenPicture, ViewTweenFrame } from "../../fluximg/viewTween";
import { pixelKey } from "../../fluximg/viewOps";
import { clipLookupKey, clipSeekTime, type ImageClip } from "../../fluximg/clipPlan";
import { IMAGE_STILL_PREFIX, lutOf } from "../imageExport";
import type { ExportPayload } from "./runtime";

/** Re-sync a playing clip when it is further than this from the clock (1.5 frames of the 60 Hz clock). */
const DRIFT_S = 1.5 / 60;
/** After a re-sync the decoder needs a moment: no second re-sync within this time. */
const RESYNC_COOLDOWN_MS = 250;
/** No frame from the player for this long: its clock stopped (paused, at rest mid-Change), so the video pauses. */
const STALL_MS = 120;

/** A still's key without its output size (`out=WxH`) or the size-dependent `smooth` flag: a picture's identity. */
const sizeless = (key: string): string => key.replace(/;out=\d+x\d+/, "").replace(/;smooth(?=;|$)/, "");

interface StillEntry { ref: string; width: number; height: number }

export interface PayloadImageHost extends FluximgSlideHost {
  /** Gates: what the surfaces are doing. */
  stats(): { surfaces: number; videos: number; seeks: number; resyncs: number; plays: number };
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
  const counters = { seeks: 0, resyncs: 0, plays: 0 };
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
    constructor(private canvas: HTMLCanvasElement) { surfaces.add(this); }

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

    draw(assetId: string, _frame: ViewTweenFrame, _w: number, _h: number, motion?: FluximgSurfaceMotion): boolean {
      clearTimeout(this.stall);
      const now = performance.now();
      const clip = motion ? this.clipFor(assetId, motion) : null;
      if (!clip || !motion || !(motion.raw > 0 && motion.raw < 1)) {
        // At rest, before the Change starts, at its end or without a clip: the still is the picture (D5, law 4). A clip
        // that waits at its first frame stays loaded (the next draw plays it without a fetch).
        if (clip && motion && motion.raw <= 0) { this.load(clip); this.seekTo(clipSeekTime(0, clip.durationMs, clip.fps, clip.frames)); }
        this.hide(); this.exact = true; this.lastRaw = -1;
        { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
        return true;
      }
      const v = this.load(clip);
      const tau = (motion.raw * clip.durationMs) / 1000;
      const forward = !options.capture && this.lastRaw >= 0 && motion.raw > this.lastRaw && now - this.lastDraw < STALL_MS;
      this.lastRaw = motion.raw; this.lastDraw = now;
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
        this.seekTo(clipSeekTime(motion.raw, clip.durationMs, clip.fps, clip.frames));
      }
      this.wantVisible = true;
      if (this.presented && v.readyState >= 2) {
        if (v.style.display !== "block") v.style.display = "block";
        this.shown = true;
      }
      // Until the decoder presents, the canvas side is not shown: the still under it stays (D4: never blank).
      return this.shown && this.exact;
    }
    private clipFor(assetId: string, motion: FluximgSurfaceMotion): ImageClip | null {
      const m = images![assetId]?.manifest, clips = payload.imageClips;
      if (!m || !clips) return null;
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
    release(): void { clearTimeout(this.stall); this.hide(); this.lastRaw = -1; }
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
