/** Tiny editor ownership seam: Figure must not import the Slides store/runtime. */
import { writable } from 'svelte/store';
export interface Model3dDeckScope { deckId: string; externalAssetIds: ReadonlySet<string> }
export const model3dDeckScope = writable<Model3dDeckScope | null>(null);
export function setModel3dDeckScope(deckId: string | null, externalAssetIds: ReadonlySet<string> = new Set()) {
  model3dDeckScope.set(deckId ? { deckId, externalAssetIds: new Set(externalAssetIds) } : null);
}
/** Resolved external paths are already project-relative (`fig/assets/...`). */
export function modelAssetPrefix(assetId: string, scope: Model3dDeckScope | null, figurePrefix = ''): string {
  return scope ? scope.externalAssetIds.has(assetId) ? '' : `slides/${scope.deckId}` : figurePrefix;
}
