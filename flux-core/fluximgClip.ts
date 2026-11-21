/**
 * Baking an image Change into an MP4 in plain Node (stage 2, W7; plan D8): the frames `fluximg/clipPlan.ts` says a
 * clip shows, drawn by the reference renderer (`still.renderStill`, one picture at a time, mixed by the reference's
 * straight per-component lerp), composited over the slide's background, piped RAW into the pinned encoder with the
 * slide-video colour filter and tags. No Electron, no browser.
 *
 * Bounded: one frame in flight (the encoder's pipe is the backpressure), a few rendered pictures kept for repeats and
 * mixes, decoded planes in a byte-capped cache. Cancellable (the partial file is removed). Cached in the project's
 * render cache by content (`fig/renders/fluximg/<key>.mp4`, the model posters' sibling): the asset's content id, both
 * ends, the blend, the curve, the duration, the rate, the size, the matte, the encoder and its settings.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Asset } from "../src/lib/types";
import type { FluximgTypedArray } from "../src/lib/fluximg/types";
import type { FluximgReader } from "../src/lib/fluximg/reader";
import { renderStill } from "../src/lib/fluximg/still";
import { planViewTween, type TweenPicture } from "../src/lib/fluximg/viewTween";
import { pixelKey } from "../src/lib/fluximg/viewOps";
import { ensureColormapLuts } from "../src/lib/color/colormapLuts";
import { frameLayers, imageClipCacheKey, type ClipFrame, matteRgba, mixRgba, planImageClip, planPlaybackClip, playbackRate, tweenPictureView, type ImageClip, type ImageClipPlan, type ImageClipRequest, type ImagePlaybackRequest } from "../src/lib/fluximg/clipPlan";
import { resolveView } from "../src/lib/fluximg/viewOps";
import { clampCrop } from "../src/lib/fluximg/crop";
import { ImageClipUnavailable } from "../src/lib/slide/payloadImages";
import { fluximgReader, fluximgRenderSession, resolveFluximgLut, type FluximgRenderSession } from "./fluximgRender";
import { safeJoin } from "./model";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function electronModule<T>(name: string): T {
  const appRoot = process.env.FLUX_VIDEO_APP_ROOT || path.resolve(here, "..");
  return require(path.join(appRoot, "electron", name)) as T;
}

/**
 * Encoder settings, measured 2026-11-21 on a synthetic 512 x 512 two-channel uint16 stack drawn at the slide scale
 * (1024 x 1024 clips; a 4 s linear walk of 48 planes = 241 frames at 60 fps, 48 distinct pictures):
 *   - GOP: all-intra (`-g 1`) 15.3 MB, `-g 15` 1.9 MB, `-g 60` 0.7 MB (CRF 15-18). `-g 15 -bf 0`: a seek decodes at most
 *     14 frames forward and lands frame-exactly; all-intra costs 8x the bytes for repeats of an unchanged plane.
 *   - CRF 15: decoded mean channel error 1.03/255 against the reference frames (CRF 12: 0.97, CRF 18: 1.07; the
 *     maxima, ~100/255 at one-pixel colour edges, are 4:2:0 chroma and barely move with CRF), 1.9 MB vs 3.1 MB (12).
 *   - the slide-video colour constants (BT.709, limited range, tagged), so a clip matches an exported slide video.
 */
export const IMAGE_CLIP_SETTINGS = { crf: 15, gop: 15, preset: "medium", tune: "stillimage" } as const;
export type ImageClipSettings = { crf: number; gop: number; preset: string; tune?: string };
const settingsKey = (s: ImageClipSettings) => `crf${s.crf}-g${s.gop}-${s.preset}${s.tune ? `-${s.tune}` : ""}-bf0-${colorConstants().VIDEO_COLOR_FILTER}`;

function colorConstants(): { VIDEO_COLOR_FILTER: string; VIDEO_COLOR_TAGS: string[] } {
  return electronModule("slideVideoWorker.cjs");
}

