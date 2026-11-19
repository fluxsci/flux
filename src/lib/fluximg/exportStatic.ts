/**
 * A placed fluximg in every output that is not the editor's canvas: figure exports (SVG / PNG / PDF), Paper, and
 * flux-core's headless renders. Pure (twin-engine rule): no DOM, no Node, no Svelte, IO injected.
 *
 * The split, so both engines produce the same markup for the same figure:
 *
 *   1. `prepareFluximgContext` (async, pure apart from the injected IO) walks the figures, decides for every visible
 *      fluximg element exactly which still it needs (`fluximgStillRequest`: size from the output surface, key from
 *      `viewOps.pixelKey`) and which layer files, and asks the engine's IO for them. The window answers through its
 *      worker pool (`exportWindow.ts`), flux-core through the same reference renderer in Node (`flux-core/fluximgRender.ts`).
 *   2. `fluximgElementMarkup` (sync) turns one element plus that context into markup: `static.fluximgStaticSvg` in the
 *      element's box, positioned at the element's x / y. `export.ts elementToSvg` wraps it in the element's own
 *      rotation / flip / opacity like every other kind. Without a context (or without the bundle) it is the stand-in.
 *
 * Pixels never enter figure JSON: a still exists only inside the context and the output it is serialized into.
 */
import type { Asset, Figure } from "../types";
import type { PosterSurface } from "../model3d/poster";
import { effectiveHidden } from "../groups";
import type { FluximgElement } from "./element";
import type { FluximgManifest } from "./types";
import type { FluximgView, PixelRect, ResolvedView } from "./view";
import { pixelKey, resolveView } from "./viewOps";
import { clampCrop, stillSize } from "./still";
import { fluximgIdPrefix, fluximgStaticSvg, insetsOf, layerSvgPath } from "./static";
import { colormapLut, ensureColormapLuts } from "../color/colormapLuts";
import { escapeXml, sanitizeLayerSvg } from "./layers";
import { fluximgPlaceholderSvg } from "./placeholder";

/** The surfaces an export names (model3d's poster surfaces: one vocabulary for every asynchronously drawn kind). */
export type FluximgExportSurface = PosterSurface;

/** Every vector-format output (SVG, PDF, Paper, `fig/renders/`) draws its stills at this many dots per inch. */
export const FLUXIMG_VECTOR_DPI = 300;
/** The largest still an export draws (width x height): 4096 x 4096. The aspect is kept below it. */
export const FLUXIMG_EXPORT_MAX_PIXELS = 4096 * 4096;

/**
 * Still pixels per canvas px for an output. A raster at N dpi draws N/96 (canvas px are CSS px, 96 per inch), so every
 * output pixel over the image is a still pixel. Vector outputs have no pixel grid of their own: they get 300 dpi, the
 * common journal requirement for halftones, at the element's printed size. `slide` and `thumbnail` exist in the
 * vocabulary for model3d; a fluximg never reaches a slide in stage 1, and a thumbnail is drawn at 1x.
 */
export function fluximgSurfaceScale(surface: FluximgExportSurface): number {
  if (typeof surface === "object" && surface.kind === "raster") {
    if (!Number.isFinite(surface.dpi) || surface.dpi <= 0) throw new Error("Invalid export DPI");
    return surface.dpi / 96;
  }
  if (typeof surface === "object" && surface.kind === "editor") return Math.max(1, surface.dpr ?? 2);
  if (surface === "slide") return 2;
  if (surface === "thumbnail") return 1;
  return FLUXIMG_VECTOR_DPI / 96;
}

/** What one element needs drawn: the still request an engine renders, and its cache key. */
export interface FluximgStillRequest {
  elementId: string;
  assetId: string;
  /** Project-relative bundle directory (`fig/assets/<id>.fluximg`). */
  bundle: string;
  view: FluximgView | null;
  /** Clamped to the image, level-0 pixels. */
  crop: PixelRect;
  outWidth: number;
  outHeight: number;
  /** `<content id>|<viewOps.pixelKey>`: the same key the editor's still uses, so the window shares one cache. */
  key: string;
}

/** The bundle directory of a placed asset, relative to the project root (`Asset.path` is relative to `fig/`). */
export function fluximgBundlePath(asset: Pick<Asset, "path">): string {
  return `fig/${asset.path.replace(/^\/+/, "")}`;
}

/** The still an element needs at `scale` still pixels per canvas px (exports draw every pixel: `magnify`). */
export function fluximgStillRequest(element: FluximgElement, asset: Pick<Asset, "id" | "path" | "sha256">, manifest: FluximgManifest, scale: number, rv: ResolvedView = resolveView(manifest, element.view)): FluximgStillRequest {
  const crop = clampCrop(manifest, element.crop);
  const box = { width: Math.max(0, element.width), height: Math.max(0, element.height) };
  const size = stillSize(crop, box, scale, { magnify: true, maxPixels: FLUXIMG_EXPORT_MAX_PIXELS });
  return {
    elementId: element.id, assetId: asset.id, bundle: fluximgBundlePath(asset),
    view: element.view ? structuredClone(element.view) : null,
    crop, outWidth: size.width, outHeight: size.height,
    key: `${asset.sha256 ?? asset.id}|${pixelKey(manifest, rv, crop, size.width, size.height)}`,
  };
}

