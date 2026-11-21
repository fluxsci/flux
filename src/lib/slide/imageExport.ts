/**
 * Images (fluximg) in everything a deck exports to (stage 2, W7; plan D5, D8). Light and pure: the exported player,
 * the capture document, Paper's embeds and the static writers import it, so it pulls no reader, renderer or codec.
 *
 * What a payload carries for an image (an exported document cannot run the decoder: its CSP has no workers, no WASM,
 * no fetch):
 *   - `images[assetId]`: a TRIMMED manifest (what the overlay, the furniture and the tween read), the layer SVG texts
 *     and tables the overlay draws, and the colour tables the furniture and styled layers need;
 *   - `assets["fluximg:<assetId>|<pixelKey>"]`: the still (PNG data URL) of every evaluated step state, at the "slide"
 *     export scale, keyed exactly as `exportStatic.fluximgStillRequest` names it for an asset without a content id, so
 *     the static writers' composer finds it by the same request (the model3d precedent: `staticModelRequest().ref`);
 *   - `imageClips[lookup]`: one MP4 per Change that moves pixels (`fluximg/clipPlan.ts`), where an encoder baked one.
 */
import type { Asset } from "../types";
import type { FluximgElement } from "../fluximg/element";
import type { FluximgManifest, FluximgTable } from "../fluximg/types";
import type { FluximgSvgContext } from "../fluximg/exportStatic";
import { modelPartOpacity } from "../model3d/appearance";
import type { FluximgPartIndex } from "../fluximg/parts";
import { partIndexFromTexts, planViewTween, insetsOf, clampCrop, zoomedStillScale } from "./imageSeam";
import type { CameraPose } from "./camera";
import type { StageSize } from "./types";
import type { ImageClip } from "../fluximg/clipPlan";
import type { ResolvedCurve } from "./curves";
import { compileSlide, type CompiledSlide } from "./compile";
import { isHandoff } from "./targets";
import { familyOf } from "./family";
import { presetParam } from "./presetCatalog";
import { transformEndState, transformPreState } from "./tween";

export interface ExportImage {
  /** Trimmed (`trimImageManifest`): no statistics arrays, no provenance, no paths outside the bundle's own names. */
  manifest: FluximgManifest;
  /** Layer SVG text by bundle path (only the layers some step shows). */
  texts?: Record<string, string>;
  /** Layer tables by bundle path (only those styling or the key needs). */
  tables?: Record<string, FluximgTable>;
  /** Colour-map tables (256 "#rrggbb") by name: the colour bar and colour-by-number styles. */
  luts?: Record<string, string[]>;
}

export interface PayloadImages {
  images?: Record<string, ExportImage>;
  imageClips?: Record<string, ImageClip>;
  assets?: Record<string, string>;
  deck: { assets: Asset[] };
}

/** The `assets` key of an image still: `fluximg:` + the still request key with the asset id as its identity. */
export const IMAGE_STILL_PREFIX = "fluximg:";
export const imageStillRef = (assetId: string, requestKey: string): string => `${IMAGE_STILL_PREFIX}${assetId}|${requestKey.slice(requestKey.indexOf("|") + 1)}`;

/** Static documents note this once when a step of a deck moves an image's pixels (the `MODEL_STILL_NOTE` of images),
 *  and say how to get the movie itself: the board's "Movie as MP4" key (W10). */
export const IMAGE_STILL_NOTE = "image movies are exported as stills; to get one as a video file, open the image's board (R) and press Movie as MP4 (Shift+R)";
/** Said once per deck export when clips could not be baked. Neither text may match Paper's refusal pattern. */
export const IMAGE_NO_ENCODER_NOTE = "image movies were exported as stills: the video encoder is not installed";

/** The asset record the composer names an image by in a payload (no path, no content id: the payload's own identity). */
export function payloadImageAsset(assetId: string, manifest: FluximgManifest): Asset {
  const s = manifest.pixels.shape, nd = s.length;
  return { id: assetId, name: assetId, kind: "fluximg", path: "", naturalWidth: s[nd - 1], naturalHeight: s[nd - 2] };
}

/**
 * What the overlay, furniture, tween and still keys read of a manifest, and nothing else: the statistics keep their
 * scalars (default windows), histograms, profiles, provenance, world matrices, regions and save-time guards go.
 */
