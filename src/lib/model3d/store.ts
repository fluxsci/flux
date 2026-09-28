/** Small metadata cache, independent of plot DOM residency and model renderer lifetime. */
import { writable } from 'svelte/store';
import { markAssetDirty } from '../assets';
import { parseScene3d } from './scene3d';
import type { Scene3dManifest } from './types';
import type { Scene3dSidecars } from './persistence';
export const scene3dManifests=writable<Record<string,Scene3dManifest>>({});
export const scene3dIssues=writable<Record<string,string[]>>({});
export const scene3dRecipes=writable<Record<string,unknown>>({});
export function primeScene3dSidecars(manifests:Record<string,Scene3dManifest>,recipes:Record<string,unknown>={},issues:Record<string,string[]>={}) {
  for(const manifest of Object.values(manifests)) { const result=parseScene3d(manifest); if('issue' in result) throw new Error(result.issue); }
  scene3dManifests.update(current=>({...current,...manifests}));
  scene3dRecipes.update(current=>({...current,...recipes}));
  scene3dIssues.update(current=>({...current,...issues}));
}
export function cacheScene3dSidecars(assetId:string,sidecars:Scene3dSidecars) {
  if(sidecars.manifest) { const result=parseScene3d(sidecars.manifest); if('issue' in result) throw new Error(result.issue); }
  scene3dManifests.update(current=> { const next={...current}; if(sidecars.manifest) next[assetId]=sidecars.manifest; else delete next[assetId]; return next; });
  scene3dRecipes.update(current=> { const next={...current}; if(sidecars.recipe!==undefined) next[assetId]=sidecars.recipe; else delete next[assetId]; return next; });
  scene3dIssues.update(current=>({...current,[assetId]:sidecars.issues??[]}));
  markAssetDirty(assetId);
}
export function clearScene3dSidecars() { scene3dManifests.set({}); scene3dRecipes.set({}); scene3dIssues.set({}); }
