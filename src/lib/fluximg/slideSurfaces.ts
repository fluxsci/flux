/**
 * The slide player's image host over a plane source: ONE WebGL renderer for the whole player document, shared by
 * every image surface (D3). A surface asks for a frame; the renderer draws each picture of it on its own offscreen
 * canvas and the surface copies the result into its own 2D canvas (a mix: the second picture over the first at
 * the mix weight, then the blend neighbour(s) at theirs: per component, `(1 - w)·x + w·y`, the reference meaning of a
 * mix). Frames never block (D4): a frame whose planes are not in hand yet leaves the newest complete earlier frame
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
export interface SlideHostStats { draws: number; glDraws: number; textures: number; textureBytes: number; liveSurfaces: number; renderer: boolean; planesHeld: number; listeners: number; surfaces: number }

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

/** The picture `p` drawn at the blend neighbour's position along `dim` (a projection along `dim` moves its run). */
export function neighbourPicture(p: TweenPicture, dim: string, other: number): TweenPicture {
  const pr = p.view.projection;
  if (pr && pr.dim === dim) return { crop: p.crop, view: { ...p.view, projection: { ...pr, from: other, to: other + (pr.to - pr.from) } } };
  return { crop: p.crop, view: { ...p.view, index: { ...p.view.index, [dim]: other } } };
}

const PLANE_BUDGET = 192 * 1024 * 1024;

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

  function gl(): FluximgLiveRenderer {
    if (renderer && !renderer.lost) return renderer;
    renderer?.dispose();
    glCanvas = source.glCanvas?.() ?? (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas"));
    renderer = new FluximgLiveRenderer(glCanvas);
    return renderer;
  }

  interface Entry { n: number; assetId: string; frame: ViewTweenFrame; w: number; h: number }
  class SurfaceImpl implements FluximgSurface {
    private ctx: CanvasRenderingContext2D | null = null;
    private recent: Entry[] = [];
    private n = 0;
    private drawn = 0;
    private waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    private error: Error | null = null;
    shown = false;
    constructor(private canvas: HTMLCanvasElement) { surfaces.add(this); }

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

    /** The pictures of a frame with their draw weights over what is already drawn (source-over, in order). */
    private pictures(e: Entry): Array<[TweenPicture, number]> {
      const f = e.frame, m = f.b ? Math.min(1, Math.max(0, f.mix)) : 0, bl = f.blend, wt = bl ? Math.min(1, Math.max(0, bl.weight)) : 0;
      const out: Array<[TweenPicture, number]> = [[f.a, 1]];
      if (f.b && m > 0) out.push([f.b, m]);
      if (bl && wt > 0) {
        // (1-w)·[(1-m)·a + m·b] + w·[(1-m)·a' + m·b'], drawn as a, b@m, a'@α, b'@β with β = w·m, α = w·(1-m)/(1-β).
        const beta = f.b && m > 0 ? wt * m : 0, alpha = beta >= 1 ? 0 : (wt * (1 - (f.b && m > 0 ? m : 0))) / (1 - beta);
        if (alpha > 0) out.push([neighbourPicture(f.a, bl.dim, bl.other), alpha]);
        if (f.b && beta > 0) out.push([neighbourPicture(f.b, bl.dim, bl.other), beta]);
      }
      return out;
    }

    private render(e: Entry, pictures: Array<[TweenPicture, number]>, needs: Need[]): void {
      const r = gl();
      if (this.canvas.width !== e.w || this.canvas.height !== e.h) { this.canvas.width = e.w; this.canvas.height = e.h; }
      this.ctx ??= this.canvas.getContext("2d", { alpha: true });
      const ctx = this.ctx!;
      pictures.forEach(([p, weight], i) => {
        const need = needs[i];
        const { frame } = liveFrameOf(need.manifest, p.view, p.crop, need.level, need.wants, (key) => touch(key)!, tables, e.w, e.h);
        r.draw(frame); glDraws++;
        ctx.globalCompositeOperation = i === 0 ? "copy" : "source-over";
        ctx.globalAlpha = i === 0 ? 1 : weight;
        ctx.drawImage(glCanvas as CanvasImageSource, 0, 0);
      });
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      draws++;
      this.shown = true;
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
    release(): void {
      // The next draw renders afresh. GPU textures (and the planes held for drawing) go once no surface shows
      // anything any more: a slide that is left, or every image of it hidden.
      const was = this.shown;
      this.drawn = this.n; this.recent = []; this.shown = false;
      this.flushWaiters();
      if (this.canvas.width || this.canvas.height) { this.canvas.width = 0; this.canvas.height = 0; }
      this.ctx = null;
      if (was && ![...surfaces].some((s) => s.shown)) { renderer?.clear(); planes.clear(); planeBytes = 0; }
    }
    dispose(): void { this.release(); surfaces.delete(this); }
  }

  return {
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
    },
    stats: () => ({ draws, glDraws, textures: renderer?.textureCount ?? 0, textureBytes: renderer?.bytes ?? 0, liveSurfaces: [...surfaces].filter((s) => s.shown).length, renderer: !!renderer, planesHeld: planes.size, listeners: listeners.size, surfaces: surfaces.size }),
  };
}
