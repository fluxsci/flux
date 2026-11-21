/**
 * An image's movie as a file (stage 2, W10): one image element, played along one dimension, written as an H.264 MP4
 * that PowerPoint, Keynote, a browser and a journal's supplement all take.
 *
 * The picture is the element as Flux draws it at rest: its crop, its view, its label and vector layers with their
 * styling, its furniture (the time stamp ADVANCING with the frames), over the document's background. The frames are
 * planned by `fluximg/moviePlan.ts` (which uses the deck clips' planners) and drawn and encoded by the deck clips' baker
 * (`fluximgClip.encodeImageFrames`: the reference renderer, the pinned encoder, the slide-video colour tags, +faststart);
 * this module only adds what a file has that a deck clip does not: the vectors and furniture rasterized over each frame
 * (a deck keeps them as SVG), the element's mirror, and a pixel of matte to make the sides even.
 *
 * The overlay is rasterized by resvg in ONE child process per movie (a pathological SVG can panic resvg, as
 * `render.ts` explains): everything but the stamp once, and the stamp per distinct text, many to a call (a strip of
 * stamps), since resvg loads the system fonts on every call.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Asset, Figure, Project } from "../src/lib/types";
import type { FluximgElement } from "../src/lib/fluximg/element";
import type { FluximgManifest, FluximgTable } from "../src/lib/fluximg/types";
import type { ResolvedView } from "../src/lib/fluximg/view";
import type { ClipFrame } from "../src/lib/fluximg/clipPlan";
import { resolveView } from "../src/lib/fluximg/viewOps";
import { clampCrop } from "../src/lib/fluximg/crop";
import { fluximgIdPrefix, fluximgStaticSvg, insetsOf, unflipTransform } from "../src/lib/fluximg/static";
import { furnitureSvg, stampLines } from "../src/lib/fluximg/furniture";
import { fluximgLayerFiles, fluximgTableFiles } from "../src/lib/fluximg/exportStatic";
import { sanitizeLayerSvg, svgNum } from "../src/lib/fluximg/layers";
import { colormapLut, ensureColormapLuts } from "../src/lib/color/colormapLuts";
import { MovieRequestError, hasDecorationView, movieFileName, planMovieClip, resolveMovie, type MovieOptions, type MovieSettings } from "../src/lib/fluximg/moviePlan";
import { effectiveHidden } from "../src/lib/groups";
import { resolveTheme } from "../src/lib/slide/theme";
import type { Deck, Slide } from "../src/lib/slide/types";
import { encodeImageFrames, imageClipEncoder, IMAGE_CLIP_SETTINGS, type BakeStats, type ImageClipSettings } from "./fluximgClip";
import { fluximgReader, fluximgRenderSession } from "./fluximgRender";
import { deckImageAsset, findImage, findSlideTarget, imageAsset } from "./fluximg";
import { loadFigModel } from "./model";
import { compileDeckSlide, loadDeck } from "./slides";
import { NotFoundError, ValidationError } from "./errors";

export interface ImageMovieRequest extends MovieOptions {
  out: string;
  /** `deckId/slideId` (or a slide id) when the image is on a slide. */
  slide?: string;
  /** A build step after Design: the image as it stands once that step has played. */
  beatId?: string;
  signal?: AbortSignal;
  onProgress?: (p: { phase: "preparing" | "encoding"; frame: number; total: number }) => void;
  /** Gates: a smaller decoded-piece budget (to show memory stays bounded on a stack larger than it). */
  pieceBudget?: number;
  settings?: ImageClipSettings;
}

export interface ImageMovieResult {
  path: string;
  elementId: string;
  name: string;
  frames: number;
  durationMs: number;
  /** Frames a second of the file (a rational when the data's own rate is not a whole number). */
  fps: number;
  rate: string;
  width: number;
  height: number;
  bytes: number;
  dim: string;
  from: number;
  to: number;
  planes: number;
  mode: "once" | "bounce";
  speed: number;
  blend: boolean;
  scale: number;
  warnings: string[];
  stats?: BakeStats & { overlayMs: number; stampCalls: number };
}