export function trimImageManifest(m: FluximgManifest): FluximgManifest {
  const stats = (s: FluximgManifest["channels"][number]["stats"]) => ({ count: s?.count ?? 0, min: s?.min ?? 0, max: s?.max ?? 0, percentiles: { ...(s?.percentiles ?? {}) }, hist: { lo: 0, hi: 0, counts: [] } });
  const { guard: _guard, ...encoding } = m.pixels.encoding as FluximgManifest["pixels"]["encoding"] & { guard?: unknown };
  return {
    spec: m.spec, name: m.name,
    pixels: { path: m.pixels.path, dims: [...m.pixels.dims], shape: [...m.pixels.shape], dtype: m.pixels.dtype, levels: m.pixels.levels.map((l) => ({ ...l, shape: [...l.shape] })), encoding: encoding as FluximgManifest["pixels"]["encoding"], ...(m.pixels.nodata !== undefined ? { nodata: m.pixels.nodata } : {}), ome: m.pixels.ome },
    axes: structuredClone(m.axes),
    channels: m.channels.map((c) => ({ ...c, stats: stats(c.stats) })),
    ...(m.photometric !== undefined ? { photometric: m.photometric } : {}),
    ...(m.defaults ? { defaults: structuredClone(m.defaults) } : {}),
    layers: m.layers.map((l) => {
      const { from: _from, ...rest } = l as typeof l & { from?: string };
      return (l.kind === "intensity" ? { ...rest, stats: stats(l.stats) } : { ...rest }) as typeof l;
    }),
    regions: [],
  };
}

/** One image Change of a compiled slide, as the player's controller finds them (player/fluximg.ts). */
export interface ImageChange { beat: number; trackId?: string; target: string; assetId: string; pre: FluximgElement; end: FluximgElement; blend: boolean; ease: ResolvedCurve; durationMs: number }
export function slideImageChanges(compiled: CompiledSlide): ImageChange[] {
  const slide = compiled.resolvedSlide, out: ImageChange[] = [];
  compiled.cues.forEach((cue, bi) => {
    for (const ct of cue.tracks) {
      const track = ct.track;
      if (track.disabled || track.preset !== "transform" || isHandoff(track)) continue;
      const pre = transformPreState(slide, track.target, bi);
      if (pre?.type !== "fluximg") continue;
      const end = transformEndState(pre, track);
      if (end.type !== "fluximg") continue;
      out.push({ beat: bi, ...(track.id ? { trackId: track.id } : {}), target: track.target, assetId: pre.assetId, pre, end, blend: presetParam<boolean>(track, "blend", "transform") === true, ease: ct.ease, durationMs: ct.duration });
    }
  });
  return out;
}

/** The camera's resting zoom where it shows an element (its box meets the camera's view): > 1 magnifies it. 1 without
 *  a camera, for a camera that does not zoom in, or for an element out of its view. */
export function cameraZoomOn(el: { x: number; y: number; width: number; height: number }, camera: CameraPose | undefined, stage: StageSize): number {
  if (!camera || !(camera.zoom > 1)) return 1;
  const hw = stage.width / (2 * camera.zoom), hh = stage.height / (2 * camera.zoom);
  const inView = el.x < camera.x + hw && el.x + el.width > camera.x - hw && el.y < camera.y + hh && el.y + el.height > camera.y - hh;
  return inView ? camera.zoom : 1;
}
/** Still pixels per canvas px for an image at a step: 2 (the export scale), more where the step's camera rests zoomed
 *  in on it (`crop.zoomedStillScale`, review B4). Exactly 2 for a deck without a camera zoom. */
export function imageStillScale(manifest: FluximgManifest, el: { x: number; y: number; width: number; height: number; crop?: import("../fluximg/view").PixelRect | null }, camera: CameraPose | undefined, stage: StageSize, scale = 2): number {
  const zoom = cameraZoomOn(el, camera, stage);
  return zoom > 1 ? zoomedStillScale(clampCrop(manifest, el.crop), { width: el.width, height: el.height }, scale, zoom) : scale;
}

/** The static writers' image context over a payload (PDF, PPTX, Paper posters, contact sheets): `exportStatic`'s
 *  composer finds each step's still by the request it computes itself. Undefined for a payload without images. */
