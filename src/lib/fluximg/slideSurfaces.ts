/**
 * The slide player's image host over a plane source. Each LIVE surface draws on its own WebGL context, within ONE
 * budget per document shared by every host (call 39, review C10); beyond it a surface draws through the host's ONE
 * shared offscreen renderer. A surface asks for a frame; the shared renderer draws each picture of it into its offscreen
 * buffer (a mix: the second picture over the first at the mix weight, then the blend neighbour(s) at theirs, all in GL:
 * per component `(1 - w)·x + w·y`, the reference meaning of a mix) and the buffer is handed to the surface's canvas as
 * a bitmap, without a copy (`transferToImageBitmap` into a `bitmaprenderer` context). Frames never block (D4): a frame whose planes are not in hand yet leaves the newest complete earlier frame
 * on the canvas, and is drawn the moment its planes land (no animation frame is requested for that).
 *
 * Browser-only (WebGL, canvases). The app binds it to the window's service (`appSlideHost.ts`); gates bind it to a
 * synthetic source. The player never imports this module: it sees only `slideHost.ts`.
 */
import { FluximgLiveRenderer } from "./gl/liveRenderer";
import type { ServicePlane } from "./service";
import type { FluximgSlideHost, FluximgSurface } from "./slideHost";
import type { FluximgManifest } from "./types";
import type { FluximgView, PixelRect, ResolvedView } from "./view";
import { pixelKey } from "./viewOps";
import type { TweenPicture, ViewTweenFrame } from "./viewTween";
import { frameLevels, liveFrameOf, requestPlane, TableCache, wantedPlanes, type PlaneSource, type PlaneWant } from "./live/frames";

export interface SlideHostSource {
  manifest(assetId: string): FluximgManifest | undefined;
  need(assetId: string): Promise<FluximgManifest>;
  /** The bundle a plane request names (also the namespace of plane keys); undefined = not an image of this deck. */
  bundle(assetId: string): string | undefined;
  /** The identity of the asset's pixels, prefixed to still keys (the editor's still cache shares them). */
  identity(assetId: string): string;
  planes: PlaneSource;
  /** Render a still in the background (the reference renderer) and resolve with its data URL. */
  still(assetId: string, key: string, request: { view: FluximgView; crop: PixelRect; outWidth: number; outHeight: number }): Promise<string>;
  /** A still that has already landed, by key. */
  stillNow(key: string): string | undefined;
  resolveLut(name: string): string[] | null;
  /** Load the colour maps (tables built before they land are gray and are rebuilt). */
  luts?(): Promise<void>;
  /** The canvas the shared renderer draws on (default: an OffscreenCanvas, else a detached canvas). */
  glCanvas?(): HTMLCanvasElement | OffscreenCanvas;
}

/** What the host's GL side did, for gates and the measurements (not part of the player's interface). */
export interface SlideHostStats { draws: number; glDraws: number; textures: number; textureBytes: number; liveSurfaces: number; renderer: boolean; planesHeld: number; listeners: number; surfaces: number;
  /** WebGL contexts alive (direct ones + the shared one), the direct ones, and how long each context took to make, and where. */
  contexts: number; direct: number; contextMs: Array<{ ms: number; where: "idle" | "frame" }> }