/** Thrown when no encoder is installed: the movie cannot be written, and the message says why. */
export const NO_ENCODER_MESSAGE = "The video encoder is not installed, so the movie cannot be written. In a source checkout run npm run fetch:video-encoder; packaged Flux includes it.";

const isHex = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim());

/** Write the movie of image `elementId` to `request.out`. */
export async function exportImageMovie(root: string, elementId: string, request: ImageMovieRequest): Promise<ImageMovieResult> {
  if (!request.out || path.extname(request.out).toLowerCase() !== ".mp4") throw new ValidationError("--out names the movie file, ending in .mp4");
  if (request.beatId !== undefined && request.slide === undefined) throw new ValidationError("--beat needs the slide that holds the image (--slide deckId/slideId)");
  const out = path.resolve(root, request.out);
  const warnings: string[] = [];
  const found = await findImageElement(root, elementId, request.slide, request.beatId);
  const { element, asset, siblings, matte } = found;
  const session = fluximgRenderSession();
  const reader = await fluximgReader(root, asset, session);
  const manifest = reader.manifest;
  const rv = resolveView(manifest, element.view);
  const decorated = hasDecoration(manifest, rv);
  let settings: MovieSettings;
  try { settings = resolveMovie(manifest, { view: element.view, crop: element.crop, width: element.width, height: element.height, playback: element.playback }, request, decorated); }
  catch (error) { if (error instanceof MovieRequestError) throw new ValidationError(`The movie does not fit image "${element.name ?? manifest.name}": ${error.message}`); throw error; }
  if (settings.raised) warnings.push(`drawn at ${settings.picture.width} × ${settings.picture.height} (not smaller) so its words stay as large as on the canvas`);
  if (settings.capped) warnings.push(`drawn at ${settings.picture.width} × ${settings.picture.height}: a movie's longest side is at most 2160`);
  const encoder = await imageClipEncoder();
  if (!encoder) throw new ValidationError(NO_ENCODER_MESSAGE);
  if (request.signal?.aborted) throw cancelled();

  const state = { view: rv, crop: clampCrop(manifest, element.crop) };
  const plan = planMovieClip(manifest, state, { view: element.view ?? null, crop: element.crop ?? null }, settings);
  request.onProgress?.({ phase: "preparing", frame: 0, total: plan.frames.length });

  // --- what is drawn over the pixels ------------------------------------------------------------------------------
  const t0 = performance.now();
  const overlay = await prepareOverlay(reader, manifest, element, rv, siblings, settings, warnings);
  const raster = overlay.needed ? openRasterizer() : null;
  let stampCalls = 0, overlayMs = performance.now() - t0;
  try {
    const base = overlay.base ? await raster!.render(overlay.base, settings.picture.width, settings.picture.height) : null;
    const stamp = overlay.stamp && raster ? stampStrip(overlay.stamp, settings, raster, plan.frames, () => { stampCalls++; }) : null;
    overlayMs = performance.now() - t0;
    const { width: pw, height: ph } = settings.picture, W = settings.width, H = settings.height;
    const mr = parseInt(matte.slice(1, 3), 16), mg = parseInt(matte.slice(3, 5), 16), mb = parseInt(matte.slice(5, 7), 16);
    const finish = async (f: ClipFrame, _i: number, px: Uint8ClampedArray): Promise<Uint8ClampedArray> => {
      if (element.flipX || element.flipY) mirror(px, pw, ph, !!element.flipX, !!element.flipY);
      if (base) over(px, base, 0);
      if (stamp) { const s0 = performance.now(); const st = await stamp.at(f); overlayMs += performance.now() - s0; if (st) over(px, st.pixels, st.y * pw * 4); }
      if (W === pw && H === ph) return px;
      // One pixel of matte on the right and / or the bottom: H.264 4:2:0 needs even sides, and a picture is never stretched.
      const padded = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < padded.length; i += 4) { padded[i] = mr; padded[i + 1] = mg; padded[i + 2] = mb; padded[i + 3] = 255; }
      for (let y = 0; y < ph; y++) padded.set(px.subarray(y * pw * 4, (y + 1) * pw * 4), y * W * 4);
      return padded;
    };
    const frameKey = stamp ? (f: ClipFrame) => `${f.key}|${stamp.text(f)}` : undefined;
    await fs.mkdir(path.dirname(out), { recursive: true });
    const stats = await encodeImageFrames({
      reader, assetId: asset.id, clip: plan, width: pw, height: ph, rate: plan.rate, matte, out: { width: W, height: H }, finish, frameKey, pieceBudget: request.pieceBudget,
    }, out, encoder, request.settings ?? IMAGE_CLIP_SETTINGS, {
      signal: request.signal,
      onProgress: request.onProgress ? (p) => request.onProgress!({ phase: "encoding", frame: p.frame, total: p.total }) : undefined,
    });
    return {
      path: out, elementId: element.id, name: element.name ?? manifest.name, frames: plan.frames.length, durationMs: plan.durationMs, fps: plan.fps, rate: plan.rate,
      width: W, height: H, bytes: stats.bytes, dim: settings.dim, from: settings.from, to: settings.to, planes: settings.planes, mode: settings.mode, speed: settings.speed,
      blend: settings.blend, scale: settings.scale, warnings, stats: { ...stats, overlayMs, stampCalls },
    };
  } catch (error) {
    if (request.signal?.aborted || (error as Error)?.name === "AbortError") throw cancelled();
    throw error;
  } finally {
    raster?.close();
  }
}

