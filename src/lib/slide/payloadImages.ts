/**
 * Gathering images (fluximg) into a deck payload (stage 2, W7). Pure apart from the injected IO, like the rest of
 * `payload.ts`: both engines gather through it, and the IO hooks decide the carrier per surface (portable exports
 * inline stills and base64 clips, a capture document gets clip files, static writers get stills only).
 *
 * The bundle DIRECTORY is never read as bytes: its manifest, the layer files and tables the overlay draws are read
 * as text, stills and clips come from the engine's renderer (`imageStill`, `imageClip`). A bundle that cannot be read
 * is a warning and the stand-in, never a failed export.
 */
import type { Asset } from "../types";
import type { Deck, Slide } from "./types";
import type { FluximgElement } from "../fluximg/element";
import type { FluximgManifest, FluximgTable } from "../fluximg/types";
import type { ResolvedView } from "../fluximg/view";
import { fluximgLayerFiles, fluximgStillRequest, fluximgTableFiles, type FluximgStillRequest } from "../fluximg/exportStatic";
import { resolveView } from "../fluximg/viewOps";
import { planViewTween } from "../fluximg/viewTween";
import { evenClipSize, clipLookupKey, playbackLookupKey, type ImageClip, type ImageClipRequest, type ImagePlaybackRequest } from "../fluximg/clipPlan";
import { resolvePlayback } from "../fluximg/playback";
import { clampCrop } from "../fluximg/crop";
import { familyOf } from "./family";
import { sanitizeLayerSvg } from "../fluximg/layers";
import { wantsTable } from "../fluximg/static";
import { DEFAULT_STYLE_LUT } from "../fluximg/objectStyle";
import { compileSlide, type CompileOptions } from "./compile";
import { resolveTheme } from "./theme";
import { fluximgAssetPath, fluximgResolvedAsset } from "../fluximg/place";
import { imageStillRef, payloadImageAsset, slideImageChanges, trimImageManifest, IMAGE_NO_ENCODER_NOTE, type ExportImage } from "./imageExport";

/** The image half of `SlidePayloadIO`. */
export interface SlideImageIO {
  readText(path: string): Promise<string>;
  /** A bundle's manifest (default: its `fluximg.json` through `readText`). */
  imageManifest?(asset: Asset): Promise<FluximgManifest>;
  /** One step state's still as a PNG data URL. Absent: the payload carries no image pixels (each image shows the
   *  frame of its stand-in under its vectors). */
  imageStill?(asset: Asset, request: FluximgStillRequest): Promise<string>;
  /** A layer file (default: `readText` of the bundle path). */
  imageText?(asset: Asset, path: string): Promise<string>;
  /** A layer table (default: `readText` + JSON). */
  imageTable?(asset: Asset, path: string): Promise<FluximgTable>;
  /** The clip of a Change that moves pixels (baked or from the render cache), with its carrier URL. Absent (static
   *  writers, the live Paper preview): stills only. Throws `ImageClipUnavailable` when no encoder can bake it. */
  imageClip?(asset: Asset, request: ImageClipRequest | ImagePlaybackRequest, ease: (raw: number) => number): Promise<ImageClip>;
}

