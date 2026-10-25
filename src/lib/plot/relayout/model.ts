import type { FluxPlotManifest } from "../types";
import type { FluxPlotLayout, LayoutAxis, LayoutColorbar } from "../types.gen";
import type {MplPath} from "./path";
import { stretchReport, type RelayoutReport } from "./report";
export type { FluxPlotLayout, LayoutAxis, LayoutColorbar };
export interface Box {x0:number;y0:number;x1:number;y1:number}
export const asBox=(v:readonly number[]):Box=>({x0:v[0],y0:v[1],x1:v[2],y1:v[3]});
export const boxArray=(b:Box)=>[b.x0,b.y0,b.x1,b.y1];
export const width=(b:Box)=>b.x1-b.x0, height=(b:Box)=>b.y1-b.y0;
export function unionBoxes(boxes:Box[]):Box {
  return {x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))};
}
export interface RelayoutModel {supported:true;manifest:FluxPlotManifest;layout:FluxPlotLayout;axes:Map<string,LayoutAxis|LayoutColorbar>;tickLabels:Map<string,{id:string;text:FluxPlotLayout["texts"][string];value:number}[]>;textFrames:[string,FluxPlotLayout["frames"][string]][];paths:Map<string,MplPath>}
export interface RefusedModel {supported:false;report:RelayoutReport}
const checkedRoots=new WeakMap<Element,boolean>();
const models=new WeakMap<FluxPlotManifest,RelayoutModel|RefusedModel>();
export function buildRelayoutModel(manifest:FluxPlotManifest|undefined,root?:Element):RelayoutModel|RefusedModel {
  if(!manifest?.layout)return {supported:false,report:stretchReport("layout:missing")};
  if(root){
    let valid=checkedRoots.get(root);
    if(valid===undefined){valid=true;const definitions=new Set(root.querySelectorAll('defs path'));for(const el of Array.from(root.querySelectorAll('path[d]'))){
      if(definitions.has(el)||el.getAttribute('data-flux-glyph')==='1')continue;
      if(/[a-df-yABDF-KN-PR-Y]/.test(el.getAttribute('d')??'')){valid=false;break;}
    }checkedRoots.set(root,valid);}
    if(!valid)return {supported:false,report:stretchReport('path:relative')};
  }
  const hit=models.get(manifest);if(hit)return hit;
  const l=manifest.layout;
  let result:RelayoutModel|RefusedModel;
  const reasons=[...l.reasons];
  if(l.version!==1)reasons.push("layout:version");
  if(!(l.figure.widthPt>0&&l.figure.heightPt>0))reasons.push("layout:size");
  if(!l.supported||reasons.length)result={supported:false,report:stretchReport(...new Set(reasons))};
  else {
    const tickLabels:RelayoutModel['tickLabels']=new Map();for(const [id,f]of Object.entries(l.frames))if(f.part==='ticklabel'&&!f.minor&&f.axes&&f.axis&&f.value!=null&&l.texts[id]){const key=f.axes+'/'+f.axis,list=tickLabels.get(key)??[];list.push({id,text:l.texts[id],value:f.value});tickLabels.set(key,list);}
    result={supported:true,manifest,layout:l,axes:new Map([...l.axes,...l.colorbars].map(a=>[a.id,a])),tickLabels,paths:new Map(),textFrames:Object.entries(l.frames).filter(([id])=>!!l.texts[id])};
  }
  models.set(manifest,result);return result;
}
/** Size fields are canvas px; matplotlib layout and the SVG viewBox use pt. */
export function targetFigureSize(el:{width:number;height:number;contentScale?:number}) {
  const cs=el.contentScale??1;
  return {wPt:el.width*.75/cs,hPt:el.height*.75/cs};
}
