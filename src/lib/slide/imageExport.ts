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
import type { ImageClip } from "../fluximg/clipPlan";
import type { ResolvedCurve } from "./curves";
import type { CompiledSlide } from "./compile";
import { isHandoff } from "./targets";
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

/** Static documents note this once when a step of a deck moves an image's pixels (the `MODEL_STILL_NOTE` of images). */
export const IMAGE_STILL_NOTE = "image movie exported as a still";
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

/** The static writers' image context over a payload (PDF, PPTX, Paper posters, contact sheets): `exportStatic`'s
 *  composer finds each step's still by the request it computes itself. Undefined for a payload without images. */
export function payloadImageSvgContext(payload: PayloadImages): FluximgSvgContext | undefined {
  const images = payload.images;
  if (!images || !Object.keys(images).length) return undefined;
  const assets = new Map(Object.entries(images).map(([id, image]) => [id, payloadImageAsset(id, image.manifest)]));
  return {
    scale: 2,
    assetOf: (id) => assets.get(id),
    manifestOf: (id) => images[id]?.manifest,
    stillOf: (key) => payload.assets?.[`${IMAGE_STILL_PREFIX}${key}`],
    layerTextOf: (id, path) => images[id]?.texts?.[path],
    tableOf: (id, path) => images[id]?.tables?.[path],
    insetsOf: () => [],
    resolveLut: (name) => lutOf(images, name),
  };
}

/** A colour table carried by any image of the payload. */
export function lutOf(images: Record<string, ExportImage> | undefined, name: string): string[] | null {
  for (const image of Object.values(images ?? {})) { const lut = image.luts?.[name]; if (lut) return lut; }
  return null;
}
