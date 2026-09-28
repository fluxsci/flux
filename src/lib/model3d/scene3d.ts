import type { PartOverride } from '../types';
import { validateScene3d } from './scene3dValidator.gen.mjs';
import type { Scene3dManifest, Scene3dPart, Scene3dField, Model3dInfo } from './types';
export type { Scene3dManifest, Scene3dPart, Scene3dField } from './types';
export interface Scene3dIssue { issue:string }
export const isScene3d = (value:unknown): value is Scene3dManifest => !!value && typeof value==='object' && (value as {spec?:unknown}).spec==='fluxplot/scene3d';
export function parseScene3d(input:unknown): Scene3dManifest|Scene3dIssue {
  let data:unknown=input;
  try{if(typeof input==='string'){if(input.length>4*1024*1024)return {issue:'3D manifest exceeds 4 MiB'};data=JSON.parse(input);}}catch{return {issue:'Invalid 3D manifest JSON'};}
  if(!isScene3d(data))return {issue:'Not a fluxplot/scene3d manifest'};
  if(data.schemaVersion!=='0.1.0')return {issue:`Unsupported scene3d version ${String(data.schemaVersion)}`};
  if(!validateScene3d(data))return {issue:`Invalid scene3d manifest: ${validateScene3d.errors?.map((e:{instancePath?:string;message?:string})=>`${e.instancePath??''} ${e.message??''}`).join('; ')}`};
  const parts=data.parts??[],ids=new Set<string>();
  for(const p of parts){if(ids.has(p.id))return {issue:`Duplicate scene3d part ${p.id}`};ids.add(p.id);}
  const index=buildScene3dPartIndex(data);
  for(const p of parts){
    if(p.parent&&!ids.has(p.parent))return {issue:`Missing parent ${p.parent} for ${p.id}`};
    const seen=new Set([p.id]);let parent=p.parent;while(parent){if(seen.has(parent))return {issue:`Cyclic scene3d part parents at ${p.id}`};seen.add(parent);parent=index[parent]?.parent;}
    if(typeof p.field==='string'&&(!index[p.field]||typeof index[p.field].field!=='object'))return {issue:`Unknown field ${p.field}`};
    if(p.entries?.some(id=>!ids.has(id)))return {issue:`Unknown legend entry in ${p.id}`};
    if(typeof p.field==='object'){
      const f=p.field;if(f.range[0]>f.range[1])return {issue:`Field ${p.id} has a reversed range`};
      if(f.cmap.stops[0][0]!==0||f.cmap.stops.at(-1)![0]!==1||f.cmap.stops.some((s,i)=>i>0&&s[0]<=f.cmap.stops[i-1][0]))return {issue:`Field ${p.id} has unordered colormap stops`};
    }
  }
  if(data.bounds&&data.bounds.min.some((v,i)=>v>data.bounds!.max[i]))return {issue:'Reversed scene3d bounds'};
  if(data.toWorld&&(data.toWorld[3]!==0||data.toWorld[7]!==0||data.toWorld[11]!==0||data.toWorld[15]!==1))return {issue:'toWorld must be an affine column-major matrix'};
  if(data.toWorld){const m=data.toWorld,cols=[m.slice(0,3),m.slice(4,7),m.slice(8,11)],dot=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*b[i],0);const determinant=m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]);if(cols.some((v,i)=>Math.abs(dot(v,v)-1)>1e-6||cols.some((w,j)=>i!==j&&Math.abs(dot(v,w))>1e-6))||Math.abs(determinant-1)>1e-6||m[12]!==0||m[13]!==0||m[14]!==0)return {issue:'toWorld must be a proper rotation (orthonormal, determinant +1)'};}
  if(data.states&&new Set(data.states.map(s=>s.name)).size!==data.states.length)return {issue:'Duplicate shape state names'};
  if(data.order?.some(id=>!ids.has(id)))return {issue:'Unknown part in scene3d order'};
  return data;
}
export interface IndexedScene3dPart extends Scene3dPart {kind:'mesh'|'field'|'missing'|'furniture'}
export function buildScene3dPartIndex(manifest:Scene3dManifest):Record<string,IndexedScene3dPart>{
  const index:Record<string,IndexedScene3dPart>=Object.create(null);
  for(const p of manifest.parts??[])index[p.id]={...p,kind:p.kind??(p.node?(typeof p.field==='object'?'field':p.id.endsWith('.missing')?'missing':'mesh'):'furniture')};
  return index;
}
export const scene3dPartIndex=buildScene3dPartIndex;
export function scene3dFields(manifest?:Scene3dManifest|null):Record<string,Scene3dField>{
 const fields:Record<string,Scene3dField>=Object.create(null);for(const p of manifest?.parts??[])if(typeof p.field==='object')fields[p.id]=p.field;return fields;
}
/** Geometry owns state names. Metadata never invents unavailable GPU targets. */
export function scene3dStateIssues(manifest:Scene3dManifest,info:Model3dInfo):string[]{
 const names=new Set(info.states);return (manifest.states??[]).filter(s=>!names.has(s.name)).map(s=>`Manifest shape state ${s.name} is absent from the GLB; GLB state names are used`);
}

/** Shared semantic cascade. Ancestor opacity multiplies; hiding an ancestor hides its subtree.
 * A local hidden:false restores a source-hidden part but cannot unhide its hidden parent. */
export function resolveScene3dPartStyle(manifest:Scene3dManifest|null|undefined,overrides:Record<string,PartOverride>|undefined,id:string,opts:{sourceColors?:boolean}={}):PartOverride {
 const index=manifest?buildScene3dPartIndex(manifest):{},lineage:Scene3dPart[]=[],seen=new Set<string>();let p=index[id];
 while(p&&!seen.has(p.id)){seen.add(p.id);lineage.unshift(p);p=p.parent?index[p.parent]:undefined!;}
 if(!lineage.length)return {...overrides?.[id]};
 let result:PartOverride={},opacity=1,hidden=false,sourceColor:string|undefined;
 for(const part of lineage){const o=overrides?.[part.id]??{};sourceColor=part.color??sourceColor;result={...result,...o};opacity*=o.opacity??part.opacity??1;hidden ||= o.hidden??part.hidden??false;}
 if(result.fill==null&&opts.sourceColors!==false&&sourceColor)result.fill=sourceColor;
 result.opacity=opacity;result.hidden=hidden;
 return result;
}