function cancelled(): Error { const e = new Error("Movie export cancelled"); e.name = "AbortError"; return e; }

/** Whether anything is drawn over the pixels (the legibility floor applies). */
export const hasDecoration = hasDecorationView;

/** The image element a movie is made of, its asset, the elements beside it (blow-out outlines) and the matte. */
export interface MovieElement { element: FluximgElement; asset: Asset; siblings: FluximgElement[]; matte: string; project: Project }

/** Figure matte: its background, else the page's white. Slide matte: the slide's, the deck's, the theme's. */
export const figureMatte = (f: Figure): string => (isHex(f.background) ? f.background.toLowerCase() : "#ffffff");
export function slideMatte(slide: Slide, deck: Deck): string {
  const bg = slide.background ?? deck.background ?? resolveTheme(deck.theme).background;
  return isHex(bg) ? bg.toLowerCase() : "#000000";
}

// --- the overlay -------------------------------------------------------------------------------------------------

interface Overlay {
  needed: boolean;
  /** Everything over the pixels except the stamp, as one SVG at the picture's size ("" = nothing). */
  base: string;
  /** How a frame's stamp is drawn: its SVG group for a resolved view, the box region it lives in. */
  stamp: null | { group(rv: ResolvedView): string; text(rv: ResolvedView): string; y0: number; y1: number; open: string };
}

