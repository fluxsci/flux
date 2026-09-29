import type { Scene3dManifest,Rect } from './types';
import type { PartOverride } from '../types';
import { buildScene3dPartIndex, resolveScene3dPartStyle, scene3dFields } from './scene3d';
import { niceTicks, tickLabel } from './ticks';
import { textWidth, wrapWords } from './textMetrics';
/** `titleLines`: a colorbar title wrapped to the guide column, drawn bottom-aligned above the bar. */
export interface FurnitureSlot extends Rect {partId:string;titleLines?:string[]}
export interface FurnitureLayout {viewport:Rect;box:Rect;fontSize:number;lineHeight:number;title?:FurnitureSlot;colorbar?:FurnitureSlot;legend?:FurnitureSlot;scalebar?:FurnitureSlot;colorbars:FurnitureSlot[];legends:FurnitureSlot[];scalebars:FurnitureSlot[]}
export function furnitureLayout(manifest:Scene3dManifest|null|undefined,box:{x?:number;y?:number;width:number;height:number},overrides:Record<string,PartOverride>={}):FurnitureLayout {
 const x=box.x??0,y=box.y??0,width=Math.max(1,box.width),height=Math.max(1,box.height),parts=manifest?.parts??[];
 const fs=(manifest?.style?.fontSizePt??7)*4/3,lineHeight=fs*1.4;
 const index=manifest?buildScene3dPartIndex(manifest):undefined;
 const style=(id:string)=>resolveScene3dPartStyle(manifest,overrides,id,{index});
 const visible=(role:string)=>parts.filter(p=>p.role===role&&!style(p.id).hidden);
 const title=manifest?.layout?.title==='none'?undefined:visible('title')[0];
 const cbs=manifest?.layout?.colorbar==='none'?[]:visible('colorbar'),legends=manifest?.layout?.legend==='none'?[]:visible('legend'),scales=visible('scalebar');
 const titleH=title?Math.max(lineHeight,(style(title.id).fontSize??((manifest?.style?.titleSizePt??8)*4/3))*1.5)+4:0;
 // The guide column grows to fit its text (colorbar titles and tick labels, legend labels),
 // capped at 40% of the box; titles still wider than the column wrap onto more lines.
 const fields=scene3dFields(manifest),partIndex:Record<string,{label?:string}>=index??{},pad=fs*.5;
 const fieldOf=(part:{field?:unknown})=>typeof part.field==='string'?fields[part.field]:undefined;
 let needW=0;
 for(const part of cbs){const size=style(part.id).fontSize??fs,field=fieldOf(part);if(!field)continue;
  const ticks=field.ticks??(field.range?niceTicks(field.range[0],field.range[1]):[]),tickW=Math.max(0,...ticks.map(t=>textWidth(tickLabel(t),size)));
  needW=Math.max(needW,fs+Math.max(field.label?textWidth(field.label,size):0,Math.max(6,fs)+6+tickW)+pad);}
 for(const part of legends){const labels=(part.entries??[]).filter(id=>partIndex[id]&&!style(id).hidden).map(id=>partIndex[id].label??id);
  needW=Math.max(needW,fs*2.5+Math.max(0,...labels.map(l=>textWidth(l,fs)))+pad);}
 const guideW=cbs.length||legends.length?Math.min(width*.4,Math.max(64,fs*9,needW)):0;
 const axesMargin=manifest?.axes?.kind==='box'?Math.min(3*fs,width*.15,height*.15):0;
 const viewport:Rect={x:x+axesMargin,y:y+titleH+axesMargin,width:Math.max(1,width-guideW-2*axesMargin),height:Math.max(1,height-titleH-2*axesMargin)};
 const colorbars:FurnitureSlot[]=[],legendSlots:FurnitureSlot[]=[],scalebars:FurnitureSlot[]=[];
 const slotHeight=(height-titleH)/Math.max(1,cbs.length+legends.length);let slot=0;
 for(const part of cbs){
  const labelSize=style(part.id).fontSize??fs,label=fieldOf(part)?.label;
  const titleLines=label?wrapWords(label,labelSize,guideW-fs-pad):[];
  // Reserve separate title line(s) and top-tick line without scaling physical text.
  const top=labelSize*(2.1+1.25*Math.max(0,titleLines.length-1));
  colorbars.push({partId:part.id,x:x+width-guideW+fs,y:y+titleH+slot++*slotHeight+top,width:Math.max(6,fs),height:Math.max(1,slotHeight-top-2*Math.max(lineHeight,labelSize*1.4)),...(titleLines.length?{titleLines}:{})});
 }
 for(const part of legends)legendSlots.push({partId:part.id,x:x+width-guideW+fs,y:y+titleH+slot++*slotHeight+lineHeight,width:Math.max(1,guideW-fs*2),height:Math.max(lineHeight,slotHeight-lineHeight)});
 for(const [i,part]of scales.entries())scalebars.push({partId:part.id,x:viewport.x+12,y:viewport.y+viewport.height-12-i*(lineHeight+10),width:Math.max(1,viewport.width-24),height:lineHeight+6});
 return {box:{x,y,width,height},viewport,fontSize:fs,lineHeight,...(title?{title:{partId:title.id,x,y,width,height:titleH}}:{}),colorbars,legends:legendSlots,scalebars,
 ...(colorbars[0]?{colorbar:colorbars[0]}:{}),...(legendSlots[0]?{legend:legendSlots[0]}:{}),...(scalebars[0]?{scalebar:scalebars[0]}:{})};
}