/** Thrown by an `imageClip` hook that has no encoder: the deck exports with stills and ONE warning. */
export class ImageClipUnavailable extends Error {
  constructor(message = IMAGE_NO_ENCODER_NOTE) { super(message); this.name = "ImageClipUnavailable"; }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** The lut names a resolved view's furniture and styled layers draw with. */
function lutsOf(rv: ResolvedView): string[] {
  const out = new Set<string>();
  if (rv.furniture.colorbar) for (const c of rv.channels) if (c.lut) out.add(c.lut);
  for (const l of rv.layers) {
    const color = wantsTable(l) ? l.styleBy?.color : undefined;
    if (color) out.add(typeof color.lut === "string" && color.lut ? color.lut : DEFAULT_STYLE_LUT);
  }
  return [...out];
}

export interface GatherImagesOptions {
  root: string;
  deck: Deck;
  figAssets: Asset[];
  io: SlideImageIO;
  /** Writes a still into the payload's `assets`. */
  assets: Record<string, string>;
  warnings: string[];
  compileOptions: (manifests: ReadonlyMap<string, FluximgManifest>) => CompileOptions;
}

/** Everything the deck's images need in the payload. Empty when the deck holds no image. */
export async function gatherImages(o: GatherImagesOptions): Promise<{ images?: Record<string, ExportImage>; imageClips?: Record<string, ImageClip> }> {
  const { root, deck, io, assets, warnings } = o;
  const placed = new Map<string, FluximgElement[]>();
  for (const s of deck.slides) for (const el of s.elements) if (el.type === "fluximg") {
    const list = placed.get(el.assetId) ?? [];
    list.push(el as FluximgElement); placed.set(el.assetId, list);
  }
  if (!placed.size) return {};
  const label = (el: FluximgElement) => el.name || el.id;
  const bundleFile = (asset: Asset, rel: string) => `${root.replace(/[/\\]$/, "")}/fig/${asset.path.replace(/^\/+/, "").replace(/\/+$/, "")}/${rel}`;
  const sources = new Map<string, Asset>(), manifests = new Map<string, FluximgManifest>(), images: Record<string, ExportImage> = {};
  for (const [assetId, els] of placed) {
    // By id, as both engines resolve a deck's images: the figure index's record when it lists the asset, else the
    // bundle at its one place (fig/assets/<id>.fluximg), its record rebuilt from its manifest (place.fluximgResolvedAsset).
    const registered = o.figAssets.find((a) => a.id === assetId && a.kind === "fluximg");
    const asset: Asset = registered ?? { id: assetId, name: assetId, kind: "fluximg", path: fluximgAssetPath(assetId), naturalWidth: 0, naturalHeight: 0 };
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(assetId) || !asset.path) { warnings.push(`image "${label(els[0])}" (${assetId}) has no bundle — its element will show a placeholder`); continue; }
    try {
      const manifest = io.imageManifest ? await io.imageManifest(asset) : JSON.parse(await io.readText(bundleFile(asset, "fluximg.json"))) as FluximgManifest;
      if (manifest?.spec !== "fluximg/1" || !manifest.pixels?.shape) throw new Error("its manifest is not fluximg/1");
      manifests.set(assetId, manifest);
      sources.set(assetId, registered ?? fluximgResolvedAsset(assetId, manifest, els.find((e) => e.source?.sha256)?.source?.sha256));
      images[assetId] = { manifest: trimImageManifest(manifest) };
    } catch (error) {
      warnings.push(`image "${label(els[0])}" (${assetId}): its bundle fig/${asset.path} is missing or unreadable (${reason(error)}) — its element will show a placeholder`);
    }
  }
  if (!manifests.size) return {};
  const texts = new Map<string, Promise<string | undefined>>(), tables = new Map<string, Promise<FluximgTable | undefined>>();
  const wantedLuts = new Map<string, Set<string>>();
  /** Everything a view of an image draws besides its pixels: layer texts, tables, colour tables. */
  const furnish = (assetId: string, rv: ResolvedView, who: string) => {
    const asset = sources.get(assetId)!, manifest = manifests.get(assetId)!, image = images[assetId];
    const jobs: Promise<void>[] = [];
    for (const file of fluximgLayerFiles(manifest, rv)) {
      const key = `${assetId}|${file.path}`;
      if (!texts.has(key)) texts.set(key, (io.imageText ? io.imageText(asset, file.path) : io.readText(bundleFile(asset, file.path)))
        .then((text) => { sanitizeLayerSvg(text); return text; })
        .catch((error: unknown) => { warnings.push(`image "${who}": layer "${file.id}" could not be read (${reason(error)}); exported without it`); return undefined; }));
      jobs.push(texts.get(key)!.then((text) => { if (text !== undefined) (image.texts ??= {})[file.path] = text; }));
    }
    for (const file of fluximgTableFiles(manifest, rv)) {
      const key = `${assetId}|${file.path}`;
      if (!tables.has(key)) tables.set(key, (io.imageTable ? io.imageTable(asset, file.path) : io.readText(bundleFile(asset, file.path)).then((t) => JSON.parse(t) as FluximgTable))
        .catch((error: unknown) => { warnings.push(`image "${who}": the table of layer "${file.id}" could not be read (${reason(error)}); its objects are drawn unstyled`); return undefined; }));
      jobs.push(tables.get(key)!.then((table) => { if (table) (image.tables ??= {})[file.path] = table; }));
    }
    for (const name of lutsOf(rv)) { const set = wantedLuts.get(assetId) ?? new Set(); set.add(name); wantedLuts.set(assetId, set); }
    return Promise.all(jobs);
  };