/** The pinned encoder and its identity (the binary hash its manifest records), or null when it is not installed. */
export async function imageClipEncoder(): Promise<{ path: string; identity: string } | null> {
  const file = electronModule<{ encoderPath(appRoot?: string): string }>("videoMedia.cjs").encoderPath(process.env.FLUX_VIDEO_APP_ROOT || path.resolve(here, ".."));
  let stat;
  try { stat = await fs.stat(file); } catch { return null; }
  if (!stat.isFile()) return null;
  let identity = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  try { const m = JSON.parse(await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8")); if (typeof m.binaryHash === "string") identity = m.binaryHash; } catch { /* a bare binary: size and time */ }
  return { path: file, identity };
}

export interface BakeStats { frames: number; distinct: number; pictures: number; readMs: number; renderMs: number; encodeWaitMs: number; totalMs: number; bytes: number }
export interface BakeOptions {
  session?: FluximgRenderSession;
  signal?: AbortSignal;
  onProgress?: (p: { frame: number; total: number }) => void;
  encoder?: { path: string; identity: string } | null;
  settings?: ImageClipSettings;
  /** Default: the project's render cache, `fig/renders/fluximg`. */
  cacheDir?: string;
}
export interface BakedClip extends Omit<ImageClip, "url"> { file: string; cached: boolean; stats?: BakeStats; key: string }

function aborted(): Error { const e = new Error("Image clip cancelled"); e.name = "AbortError"; return e; }

/** A reader whose reads are timed (where a bake spends its time: reads vs drawing). */
function timedReader(reader: FluximgReader, stats: { readMs: number }): FluximgReader {
  const time = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { const t0 = performance.now(); try { return await fn(...a); } finally { stats.readMs += performance.now() - t0; } };
  return { ...reader, level: time(reader.level.bind(reader)), array: time(reader.array.bind(reader)), readRegion: time(reader.readRegion.bind(reader)), readPlane: time(reader.readPlane.bind(reader)), readChunk: time(reader.readChunk.bind(reader)) } as FluximgReader;
}

/** The clip of `request` (baked, or found in the cache): a Change (with its curve `ease`) or a running movie (`ease`
 *  unused). Throws `ImageClipUnavailable` without an encoder. */
export async function bakeImageClip(root: string, asset: Asset, request: ImageClipRequest | ImagePlaybackRequest, ease: (raw: number) => number, options: BakeOptions = {}): Promise<BakedClip> {
  const t0 = performance.now();
  const encoder = options.encoder === undefined ? await imageClipEncoder() : options.encoder;
  if (!encoder) throw new ImageClipUnavailable();
  const settings = options.settings ?? IMAGE_CLIP_SETTINGS;
  const session = options.session ?? fluximgRenderSession();
  const base = await fluximgReader(root, asset, session);
  const manifest = base.manifest;
  const { width: W, height: H } = request;
  let clip: ImageClipPlan, rate: string, durationMs: number;
  if (request.kind === "playback") {
    const state: TweenPicture = { view: resolveView(manifest, request.state.view), crop: clampCrop(manifest, request.state.crop) };
    clip = planPlaybackClip(manifest, state, request.playback, W, H);
    rate = playbackRate(request.playback.periodMs); durationMs = clip.frames.length * request.playback.periodMs;
  } else {
    clip = planImageClip(manifest, planViewTween(manifest, request.pre, request.end, { blend: request.blend }), ease, request.durationMs, W, H);
    rate = String(clip.fps); durationMs = request.durationMs;
  }
  const key = imageClipCacheKey(request, clip.fps, clip.frames.length, encoder.identity, settingsKey(settings));
  const dir = options.cacheDir ?? safeJoin(root, "fig/renders/fluximg");
  const file = path.join(dir, `${key}.mp4`);
  const meta = { fps: clip.fps, frames: clip.frames.length, durationMs, width: W, height: H, key, ...(request.kind === "playback" && request.playback.mode !== "once" ? { loop: true } : {}) };
  try {
    const st = await fs.stat(file);
    if (st.isFile() && st.size > 0) {
      // Least-recently-used bookkeeping for the cache's prune (`pruneImageClipCache`).
      const now = new Date(); await fs.utimes(file, now, now).catch(() => {});
      return { ...meta, file, cached: true };
    }
  } catch { /* a miss: bake */ }
  if (options.signal?.aborted) throw aborted();

  await fs.mkdir(dir, { recursive: true });
  const stats = await encodeImageFrames({ reader: base, assetId: asset.id, clip, width: W, height: H, rate, matte: request.matte }, file, encoder, settings, options);
  stats.totalMs = performance.now() - t0;
  return { ...meta, file, cached: false, stats };
}

/** One pass of frames through the pinned encoder: what a deck clip and an image's movie file have in common. */
export interface FramePass {
  reader: FluximgReader;
  assetId: string;
  clip: Pick<ImageClipPlan, "frames" | "distinct">;
  /** The drawn picture's size (what `renderStill` draws). */
  width: number;
  height: number;
  /** The encoder's frame rate (a number or an exact rational). */
  rate: string;
  /** Transparent pixels land on this colour (an MP4 has no alpha). */
  matte: string;
  /** The file's size when it is not the picture's (a movie pads to even sides). */
  out?: { width: number; height: number };
  /** After the matte, before the encoder: lays what is drawn over the pixels (a movie's vectors and furniture) and pads.
   *  Gets pixels it may change in place; returns the file-sized frame. */
  finish?: (frame: ClipFrame, index: number, pixels: Uint8ClampedArray) => Promise<Uint8ClampedArray> | Uint8ClampedArray;
  /** The identity of a frame's FINISHED pixels (default: the planned key; a movie adds its stamp). */
  frameKey?: (frame: ClipFrame, index: number) => string;
  /** Decoded pieces kept for this pass, in bytes (default 256 MiB). */
  pieceBudget?: number;
}

/**
 * Draw `pass.clip`'s frames with the reference renderer and encode them into `file` (written beside it under a
 * temporary name, synced, then renamed: a cancelled or failed pass leaves nothing). One frame in flight; a picture is
 * drawn once per run of equal frames; decoded pieces stay under `pieceBudget`.
 */
export async function encodeImageFrames(pass: FramePass, file: string, encoder: { path: string }, settings: ImageClipSettings, options: Pick<BakeOptions, "signal" | "onProgress"> = {}): Promise<BakeStats> {
  const t0 = performance.now();
  const { clip, width: W, height: H } = pass;
  const manifest = pass.reader.manifest, budget = pass.pieceBudget ?? 256 * 1024 * 1024;
  const out = pass.out ?? { width: W, height: H };
  await ensureColormapLuts();
  const stats: BakeStats = { frames: clip.frames.length, distinct: clip.distinct, pictures: 0, readMs: 0, renderMs: 0, encodeWaitMs: 0, totalMs: 0, bytes: 0 };
  const reader = timedReader(pass.reader, stats);
  // Decoded pieces for this bake only, capped: a walk reads each plane once, a contrast glide reads one plane once.
  const pieces = new Map<string, FluximgTypedArray>(); let pieceBytes = 0;
  const cache = { get: (k: string) => pieces.get(k), set: (k: string, v: FluximgTypedArray) => {
    pieces.set(k, v); pieceBytes += v.byteLength;
    while (pieceBytes > budget && pieces.size > 1) { const [first, old] = pieces.entries().next().value as [string, FluximgTypedArray]; pieces.delete(first); pieceBytes -= old.byteLength; }
  } };
  // The last few drawn pictures: a mix or a blend shares its pictures with the frames around it.
  const drawn = new Map<string, Uint8ClampedArray>();
  const draw = async (p: TweenPicture): Promise<Uint8ClampedArray> => {
    const k = pixelKey(manifest, p.view, p.crop, W, H), hit = drawn.get(k);
    if (hit) { drawn.delete(k); drawn.set(k, hit); return hit; }
    const r0 = performance.now(), before = stats.readMs;
    const s = await renderStill(reader, { view: tweenPictureView(p.view), crop: p.crop, outWidth: W, outHeight: H }, { resolveLut: resolveFluximgLut, cache, cacheScope: pass.assetId, cancelled: () => !!options.signal?.aborted });
    stats.renderMs += performance.now() - r0 - (stats.readMs - before); stats.pictures++;
    drawn.set(k, s.rgba);
    if (drawn.size > 6) drawn.delete(drawn.keys().next().value as string);
    return s.rgba;
  };

  const { VIDEO_COLOR_FILTER, VIDEO_COLOR_TAGS } = colorConstants();
  const tmp = path.join(path.dirname(file), `.${path.basename(file, ".mp4")}.tmp-${randomUUID()}.mp4`);
  const child = spawn(encoder.path, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${out.width}x${out.height}`, "-framerate", pass.rate, "-i", "pipe:0",
    "-an", "-vf", VIDEO_COLOR_FILTER, "-c:v", "libx264", "-preset", settings.preset, ...(settings.tune ? ["-tune", settings.tune] : []), "-crf", String(settings.crf),
    "-g", String(settings.gop), "-keyint_min", String(Math.min(settings.gop, 1)), "-sc_threshold", "0", "-bf", "0",
    ...VIDEO_COLOR_TAGS, "-threads", "2", "-movflags", "+faststart", "-f", "mp4", tmp], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-8000); });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `the video encoder exited ${code}`))));
  });
  closed.catch(() => {});
  const kill = () => { if (child.exitCode === null) child.kill("SIGKILL"); };
  options.signal?.addEventListener("abort", kill);
  child.stdin.on("error", () => {});
  const write = (buf: Uint8ClampedArray) => new Promise<void>((resolve, reject) => {
    const w0 = performance.now();
    child.stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), (error) => { stats.encodeWaitMs += performance.now() - w0; error ? reject(error) : resolve(); });
  });
  try {
    let last = "", pixels: Uint8ClampedArray | null = null, reported = 0;
    for (let i = 0; i < clip.frames.length; i++) {
      if (options.signal?.aborted) throw aborted();
      const f = clip.frames[i], fk = pass.frameKey ? pass.frameKey(f, i) : f.key;
      // Never draw a frame twice: an unchanged picture is the same bytes again.
      if (fk !== last || !pixels) {
        const L = frameLayers(f.frame);
        const one = async (a: TweenPicture, b: TweenPicture | null) => (b ? mixRgba(await draw(a), await draw(b), L.mix) : await draw(a));
        let rgba = await one(L.a, L.b);
        if (L.there) rgba = mixRgba(rgba, await one(L.there.a, L.there.b), L.weight);
        // The matte writes in place: never into a picture the cache may hand out again.
        pixels = matteRgba(rgba === drawn.get(pixelKey(manifest, L.a.view, L.a.crop, W, H)) ? rgba.slice() : rgba, pass.matte);
        if (pass.finish) pixels = await pass.finish(f, i, pixels);
        last = fk;
      }
      if (child.exitCode !== null) { await closed; throw new Error("the video encoder stopped before the last frame"); }
      await write(pixels);
      if (options.onProgress && (i === 0 || i === clip.frames.length - 1 || performance.now() - reported > 150)) { options.onProgress({ frame: i + 1, total: clip.frames.length }); reported = performance.now(); }
    }
    child.stdin.end();
    await closed;
    if (options.signal?.aborted) throw aborted();
    const handle = await fs.open(tmp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
    stats.bytes = (await fs.stat(file)).size;
    stats.totalMs = performance.now() - t0;
    return stats;
  } catch (error) {
    kill();
    await closed.catch(() => {});
    throw options.signal?.aborted ? aborted() : error;
  } finally {
    options.signal?.removeEventListener("abort", kill);
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** The project cache's clip names (a key names its content). */
export const isImageClipName = (name: string): boolean => /^fxc-[\da-f]{16}\.mp4$/.test(name);

/**
 * The clip cache's bounds (review C3), its siblings' rule: the 3D poster caches drop what has not been used for 14 days
 * and cap the shared cache at 1 GiB, least recently used first. A clip is derived (its key names its content and the
 * encoder re-bakes the same bytes), so a pruned clip costs only a re-bake at the next export that needs it. The cache
 * grows only when an export bakes, so it is bounded right there; the clips that export uses are never pruned.
 */
export const IMAGE_CLIP_CACHE_LIMITS = Object.freeze({ maxBytes: 1024 * 1024 * 1024, olderThanDays: 14 });
export interface CachedClipEntry { name: string; size: number; mtimeMs: number }
/** Pure prune plan: clips unused for `olderThanDays` go first, then least recently used (mtime is touched on every
 *  hit) until the cache fits `maxBytes`. `protect` holds the keys (names without `.mp4`) the current export uses. */
export function planImageClipPrune(entries: readonly CachedClipEntry[], protect: ReadonlySet<string>, now = Date.now(), limits: { maxBytes: number; olderThanDays: number } = IMAGE_CLIP_CACHE_LIMITS): string[] {
  const valid = entries.filter((e) => isImageClipName(e.name) && Number.isFinite(e.size) && Number.isFinite(e.mtimeMs));
  const kept = (e: CachedClipEntry) => protect.has(e.name.slice(0, -4));
  const cutoff = now - limits.olderThanDays * 86400_000, removed = new Set<string>();
  for (const e of valid) if (e.mtimeMs < cutoff && !kept(e)) removed.add(e.name);
  let total = valid.filter((e) => !removed.has(e.name)).reduce((n, e) => n + e.size, 0);
  for (const e of [...valid].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
    if (total <= limits.maxBytes) break;
    if (removed.has(e.name) || kept(e)) continue;
    removed.add(e.name); total -= e.size;
  }
  return valid.map((e) => e.name).filter((n) => removed.has(n));
}
/** Apply `planImageClipPrune` to a project's clip cache (`fig/renders/fluximg`); returns the removed names. Only
 *  regular `fxc-*.mp4` files are candidates (a bake in flight writes a temporary name). */
export async function pruneImageClipCache(root: string, options: { protect?: ReadonlySet<string>; now?: number; limits?: { maxBytes: number; olderThanDays: number }; dir?: string } = {}): Promise<string[]> {
  const dir = options.dir ?? safeJoin(root, "fig/renders/fluximg"), entries: CachedClipEntry[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!isImageClipName(name)) continue;
    const stat = await fs.lstat(path.join(dir, name)).catch(() => undefined);
    if (stat?.isFile()) entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const removed: string[] = [];
  for (const name of planImageClipPrune(entries, options.protect ?? new Set(), options.now, options.limits)) {
    try { await fs.rm(path.join(dir, name)); removed.push(name); } catch { /* another export pruned it */ }
  }
  return removed;
}