/** The layer files an element's static markup reads: visible vector and label layers (their shapes and names). */
export function fluximgLayerFiles(manifest: FluximgManifest, rv: ResolvedView): Array<{ id: string; path: string }> {
  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  const out: Array<{ id: string; path: string }> = [];
  for (const lv of rv.layers) {
    if (!lv.visible || lv.kind === "intensity") continue;
    const path = layerSvgPath(byId.get(lv.id));
    if (path) out.push({ id: lv.id, path });
  }
  return out;
}

/** Everything `fluximgElementMarkup` reads. Built by `prepareFluximgContext`; plain data apart from the lookups. */
export interface FluximgSvgContext {
  /** Still pixels per canvas px of the output this context was prepared for. */
  scale: number;
  /** Paper's display renders namespace every id (an embed of a figure must not share ids with the live canvas). */
  namespace?: string;
  assetOf(assetId: string): Asset | undefined;
  manifestOf(assetId: string): FluximgManifest | undefined;
  /** A still as a `data:image/png` URL by request key. */
  stillOf(key: string): string | undefined;
  /** A layer file's SVG text (already checked by the sanitizer), by asset id and bundle path. */
  layerTextOf(assetId: string, path: string): string | undefined;
  /** The blow-outs of an element in its figure (their frames are outlined on it). */
  insetsOf?(elementId: string): Array<{ id: string; crop: PixelRect }>;
  /** Colour-map tables for the calibration bar (loaded by the preparation when a shown bar needs one). */
  resolveLut?(name: string): string[] | null;
}

/** What an engine supplies. Every call may throw: the element is then drawn as the stand-in and the reason reported. */
export interface FluximgExportIO {
  manifest(asset: Asset): Promise<FluximgManifest>;
  /** The still of `request` as a `data:image/png;base64,` URL (the reference renderer's pixels, straight alpha). */
  still(asset: Asset, request: FluximgStillRequest): Promise<string>;
  text(asset: Asset, path: string): Promise<string>;
}

export interface PrepareFluximgOptions {
  surface: FluximgExportSurface;
  namespace?: string;
  /** One line per element that cannot be drawn as it should (missing bundle, unreadable still or layer). */
  onIssue?: (element: FluximgElement, message: string) => void;
  /** Checked between reads: false abandons the preparation (`AbortError`). */
  isCurrent?: () => boolean;
}

const label = (e: FluximgElement, asset?: Asset): string => e.name || asset?.name || e.id;
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** The visible fluximg elements of some figures (hidden ones, or ones under a hidden group, are not drawn by any export). */
export function visibleFluximgElements(figures: readonly Figure[]): FluximgElement[] {
  const out: FluximgElement[] = [];
  for (const f of figures) for (const e of f.elements) if (e.type === "fluximg" && !effectiveHidden(f, e)) out.push(e);
  return out;
}

/**
 * Fetch what the figures' fluximg elements need for one output. Each manifest, still and layer file is asked for once
 * (two elements showing the same view share a still). A failure never throws: it is reported per element and that
 * element draws as the stand-in (no manifest) or with an empty frame under its vectors (no still).
 */
