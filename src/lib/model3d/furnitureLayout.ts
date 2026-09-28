import type { Scene3dManifest,Rect } from './types';
import type { PartOverride } from '../types';
import { resolveScene3dPartStyle } from './scene3d';
export interface FurnitureSlot extends Rect {partId:string}
export interface FurnitureLayout {viewport:Rect;box:Rect;fontSize:number;lineHeight:number;title?:FurnitureSlot;colorbar?:FurnitureSlot;legend?:FurnitureSlot;scalebar?:FurnitureSlot;colorbars:FurnitureSlot[];legends:FurnitureSlot[];scalebars:FurnitureSlot[]}
export function furnitureLayout(manifest:Scene3dManifest|null|undefined,box:{x?:number;y?:number;width:number;height:number},overrides:Record<string,PartOverride>={}):FurnitureLayout {
 const x=box.x??0,y=box.y??0,width=Math.max(1,box.width),height=Math.max(1,box.height),parts=manifest?.parts??[];
 const fs=(manifest?.style?.fontSizePt??7)*4/3,lineHeight=fs*1.4;
 const visible=(role:string)=>parts.filter(p=>p.role===role&&!(overrides[p.id]?.hidden??p.hidden));
 const title=manifest?.layout?.title==='none'?undefined:visible('title')[0];
 const cbs=manifest?.layout?.colorbar==='none'?[]:visible('colorbar'),legends=manifest?.layout?.legend==='none'?[]:visible('legend'),scales=visible('scalebar');
 const titleH=title?Math.max(lineHeight,(overrides[title.id]?.fontSize??((manifest?.style?.titleSizePt??8)*4/3))*1.5)+4:0;
 const guideW=cbs.length||legends.length?Math.min(width*.4,Math.max(64,fs*9)):0;
 const axesMargin=manifest?.axes?.kind==='box'?Math.min(3*fs,width*.15,height*.15):0;
 const viewport:Rect={x:x+axesMargin,y:y+titleH+axesMargin,width:Math.max(1,width-guideW-2*axesMargin),height:Math.max(1,height-titleH-2*axesMargin)};
 const colorbars:FurnitureSlot[]=[],legendSlots:FurnitureSlot[]=[],scalebars:FurnitureSlot[]=[];
 const slotHeight=(height-titleH)/Math.max(1,cbs.length+legends.length);let slot=0;
 for(const part of cbs){
  const labelSize=resolveScene3dPartStyle(manifest,overrides,part.id).fontSize??fs;
  // Reserve separate title and top-tick lines without scaling physical text.
  const top=labelSize*2.1;
  colorbars.push({partId:part.id,x:x+width-guideW+fs,y:y+titleH+slot++*slotHeight+top,width:Math.max(6,fs),height:Math.max(1,slotHeight-top-2*lineHeight)});
 }
 for(const part of legends)legendSlots.push({partId:part.id,x:x+width-guideW+fs,y:y+titleH+slot++*slotHeight+lineHeight,width:Math.max(1,guideW-fs*2),height:Math.max(lineHeight,slotHeight-lineHeight)});
 for(const [i,part]of scales.entries())scalebars.push({partId:part.id,x:viewport.x+12,y:viewport.y+viewport.height-12-i*(lineHeight+10),width:Math.max(1,viewport.width-24),height:lineHeight+6});
 return {box:{x,y,width,height},viewport,fontSize:fs,lineHeight,...(title?{title:{partId:title.id,x,y,width,height:titleH}}:{}),colorbars,legends:legendSlots,scalebars,
 ...(colorbars[0]?{colorbar:colorbars[0]}:{}),...(legendSlots[0]?{legend:legendSlots[0]}:{}),...(scalebars[0]?{scalebar:scalebars[0]}:{})};
}
