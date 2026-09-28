/** Static 3D composition, shared by browser and Node. No DOM, IO or renderer. */
import type { Asset, Figure } from '../types';
import { effectiveHidden } from '../groups';
import { xmlEscape } from '../xml';
import { furnitureLayout } from './furnitureLayout';
import { furnitureSvg } from './furniture';
import { orbitPose } from './orbit';
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
}
export function staticModelRequest(element: Model3dElement, asset: Model3dAsset, manifest: Scene3dManifest | undefined, surface: PosterSurface): StaticModelPosterRequest {
  const layout = furnitureLayout(manifest, element, element.overrides), px = posterPixels(layout.viewport, surface);
  const key = posterKey(element, asset, manifest, px);
  return { element, asset, manifest, key, ref: posterRef(key), ...px };
}
export function model3dSvgContext(assets: readonly Asset[], manifests: Record<string, Scene3dManifest>, surface: PosterSurface = 'figure', namespace?: string): Model3dSvgContext {
  const byId = new Map(assets.filter((asset): asset is Model3dAsset => asset.kind === 'glb' && !!asset.model && !!asset.sha256).map(asset => [asset.id, asset]));
  return { namespace, assetOf: element => byId.get(element.assetId), manifestOf: element => manifests[element.assetId],
    posterIdOf: element => { const asset = byId.get(element.assetId); return asset ? staticModelRequest(element, asset, manifests[element.assetId], surface).ref : undefined; } };
}
export function collectModelPosters(figures: readonly Figure[], context: Model3dSvgContext, surface: PosterSurface): StaticModelPosterRequest[] {
  const out: StaticModelPosterRequest[] = [];
  for (const figure of figures) for (const element of figure.elements) {
    if (element.type !== 'model3d' || effectiveHidden(figure, element)) continue;
    const asset = context.assetOf(element);
    if (!asset) throw new Error(`Cannot render 3D model "${element.name || element.id}": missing model metadata`);
    out.push(staticModelRequest(element, asset, context.manifestOf(element), surface));
  }
  return out;
}
export function model3dStaticSvg(element: Model3dElement, assetUrl: (id: string) => string | undefined, context?: Model3dSvgContext): string {
  const manifest = context?.manifestOf(element), asset = context?.assetOf(element);
  const frame = context?.namespace ? { ...element, id: `${context.namespace}__${element.id}` } : element;
  const layout = furnitureLayout(manifest, frame, frame.overrides);
  const furniture = furnitureSvg(manifest, frame, orbitPose(frame, asset?.model.bounds ?? manifest?.bounds ?? { min: [-1, -1, -1], max: [1, 1, 1] }, layout.viewport), layout);
  const ref = context?.posterIdOf(element), url = ref ? assetUrl(ref) : undefined, box = layout.viewport;
  const mesh = url?.startsWith('data:image/png;')
    ? `<image data-model3d-poster="true" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="none" href="${xmlEscape(url)}"/>`
    : modelPlaceholder(element.name || asset?.name || element.id, box);
  return furniture.under + mesh + furniture.over;
}