export async function prepareFluximgContext(figures: readonly Figure[], assets: readonly Asset[], io: FluximgExportIO, options: PrepareFluximgOptions): Promise<FluximgSvgContext> {
  const scale = fluximgSurfaceScale(options.surface);
  const byId = new Map(assets.filter((a) => a.kind === "fluximg").map((a) => [a.id, a]));
  const manifests = new Map<string, FluximgManifest>();
  const stills = new Map<string, string>();
  const texts = new Map<string, string>();
  const pendingManifests = new Map<string, Promise<FluximgManifest>>();
  const pendingStills = new Map<string, Promise<string>>();
  const pendingTexts = new Map<string, Promise<string>>();
  const check = (): void => {
    if (options.isCurrent && !options.isCurrent()) { const e = new Error("The figure changed while its images were prepared"); e.name = "AbortError"; throw e; }
  };
  const issue = (e: FluximgElement, message: string): void => options.onIssue?.(e, message);
  // Blow-outs are a relation between elements of one figure: resolved here, where the figures are in hand.
  const insets = new Map<string, Array<{ id: string; crop: PixelRect }>>();
  for (const f of figures) for (const e of f.elements) {
    if (e.type !== "fluximg" || effectiveHidden(f, e)) continue;
    const mine = insetsOf(f.elements.filter((x) => !effectiveHidden(f, x)), e.id, e.assetId);
    if (mine.length) insets.set(e.id, mine);
  }
  let wantLuts = false;

  await Promise.all(visibleFluximgElements(figures).map(async (e) => {
    const asset = byId.get(e.assetId);
    if (!asset || !asset.path) { issue(e, `Image "${label(e)}" (${e.id}): its asset ${e.assetId} is not registered; drawn as a placeholder`); return; }
    let manifest: FluximgManifest;
    try {
      let p = pendingManifests.get(asset.id);
      if (!p) { p = io.manifest(asset); pendingManifests.set(asset.id, p); }
      manifest = await p;
      manifests.set(asset.id, manifest);
    } catch (error) {
      check();
      issue(e, `Image "${label(e, asset)}" (${e.id}): ${reason(error)}; drawn as a placeholder`);
      return;
    }
    check();
    const rv = resolveView(manifest, e.view);
    if (rv.furniture.colorbar && rv.channels.some((c) => c.lut)) wantLuts = true;
    const request = fluximgStillRequest(e, asset, manifest, scale, rv);
    const jobs: Array<Promise<void>> = [];
    if (!stills.has(request.key)) {
      let p = pendingStills.get(request.key);
      if (!p) { p = io.still(asset, request); pendingStills.set(request.key, p); }
      jobs.push(p.then((href) => {
        if (!href.startsWith("data:image/png;")) throw new Error("the still is not a PNG data URL");
        stills.set(request.key, href);
      }).catch((error: unknown) => { check(); issue(e, `Image "${label(e, asset)}" (${e.id}): its pixels could not be drawn (${reason(error)}); exported without them`); }));
    }
    for (const file of fluximgLayerFiles(manifest, rv)) {
      const key = `${asset.id}|${file.path}`;
      if (texts.has(key)) continue;
      let p = pendingTexts.get(key);
      if (!p) {
        // Checked here, once: a layer file the sanitizer refuses is left out (and named) rather than failing the figure.
        p = io.text(asset, file.path).then((text) => { sanitizeLayerSvg(text); return text; });
        pendingTexts.set(key, p);
      }
      jobs.push(p.then((text) => { texts.set(key, text); }).catch((error: unknown) => { check(); issue(e, `Image "${label(e, asset)}" (${e.id}): layer "${file.id}" could not be read (${reason(error)}); exported without it`); }));
    }
    await Promise.all(jobs);
  }));
  check();
  // A calibration bar draws a colour map's own colours; without the tables it would be gray.
  if (wantLuts) await ensureColormapLuts().catch(() => {});
  return {
    scale, namespace: options.namespace,
    assetOf: (id) => byId.get(id),
    manifestOf: (id) => manifests.get(id),
    stillOf: (key) => stills.get(key),
    layerTextOf: (id, path) => texts.get(`${id}|${path}`),
    insetsOf: (id) => insets.get(id) ?? [],
    resolveLut: (name) => colormapLut(name)?.lut ?? null,
  };
}

/** The ids an element's markup uses: `fx-<element id>-…`, namespaced the way Paper namespaces plot parts. */
export function fluximgExportIdPrefix(elementId: string, namespace?: string): string {
  return fluximgIdPrefix(namespace ? `${namespace}__${elementId}` : elementId);
}

/**
 * One element's markup in figure coordinates, WITHOUT its rotation / flip / opacity (the caller wraps those, as for
 * every element kind). The static markup is a nested `<svg>` at the box origin, so it is translated to the element's
 * x / y. No context, no asset or no manifest: the stand-in (`placeholder.ts`).
 */
export function fluximgElementMarkup(e: FluximgElement, ctx?: FluximgSvgContext): string {
  const asset = ctx?.assetOf(e.assetId), manifest = asset ? ctx?.manifestOf(asset.id) : undefined;
  if (!ctx || !asset || !manifest) return fluximgPlaceholderSvg(e, asset ?? null);
  const rv = resolveView(manifest, e.view);
  const request = fluximgStillRequest(e, asset, manifest, ctx.scale, rv);
  const layerSvg: Record<string, string> = {};
  for (const file of fluximgLayerFiles(manifest, rv)) {
    const text = ctx.layerTextOf(asset.id, file.path);
    if (text !== undefined) layerSvg[file.id] = text;
  }
  const input = {
    manifest, view: rv, crop: request.crop, box: { width: Math.max(0, e.width), height: Math.max(0, e.height) },
    stillHref: ctx.stillOf(request.key) ?? null, layerSvg, idPrefix: fluximgExportIdPrefix(e.id, ctx.namespace),
    flipX: !!e.flipX, flipY: !!e.flipY,
    insets: ctx.insetsOf?.(e.id) ?? [], resolveLut: ctx.resolveLut,
  };
  let inner: string;
  try { inner = fluximgStaticSvg(input); }
  catch {
    // A layer that passed the sanitizer alone can still fail placement; the image without its vectors beats no figure.
    try { inner = fluximgStaticSvg({ ...input, layerSvg: {} }); } catch { return fluximgPlaceholderSvg(e, asset); }
  }
  // Raw x / y (not rounded): the wrapper's rotation pivots on the same numbers, as for every other kind.
  return `<g data-fluximg="${escapeXml(e.assetId)}" transform="translate(${e.x} ${e.y})">${inner}</g>`;
}
