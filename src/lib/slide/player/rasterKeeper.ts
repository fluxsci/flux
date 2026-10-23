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
export function needsBake(baked: string | null, now: string, tolerant = false): boolean { return baked !== null && baked !== now && !(tolerant && withinBakeTolerance(baked, now)); }
/** LIVE keepers only (needsBake `tolerant`): a raster baked this close to the pose it now sits at is the same raster, and re-baking it
 *  would be a second sharpening step (and a one-frame un-promoted anti-aliasing flip) on a still frame for an error nobody can see.
 *  Same host scale and dpr, zoom within BAKE_TOLERANCE_ZOOM (0.01 %: 0.2 px at the far edge of a 1920 px stage) and the offset within
 *  BAKE_TOLERANCE_PX (a tenth of a pixel: a layer is resampled by the fraction it is off). It covers the early bake of a flight, which
 *  is taken at the pose the flight LANDS on (EARLY_BAKE_LEAD_FRAMES), so what it forgives is rounding and a frame that came a little
 *  early or late, never a visible part of the travel. A pure pan (`translate(x, y)`, no scale) and the identity pose ("") count. Pure. */
export function withinBakeTolerance(a: string, b: string): boolean {
  const [pa, ha, da] = a.split("|"), [pb, hb, db] = b.split("|");
  if (ha !== hb || da !== db) return false;
  const x = poseNumbers(pa), y = poseNumbers(pb);
  if (!x || !y) return false;
  return Math.abs(x[2] / y[2] - 1) < BAKE_TOLERANCE_ZOOM && Math.abs(x[0] - y[0]) < BAKE_TOLERANCE_PX && Math.abs(x[1] - y[1]) < BAKE_TOLERANCE_PX;
}
export const BAKE_TOLERANCE_ZOOM = 1e-4;
export const BAKE_TOLERANCE_PX = 0.1;
/** Pure: [x, y, zoom] of a camera pose string (`translate(x px, y px) scale(z)`, a bare translate, or "" = identity); null when unreadable. */
function poseNumbers(pose: string): [number, number, number] | null {
  if (pose.trim() === "") return [0, 0, 1];
  const n = pose.match(/-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
  if (!n || (n.length !== 2 && n.length !== 3) || n.some(v => !Number.isFinite(v)) || (n.length === 3 && n[2] === 0)) return null;
  return [n[0], n[1], n.length === 3 ? n[2] : 1];
}
/** Pure: the key of everything a will-change layer freezes at its first raster. */
export function bakeKey(pose: string, hostScale: number, dpr: number): string { return `${pose}|${hostScale.toFixed(4)}|${dpr}`; }
/** Live re-bakes are skipped above this many DOM nodes under the camera layer: the display-list record is
 *  main-thread work (measured, Electron offscreen, SwiftShader: worst rAF gap 17/27/80/125/177/232 ms at
 *  2k/20k/40k/60k/80k/100k paths). 30 000 keeps the gap <= ~50 ms (3 frames). Capture ignores it. */
export const MAX_BAKE_NODES = 30000;
/** Pure: bake iff the key changed and (capture, or the layer is light enough for an interactive re-bake). */
export function shouldBake(baked: string | null, now: string, nodes: number, capture: boolean, maxNodes = MAX_BAKE_NODES): boolean {
  // Capture is exact (every pose change re-bakes); only a LIVE keeper accepts a raster within tolerance of the pose.
  return needsBake(baked, now, !capture) && (capture || nodes <= maxNodes);
}
/** Capture waits at most this long for a bake (a throttled/occluded host would otherwise hit the worker's 30 s deadline). */
export const SETTLE_TIMEOUT_MS = 1500;
/** A re-bake is two frame hops: the hint drops in one frame and goes back in the next, and the fresh layer rasterises the pose of THAT
 *  frame. A flight that triggers `early()` this many frames before it lands therefore bakes the pose it lands on, under the last of the
 *  motion, and its landing finds the raster already right (no step on a still frame, no second bake). Measured on the compositor
 *  (offscreen Electron, GPU): baked at the pose of the landing frame, 0.0 change at and after landing on a pan and a 3x zoom. */
export const EARLY_BAKE_LEAD_FRAMES = 2;
/** Pure: is a camera flight that has `remainingMs` of cue time left (spec delay + duration - time), with the clock advancing `frameMs` per
 *  presented frame, within the early-bake lead of landing? Time-based, not progress-based: a progress threshold is a fixed fraction of the
 *  TRAVEL (0.5 % of a 1000 px pan is 5 px), the lead is a fixed number of frames whatever the travel and the curve. */
export function earlyBakeDue(remainingMs: number, frameMs: number): boolean { return remainingMs <= EARLY_BAKE_LEAD_FRAMES * frameMs; }
/** Idle debounce after a scrub/refresh/resize. */
export const BAKE_DEBOUNCE_MS = 80;

export interface RasterKeeper {
  /** The stage is at rest (a paint with no flight running). `end` = a flight just finished by itself: bake now, no debounce. */
  rest(end?: boolean): void;
  /** A flight is running: cancel any pending re-bake (an `early()` bake in progress is kept). */
  flying(): void;
  /** A zoom/pan flight is EARLY_BAKE_LEAD_FRAMES from landing: re-bake NOW, so the fresh layer rasterises the landing pose under the motion
   *  that is left and the sharpening is hidden in it instead of landing on a still frame. Once per flight: `flight` names it (the same
   *  object on every frame of one flight; a second flight of the cue bakes again), reset by the next rest(). */
  early(flight?: unknown): void;
  /** Capture: re-bake now if the pose/scale changed. Resolves when done (or after SETTLE_TIMEOUT_MS). */
  settle(): Promise<void>;
  /** Re-bakes performed (probes and gates). */
  count(): number;
  dispose(): void;
}
const NOOP: RasterKeeper = { rest() {}, flying() {}, early() {}, settle: () => Promise.resolve(), count: () => 0, dispose() {} };
const RAF = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function createRasterKeeper(cam: HTMLElement, mount: HTMLElement, opts: { capture?: boolean; debounceMs?: number; maxNodes?: number } = {}): RasterKeeper {
  // Headless hosts (linkedom gates, flux-core SSR) have no frames, no layout and no `window`: the keeper is inert there.
  if (typeof requestAnimationFrame !== "function" || typeof window === "undefined" || typeof mount.getBoundingClientRect !== "function") return NOOP;
  const capture = !!opts.capture, debounceMs = opts.debounceMs ?? BAKE_DEBOUNCE_MS, maxNodes = opts.maxNodes ?? MAX_BAKE_NODES;
  let baked: string | null = null, timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | null = null;
  let dirty = false, disposed = false, done = 0, token = 0, endPending = false, earlyBaking = false;
  let earlyFor = new Set<unknown>();
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
  /** Is a re-bake due NOW (judged when it would run, never when it was asked for: a bake in flight may already have made it unnecessary)?
   *  The re-bake records the layer's display list on the main thread, so it is skipped on a heavy slide (live only; the node count is
   *  taken only when the key changed, ~1 ms per 100k nodes). */
  const due = (): boolean => {
    try { const now = key(); return baked !== null && needsBake(baked, now, !capture) && shouldBake(baked, now, capture ? 0 : cam.getElementsByTagName("*").length, capture, maxNodes); } catch { return false; }
  };
  function run(): Promise<void> {
    clear(); endPending = false;
    if (disposed || !dirty) return running ?? Promise.resolve();
    dirty = false;
    if (baked === null) { try { baked = key(); } catch { /* inert */ } return running ?? Promise.resolve(); }
    if (!running && !due()) return Promise.resolve();
    // Queued behind a bake in flight (an early bake whose flight has just landed): decided again when it is this bake's turn, so the
    // landing never bakes a second time for a pose the early bake already took.
    const next = (running ?? Promise.resolve()).then(() => due() ? bake() : undefined).catch(() => {}).finally(() => { if (running === next) running = null; });
    running = next;
    return next;
  }
  // The first layer is rasterized by the first frame after creation (host fit, camera pose already applied): record its key then,
  // so a flight that starts inside the first debounce window is still compared against the pose the raster was baked at.
  void RAF().then(() => { if (baked === null && !disposed) { try { baked = key(); } catch { /* run() records it */ } } });
  return {
    rest(end = false) {
      earlyFor = new Set();
      dirty = true;
      if (capture) return;
      if (endPending) return;                     // the paint that follows a natural flight end must not push the bake out
      clear();
      if (end) endPending = true;
      timer = setTimeout(() => { timer = undefined; void run(); }, end ? 0 : debounceMs);
    },
    flying() { dirty = false; endPending = false; if (!earlyBaking) token++; clear(); },
    early(flight: unknown = null) {
      if (earlyFor.has(flight) || earlyBaking || disposed || capture) return;
      earlyFor.add(flight);
      try { if (baked === null || !shouldBake(baked, key(), cam.getElementsByTagName("*").length, false, maxNodes)) return; } catch { return; }
      earlyBaking = true; dirty = true;
      const next = (running ?? Promise.resolve()).then(bake).catch(() => {}).finally(() => { earlyBaking = false; if (running === next) running = null; });
      running = next;
    },
    settle: () => new Promise<void>((resolve) => { const t = setTimeout(resolve, SETTLE_TIMEOUT_MS); void run().then(() => { clearTimeout(t); resolve(); }); }),
    count: () => done,
    dispose() { disposed = true; token++; clear(); cam.style.willChange = "transform"; },
  };
}
