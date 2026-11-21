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
import { frameLayers, imageClipCacheKey, matteRgba, mixRgba, planImageClip, tweenPictureView, type ImageClip, type ImageClipRequest } from "../src/lib/fluximg/clipPlan";
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
 * Encoder settings (measured 2026-11-21 on synthetic two-channel stacks; see the export gate's numbers):
 *   - `-g 15 -bf 0`: a keyframe every 15 frames and no B-frames, so a seek decodes at most 14 frames forward (an
 *     all-intra clip seeks in one frame but repeats of an unchanged plane each cost a whole I-frame);
 *   - `-crf 12 -preset medium -tune stillimage`: a scientific image's fine structure survives 4:2:0;
 *   - the slide-video colour constants (BT.709, limited range, tagged), so a clip matches an exported slide video.
 */
export const IMAGE_CLIP_SETTINGS = { crf: 12, gop: 15, preset: "medium", tune: "stillimage" } as const;
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

/** The clip of `request` (baked, or found in the cache). Throws `ImageClipUnavailable` without an encoder. */
export async function bakeImageClip(root: string, asset: Asset, request: ImageClipRequest, ease: (raw: number) => number, options: BakeOptions = {}): Promise<BakedClip> {
  const t0 = performance.now();
  const encoder = options.encoder === undefined ? await imageClipEncoder() : options.encoder;
  if (!encoder) throw new ImageClipUnavailable();
  const settings = options.settings ?? IMAGE_CLIP_SETTINGS;
  const session = options.session ?? fluximgRenderSession();
  const base = await fluximgReader(root, asset, session);
  const manifest = base.manifest;
  const plan = planViewTween(manifest, request.pre, request.end, { blend: request.blend });
  const { width: W, height: H } = request;
  const clip = planImageClip(manifest, plan, ease, request.durationMs, W, H);
  const key = imageClipCacheKey(request, clip.fps, clip.frames.length, encoder.identity, settingsKey(settings));
  const dir = options.cacheDir ?? safeJoin(root, "fig/renders/fluximg");
  const file = path.join(dir, `${key}.mp4`);
  const meta = { fps: clip.fps, frames: clip.frames.length, durationMs: request.durationMs, width: W, height: H, key };
  try { const st = await fs.stat(file); if (st.isFile() && st.size > 0) return { ...meta, file, cached: true }; } catch { /* a miss: bake */ }
  if (options.signal?.aborted) throw aborted();

  await fs.mkdir(dir, { recursive: true });
  await ensureColormapLuts();
  const stats: BakeStats = { frames: clip.frames.length, distinct: clip.distinct, pictures: 0, readMs: 0, renderMs: 0, encodeWaitMs: 0, totalMs: 0, bytes: 0 };
  const reader = timedReader(base, stats);
  // Decoded pieces for this bake only, capped: a walk reads each plane once, a contrast glide reads one plane once.
  const pieces = new Map<string, FluximgTypedArray>(); let pieceBytes = 0;
  const cache = { get: (k: string) => pieces.get(k), set: (k: string, v: FluximgTypedArray) => {
    pieces.set(k, v); pieceBytes += v.byteLength;
    while (pieceBytes > 256 * 1024 * 1024 && pieces.size > 1) { const [first, old] = pieces.entries().next().value as [string, FluximgTypedArray]; pieces.delete(first); pieceBytes -= old.byteLength; }
  } };
  // The last few drawn pictures: a mix or a blend shares its pictures with the frames around it.
  const drawn = new Map<string, Uint8ClampedArray>();
  const draw = async (p: TweenPicture): Promise<Uint8ClampedArray> => {
    const k = pixelKey(manifest, p.view, p.crop, W, H), hit = drawn.get(k);
    if (hit) { drawn.delete(k); drawn.set(k, hit); return hit; }
    const r0 = performance.now(), before = stats.readMs;
    const s = await renderStill(reader, { view: tweenPictureView(p.view), crop: p.crop, outWidth: W, outHeight: H }, { resolveLut: resolveFluximgLut, cache, cacheScope: asset.id, cancelled: () => !!options.signal?.aborted });
    stats.renderMs += performance.now() - r0 - (stats.readMs - before); stats.pictures++;
    drawn.set(k, s.rgba);
    if (drawn.size > 6) drawn.delete(drawn.keys().next().value as string);
    return s.rgba;
  };

  const { VIDEO_COLOR_FILTER, VIDEO_COLOR_TAGS } = colorConstants();
  const tmp = path.join(dir, `.${key}.tmp-${randomUUID()}.mp4`);
  const child = spawn(encoder.path, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-framerate", String(clip.fps), "-i", "pipe:0",
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
      const f = clip.frames[i];
      // Never draw a frame twice: an unchanged picture is the same bytes again.
      if (f.key !== last || !pixels) {
        const L = frameLayers(f.frame);
        const one = async (a: TweenPicture, b: TweenPicture | null) => (b ? mixRgba(await draw(a), await draw(b), L.mix) : await draw(a));
        let rgba = await one(L.a, L.b);
        if (L.there) rgba = mixRgba(rgba, await one(L.there.a, L.there.b), L.weight);
        // The matte writes in place: never into a picture the cache may hand out again.
        pixels = matteRgba(rgba === drawn.get(pixelKey(manifest, L.a.view, L.a.crop, W, H)) ? rgba.slice() : rgba, request.matte);
        last = f.key;
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
    return { ...meta, file, cached: false, stats };
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
