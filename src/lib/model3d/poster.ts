import { canonical,cyrb53,hex14 } from './hash';
import { boundsSphere,clamp,normalizeAzimuth } from './orbit';
import { framingBounds } from './framing';
import { buildScene3dPartIndex,scene3dFields,resolveScene3dPartStyle } from './scene3d';
import { resolvedColormap } from './colormap';
import type { Model3dAsset,Model3dElement,Scene3dManifest,Rect } from './types';
export const RENDERER_VERSION='m3d-r4';
const round=(n:number,p:number)=>Math.round(n/p)*p;
const sig=(n:number)=>Number(n.toPrecision(5));
export function posterKey(el:Model3dElement,asset:Model3dAsset,manifest:Scene3dManifest|null|undefined,px:{w:number;h:number}):string{
 const index:ReturnType<typeof buildScene3dPartIndex>=manifest?buildScene3dPartIndex(manifest):Object.create(null),parts:Record<string,unknown>=Object.create(null),fields:Record<string,unknown>=Object.create(null),states:Record<string,number>=Object.create(null);
 for(const id of manifest?Object.values(index).filter(p=>p.node).map(p=>p.id):asset.model.partNames){
  const override=resolveScene3dPartStyle(manifest,el.overrides,id,{index}),entry:Record<string,unknown>={};
  for(const k of ['fill','opacity','hidden'] as const)if(override[k]!=null)entry[k]=k==='fill'?String(override[k]).toLowerCase():override[k];
  if(Object.keys(entry).length)parts[id]=entry;
 }
 // The key holds every render input: the stops the renderer resolves (a named
 // override's stops, not just its name), the transparent draw order and the framing radius.
 for(const [id,f]of Object.entries(scene3dFields(manifest))){
  const o=el.fields?.[id];let stops:Array<[number,string]>|null;
  try{stops=resolvedColormap(f,o);}catch{stops=null;}
  fields[id]={cmap:o?.cmap??f.cmap.name,range:o?.range??f.range,stops,missing:f.missingColor??'#D8D8D8'};
 }
 // The sphere the camera frames: tight radius, legacy half-diagonal, or grown to hold box axes.
 const sphere=boundsSphere(framingBounds(asset.model.bounds,manifest)),framing=[...sphere.center,sphere.radius].map(v=>Number(v.toPrecision(9)));
 for(const [k,v]of Object.entries(el.modelStates??{}))if(v!==0)states[k]=sig(v);
 return 'm3d-'+hex14(cyrb53(canonical({v:RENDERER_VERSION,glb:asset.sha256,az:round(normalizeAzimuth(el.orbitAzimuth),.001),el:round(clamp(el.orbitElevation,-90,90),.001),roll:round(normalizeAzimuth(el.orbitRoll??0),.001),z:sig(clamp(el.orbitZoom,.02,50)),px:round(el.orbitPanX??0,.0001),py:round(el.orbitPanY??0,.0001),proj:el.orbitProjection,fov:el.orbitProjection==='perspective'?round(el.orbitFov,.001):null,fill:el.fill.toLowerCase(),colors:el.modelColors??'uniform',lighting:el.modelLighting??'studio',parts,fields,states,order:manifest?.order??null,framing,w:px.w,h:px.h})));
}
export type PosterSurface='figure'|'slide'|'thumbnail'|'pdf'|'svg'|{kind:'raster';dpi:number}|{kind:'editor';base?:'figure'|'slide';onscreen?:{w:number;h:number};dpr?:number};
/** Input is already the furniture-subtracted viewport in canvas CSS px. */
export function posterPixels(viewport:{width:number;height:number},surface:PosterSurface):{w:number;h:number}{
 const {width,height}=viewport;if(![width,height].every(n=>Number.isFinite(n)&&n>0))throw new Error('Invalid model viewport size');
 let scale=300/96,min=256,max=4096;
 if(surface==='slide')scale=2;else if(surface==='thumbnail')scale=256/Math.max(width,height);else if(surface==='pdf'||surface==='svg'){scale=600/96;max=8192;min=0;}
 else if(typeof surface==='object'&&surface.kind==='raster'){if(!Number.isFinite(surface.dpi)||surface.dpi<=0)throw new Error('Invalid export DPI');scale=surface.dpi/96;max=8192;min=0;}
 else if(typeof surface==='object'&&surface.kind==='editor'){
  const stored=posterPixels(viewport,surface.base??'figure'),target=Math.max(stored.w,stored.h,(surface.onscreen?.w??0)*(surface.dpr??1),(surface.onscreen?.h??0)*(surface.dpr??1));
  scale=Math.pow(2,Math.ceil(Math.log2(target)))/Math.max(width,height);
 }
 const long=Math.max(width,height)*scale;scale*=Math.max(min,Math.min(max,long))/long;
 return {w:Math.max(1,Math.round(width*scale)),h:Math.max(1,Math.round(height*scale))};
}
export const posterPath=(key:string)=>{if(!/^m3d-[\da-f]{14}$/.test(key))throw new Error('Invalid model poster key');return `fig/renders/model3d/${key}.png`;};
export const posterRef=(key:string)=>`m3dposter:${key}`;
/** Shared GUI/Node cache GC policy: current views and recent history survive. */
export function isModelPosterPrunable(name:string,mtimeMs:number,live:ReadonlySet<string>,now=Date.now()):boolean {
 return /^m3d-[\da-f]{14}\.png$/.test(name)&&Number.isFinite(mtimeMs)&&mtimeMs<now-14*86400_000&&!live.has(name.slice(0,-4));
}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function modelPlaceholder(name:string,box:Rect):string{return `<g data-model3d-placeholder="true"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#F2F0E5" stroke="#B7B5AC" stroke-width="0.75"/><text x="${box.x+box.width/2}" y="${box.y+box.height/2-4}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#6F6E69">3D</text><text x="${box.x+box.width/2}" y="${box.y+box.height/2+14}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6F6E69">${esc(name)}</text></g>`;}
export const modelPosterWarning=(name:string)=>`3D model "${name}": poster not rendered — open the project in Flux or run flux render-model-posters`;