async function prepareOverlay(reader: Awaited<ReturnType<typeof fluximgReader>>, manifest: FluximgManifest, element: FluximgElement, rv: ResolvedView, siblings: FluximgElement[], s: MovieSettings, warnings: string[]): Promise<Overlay> {
  if (!hasDecoration(manifest, rv) && !siblings.some((e) => e.view?.insetOf === element.id)) return { needed: false, base: "", stamp: null };
  await ensureColormapLuts();
  const resolveLut = (name: string) => colormapLut(name)?.lut ?? null;
  const layerSvg: Record<string, string> = {}, tables: Record<string, FluximgTable> = {};
  for (const file of fluximgLayerFiles(manifest, rv)) {
    try { const text = await reader.readText(file.path); sanitizeLayerSvg(text); layerSvg[file.id] = text; }
    catch (error) { warnings.push(`layer "${file.id}" could not be read (${(error as Error).message.split("\n")[0]}); the movie is drawn without it`); }
  }
  for (const file of fluximgTableFiles(manifest, rv)) {
    try { tables[file.id] = await reader.readTable(file.path); }
    catch (error) { warnings.push(`the table of layer "${file.id}" could not be read (${(error as Error).message.split("\n")[0]}); its objects are drawn unstyled`); }
  }
  const box = s.box, crop = s.crop, prefix = fluximgIdPrefix(element.id);
  const insets = insetsOf(siblings, element.id, element.assetId);
  let inner: string;
  const input = { manifest, view: rv, crop, tables, box, stillHref: null, layerSvg, idPrefix: prefix, flipX: !!element.flipX, flipY: !!element.flipY, insets, resolveLut, overlayOnly: true };
  try { inner = fluximgStaticSvg(input); }
  catch { warnings.push("the image's vector layers could not be placed; the movie is drawn without them"); inner = fluximgStaticSvg({ ...input, layerSvg: {} }); }
  // The pixels are mirrored by the element's own transform on the canvas: the overlay is mirrored with them here (its
  // words carry their own un-mirroring inside, as on the canvas).
  const mirrorT = element.flipX || element.flipY ? unflipTransform(box, element.flipX, element.flipY) : "";
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.picture.width}" height="${s.picture.height}" viewBox="0 0 ${svgNum(box.width)} ${svgNum(box.height)}" preserveAspectRatio="none">`;
  const stampGroup = (view: ResolvedView): string => {
    const m = STAMP_RE(prefix).exec(furnitureSvg(manifest, view, crop, box, prefix, resolveLut));
    return m ? m[0] : "";
  };
  const first = rv.furniture.stamp ? stampGroup(rv) : "";
  // The base: everything as drawn at the first frame, minus the stamp (only the stamp changes as the planes go by;
  // what stacks after it in its corner keeps its place).
  const base = first ? inner.replace(first, "") : inner;
  const wrapped = `${open}${mirrorT ? `<g transform="${mirrorT}">${base}</g>` : base}</svg>`;
  let stamp: Overlay["stamp"] = null;
  if (first) {
    // The stamp's band of the box: from above its first line to below its last.
    const ys = [...first.matchAll(/ y="([-\d.e]+)"/g)].map((m) => Number(m[1])), fs = Number(/font-size="([-\d.e]+)"/.exec(first)?.[1] ?? 12);
    const y0 = Math.max(0, Math.min(...ys) - 1.1 * fs), y1 = Math.min(box.height, Math.max(...ys) + 0.5 * fs);
    stamp = { group: stampGroup, text: (view) => stampLines(manifest, view).join("\n"), y0, y1, open };
  }
  return { needed: true, base: /<(path|rect|text|circle|line|polyline|polygon|ellipse|image|use)\b/.test(base) ? wrapped : "", stamp };
}

const STAMP_RE = (prefix: string) => new RegExp(`<g id="${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}stamp" data-part="stamp">[\\s\\S]*?</g>`);

/**
 * The stamps of a movie's frames, rasterized lazily in strips: each call draws up to `STRIP` stamps not yet drawn (the
 * next ones in frame order), each in its own band. A band is the stamp's rows of the picture at the frame's scale, so
 * a stamp lands where the full overlay would have drawn it. Memory stays bounded: drawn bands are dropped in order.
 */
