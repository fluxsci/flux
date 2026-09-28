/** Metadata-only scene sidecars. Binary model IO belongs to the native service. */
import { parseScene3d } from './scene3d';
import { scene3dSourceBindingIssue, type Model3dSourceBinding } from './sourceBinding';
import type { Scene3dManifest } from './types';
export interface Scene3dSidecars { manifest?: Scene3dManifest; recipe?: unknown; issues?: string[]; raw?: {manifest?:string;recipe?:string} }
export interface Scene3dSidecarIO { exists(path:string):Promise<boolean>; readText(path:string):Promise<string> }
export function scene3dSidecarPaths(directory:string,assetId:string) {
  if (!assetId || /[\\/\0]/.test(assetId) || ['.','..','__proto__','constructor','prototype'].includes(assetId)) throw new Error('Unsafe model asset id');
  const base = `${directory.replace(/\/$/, '')}/${assetId}`;
  return { manifest: `${base}.fluxplot.json`, recipe: `${base}.recipe.json` };
}
export async function readScene3dSidecars(io:Scene3dSidecarIO,directory:string,assetId:string,options:{strict?:boolean;binding?:Model3dSourceBinding}={}):Promise<Scene3dSidecars> {
  const paths=scene3dSidecarPaths(directory,assetId), result:Scene3dSidecars={};
  async function optional(kind:'manifest'|'recipe'):Promise<string|undefined> {
    try { return await io.exists(paths[kind]) ? await io.readText(paths[kind]) : undefined; }
    catch(error) {
      if(options.strict) throw new Error(`${assetId}: cannot copy unreadable ${kind} sidecar: ${String(error)}`);
      (result.issues??=[]).push(`${assetId}: ${kind} metadata could not be read; showing the stored mesh. ${String(error)}`);
      return undefined;
    }
  }
  const manifestText=await optional('manifest');
  if(manifestText!==undefined) {
    const manifest=parseScene3d(manifestText);
    result.raw={manifest:manifestText};
    if('issue' in manifest) (result.issues??=[]).push(`${assetId}: ${manifest.issue}; showing the stored mesh without scene metadata`);
    else {
      const issue=scene3dSourceBindingIssue(manifest,options.binding);
      if(issue) (result.issues??=[]).push(`${assetId}: ${issue}; showing the stored mesh without scene metadata`);
      else result.manifest=manifest;
    }
  }
  const recipeText=await optional('recipe');
  if(recipeText!==undefined) {
    result.raw={...result.raw,recipe:recipeText};
    try { if(recipeText.length>4*1024*1024) throw new Error('3D recipe exceeds 4 MiB'); result.recipe=JSON.parse(recipeText); }
    catch(error) { (result.issues??=[]).push(`${assetId}: ${String(error)}`); }
  }
  return result;
}
/** JSON only; these writes may join a text-generation journal, never GLB bytes. */
export function scene3dSidecarWrites(directory:string,assetId:string,sidecars:Scene3dSidecars):Map<string,string|null> {
  const paths=scene3dSidecarPaths(directory,assetId), result=new Map<string,string|null>();
  if(sidecars.manifest) {
    const parsed=parseScene3d(sidecars.manifest);
    if('issue' in parsed) throw new Error(parsed.issue);
    result.set(paths.manifest,JSON.stringify(parsed,null,2));
  } else if(sidecars.raw?.manifest!==undefined) result.set(paths.manifest,sidecars.raw.manifest);
  // An absent parsed cache is not permission to delete unknown/newer metadata.
  if(sidecars.recipe!==undefined) result.set(paths.recipe,JSON.stringify(sidecars.recipe,null,2));
  else if(sidecars.raw?.recipe!==undefined) result.set(paths.recipe,sidecars.raw.recipe);
  return result;
}
