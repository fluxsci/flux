// ---------------------------------------------------------------------------
// Camera raster keeper (T7 / C1). The camera layer is a PERMANENT compositor layer
// (`will-change: transform`, player.ts) so Chromium never squashes later siblings into
// layers mid-slide (text LCD <-> grayscale shimmer at both ends of every transform,
// 2026-10-03). The price, measured: Chromium rasterizes a will-change layer ONCE and
// never again when its scale, its fractional offset or an ANCESTOR's scale changes —
// after a camera zoom, a camera landing on a fractional pixel, a window resize or a
// fullscreen switch the stage is a resampled bitmap (gradient energy 0.25-0.65 of exact).
//
// The cure is to re-bake: drop the hint for one frame and put it back; the fresh layer
// rasterizes at the CURRENT pose and keeps it. The hint always ends ON (any failure,
// cancel or dispose restores it), so the keeper can only ever degrade to today's behaviour.
// Live: re-bake once the stage is at rest (immediately at the natural end of a flight,
// debounced after a scrub/resize/refresh), never above MAX_BAKE_NODES. Capture
// (`capture: true`): re-bake after every sampled frame whose pose changed, awaited by the host.
// ---------------------------------------------------------------------------

/** Pure: does the raster need to be re-baked? `baked` is null until the first look. */
export function needsBake(baked: string | null, now: string): boolean { return baked !== null && baked !== now; }
/** Pure: the key of everything a will-change layer freezes at its first raster. */
export function bakeKey(pose: string, hostScale: number, dpr: number): string { return `${pose}|${hostScale.toFixed(4)}|${dpr}`; }
/** Live re-bakes are skipped above this many DOM nodes under the camera layer: the display-list record is
 *  main-thread work (measured, Electron offscreen, SwiftShader: worst rAF gap 17/27/80/125/177/232 ms at
 *  2k/20k/40k/60k/80k/100k paths). 30 000 keeps the gap <= ~50 ms (3 frames). Capture ignores it. */
export const MAX_BAKE_NODES = 30000;
/** Pure: bake iff the key changed and (capture, or the layer is light enough for an interactive re-bake). */
export function shouldBake(baked: string | null, now: string, nodes: number, capture: boolean, maxNodes = MAX_BAKE_NODES): boolean {
  return needsBake(baked, now) && (capture || nodes <= maxNodes);
}
/** Capture waits at most this long for a bake (a throttled/occluded host would otherwise hit the worker's 30 s deadline). */
export const SETTLE_TIMEOUT_MS = 1500;
/** Idle debounce after a scrub/refresh/resize. */
export const BAKE_DEBOUNCE_MS = 80;

export interface RasterKeeper {
  /** The stage is at rest (a paint with no flight running). `end` = a flight just finished by itself: bake now, no debounce. */
  rest(end?: boolean): void;
  /** A flight is running: cancel any pending re-bake. */
  flying(): void;
  /** Capture: re-bake now if the pose/scale changed. Resolves when done (or after SETTLE_TIMEOUT_MS). */
  settle(): Promise<void>;
  /** Re-bakes performed (probes and gates). */
  count(): number;
  dispose(): void;
}
const NOOP: RasterKeeper = { rest() {}, flying() {}, settle: () => Promise.resolve(), count: () => 0, dispose() {} };
const RAF = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function createRasterKeeper(cam: HTMLElement, mount: HTMLElement, opts: { capture?: boolean; debounceMs?: number; maxNodes?: number } = {}): RasterKeeper {
  // Headless hosts (linkedom gates, flux-core SSR) have no frames, no layout and no `window`: the keeper is inert there.
  if (typeof requestAnimationFrame !== "function" || typeof window === "undefined" || typeof mount.getBoundingClientRect !== "function") return NOOP;
  const capture = !!opts.capture, debounceMs = opts.debounceMs ?? BAKE_DEBOUNCE_MS, maxNodes = opts.maxNodes ?? MAX_BAKE_NODES;
  let baked: string | null = null, timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | null = null;
  let dirty = false, disposed = false, done = 0, token = 0, endPending = false;
  const key = (): string => bakeKey(cam.style.transform, mount.getBoundingClientRect().width / (mount.offsetWidth || 1), window.devicePixelRatio || 1);
  const clear = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  async function bake(): Promise<void> {
    const mine = ++token;
    try {
      await RAF();                                 // enter the rAF phase: what we assign next is rendered by THIS frame
      if (disposed || mine !== token) return;
      cam.style.willChange = "auto";
      await RAF();                                 // the stage was painted un-promoted at the current pose
    } finally {
      if (!disposed) cam.style.willChange = "transform"; // the fresh layer bakes the current scale + offset
    }
    if (disposed) return;
    baked = key();
    await RAF();                                   // ... and is committed before anyone captures
    done++;
  }
  function run(): Promise<void> {
    clear(); endPending = false;
    if (disposed || !dirty) return running ?? Promise.resolve();
    dirty = false;
    try {
      if (baked === null) { baked = key(); return running ?? Promise.resolve(); }
      const now = key();
      // The re-bake records the layer's display list on the main thread: skip it on a heavy slide (live only; the count is
      // taken only when the key changed, ~1 ms per 100k nodes).
      if (!needsBake(baked, now) || !shouldBake(baked, now, capture ? 0 : cam.getElementsByTagName("*").length, capture, maxNodes)) return running ?? Promise.resolve();
    } catch { return running ?? Promise.resolve(); }
    const next = (running ?? Promise.resolve()).then(bake).catch(() => {}).finally(() => { if (running === next) running = null; });
    running = next;
    return next;
  }
  // The first layer is rasterized by the first frame after creation (host fit, camera pose already applied): record its key then,
  // so a flight that starts inside the first debounce window is still compared against the pose the raster was baked at.
  void RAF().then(() => { if (baked === null && !disposed) { try { baked = key(); } catch { /* run() records it */ } } });
  return {
    rest(end = false) {
      dirty = true;
      if (capture) return;
      if (endPending) return;                     // the paint that follows a natural flight end must not push the bake out
      clear();
      if (end) endPending = true;
      timer = setTimeout(() => { timer = undefined; void run(); }, end ? 0 : debounceMs);
    },
    flying() { dirty = false; endPending = false; token++; clear(); },
    settle: () => new Promise<void>((resolve) => { const t = setTimeout(resolve, SETTLE_TIMEOUT_MS); void run().then(() => { clearTimeout(t); resolve(); }); }),
    count: () => done,
    dispose() { disposed = true; token++; clear(); cam.style.willChange = "transform"; },
  };
}
