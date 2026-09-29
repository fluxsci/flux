/** Static 3D composition, shared by browser and Node. No DOM, IO or renderer. */
import type { Asset, Figure } from '../types';
import { effectiveHidden } from '../groups';
import { xmlEscape } from '../xml';
import { furnitureLayout } from './furnitureLayout';
import { furnitureSvg } from './furniture';
import { orbitPose } from './orbit';
import { framingBounds } from './framing';
import { partDomId } from '../plot/parse';
import { modelPlaceholder, posterKey, posterPixels, posterRef, type PosterSurface } from './poster';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';

export interface Model3dSvgContext {
  posterIdOf: (element: Model3dElement) => string | undefined;
  manifestOf: (element: Model3dElement) => Scene3dManifest | undefined;
  assetOf: (element: Model3dElement) => Model3dAsset | undefined;
  namespace?: string;
}
export interface StaticModelPosterRequest {
  element: Model3dElement; asset: Model3dAsset; manifest?: Scene3dManifest;
  key: string; ref: string; w: number; h: number;
  /** Transient mesh-part appearance factors (a sampled slide step). */
  partOpacity?: Record<string, number>;
}
export function staticModelRequest(element: Model3dElement, asset: Model3dAsset, manifest: Scene3dManifest | undefined, surface: PosterSurface, partOpacity?: Record<string, number>): StaticModelPosterRequest {
  const layout = furnitureLayout(manifest, element, element.overrides), px = posterPixels(layout.viewport, surface);
  const key = posterKey(element, asset, manifest, px, partOpacity);
  return { element, asset, manifest, key, ref: posterRef(key), ...px, ...(partOpacity ? { partOpacity } : {}) };
}
export function model3dSvgContext(assets: readonly Asset[], manifests: Record<string, Scene3dManifest>, surface: PosterSurface = 'figure', namespace?: string): Model3dSvgContext {
  const byId = new Map(assets.filter((asset): asset is Model3dAsset => asset.kind === 'glb' && !!asset.model && !!asset.sha256).map(asset => [asset.id, asset]));
  return { namespace, assetOf: element => byId.get(element.assetId), manifestOf: element => manifests[element.assetId],
    // A placement whose request cannot be formed draws the placeholder instead of
    // failing the whole figure; collectModelPosters reports why.
    posterIdOf: element => {
      const asset = byId.get(element.assetId);
      if (!asset) return undefined;
      try { return staticModelRequest(element, asset, manifests[element.assetId], surface).ref; } catch { return undefined; }
    } };
}
export interface CollectModelPosterOptions {
  /** Read paths degrade a placement they cannot request to a placeholder and a
   * named issue. Without this callback (exports) the first problem throws. */
  onIssue?: (element: Model3dElement, message: string) => void;
}
export function collectModelPosters(figures: readonly Figure[], context: Model3dSvgContext, surface: PosterSurface, options: CollectModelPosterOptions = {}): StaticModelPosterRequest[] {
  const out: StaticModelPosterRequest[] = [];
  for (const figure of figures) for (const element of figure.elements) {
    if (element.type !== 'model3d' || effectiveHidden(figure, element)) continue;
    const label = element.name || element.id;
    try {
      const asset = context.assetOf(element);
      if (!asset) throw new Error(`Cannot render 3D model "${label}": missing model metadata`);
      out.push(staticModelRequest(element, asset, context.manifestOf(element), surface));
    } catch (error) {
      if (!options.onIssue) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      options.onIssue(element, reason.startsWith('Cannot render 3D model') ? reason : `Cannot render 3D model "${label}": ${reason}`);
    }
  }
  return out;
}
export function model3dStaticSvg(element: Model3dElement, assetUrl: (id: string) => string | undefined, context?: Model3dSvgContext): string {
  const manifest = context?.manifestOf(element), asset = context?.assetOf(element);
  const frame = context?.namespace ? { ...element, id: partDomId(context.namespace, element.id) } : element;
  const layout = furnitureLayout(manifest, frame, frame.overrides);
  const furniture = furnitureSvg(manifest, frame, orbitPose(frame, framingBounds(asset?.model.bounds ?? manifest?.bounds ?? { min: [-1, -1, -1], max: [1, 1, 1] }, manifest), layout.viewport), layout);
  const ref = context?.posterIdOf(element), url = ref ? assetUrl(ref) : undefined, box = layout.viewport;
  const mesh = url?.startsWith('data:image/png;')
    ? `<image data-model3d-poster="true" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="none" href="${xmlEscape(url)}"/>`
    : modelPlaceholder(element.name || asset?.name || element.id, box);
  return furniture.under + mesh + furniture.over;
}