export function payloadImageSvgContext(payload: PayloadImages, elements?: ReadonlyArray<{ id: string; type: string; hidden?: boolean }>,
  partStates?: Record<string, Record<string, { opacity?: number; visible?: boolean }>>, camera?: CameraPose, stage?: StageSize): FluximgSvgContext | undefined {
  const images = payload.images;
  if (!images || !Object.keys(images).length) return undefined;
  const assets = new Map(Object.entries(images).map(([id, image]) => [id, payloadImageAsset(id, image.manifest)]));
  return {
    scale: 2,
    // A page whose camera rests zoomed in on an image draws its still at the zoom's resolution (as the gather did).
    ...(camera && stage && camera.zoom > 1 ? { scaleOf: (id: string) => {
      const el = elements?.find((e) => e.id === id) as unknown as (FluximgElement | undefined), m = el?.assetId ? images[el.assetId]?.manifest : undefined;
      return el && m ? imageStillScale(m, el, camera, stage) : undefined;
    } } : {}),
    assetOf: (id) => assets.get(id),
    manifestOf: (id) => images[id]?.manifest,
    stillOf: (key) => payload.assets?.[`${IMAGE_STILL_PREFIX}${key}`],
    layerTextOf: (id, path) => images[id]?.texts?.[path],
    tableOf: (id, path) => images[id]?.tables?.[path],
    // Blow-outs of an image on the same slide (their frames outlined on it), from the page's evaluated elements.
    insetsOf: (id) => { const shown = (elements ?? []).filter((e) => !e.hidden), me = shown.find((e) => e.id === id) as { assetId?: string } | undefined; return me?.assetId ? insetsOf(shown, id, me.assetId) : []; },
    resolveLut: (name) => lutOf(images, name),
    // a step's objects that have not appeared yet (or have gone) are drawn that way, as on the live slide (W8)
    ...(partStates ? { partOpacityOf: (id: string) => modelPartOpacity(partStates[id]) } : {}),
  };
}

/** An image's object index from a payload (its trimmed manifest and the layer texts it carries): what the static
 *  writers' compile resolves image-object tracks with. */
export function payloadImageParts(payload: PayloadImages): ((assetId: string) => FluximgPartIndex | undefined) | undefined {
  const images = payload.images;
  if (!images || !Object.keys(images).length) return undefined;
  return (id) => { const image = images[id]; return image?.manifest ? partIndexFromTexts(image.manifest, (p) => image.texts?.[p]) : undefined; };
}

/** A colour table carried by any image of the payload. */
export function lutOf(images: Record<string, ExportImage> | undefined, name: string): string[] | null {
  for (const image of Object.values(images ?? {})) { const lut = image.luts?.[name]; if (lut) return lut; }
  return null;
}

/** True when some image Change of the payload's slides moves pixels: a static document notes once that the movie was
 *  exported as a still (`IMAGE_STILL_NOTE`). */
export function payloadImagesMove(payload: PayloadImages & { deck: { slides: import("./types").Slide[]; stage: import("./types").StageSize; animStyles?: import("./types").Deck["animStyles"] } }): boolean {
  const imgs = payload.images;
  if (!imgs || !Object.keys(imgs).length) return false;
  for (const slide of payload.deck.slides) {
    if (!slide.elements.some((e) => e.type === "fluximg")) continue;
    // An image movie (Start / Pause / Stop) moves pixels too: a page shows the plane its state holds.
    const images = new Set(slide.elements.filter((e) => e.type === "fluximg").map((e) => e.id));
    if (slide.beats.some((b, bi) => bi > 0 && b.tracks.some((t) => !t.disabled && images.has(t.target) && familyOf(t) === "media"))) return true;
    const compiled = compileSlide(slide, payload.deck.stage, { animStyles: payload.deck.animStyles });
    for (const c of slideImageChanges(compiled)) {
      const m = imgs[c.assetId]?.manifest;
      if (!m) continue;
      try { if (planViewTween(m, { view: c.pre.view, crop: c.pre.crop }, { view: c.end.view, crop: c.end.crop }, { blend: c.blend }).pixels) return true; } catch { /* a Change the plan refuses shows as stills anyway */ }
    }
  }
  return false;
}
