import type { Scene3dManifest,Rect,Model3dElement } from './types';
import type { PartOverride } from '../types';
import { buildScene3dPartIndex, resolveScene3dPartStyle, scene3dFields } from './scene3d';
import { colorbarTicks, tickLabel } from './ticks';
import { textWidth, wrapWords } from './textMetrics';
/** Line breaks are shared by every renderer; no renderer measures or truncates guide text. */
export interface FurnitureSlot extends Rect {partId:string;titleLines?:string[];legendRows?:{id:string;lines:string[];offset:number}[]}
export interface FurnitureLayout {viewport:Rect;box:Rect;fontSize:number;lineHeight:number;overflow:boolean;overflowParts:string[];title?:FurnitureSlot;colorbar?:FurnitureSlot;legend?:FurnitureSlot;scalebar?:FurnitureSlot;colorbars:FurnitureSlot[];legends:FurnitureSlot[];scalebars:FurnitureSlot[]}
export function furnitureLayout(manifest:Scene3dManifest|null|undefined,box:{x?:number;y?:number;width:number;height:number;fields?:Model3dElement['fields']},overrides:Record<string,PartOverride>={}):FurnitureLayout {
 const x=box.x??0,y=box.y??0,width=Math.max(1,box.width),height=Math.max(1,box.height),parts=manifest?.parts??[];
 const fs=(manifest?.style?.fontSizePt??7)*4/3,lineHeight=fs*1.4;
 const index=manifest?buildScene3dPartIndex(manifest):undefined;
 const style=(id:string)=>resolveScene3dPartStyle(manifest,overrides,id,{index});
 const visible=(role:string)=>parts.filter(p=>p.role===role&&!style(p.id).hidden);
 const title=manifest?.layout?.title==='none'?undefined:visible('title')[0];
 const cbs=manifest?.layout?.colorbar==='none'?[]:visible('colorbar'),legends=manifest?.layout?.legend==='none'?[]:visible('legend'),scales=visible('scalebar');
 const titleH=title?Math.max(lineHeight,(style(title.id).fontSize??((manifest?.style?.titleSizePt??8)*4/3))*1.5)+4:0;
 // Reserve at most 40% for guides. Widths are deterministic font estimates; fonts
 // remain physical size. If even one glyph/tick cannot fit, report overflow.
 const fields=scene3dFields(manifest),pad=fs*.5,partIndex=index??{};
 const fieldOf=(part:{field?:unknown})=>typeof part.field==='string'?fields[part.field]:undefined;
 const ticksOf=(part:{field?:unknown})=>{const f=fieldOf(part);return f?colorbarTicks(f,box.fields?.[String(part.field)]?.range):[];};
 const entriesOf=(part:{entries?:string[]})=>(part.entries??[]).filter(id=>partIndex[id]&&!style(id).hidden);
 let needW=0;
 for(const part of cbs){const size=style(part.id).fontSize??fs,field=fieldOf(part);if(!field)continue;
  const tickW=Math.max(0,...ticksOf(part).map(t=>textWidth(tickLabel(t),size)));
  needW=Math.max(needW,fs+Math.max(field.label?textWidth(field.label,size):0,Math.max(6,fs)+6+tickW)+pad);}
 for(const part of legends){const size=style(part.id).fontSize??fs;
  needW=Math.max(needW,fs*2.5+Math.max(0,...entriesOf(part).map(id=>textWidth(partIndex[id].label??id,size)))+pad);}
 const guideW=cbs.length||legends.length?Math.min(width*.4,Math.max(64,fs*9,needW)):0;
 const axesMargin=manifest?.axes?.kind==='box'?Math.min(3*fs,width*.15,height*.15):0;
 const viewport:Rect={x:x+axesMargin,y:y+titleH+axesMargin,width:Math.max(1,width-guideW-2*axesMargin),height:Math.max(1,height-titleH-2*axesMargin)};
 const colorbars:FurnitureSlot[]=[],legendSlots:FurnitureSlot[]=[],scalebars:FurnitureSlot[]=[],overflowParts:string[]=[];
 const markOverflow=(id:string)=>{if(!overflowParts.includes(id))overflowParts.push(id);};
 const guides=[...cbs.map(part=>{
  const size=style(part.id).fontSize??fs,label=fieldOf(part)?.label,titleLines=label?wrapWords(label,size,guideW-fs-pad):[];
  const top=size*(2.1+1.25*Math.max(0,titleLines.length-1)),bottom=2*Math.max(lineHeight,size*1.4);
  if(titleLines.some(line=>textWidth(line,size)>guideW-fs-pad)||ticksOf(part).some(t=>fs+Math.max(6,fs)+6+textWidth(tickLabel(t),size)+pad>guideW))markOverflow(part.id);
  return {part,size,top,bottom,minHeight:top+bottom+Math.max(size*2,(ticksOf(part).length-1)*size*1.4),titleLines,rows:undefined};
 }),...legends.map(part=>{
  const size=style(part.id).fontSize??fs,rowHeight=Math.max(lineHeight,size*1.4);let offset=0;
  const rows=entriesOf(part).map(id=>{const lines=wrapWords(partIndex[id].label??id,size,guideW-fs*2.5-pad),row={id,lines,offset};offset+=lines.length*rowHeight;return row;});
  if(rows.some(row=>row.lines.some(line=>textWidth(line,size)>guideW-fs*2.5-pad)))markOverflow(part.id);
  return {part,size,top:rowHeight,bottom:rowHeight,minHeight:rowHeight+Math.max(rowHeight,offset),titleLines:undefined,rows};
 })];
 // Preserve classic equal slots when they fit; borrow unused height from shorter
 // guides for wrapped titles/rows. Impossible boxes keep all text and report resize.
 const available=Math.max(0,height-titleH),equal=available/Math.max(1,guides.length),heights=guides.map(g=>Math.max(equal,g.minHeight));
 let deficit=heights.reduce((a,b)=>a+b,0)-available;
 for(let i=0;i<guides.length&&deficit>0;i++){const take=Math.min(deficit,heights[i]-guides[i].minHeight);heights[i]-=take;deficit-=take;}
 let offset=0;
 guides.forEach((g,i)=>{
  if(offset+heights[i]>available+1e-9)markOverflow(g.part.id);
  const slot={partId:g.part.id,x:x+width-guideW+fs,y:y+titleH+offset+g.top};
  if(g.titleLines)colorbars.push({...slot,width:Math.max(6,fs),height:Math.max(1,heights[i]-g.top-g.bottom),...(g.titleLines.length?{titleLines:g.titleLines}:{})});
  else legendSlots.push({...slot,width:Math.max(1,guideW-fs*2),height:Math.max(g.top,heights[i]-g.top),legendRows:g.rows});
  offset+=heights[i];
 });
 for(const [i,part]of scales.entries())scalebars.push({partId:part.id,x:viewport.x+12,y:viewport.y+viewport.height-12-i*(lineHeight+10),width:Math.max(1,viewport.width-24),height:lineHeight+6});
 return {box:{x,y,width,height},viewport,fontSize:fs,lineHeight,overflow:!!overflowParts.length,overflowParts,...(title?{title:{partId:title.id,x,y,width,height:titleH}}:{}),colorbars,legends:legendSlots,scalebars,
 ...(colorbars[0]?{colorbar:colorbars[0]}:{}),...(legendSlots[0]?{legend:legendSlots[0]}:{}),...(scalebars[0]?{scalebar:scalebars[0]}:{})};
}