function stampStrip(st: NonNullable<Overlay["stamp"]>, s: MovieSettings, raster: Rasterizer, frames: ClipFrame[], onCall: () => void) {
  const { width: pw, height: ph } = s.picture, k = ph / s.box.height;
  const top = Math.max(0, Math.floor(st.y0 * k)), bottom = Math.min(ph, Math.ceil(st.y1 * k)), rows = Math.max(1, bottom - top);
  const STRIP = Math.max(1, Math.min(64, Math.floor((48 * 1024 * 1024) / (rows * pw * 4))));
  const textOf = (f: ClipFrame) => st.text(f.frame.overlay.view);
  const drawn = new Map<string, Uint8Array>();
  let cursor = 0;
  const vbTop = top / k, vbH = rows / k;
  return {
    text: textOf,
    async at(f: ClipFrame): Promise<{ pixels: Uint8Array; y: number } | null> {
      const want = textOf(f);
      if (!drawn.has(want)) {
        // This stamp and the next ones not drawn yet, in frame order.
        const batch: Array<{ text: string; group: string }> = [{ text: want, group: st.group(f.frame.overlay.view) }];
        const seen = new Set([want]);
        while (cursor < frames.length && frames[cursor] !== f) cursor++;
        for (let j = cursor; j < frames.length && batch.length < STRIP; j++) {
          const t = textOf(frames[j]);
          if (seen.has(t) || drawn.has(t)) continue;
          seen.add(t); batch.push({ text: t, group: st.group(frames[j].frame.overlay.view) });
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${rows * batch.length}" viewBox="0 0 ${pw} ${rows * batch.length}">` +
          batch.map((b, i) => `<svg x="0" y="${i * rows}" width="${pw}" height="${rows}" viewBox="0 ${svgNum(vbTop)} ${svgNum(s.box.width)} ${svgNum(vbH)}" preserveAspectRatio="none" overflow="hidden">${b.group}</svg>`).join("") + `</svg>`;
        onCall();
        const px = await raster.render(svg, pw, rows * batch.length);
        // Bounded: the bands of stamps already passed go first.
        while (drawn.size + batch.length > 4 * STRIP) drawn.delete(drawn.keys().next().value as string);
        batch.forEach((b, i) => drawn.set(b.text, px.subarray(i * rows * pw * 4, (i + 1) * rows * pw * 4)));
      }
      const pixels = drawn.get(want)!;
      return { pixels, y: top };
    },
  };
}

/** `src` (premultiplied RGBA, as resvg gives it) over opaque `dst` from byte `at` on. */
function over(dst: Uint8ClampedArray, src: Uint8Array, at: number): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    const j = at + i;
    if (a === 255) { dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; continue; }
    const k = 1 - a / 255;
    dst[j] = src[i] + dst[j] * k; dst[j + 1] = src[i + 1] + dst[j + 1] * k; dst[j + 2] = src[i + 2] + dst[j + 2] * k;
  }
}

/** Mirror opaque pixels in place (the element's flip). */
function mirror(px: Uint8ClampedArray, w: number, h: number, fx: boolean, fy: boolean): void {
  const row = w * 4, tmp = new Uint8ClampedArray(row);
  if (fy) for (let y = 0; y < h >> 1; y++) { const a = y * row, b = (h - 1 - y) * row; tmp.set(px.subarray(a, a + row)); px.copyWithin(a, b, b + row); px.set(tmp, b); }
  if (fx) for (let y = 0; y < h; y++) {
    const r = y * row;
    for (let x = 0; x < w >> 1; x++) {
      const a = r + x * 4, b = r + (w - 1 - x) * 4;
      for (let c = 0; c < 4; c++) { const t = px[a + c]; px[a + c] = px[b + c]; px[b + c] = t; }
    }
  }
}

// --- resvg in one child for the whole movie ----------------------------------------------------------------------

interface Rasterizer { render(svg: string, width: number, height: number): Promise<Uint8Array>; close(): void }

