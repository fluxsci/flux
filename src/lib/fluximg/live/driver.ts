/**
 * The live view's frame driver: turns "show this view of this bundle in this canvas" into GPU frames.
 *
 * It asks the service for the planes a view needs, at two qualities: the stored level that matches the screen,
 * and the coarsest overview (a few hundred pixels, decoded in about a millisecond). A frame is drawn from the
 * best quality that is complete for EVERY contributing channel, so a scrub shows the right plane at once and
 * sharpens a moment later, and channels are never mixed across planes. If nothing is ready the previous frame
 * stays up: the picture never goes blank.
 *
 * Browser-only (it owns a WebGL canvas). No Svelte: the overlay component owns one instance.
 */
import { FluximgLiveRenderer, MAX_LIVE_CHANNELS, MAX_LIVE_LAYERS, type LiveChannel, type LiveFrame, type LiveLayer } from "../gl/liveRenderer";
import { channelTable } from "../lut";
import { pickLevel } from "../reader";
import { layerKey, planeKey, projectionKey, type FluximgService, type ServicePlane } from "../service";
import { valueAt } from "../stats";
import type { FluximgManifest } from "../types";
import type { PixelRect, ResolvedView } from "../view";
import { planeRequests, type PlaneRequest } from "../viewOps";

export interface LiveTarget {
  view: ResolvedView;
  /** The rectangle of the image (level-0 pixels) the canvas shows. */
  crop: PixelRect;
  /** Drawing-buffer size in device pixels. */
  outWidth: number;
  outHeight: number;
}

export interface FrameInfo {
  /** Index into `manifest.pixels.levels` the frame was drawn from. */
  level: number;
  /** True when this is the quality the screen asked for (false = an overview standing in). */
  sharp: boolean;
  drawMs: number;
  /** Requests still on their way for the current target. */
  pending: number;
  serial: number;
}

interface Wanted { key: string; request: PlaneRequest | { layerId: string } }

export class LiveDriver {
  private renderer: FluximgLiveRenderer;
  private target: LiveTarget | null = null;
  /** The last few targets, oldest first, each with a rising number: while planes are still arriving for the newest,
   *  the newest one that IS complete is drawn, so playback and fast scrubbing show every plane they can. */
  private recent: Array<{ n: number; target: LiveTarget }> = [];
  private targetCount = 0;
  private drawnTarget = 0;
  private dirty = false;
  private lastSet = 0;
  private planes = new Map<string, ServicePlane>();
  private asked = new Set<string>();
  private touched = new Map<string, number>();
  private tables = new Map<string, Uint8Array>();
  private raf = 0;
  private serial = 0;
  private generation = 0;
  private disposed = false;
  private last: { level: number; frame: LiveFrame; f: number } | null = null;
  /** Called after every frame that reaches the screen. */
  onFrame: ((info: FrameInfo) => void) | null = null;
  /** Called when a request fails for a reason other than being superseded. */
  onError: ((message: string) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private service: FluximgService,
    private bundle: string,
    private manifest: FluximgManifest,
    private resolveLut: (name: string) => string[] | null,
  ) {
    this.renderer = new FluximgLiveRenderer(canvas);
    canvas.addEventListener("webglcontextrestored", this.restored);
  }

  private restored = (): void => {
    if (this.disposed) return;
    // A restored context has no textures or programs: start a fresh renderer and redraw from the planes we hold.
    this.renderer = new FluximgLiveRenderer(this.canvas);
    this.schedule();
  };

  get rendererName(): string { return this.renderer.rendererName(); }

  /** Show this view. Cheap to call on every change: requests are deduplicated and draws coalesce per frame. */
  set(target: LiveTarget): void {
    if (this.disposed) return;
    const previous = this.target;
    this.target = target;
    this.lastSet = performance.now();
    this.recent.push({ n: ++this.targetCount, target });
    if (this.recent.length > 6) this.recent.shift();
    const { sharp, coarse } = this.levels(target);
    // Coarse first: it is what makes a scrub feel instant.
    if (coarse !== sharp) this.ask(coarse, target);
    this.ask(sharp, target);
    this.lookAhead(previous, target);
    this.schedule();
  }

  /** Moving steadily along one dimension (wheel, arrows, a rail drag, playback): decode the next planes that way. */
  private lookAhead(previous: LiveTarget | null, next: LiveTarget): void {
    if (!previous || next.view.projection) return;
    let dim = "", delta = 0;
    for (const d of Object.keys(next.view.index)) {
      const change = next.view.index[d] - (previous.view.index[d] ?? 0);
      if (!change) continue;
      if (dim) return; // two dimensions changed at once: not a walk
      dim = d; delta = change;
    }
    if (!dim || Math.abs(delta) > 12) return;
    const step = Math.sign(delta), stride = Math.abs(delta);
    // How far ahead depends on what a plane costs: small planes (a movie) are cheap, so playback at 80 planes a
    // second never waits; a 4-megapixel confocal plane gets a shorter runway.
    const s = this.manifest.pixels.shape, nd = s.length, px = s[nd - 1] * s[nd - 2];
    const runway = px <= 300_000 ? 8 : px <= 1_200_000 ? 6 : 3;
    // Small steps: every plane ahead (playback advances by one or two planes a frame, in no fixed pattern).
    // Larger strides (Shift+wheel): the planes those strides will land on.
    const ahead = stride <= 2 ? Array.from({ length: runway }, (_, k) => step * (k + 1)) : [1, 2, 3].map((k) => step * stride * k);
    this.prefetch(dim, ahead);
  }

