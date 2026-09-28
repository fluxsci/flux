/** Enumerate references by purpose: GLB bytes must never enter image/base64 paths. */
export interface ElementAssetRefs {images:string[];models:string[];manifests:string[];posterRefs:string[]}
interface RefElement {type:string;assetId?:string;posterAssetId?:string;source?:{manifestPath?:string};manifestRef?:unknown}
export function elementAssetRefs(el:RefElement,posterIdOf?:(el:RefElement)=>string|null|undefined):ElementAssetRefs {
 const out:ElementAssetRefs={images:[],models:[],manifests:[],posterRefs:[]};
 if(el.type==='model3d'){if(el.assetId)out.models.push(el.assetId);const poster=posterIdOf?.(el);if(poster)out.posterRefs.push(poster);}
 else if(el.type==='video'){if(el.posterAssetId)out.images.push(el.posterAssetId);}
 else if(el.assetId)out.images.push(el.assetId);
 if(el.source?.manifestPath)out.manifests.push(el.source.manifestPath);
 return out;
}