/** Length-prefixed SVG in, `status | width | height` + premultiplied RGBA out, one request at a time. */
const RASTER_SERVER = `
import { createRequire } from "node:module";
const req = createRequire(process.env.FLUX_RESVG_FROM);
const { Resvg } = req("@resvg/resvg-js");
let buf = Buffer.alloc(0);
const head = (a, b, c) => { const h = Buffer.alloc(12); h.writeUInt32LE(a, 0); h.writeUInt32LE(b, 4); h.writeUInt32LE(c, 8); return h; };
process.stdin.on("data", (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const svg = buf.subarray(4, 4 + len).toString("utf8"); buf = buf.subarray(4 + len);
    try { const img = new Resvg(svg).render(); process.stdout.write(Buffer.concat([head(0, img.width, img.height), img.pixels])); }
    catch (e) { const m = Buffer.from(String(e && e.message || e)); process.stdout.write(Buffer.concat([head(1, m.length, 0), m])); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function openRasterizer(): Rasterizer {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--input-type=module", "-e", RASTER_SERVER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FLUX_RESVG_FROM: pathToFileURL(fileURLToPath(import.meta.url).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2")).href },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let buf: Buffer = Buffer.alloc(0), stderr = "", dead: Error | null = null;
  let waiting: { resolve: (b: Uint8Array) => void; reject: (e: Error) => void; width: number; height: number } | null = null;
  child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-4000); });
  const fail = (e: Error) => { dead = e; const w = waiting; waiting = null; w?.reject(e); };
  child.on("error", fail);
  child.on("close", (code) => fail(new Error(`the overlay rasterizer stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").find((l) => /error|panic/i.test(l)) ?? stderr.trim().split("\n")[0]}` : ""}`)));
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!waiting || buf.length < 12) return;
    const status = buf.readUInt32LE(0), a = buf.readUInt32LE(4), b = buf.readUInt32LE(8);
    const need = status ? a : a * b * 4;
    if (buf.length < 12 + need) return;
    const body = buf.subarray(12, 12 + need); buf = buf.subarray(12 + need);
    const w = waiting; waiting = null;
    if (status) w.reject(new Error(`the overlay could not be drawn: ${body.toString("utf8")}`));
    else if (a !== w.width || b !== w.height) w.reject(new Error(`the overlay came back ${a} × ${b}, not ${w.width} × ${w.height}`));
    else w.resolve(new Uint8Array(body));
  });
  return {
    render(svg, width, height) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject, width, height };
        const bytes = Buffer.from(svg, "utf8"), len = Buffer.alloc(4);
        len.writeUInt32LE(bytes.length, 0);
        child.stdin.write(Buffer.concat([len, bytes]));
      });
    },
    close() { child.stdin.end(); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000).unref(); },
  };
}

/**
 * The image a movie is made of. On a figure: the element as stored. On a slide (`deckId/slideId`, addressed as
 * `set-image-view` does): its Design state, or with `beatId` the state it stands in once that step has played.
 */
export async function findImageElement(root: string, elementId: string, slide?: string, beatId?: string): Promise<MovieElement> {
  const { project } = await loadFigModel(root);
  if (slide === undefined) {
    const { figure, element } = findImage(project, elementId);
    const siblings = figure.elements.filter((e): e is FluximgElement => e.type === "fluximg" && !effectiveHidden(figure, e));
    return { element, asset: imageAsset(project, element.assetId), siblings, matte: figureMatte(figure), project };
  }
  const where = await findSlideTarget(root, slide);
  if (!where) throw new NotFoundError(`Slide not found: ${slide}`);
  const deck = await loadDeck(root, where.deckId);
  const sl = deck.slides.find((x) => x.id === where.slideId);
  if (!sl) throw new NotFoundError(`Slide not found: ${where.slideId} in deck ${where.deckId}`);
  const design = sl.elements.find((e) => e.id === elementId);
  if (!design) throw new NotFoundError(`Image element not found: ${elementId} on slide ${where.slideId}`);
  if (design.type !== "fluximg") throw new ValidationError(`Element ${elementId} is a ${design.type}, not an image (fluximg)`);
  let elements = sl.elements;
  if (beatId !== undefined) {
    const bi = sl.beats.findIndex((b) => b.id === beatId);
    if (bi < 1) throw new ValidationError("Choose an existing build step after Design (--beat).");
    elements = (await compileDeckSlide(root, deck, sl.id)).sample(bi).elements;
  }
  const element = elements.find((e) => e.id === elementId) as FluximgElement;
  // Playback is Design-level (plan D7): the Design element's setting, whatever the step.
  const withPlayback = { ...element, ...((design as FluximgElement).playback ? { playback: (design as FluximgElement).playback } : {}) } as FluximgElement;
  const siblings = elements.filter((e): e is FluximgElement => e.type === "fluximg" && !e.hidden);
  return { element: withPlayback, asset: await deckImageAsset(root, project, element), siblings, matte: slideMatte(sl, deck), project };
}

export { movieFileName };
export const _test = { over, mirror, STAMP_RE };