  /** Colour maps finished loading (or changed): tables built before that were the gray fallback. */
  invalidateTables(): void { this.tables.clear(); this.schedule(); }

  private levels(t: LiveTarget): { sharp: number; coarse: number } {
    const levels = this.manifest.pixels.levels;
    const sharp = pickLevel(levels, Math.min(t.crop.width / Math.max(1, t.outWidth), t.crop.height / Math.max(1, t.outHeight)));
    let coarse = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i].downsample > levels[coarse].downsample) coarse = i;
    return { sharp, coarse };
  }

  private wanted(level: number, t: LiveTarget): Wanted[] {
    const out: Wanted[] = [];
    for (const r of planeRequests(this.manifest, t.view).slice(0, MAX_LIVE_CHANNELS)) {
      out.push({ key: "dim" in r ? projectionKey(this.bundle, level, r.leading, r.dim, r.from, r.to, r.mode) : planeKey(this.bundle, level, r.leading), request: r });
    }
    const f = this.manifest.pixels.levels[level].downsample;
    let n = 0;
    for (const L of t.view.layers) {
      if (L.kind !== "intensity" || !L.visible || !(L.opacity > 0) || n >= MAX_LIVE_LAYERS) continue;
      out.push({ key: layerKey(this.bundle, L.id, f), request: { layerId: L.id } });
      n++;
    }
    return out;
  }

  private ask(level: number, t: LiveTarget): void {
    const f = this.manifest.pixels.levels[level].downsample;
    for (const w of this.wanted(level, t)) {
      this.touched.set(w.key, this.serial);
      if (this.planes.has(w.key) || this.asked.has(w.key)) continue;
      this.asked.add(w.key);
      const generation = this.generation;
      const r = w.request;
      const promise = "layerId" in r ? this.service.layer(this.bundle, r.layerId, f)
        : "dim" in r ? this.service.projection(this.bundle, level, r.leading, r.dim, r.from, r.to, r.mode, `live:${level}:${r.channel}`)
        : this.service.plane(this.bundle, level, r.leading);
      promise.then(
        (plane) => {
          this.asked.delete(w.key);
          if (this.disposed || generation !== this.generation) return;
          this.planes.set(w.key, plane);
          this.touched.set(w.key, this.serial);
          this.schedule();
        },
        (error: unknown) => {
          this.asked.delete(w.key);
          const message = error instanceof Error ? error.message : String(error);
          if (!this.disposed && message !== "cancelled") this.onError?.(message);
        },
      );
    }
  }

  /** Decode ahead: the planes `steps` positions further along `dim` (signed), coarse quality first. */
  prefetch(dim: string, steps: readonly number[]): void {
    const t = this.target;
    if (!t || this.disposed || t.view.projection) return;
    const di = this.manifest.pixels.dims.indexOf(dim);
    if (di < 0) return;
    const n = this.manifest.pixels.shape[di], here = t.view.index[dim] ?? 0;
    const { sharp, coarse } = this.levels(t);
    for (const s of steps) {
      const i = here + s;
      if (i < 0 || i >= n) continue;
      const ahead: LiveTarget = { ...t, view: { ...t.view, index: { ...t.view.index, [dim]: i } } };
      // The service keeps what it decodes; asking is enough. Only pixel planes: layers do not change along a dimension.
      for (const level of coarse !== sharp ? [coarse, sharp] : [sharp]) {
        for (const r of planeRequests(this.manifest, ahead.view)) if (!("dim" in r)) void this.service.plane(this.bundle, level, r.leading).catch(() => {});
      }
    }
  }

  private complete(level: number, t: LiveTarget): Wanted[] | null {
    // Nothing wanted (every channel hidden) is complete too: the frame is just the background.
    const w = this.wanted(level, t);
    return w.every((x) => this.planes.has(x.key)) ? w : null;
  }

  /**
   * One draw per screen frame, and only when something changed. While targets are streaming in (playback, a scrub)
   * the frame callback stays armed for a few frames: a target set during this frame's callbacks is then drawn in
   * the SAME frame instead of the one after next, which is the difference between 30 and 60 frames a second.
   */
  private schedule(): void {
    this.dirty = true;
    this.arm();
  }
  private arm(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.dirty) { this.dirty = false; this.draw(); }
      if (performance.now() - this.lastSet < 100) this.arm();
    });
  }

  private table(spec: { color: string | null; lut: string | null; invert: boolean }): Uint8Array {
    const key = `${spec.color ?? ""}|${spec.lut ?? ""}|${spec.invert ? 1 : 0}`;
    let t = this.tables.get(key);
    if (!t) { t = channelTable(spec, this.resolveLut); this.tables.set(key, t); if (this.tables.size > 64) this.tables.delete(this.tables.keys().next().value as string); }
    return t;
  }

  private draw(): void {
    if (!this.target || this.disposed || this.renderer.lost) return;
    // Newest first: the first target with every plane in hand wins. An older target is drawn only if nothing newer
    // has been drawn yet (never step backwards), so a stream of steps shows each plane as it lands.
    let t: LiveTarget | null = null, level = 0, have: Wanted[] | null = null, sharp = 0, number = 0;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const entry = this.recent[i];
      const newest = i === this.recent.length - 1;
      if (entry.n < this.drawnTarget || (entry.n === this.drawnTarget && !newest)) break;
      const lv = this.levels(entry.target);
      let l = lv.sharp, h = this.complete(lv.sharp, entry.target);
      if (!h && lv.coarse !== lv.sharp) { l = lv.coarse; h = this.complete(lv.coarse, entry.target); }
      if (!h) continue;
      t = entry.target; level = l; have = h; sharp = lv.sharp; number = entry.n;
      break;
    }
    if (!t || !have) return; // keep the previous frame
    this.drawnTarget = number;
    const f = this.manifest.pixels.levels[level].downsample;
    const first = have.length ? this.planes.get(have[0].key)! : null;
    const nd = this.manifest.pixels.levels[level].shape.length;
    const width = first ? first.width : this.manifest.pixels.levels[level].shape[nd - 1];
    const height = first ? first.height : this.manifest.pixels.levels[level].shape[nd - 2];
    const channels: LiveChannel[] = [], layers: LiveLayer[] = [];
    for (const w of have) {
      const plane = this.planes.get(w.key)!;
      if ("layerId" in w.request) {
        const id = w.request.layerId;
        const L = t.view.layers.find((l) => l.id === id), entry = this.manifest.layers.find((l) => l.id === id);
        if (!L || !entry || entry.kind !== "intensity") continue;
        layers.push({ plane, table: this.table({ color: L.color, lut: L.lut, invert: false }), range: L.range ?? entry.range, norm: "linear", gamma: 1, opacity: L.opacity, opacityFromValue: L.opacityFromValue });
      } else {
        const c = t.view.channels[w.request.channel];
        channels.push({ plane, table: this.table(c), range: c.range, norm: c.norm, gamma: c.gamma });
      }
    }
    const frame: LiveFrame = {
      width, height, channels, layers, background: t.view.background, smooth: t.view.smooth,
      crop: { x: t.crop.x / f, y: t.crop.y / f, width: t.crop.width / f, height: t.crop.height / f },
      outWidth: t.outWidth, outHeight: t.outHeight,
    };
    const t0 = performance.now();
    this.renderer.draw(frame);
    this.last = { level, frame, f };
    this.serial++;
    this.prune();
    let pending = 0;
    for (const w of this.wanted(sharp, t)) if (!this.planes.has(w.key)) pending++;
    this.onFrame?.({ level, sharp: level === sharp, drawMs: performance.now() - t0, pending, serial: this.serial });
    // A superseded target was drawn: the newest is still on its way, and its planes will schedule the next frame.
    if (t !== this.target) this.touchTarget(this.target);
  }

  /** Keep the newest target's planes marked as wanted while an older one is on screen. */
  private touchTarget(t: LiveTarget): void {
    const { sharp, coarse } = this.levels(t);
    for (const level of coarse !== sharp ? [coarse, sharp] : [sharp]) for (const w of this.wanted(level, t)) this.touched.set(w.key, this.serial);
  }

  /** Forget planes no recent target used; the service's own cache still has them if they are wanted again. */
  private prune(): void {
    if (this.planes.size <= 48) return;
    for (const [key] of this.planes) {
      if ((this.touched.get(key) ?? 0) < this.serial - 6) { this.planes.delete(key); this.touched.delete(key); }
    }
  }

  /**
   * The values under an image position (level-0 pixels), one per channel of the frame on screen, in the frame's
   * channel order; NaN where there is no data or the position is outside. Read from the planes that frame drew.
   */
  valuesAt(x: number, y: number): number[] {
    const last = this.last;
    if (!last) return [];
    const px = Math.floor(x / last.f), py = Math.floor(y / last.f);
    return last.frame.channels.map((c) => (c.plane ? valueAt({ data: c.plane.data, map: c.plane.map }, last.frame.width, px, py) : NaN));
  }

  /** The drawing buffer as straight-alpha RGBA rows from the top (gates only). */
  readPixels(): Uint8ClampedArray { return this.renderer.readPixels(); }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    this.planes.clear(); this.asked.clear(); this.touched.clear(); this.tables.clear();
    this.renderer.dispose();
  }
}
