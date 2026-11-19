/** Enumerate references by purpose: GLB bytes and fluximg bundles must never enter image/base64 paths. */
import type { Element } from "../types";
export interface ElementAssetRefs {
 images:string[];models:string[];media:string[];
 /** fluximg bundles: immutable DIRECTORIES (`assets/<id>.fluximg`) read only in ranged pieces. Referenced for GC and
  *  dependencies, never read whole, base64'd or thumbnailed. */
 stacks:string[];
 manifests:string[];posterRefs:string[];
}
interface RefElement {type:string;assetId?:string;posterAssetId?:string;source?:{manifestPath?:string;bundlePath?:string};manifestRef?:unknown}
export function elementAssetRefs(el:RefElement,posterIdOf?:(el:RefElement)=>string|null|undefined):ElementAssetRefs {
 const out:ElementAssetRefs={images:[],models:[],media:[],stacks:[],manifests:[],posterRefs:[]};
 if(el.type==='model3d'){if(el.assetId)out.models.push(el.assetId);const poster=posterIdOf?.(el);if(poster)out.posterRefs.push(poster);}
 else if(el.type==='video'){if(el.assetId)out.media.push(el.assetId);if(el.posterAssetId)out.images.push(el.posterAssetId);}
 else if(el.type==='fluximg'){if(el.assetId)out.stacks.push(el.assetId);}
 // image + plot are the readable kinds. `ClassifiedKinds` below fails the build when a new element kind with an
 // assetId appears, so it is classified here deliberately instead of silently falling into `images`.
 else if(el.assetId)out.images.push(el.assetId);
 if(el.source?.manifestPath)out.manifests.push(el.source.manifestPath);
 return out;
}

/** Physical source IDs for GC/dependencies; derived poster keys and sidecar paths are separate. */
export function elementSourceAssetIds(el:RefElement):string[] { const r=elementAssetRefs(el); return [...r.images,...r.models,...r.media,...r.stacks]; }

/** Every element kind that carries an `assetId`, and the bucket it belongs to above. */
type ClassifiedKinds = 'image'|'plot'|'model3d'|'video'|'fluximg';
type AssetBearingKinds = Extract<Element,{assetId:unknown}>['type'];
/** Compile-time exhaustiveness: a new asset-bearing kind must be added to `ClassifiedKinds` (and to a bucket). */
export const ASSET_KINDS_CLASSIFIED:[Exclude<AssetBearingKinds,ClassifiedKinds>] extends [never]?true:never=true;
