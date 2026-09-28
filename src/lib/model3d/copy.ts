import { readScene3dSidecars, type Scene3dSidecars } from './persistence';
/** Native-copy preflight shared by conversions and Save As; no GLB data URLs. */
import { storedAssetPath } from '../project/assetPath';
import { joinPath, type FileBridge } from '../project/types';
import type { Asset } from '../types';
export interface PreparedModelCopy { source:string; destination:string; sha256:string; asset:Asset; sidecars:Scene3dSidecars }
export async function prepareModelCopy(bridge:FileBridge,sourceRoot:string,asset:Asset,destinationRoot:string,destinationPath:string,options:{sourcePrefix?:string}={}):Promise<PreparedModelCopy> {
  if(asset.kind!=='glb'||!asset.sha256||!asset.path) throw new Error('Native model copy requires complete GLB metadata');
  if(!bridge.copyFileVerified) throw new Error('Native model copy is unavailable in this host');
  const sourcePath=storedAssetPath([options.sourcePrefix,asset.path].filter(Boolean).join("/")), targetPath=storedAssetPath(destinationPath);
  const source=bridge.projectAssetPath?await bridge.projectAssetPath(sourceRoot,sourcePath):joinPath(sourceRoot,sourcePath);
  if(!await bridge.exists(source)) throw new Error(`Missing GLB asset ${asset.id}`);
  const sidecars=await readScene3dSidecars(bridge,joinPath(sourceRoot,options.sourcePrefix??"","assets"),asset.id,{strict:true});
  return {sidecars,source,destination:joinPath(destinationRoot,targetPath),sha256:asset.sha256,asset:{...asset,path:targetPath}};
}
export async function publishModelCopy(bridge:FileBridge,copy:PreparedModelCopy,assertOwner:()=>void|Promise<void>=()=>{}):Promise<void> {
  await assertOwner();
  if(!bridge.copyFileVerified) throw new Error('Native model copy is unavailable in this host');
  await bridge.copyFileVerified(copy.source,copy.destination,copy.sha256);
  await assertOwner();
}
export function assertModel3dDeckConversionAvailable(elements:readonly {type:string}[]):void {
  if(elements.some(e=>e.type==='model3d')) throw new Error('3D deck conversion is not available in this deck format yet');
}
