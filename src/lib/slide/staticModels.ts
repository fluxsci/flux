/** Static document policy: original model identities keep Design appearance;
 * an identity retyped into 3D uses its evaluated model endpoint. Mesh and
 * furniture always receive the same complete state. */
import type { Element } from '../types';
import type { Model3dAsset, Model3dElement } from '../model3d/types';
import { model3dSvgContext } from '../model3d/static';
import type { ExportPayload } from './export/runtime';
import type { Slide } from './types';

export function staticModelElement(element: Element, slide: Slide): Element {
  if (element.type !== 'model3d') return element;
  const design = slide.elements.find(e => e.id === element.id && e.type === 'model3d');
  if (!design) return element;
  const { x, y, width, height, rotation, opacity, hidden, flipX, flipY } = element;
  return { ...design, x, y, width, height, rotation, opacity, hidden, flipX, flipY } as Model3dElement;
}
export function staticModelContext(payload: ExportPayload) {
  return model3dSvgContext(payload.deck.assets, payload.modelManifests ?? {}, 'slide');
}
export function payloadModelCompileOptions(payload: ExportPayload) {
  const assets = new Map(payload.deck.assets.filter((asset): asset is Model3dAsset => asset.kind === 'glb').map(asset => [asset.id, asset]));
  return { animStyles: payload.deck.animStyles, plotManifest: (id: string) => payload.plots?.[id]?.manifest,
    modelAsset: (id: string) => assets.get(id), modelManifest: (id: string) => payload.modelManifests?.[id] };
}