/** The sparse view that resolves back to exactly this picture's pixels (stills are asked by recipe, not resolved). */
export function pictureView(rv: ResolvedView): FluximgView {
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

/** The picture `p` drawn at the blend neighbour's position along `dim`: `index[dim] = other`, or, for a stepping
 *  projection run, that run end (`end`) replaced by `other` (viewTween's `ViewTweenFrame.blend`). */
export function neighbourPicture(p: TweenPicture, blend: { dim: string; other: number; end?: "from" | "to" }): TweenPicture {
  const pr = p.view.projection;
  if (pr && pr.dim === blend.dim && blend.end) return { crop: p.crop, view: { ...p.view, projection: { ...pr, [blend.end]: blend.other } } };
  return { crop: p.crop, view: { ...p.view, index: { ...p.view.index, [blend.dim]: blend.other } } };
}

const PLANE_BUDGET = 192 * 1024 * 1024;
const TEXTURE_BUDGET = 128 * 1024 * 1024;
/** Live surfaces with their own WebGL context at once, per DOCUMENT (the browser caps a document's active contexts at
 *  ~16): one budget shared by every host in it (the editor preview, Present, a second player: review C10). Each host
 *  adds at most its one shared offscreen renderer. */
export const MAX_DIRECT = 6;
/** The direct surfaces of this document, of every host: the one budget. */
interface DirectSlot { lastDraw: number; demote(): void }
const documentDirect = new Set<DirectSlot>();
/** A direct surface drawn this recently is playing: its slot is not taken from it. */
const BUSY_MS = 250;

/** Every host alive in this document (dev handle and gates: `slideHostStats`). */
const hosts = new Set<{ stats(): SlideHostStats }>();
/** What the live image hosts of this document hold right now, summed (dev handle: `__flux.fluximgSlide.hosts()`). */
export function slideHostStats(): SlideHostStats & { hosts: number } {
  const sum: SlideHostStats & { hosts: number } = { draws: 0, glDraws: 0, textures: 0, textureBytes: 0, liveSurfaces: 0, renderer: false, planesHeld: 0, listeners: 0, surfaces: 0, contexts: 0, direct: 0, contextMs: [], hosts: hosts.size };
  for (const h of hosts) { const s = h.stats(); for (const k of Object.keys(s) as (keyof SlideHostStats)[]) if (k === "renderer") sum.renderer ||= s.renderer; else if (k === "contextMs") sum.contextMs.push(...s.contextMs); else (sum[k] as number) += s[k] as number; }
  return sum;
}

export function createFluximgSlideHost(source: SlideHostSource): FluximgSlideHost & { stats(): SlideHostStats } {
  /** Planes in hand for synchronous drawing, least recently used first (the service keeps its own, larger cache). */
  const planes = new Map<string, ServicePlane>();
  let planeBytes = 0;
  const inflight = new Map<string, Promise<ServicePlane>>();
  const failed = new Map<string, Error>();
  const listeners = new Set<() => void>();
  const surfaces = new Set<SurfaceImpl>();
  const tables = new TableCache((name) => source.resolveLut(name));
  const stillsAsked = new Set<string>();
  let renderer: FluximgLiveRenderer | null = null, glCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  let disposed = false, draws = 0, glDraws = 0;
  void source.luts?.().then(() => { if (disposed) return; tables.clear(); for (const s of surfaces) s.invalidate(); notify(); }, () => {});

  function notify(): void { for (const l of [...listeners]) l(); }
  function keep(key: string, plane: ServicePlane): void {
    if (planes.has(key)) { planes.delete(key); planes.set(key, plane); return; }
    planes.set(key, plane); planeBytes += plane.data.byteLength;
    for (const [k, v] of planes) { if (planeBytes <= PLANE_BUDGET) break; if (k === key) continue; planes.delete(k); planeBytes -= v.data.byteLength; }
  }
  function touch(key: string): ServicePlane | undefined {
    const p = planes.get(key);
    if (p) { planes.delete(key); planes.set(key, p); }
    return p;
  }

  interface Need { manifest: FluximgManifest; bundle: string; level: number; wants: PlaneWant[] }
  function needOf(assetId: string, picture: TweenPicture, outWidth: number, outHeight: number): Need | null {
    const manifest = source.manifest(assetId), bundle = source.bundle(assetId);
    if (!manifest || !bundle) return null;
    const level = frameLevels(manifest, picture.crop, outWidth, outHeight).sharp;
    return { manifest, bundle, level, wants: wantedPlanes(manifest, bundle, picture.view, level) };
  }
  function ask(need: Need): Promise<ServicePlane>[] {
    const out: Promise<ServicePlane>[] = [];
    for (const w of need.wants) {
      const have = planes.get(w.key);
      if (have) { out.push(Promise.resolve(have)); continue; }
      let p = inflight.get(w.key);
      if (!p) {
        failed.delete(w.key);
        p = requestPlane(source.planes, need.bundle, need.manifest, need.level, w);
        inflight.set(w.key, p);
        const key = w.key;
        p.then((plane) => {
          inflight.delete(key);
          if (disposed) return;
          keep(key, plane);
          for (const s of surfaces) s.landed();
          notify();
        }, (error: unknown) => {
          inflight.delete(key);
          if (disposed) return;
          failed.set(key, error instanceof Error ? error : new Error(String(error)));
          for (const s of surfaces) s.landed();
          notify();
        });
      }
      out.push(p);
    }
    return out;
  }
  const complete = (need: Need): boolean => need.wants.every((w) => planes.has(w.key));
  const failure = (need: Need): Error | undefined => { for (const w of need.wants) { const e = failed.get(w.key); if (e) return e; } return undefined; };

  // ---- GL: one context per LIVE surface (at most MAX_DIRECT), drawing straight into the surface's own visible canvas
  // (no hand-over, no wait for the GPU in the frame); a surface beyond that draws through ONE shared offscreen renderer
  // and is handed the result as a bitmap. The texture budget (TEXTURE_BUDGET in all) is split evenly over the renderers
  // that exist.
  const direct = new Set<SurfaceImpl>();
  const contextMs: Array<{ ms: number; where: "idle" | "frame" }> = [];
  function rebudget(): void {
    const n = direct.size + (renderer ? 1 : 0);
    if (!n) return;
    const share = Math.floor(TEXTURE_BUDGET / n);
    for (const s of direct) s.budget(share);
    renderer?.setBudget(share);
  }
  function gl(): FluximgLiveRenderer {
    if (renderer && !renderer.lost) return renderer;
    renderer?.dispose();
    glCanvas = source.glCanvas?.() ?? (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas"));
    renderer = new FluximgLiveRenderer(glCanvas, TEXTURE_BUDGET);
    rebudget();
    return renderer;
  }
  /** A slot for a direct context in the DOCUMENT's budget: a free one, else the one of the least recently drawn surface
   *  of any host when that one is at rest (it moves to its own host's shared renderer, its picture redrawn there);
   *  none while all six are drawing. */
  function slotFor(wanting: SurfaceImpl): boolean {
    if (documentDirect.size < MAX_DIRECT) return true;
    let lru: DirectSlot | null = null;
    for (const s of documentDirect) if (s !== wanting && (!lru || s.lastDraw < lru.lastDraw)) lru = s;
    if (!lru || performance.now() - lru.lastDraw < BUSY_MS) return false;
    lru.demote();
    return true;
  }

  interface Entry { n: number; assetId: string; frame: ViewTweenFrame; w: number; h: number }
  class SurfaceImpl implements FluximgSurface {
    private ctx: CanvasRenderingContext2D | null = null;
    private bitmaps: ImageBitmapRenderingContext | null = null;
    /** This surface's own renderer on its own canvas, while it holds a direct slot. */
    private own: FluximgLiveRenderer | null = null;
    /** The canvas has had a context of some kind (a canvas keeps its first kind, and a lost GL context stays lost). */
    private used = false;
    /** Draws through the shared renderer (no slot was free when it went live). */
    private shared = false;
    private recent: Entry[] = [];
    private n = 0;
    private drawn = 0;
    private waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    private error: Error | null = null;
    lastDraw = -Infinity;
    shown = false;
    get exact(): boolean { return this.drawn === this.n; }
    constructor(public canvas: HTMLCanvasElement) { surfaces.add(this); }

    budget(bytes: number): void { this.own?.setBudget(bytes); }
    /** A canvas that has never had a context, in place of this one (same place, style and data). */
    private fresh(): void {
      if (!this.used) return;
      const c = document.createElement("canvas");
      c.style.cssText = this.canvas.style.cssText;
      for (const [k, v] of Object.entries(this.canvas.dataset)) if (v !== undefined) c.dataset[k] = v;
      c.width = 0; c.height = 0;
      this.canvas.replaceWith(c);
      this.canvas = c; this.ctx = null; this.bitmaps = null; this.used = false;
    }
    /** Take a direct context now (idle time: the controller warms surfaces before they draw). */
    prepare(where: "idle" | "frame" = "idle"): void {
      if (disposed || this.own || this.shared || !slotFor(this)) return;
      this.fresh();
      const t0 = performance.now();
      try {
        this.own = new FluximgLiveRenderer(this.canvas, TEXTURE_BUDGET);
      } catch { this.own = null; this.shared = true; return; }
      this.used = true;
      contextMs.push({ ms: performance.now() - t0, where });
      direct.add(this); documentDirect.add(this);
      rebudget();
      // A context the browser takes away (GPU reset, too many contexts, `loseContext`): its slot is given back and the
      // picture is drawn again on a new canvas and context (review C10), never left blank, never thrown.
      const canvas = this.canvas;
      canvas.addEventListener("webglcontextlost", () => { setTimeout(() => this.recover(canvas), 0); }, { once: true });
    }
    private recover(canvas: HTMLCanvasElement): void {
      if (disposed || this.canvas !== canvas || !this.own?.lost) return;
      this.dropOwn();
      this.fresh();
      if (!this.recent.length) { this.shown = false; return; }
      // Redraw the newest frame (its planes are normally still in hand: drawn in this task); until it lands the
      // binding shows its still (`shown` false and a change notified).
      this.shown = false; this.drawn = 0;
      this.attempt();
      notify();
    }
    /** Give the direct slot up and keep the picture: redrawn through the shared renderer. */
    demote(): void {
      if (!this.own) return;
      this.dropOwn();
      this.shared = true;
      this.fresh();
      if (this.shown) { this.drawn = 0; this.shown = false; this.attempt(); }
    }
    private dropOwn(): void {
      this.own?.dispose();   // loseContext(): the GPU memory goes now, not at garbage collection
      this.own = null;
      direct.delete(this); documentDirect.delete(this);
      rebudget();
    }

    draw(assetId: string, frame: ViewTweenFrame, outWidth: number, outHeight: number): boolean {
      const w = Math.max(1, Math.round(outWidth)), h = Math.max(1, Math.round(outHeight));
      this.recent.push({ n: ++this.n, assetId, frame, w, h });
      if (this.recent.length > 6) this.recent.shift();
      this.error = null;
      this.attempt();
      return this.drawn === this.n;
    }
    /** A plane landed or failed: a frame that waited may draw now. */
    landed(): void { if (this.drawn !== this.n) this.attempt(); }
    /** Tables changed (colour maps landed): redraw the newest frame. */
    invalidate(): void { if (this.n) { this.drawn = Math.min(this.drawn, this.n - 1); this.attempt(); } }

    private attempt(): void {
      if (disposed || !this.recent.length) return;
      // Newest first: the newest frame whose planes are all in hand, never one older than what is on the canvas.
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const e = this.recent[i];
        if (e.n <= this.drawn) break;
        const pictures = this.pictures(e);
        const needs = pictures.map(([p]) => needOf(e.assetId, p, e.w, e.h));
        if (needs.some((x) => !x)) continue;
        const ready = needs.every((x) => complete(x!));
        if (!ready) {
          // Only the frame asked for last is worth decoding; an older one is drawn only if its planes are already here.
          if (i === this.recent.length - 1) {
            for (const x of needs) ask(x!);
            const err = needs.map((x) => failure(x!)).find(Boolean);
            if (err) { this.error = err; this.flushWaiters(); }
          }
          continue;
        }
        this.render(e, pictures, needs as Need[]);
        this.drawn = e.n;
        break;
      }
      if (this.drawn === this.n) this.flushWaiters();
    }

    /** The pictures of a frame with their draw weights over what is already drawn (in order). */
    private pictures(e: Entry): Array<[TweenPicture, number]> {
      const f = e.frame, m = f.b ? Math.min(1, Math.max(0, f.mix)) : 0, bl = f.blend, wt = bl ? Math.min(1, Math.max(0, bl.weight)) : 0;
      const out: Array<[TweenPicture, number]> = [[f.a, 1]];
      if (f.b && m > 0) out.push([f.b, m]);
      if (bl && wt > 0) {
        // (1-w)·[(1-m)·a + m·b] + w·[(1-m)·a' + m·b'], drawn as a, b@m, a'@α, b'@β with β = w·m, α = w·(1-m)/(1-β).
        const beta = f.b && m > 0 ? wt * m : 0, alpha = beta >= 1 ? 0 : (wt * (1 - (f.b && m > 0 ? m : 0))) / (1 - beta);
        if (alpha > 0) out.push([neighbourPicture(f.a, bl), alpha]);
        if (f.b && beta > 0) out.push([neighbourPicture(f.b, bl), beta]);
      }
      return out;
    }

    private render(e: Entry, pictures: Array<[TweenPicture, number]>, needs: Need[]): void {
      if (this.own?.lost) this.dropOwn();
      // First live frame without an idle warm before it: the context is made here (counted as "frame").
      if (!this.own && !this.shared) this.prepare("frame");
      const r = this.own ?? gl();
      // Every picture of the frame is drawn into one GL buffer, each later one over it at its weight (the renderer's
      // `over`: a straight per-component lerp), so a mix costs GL draws, not canvas copies.
      pictures.forEach(([p, weight], i) => {
        const need = needs[i];
        const { frame } = liveFrameOf(need.manifest, p.view, p.crop, need.level, need.wants, (key) => touch(key)!, tables, e.w, e.h);
        r.draw(frame, i === 0 ? undefined : weight); glDraws++;
      });
      draws++; this.shown = true; this.lastDraw = performance.now();
      if (this.own) return;   // drawn on this surface's own visible canvas: nothing to hand over
      if (this.canvas.width !== e.w || this.canvas.height !== e.h) { this.canvas.width = e.w; this.canvas.height = e.h; }
      // The shared renderer's hand-over: its buffer becomes this canvas's bitmap (transferred, else copied in 2D).
      this.used = true;
      const offscreen = glCanvas as OffscreenCanvas;
      if (!this.ctx && typeof offscreen.transferToImageBitmap === "function") {
        this.bitmaps ??= this.canvas.getContext("bitmaprenderer");
        if (this.bitmaps) { this.bitmaps.transferFromImageBitmap(offscreen.transferToImageBitmap()); return; }
      }
      this.ctx ??= this.canvas.getContext("2d", { alpha: true });
      const ctx = this.ctx!;
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(glCanvas as CanvasImageSource, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }

    private flushWaiters(): void {
      const list = this.waiters; this.waiters = [];
      for (const w of list) { if (this.error && this.drawn !== this.n) w.reject(this.error); else w.resolve(); }
    }
    settled(): Promise<void> {
      if (this.drawn === this.n) return Promise.resolve();
      if (this.error) return Promise.reject(this.error);
      return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.attempt(); });
    }
    release(keepContext = false): void {
      // The next draw renders afresh (on a new context when a slot is free). The direct context is lost at once, unless
      // asked to keep it (an image hidden on the slide that will appear: no context is made in its entrance frame); its
      // textures and drawing buffer go either way. The shared renderer's textures (and the planes held for drawing) go
      // once no surface shows anything any more.
      const was = this.shown;
      this.drawn = this.n; this.recent = []; this.shown = false;
      this.flushWaiters();
      if (this.own && keepContext) this.own.clear();
      else if (this.own) { this.dropOwn(); this.fresh(); }
      this.shared = false;
      this.bitmaps?.transferFromImageBitmap(null);
      if (this.canvas.width || this.canvas.height) { this.canvas.width = 0; this.canvas.height = 0; }
      if (was && ![...surfaces].some((s) => s.shown)) { renderer?.clear(); planes.clear(); planeBytes = 0; }
    }
    dispose(): void { this.release(false); surfaces.delete(this); }
    textures(): { count: number; bytes: number } { return { count: this.own?.textureCount ?? 0, bytes: this.own?.bytes ?? 0 }; }
    /** Gates: is this surface drawing on its own context? */
    get directly(): boolean { return !!this.own; }
  }

  const self: FluximgSlideHost & { stats(): SlideHostStats } = {
    manifest: (id) => source.manifest(id),
    need: (id) => source.need(id),
    still(assetId, picture, outWidth, outHeight) {
      const manifest = source.manifest(assetId);
      if (!manifest) return undefined;
      const key = `${source.identity(assetId)}|${pixelKey(manifest, picture.view, picture.crop, outWidth, outHeight)}`;
      const href = source.stillNow(key);
      if (href || stillsAsked.has(key) || disposed) return href;
      stillsAsked.add(key);
      source.still(assetId, key, { view: pictureView(picture.view), crop: picture.crop, outWidth, outHeight }).then(() => { stillsAsked.delete(key); if (!disposed) notify(); }, () => { stillsAsked.delete(key); });
      return undefined;
    },
    surface(canvas) { return new SurfaceImpl(canvas); },
    maxLive: MAX_DIRECT,
    warm(assetId, pictures, outWidth, outHeight) {
      if (disposed) return;
      for (const p of pictures) { const need = needOf(assetId, p, outWidth, outHeight); if (need) ask(need); }
    },
    async ready(assetId, pictures, outWidth, outHeight) {
      if (!source.manifest(assetId)) await source.need(assetId);
      const all: Promise<ServicePlane>[] = [];
      for (const p of pictures) { const need = needOf(assetId, p, outWidth, outHeight); if (need) all.push(...ask(need)); }
      await Promise.all(all);
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of [...surfaces]) s.dispose();
      listeners.clear(); planes.clear(); inflight.clear();
      renderer?.dispose(); renderer = null; glCanvas = null;
      hosts.delete(self);
    },
    stats: () => {
      let textures = renderer?.textureCount ?? 0, textureBytes = renderer?.bytes ?? 0;
      for (const s of direct) { const t = s.textures(); textures += t.count; textureBytes += t.bytes; }
      return { draws, glDraws, textures, textureBytes, liveSurfaces: [...surfaces].filter((s) => s.shown).length, renderer: !!renderer, planesHeld: planes.size, listeners: listeners.size, surfaces: surfaces.size,
        contexts: direct.size + (renderer ? 1 : 0), direct: direct.size, contextMs: contextMs.slice() };
    },
  };
  hosts.add(self);
  return self;
}