  // Every evaluated step state of every image (the model3d precedent: staticModels.slideModelStills): its still, keyed
  // by the request the static composer computes for the same element, and the vectors it draws.
  const options = o.compileOptions(manifests);
  const stillJobs = new Map<string, Promise<void>>();
  let missingStills = false;
  const still = (el: FluximgElement, who: string): Promise<void> | undefined => {
    const manifest = manifests.get(el.assetId), asset = sources.get(el.assetId);
    if (!manifest || !asset) return undefined;
    const rv = resolveView(manifest, el.view);
    const request = fluximgStillRequest(el, asset, manifest, 2, rv), ref = imageStillRef(el.assetId, request.key);
    const jobs: Promise<unknown>[] = [furnish(el.assetId, rv, who)];
    if (!assets[ref] && !stillJobs.has(ref)) {
      if (!io.imageStill) missingStills = true;
      else stillJobs.set(ref, io.imageStill(asset, request).then((href) => {
        if (!href.startsWith("data:image/png;")) throw new Error("the still is not a PNG data URL");
        assets[ref] = href;
      }).catch((error: unknown) => { warnings.push(`image "${who}": its pixels could not be drawn (${reason(error)}); exported without them`); }));
    }
    if (stillJobs.has(ref)) jobs.push(stillJobs.get(ref)!);
    return Promise.all(jobs).then(() => undefined);
  };
  const clips: Record<string, ImageClip> = {};
  let noEncoder = false;
  for (const slide of deck.slides) {
    if (!slide.elements.some((e) => e.type === "fluximg")) continue;
    const compiled = compileSlide(slide, deck.stage, options);
    const jobs: Promise<unknown>[] = [];
    for (let step = 0; step < Math.max(1, slide.beats.length); step++) {
      for (const el of compiled.sample(step).elements) if (el.type === "fluximg") { const j = still(el as FluximgElement, label(el as FluximgElement)); if (j) jobs.push(j); }
    }
    const movies = slideMovies(slide);
    for (const change of slideImageChanges(compiled)) {
      const manifest = manifests.get(change.assetId), asset = sources.get(change.assetId);
      if (!manifest || !asset) continue;
      // The ends of a Change are drawn too (a with-prev chain can start a Change from a state no step rests in).
      for (const el of [change.pre, change.end]) { const j = still(el, label(change.pre)); if (j) jobs.push(j); }
      // Under a running movie the movie's clip is what the image shows: this Change bakes no clip of its own.
      if (!io.imageClip || noEncoder || movies.some((mv) => mv.target === change.target && mv.runningAt(change.beat))) continue;
      let plan;
      try { plan = planViewTween(manifest, { view: change.pre.view, crop: change.pre.crop }, { view: change.end.view, crop: change.end.crop }, { blend: change.blend }); }
      catch (error) { warnings.push(`image "${label(change.pre)}": its Change at step ${change.beat} is shown as stills (${reason(error)})`); continue; }
      if (!plan.pixels || !(change.durationMs > 0)) continue;
      const sizes = [change.pre, change.end].map((el) => fluximgStillRequest(el, asset, manifest, 2));
      const big = sizes[0].outWidth * sizes[0].outHeight >= sizes[1].outWidth * sizes[1].outHeight ? sizes[0] : sizes[1];
      const size = evenClipSize(big.outWidth, big.outHeight);
      const lookup = clipLookupKey(trimmed(images, change.assetId), change.assetId, plan, { track: change.trackId, durationMs: change.durationMs, curve: change.ease.key, blend: change.blend });
      if (clips[lookup]) continue;
      const request: ImageClipRequest = {
        kind: "change", assetId: change.assetId, contentId: asset.sha256 ?? asset.id,
        pre: { view: change.pre.view ?? null, crop: change.pre.crop ?? null }, end: { view: change.end.view ?? null, crop: change.end.crop ?? null },
        blend: change.blend, curve: change.ease.key, durationMs: change.durationMs, width: size.width, height: size.height,
        matte: matteOf(slide, deck), lookup,
      };
      try { clips[lookup] = await io.imageClip(asset, request, change.ease.fn); }
      catch (error) {
        if (error instanceof ImageClipUnavailable || (error as Error)?.name === "ImageClipUnavailable") { noEncoder = true; warnings.push(IMAGE_NO_ENCODER_NOTE); }
        else if ((error as Error)?.name === "AbortError") throw error;
        else warnings.push(`image "${label(change.pre)}": the movie of its Change at step ${change.beat} could not be made (${reason(error)}); exported as a still`);
      }
    }
    // Running movies (Start / Pause / Stop, plan D7): one clip per look the movie runs with (each step's state from its
    // first Start on), a single pass of its range at its rate. A pixel-setting Change while it runs keeps the clip it
    // started with until the Change ends (the exported deck's limit): said once per step.
    for (const movie of movies) {
      const design = slide.elements.find((e) => e.id === movie.target) as FluximgElement | undefined;
      const manifest = design && manifests.get(design.assetId), asset = design && sources.get(design.assetId);
      if (!design || !manifest || !asset) continue;
      const playback = resolvePlayback(manifest, design.playback);
      if (!playback) continue;
      const p = { dim: playback.dim, mode: playback.mode, from: playback.from, to: playback.to, periodMs: playback.periodMs };
      for (const change of slideImageChanges(compiled)) if (change.target === movie.target && movie.runningAt(change.beat)) {
        try {
          if (planViewTween(manifest, { view: change.pre.view, crop: change.pre.crop }, { view: change.end.view, crop: change.end.crop }, { blend: change.blend }).pixels)
            warnings.push(`image "${label(design)}": its movie runs through the Change at step ${change.beat}; the exported deck keeps the movie's look until that Change ends, then plays the movie with the new look`);
        } catch { /* a refused plan is reported above */ }
      }
      if (!io.imageClip || noEncoder) continue;
      for (let step = movie.firstStart; step < Math.max(1, slide.beats.length); step++) {
        const el = compiled.sample(step).elements.find((e) => e.id === movie.target) as FluximgElement | undefined;
        if (!el || el.type !== "fluximg") continue;
        const picture = { view: resolveView(manifest, el.view), crop: clampCrop(manifest, el.crop) };
        const lookup = playbackLookupKey(trimmed(images, el.assetId), el.assetId, picture, p);
        if (clips[lookup]) continue;
        const still = fluximgStillRequest(el, asset, manifest, 2), size = evenClipSize(still.outWidth, still.outHeight);
        const request: ImagePlaybackRequest = { kind: "playback", assetId: el.assetId, contentId: asset.sha256 ?? asset.id, state: { view: el.view ?? null, crop: el.crop ?? null }, playback: p, width: size.width, height: size.height, matte: matteOf(slide, deck), lookup };
        try { clips[lookup] = await io.imageClip(asset, request, (r) => r); }
        catch (error) {
          if (error instanceof ImageClipUnavailable || (error as Error)?.name === "ImageClipUnavailable") { noEncoder = true; warnings.push(IMAGE_NO_ENCODER_NOTE); break; }
          else if ((error as Error)?.name === "AbortError") throw error;
          else warnings.push(`image "${label(el)}": its movie could not be made (${reason(error)}); exported as a still`);
        }
      }
    }
    await Promise.all(jobs);
  }
  await Promise.all([...stillJobs.values()]);
  if (missingStills) warnings.push("image pixels are not drawn by this export (no image renderer); each image shows its frame and vectors");
  const lutNames = [...new Set([...wantedLuts.values()].flatMap((s) => [...s]))];
  if (lutNames.length) {
    const { ensureColormapLuts, colormapLut } = await import("../color/colormapLuts");
    await ensureColormapLuts().catch(() => {});
    for (const [assetId, names] of wantedLuts) for (const name of [...names].sort()) {
      const lut = colormapLut(name)?.lut;
      if (lut) (images[assetId].luts ??= {})[name] = [...lut];
    }
  }
  // Sorted keys: both engines emit the same bytes whatever order their reads finished in.
  for (const image of Object.values(images)) {
    if (image.texts) image.texts = Object.fromEntries(Object.entries(image.texts).sort(([a], [b]) => a.localeCompare(b)));
    if (image.tables) image.tables = Object.fromEntries(Object.entries(image.tables).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { images, ...(Object.keys(clips).length ? { imageClips: clips } : {}) };
}

/** The images of a slide that take movie commands: the first step with a Start, and whether the movie runs at a step's
 *  start (Start ... Pause / Stop, in step order; with-prev timing inside a step is ignored for this warning only). */
function slideMovies(slide: Slide): Array<{ target: string; firstStart: number; runningAt(beat: number): boolean }> {
  const images = new Set(slide.elements.filter((e) => e.type === "fluximg").map((e) => e.id));
  const by = new Map<string, Array<{ beat: number; preset: string }>>();
  slide.beats.forEach((b, bi) => { if (bi > 0) for (const t of b.tracks) if (!t.disabled && images.has(t.target) && familyOf(t) === "media") (by.get(t.target) ?? by.set(t.target, []).get(t.target)!).push({ beat: bi, preset: t.preset ?? "" }); });
  const out: Array<{ target: string; firstStart: number; runningAt(beat: number): boolean }> = [];
  for (const [target, commands] of by) {
    const starts = commands.filter((c) => c.preset === "videoStart");
    if (!starts.length) continue;
    out.push({ target, firstStart: starts[0].beat, runningAt: (beat) => { let on = false; for (const c of commands) if (c.beat < beat || (c.beat === beat && c.preset === "videoStart")) on = c.preset === "videoStart"; return on; } });
  }
  return out;
}

/** The lookup key is computed on the TRIMMED manifest: the exported player has only that one. */
const trimmed = (images: Record<string, ExportImage>, assetId: string): FluximgManifest => images[assetId].manifest;

/** Transparent image pixels in a clip land on the slide's background (an MP4 has no alpha). */
function matteOf(slide: Slide, deck: Deck): string {
  const bg = slide.background ?? deck.background ?? resolveTheme(deck.theme).background;
  return /^#[0-9a-f]{6}$/i.test(bg) ? bg.toLowerCase() : "#000000";
}

export { payloadImageAsset };
