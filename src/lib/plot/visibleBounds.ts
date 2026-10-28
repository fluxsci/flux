// View-only bounds of a plot with hidden parts. Measured once after its content
// mount, never from a pointer or viewport subscription; saved placement remains
// the coordinate frame for resize/export/source updates.
import { writable } from 'svelte/store';
import type { Element as SceneElement, SemanticPlotElement } from '../types';
import { rotatedAABB, rotatePoint, rectIntersectsElement, unionRect, type Rect } from '../geometry';
import { insideDefs } from './derive';
import { compose, parseTransform, transformToAncestor, type SvgMatrix } from './svgMatrix';

const bounds=new Map<string,{root:SVGSVGElement;rect:Rect|null;width:number;height:number}>();
export const plotBoundsRevision=writable(0);
export const visiblePlotBoundsStats={measurements:0,lastMs:0};
const same=(a:Rect|null,b:Rect|null)=>a===b||!!a&&!!b&&['x','y','w','h'].every(k=>Math.abs(a[k as keyof Rect]-b[k as keyof Rect])<1e-6);
export function clearPlotVisibleBounds(id:string,root:SVGSVGElement):void {
  if(bounds.get(id)?.root===root){bounds.delete(id);plotBoundsRevision.update(n=>n+1);}
}
export function localPlotVisibleBounds(id:string,width?:number,height?:number):Rect|null|undefined {
  const value=bounds.get(id);if(!value||!value.rect)return value?.rect;
  const sx=width==null?1:width/value.width,sy=height==null?1:height/value.height,r=value.rect;
  return {x:r.x*sx,y:r.y*sy,w:r.w*sx,h:r.h*sy};
}

/** Node-local boxes through the live SVG transforms: text, glyphs, relayout,
 * overrides and crop all agree with what is actually drawn. No pixel sampling. */
export function measureVisiblePlotBounds(root:SVGSVGElement,element:Pick<SemanticPlotElement,'width'|'height'|'crop'>):Rect|null {
  const started=performance.now();visiblePlotBoundsStats.measurements++;
  const vb=(root.getAttribute('viewBox')??'').trim().split(/[\s,]+/).map(Number);
  const view=vb.length===4&&vb.every(Number.isFinite)&&vb[2]>0&&vb[3]>0?vb:[0,0,element.width,element.height];
  // getCTM targets each node's nearest viewport, which differs for a nested
  // SVG and its children. Screen matrices share one space; their ratio removes
  // scene zoom, pan, placement, rotation and flips exactly.
  const rootMatrix=root.getScreenCTM();if(!rootMatrix)return null;const inverse=rootMatrix.inverse(),rects:Rect[]=[];
  const hidden=new WeakMap<Element,boolean>(),styles=new WeakMap<Element,CSSStyleDeclaration>();
  const styleOf=(node:Element)=>{let style=styles.get(node);if(!style){style=getComputedStyle(node);styles.set(node,style);}return style;};
  const placement:SvgMatrix=[element.width/view[2],0,0,element.height/view[3],-view[0]*element.width/view[2],-view[1]*element.height/view[3]];
  const screenUnitsToPlacement=compose(placement,[inverse.a,inverse.b,inverse.c,inverse.d,inverse.e,inverse.f]);
  const screenToPlacement=(m:DOMMatrix):SvgMatrix=>compose(screenUnitsToPlacement,[m.a,m.b,m.c,m.d,m.e,m.f]);
  // An affine image of a rectangle: its extent is the centre ± the absolute half-axes.
  const mappedBox=(box:{x:number;y:number;width:number;height:number},[a,b,c,d,e,f]:SvgMatrix):Rect=>{
    const hw=box.width/2,hh=box.height/2,cx=box.x+hw,cy=box.y+hh,w=Math.abs(a)*hw+Math.abs(c)*hh,h=Math.abs(b)*hw+Math.abs(d)*hh;
    return{x:a*cx+c*cy+e-w,y:b*cx+d*cy+f-h,w:2*w,h:2*h};
  };
  const clipsOverflow=(value:string)=>['hidden','clip','scroll','auto'].includes(value);
  const crop=!!element.crop,rootStyle=styleOf(root),clipX=crop||clipsOverflow(rootStyle.overflowX),clipY=crop||clipsOverflow(rootStyle.overflowY);
  const viewport=(root.getAttribute('preserveAspectRatio')??'').trim()==='none'||crop?{x:0,y:0,w:element.width,h:element.height}:mappedBox(root.getBoundingClientRect(),screenUnitsToPlacement);
  // undefined is unbounded/unsupported, null is an empty clipping region.
  const intersect=(a:Rect|null|undefined,b:Rect|null|undefined):Rect|null|undefined=>{
    if(a===null||b===null)return null;if(a===undefined)return b;if(b===undefined)return a;
    const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.w,b.x+b.w),bottom=Math.min(a.y+a.h,b.y+b.h);
    return right<x||bottom<y?null:{x,y,w:right-x,h:bottom-y};
  };
  const byId=new Map<string,Element>();for(const node of Array.from(root.querySelectorAll('[id]')))if(!byId.has(node.id))byId.set(node.id,node);
  const clipGeometry=new WeakMap<Element,{box:DOMRect;matrix:SvgMatrix}[]|null>();
  const drawables='path,line,polyline,polygon,rect,circle,ellipse,text,image,use';
  const geometryOfClip=(clip:Element)=>{
    if(clipGeometry.has(clip))return clipGeometry.get(clip)!;
    const shapes:{box:DOMRect;matrix:SvgMatrix}[]=[];
    for(const shape of Array.from(clip.querySelectorAll<SVGGraphicsElement>(drawables))){
      let ignored=false;
      for(let p:Element|null=shape;p&&p!==clip;p=p.parentElement){if(p.tagName.toLowerCase()==='defs'||styleOf(p).display==='none'){ignored=true;break;}}
      if(ignored||styleOf(shape).visibility==='hidden')continue;
      // Clip geometry ignores fill, stroke and opacity. Its bounding rectangle
      // is conservative for paths/circles and exact for an axis-aligned rect.
      try{const box=shape.getBBox();if(box.width||box.height)shapes.push({box,matrix:transformToAncestor(shape,clip)});}catch{clipGeometry.set(clip,null);return null;}
    }
    clipGeometry.set(clip,shapes);return shapes;
  };
  const ownClip=new Map<Element,Rect|null|undefined>(),clipChain=new Map<Element,Rect|null|undefined>();
  const clipOf=(owner:Element):Rect|null|undefined=>{
    if(ownClip.has(owner))return ownClip.get(owner);
    const value=styleOf(owner).clipPath||owner.getAttribute('clip-path')||'';
    let ref=/#([^)'"\s]+)/.exec(value);
    const resource=/url\(\s*["']?([^#"']*)#/.exec(value)?.[1];
    // A different document's clip is not a local id just because its fragment
    // matches. Unsupported/external clips leave a conservative unbounded box.
    if(resource){try{if(new URL(resource,root.baseURI).href.split('#')[0]!==root.ownerDocument.URL.split('#')[0])ref=null;}catch{ref=null;}}
    let result:Rect|null|undefined;
    if(ref){
      let id=ref[1];try{id=decodeURIComponent(id);}catch{/* literal SVG id */}
      const clip=byId.get(id),graphics=owner as SVGGraphicsElement,matrix=graphics.getScreenCTM?.();
      if(clip?.tagName.toLowerCase()==='clippath'&&matrix){
        const geometry=geometryOfClip(clip);
        if(geometry){
          let local:SvgMatrix|undefined=[1,0,0,1,0,0];
          if(clip.getAttribute('clipPathUnits')==='objectBoundingBox'){
            const box=graphics.getBBox();local=box.width>0&&box.height>0?[box.width,0,0,box.height,box.x,box.y]:undefined;
          }
          if(local){const transform=compose(screenToPlacement(matrix),compose(local,parseTransform(clip.getAttribute('transform'))));result=unionRect(geometry.map(shape=>mappedBox(shape.box,compose(transform,shape.matrix))));}
        }
      }
    }
    if(owner!==root&&owner.tagName.toLowerCase()==='svg'&&clipsOverflow(styleOf(owner).overflowX)&&clipsOverflow(styleOf(owner).overflowY)){
      result=intersect(result,mappedBox(owner.getBoundingClientRect(),screenUnitsToPlacement));
    }
    ownClip.set(owner,result);return result;
  };
  const clipsOf=(node:Element):Rect|null|undefined=>{
    if(clipChain.has(node))return clipChain.get(node);
    const parent=node===root?undefined:node.parentElement?clipsOf(node.parentElement):undefined,result=intersect(parent,clipOf(node));clipChain.set(node,result);return result;
  };
  const isHidden=(node:Element):boolean=>{
    const known=hidden.get(node);if(known!==undefined)return known;
    let invisible=node!==root&&!!node.parentElement&&isHidden(node.parentElement)||node.getAttribute('data-role')==='background';
    if(!invisible){const style=styleOf(node);invisible=style.display==='none'||Number(style.opacity||1)===0;}
    hidden.set(node,invisible);return invisible;
  };
  for(const node of Array.from(root.querySelectorAll<SVGGraphicsElement>(drawables))){
    if(insideDefs(node)||isHidden(node)||typeof node.getBBox!=='function')continue;
    const style=styleOf(node),emptyPaint=(paint:string)=>paint==='none'||paint==='transparent'||paint==='rgba(0, 0, 0, 0)';
    if(style.visibility==='hidden'||style.visibility==='collapse')continue;
    if((emptyPaint(style.fill)||Number(style.fillOpacity)===0)&&(emptyPaint(style.stroke)||Number(style.strokeOpacity)===0||Number.parseFloat(style.strokeWidth)===0))continue;
    const box=node.getBBox(),matrix=node.getScreenCTM();if(!matrix||!box.width&&!box.height)continue;
    const stroke=emptyPaint(style.stroke)||Number(style.strokeOpacity)===0?0:Number.parseFloat(style.strokeWidth)||0;
    // Chromium ignores the SVG2 getBBox({stroke:true,clipped:true}) options.
    // Include stroke overhang conservatively before applying clip regions.
    const strokePad=stroke/2*(style.strokeLinejoin==='miter'?Math.max(1,Number(style.strokeMiterlimit)||4):1),nonScaling=style.vectorEffect==='non-scaling-stroke',pad=nonScaling?0:strokePad;
    const painted={x:box.x-pad,y:box.y-pad,width:box.width+2*pad,height:box.height+2*pad};
    let ink=mappedBox(painted,screenToPlacement(matrix));
    if(nonScaling){const px=strokePad*(Math.abs(screenUnitsToPlacement[0])+Math.abs(screenUnitsToPlacement[2])),py=strokePad*(Math.abs(screenUnitsToPlacement[1])+Math.abs(screenUnitsToPlacement[3]));ink={x:ink.x-px,y:ink.y-py,w:ink.w+2*px,h:ink.h+2*py};}
    let r=intersect(ink,clipsOf(node));
    // Overflow clipping can differ by axis. A visible root overflow must keep
    // genuine overhanging artwork; crop and hidden overflow clip the viewport.
    if(r&&(clipX||clipY)){
      const x=clipX?Math.max(r.x,viewport.x):r.x,y=clipY?Math.max(r.y,viewport.y):r.y,right=clipX?Math.min(r.x+r.w,viewport.x+viewport.w):r.x+r.w,bottom=clipY?Math.min(r.y+r.h,viewport.y+viewport.h):r.y+r.h;
      r=right<x||bottom<y?null:{x,y,w:right-x,h:bottom-y};
    }
    if(r&&Object.values(r).every(Number.isFinite))rects.push(r);
  }
  visiblePlotBoundsStats.lastMs=performance.now()-started;return unionRect(rects);
}

export const hidesPlotParts=(element:Pick<SemanticPlotElement,'overrides'>)=>Object.values(element.overrides??{}).some(ov=>ov.hidden===true||ov.opacity===0);
// A measurement is a function of the mounted content alone: the cached source
// DOM and its mount signature. Re-mounting the same content (culling, figure
// switches, Undo of a hide) reuses it instead of walking the plot again.
const measured=new WeakMap<Element,Map<string,Rect|null>>();
export interface PlotBoundsSource {dom:Element;key:string}
export const hasMeasuredPlotBounds=(source:PlotBoundsSource)=>!!measured.get(source.dom)?.has(source.key);
export function updatePlotVisibleBounds(root:SVGSVGElement,element:SemanticPlotElement,source?:PlotBoundsSource):Rect|null|undefined {
  if(!hidesPlotParts(element)){
    const previous=bounds.get(element.id);if(previous){bounds.delete(element.id);plotBoundsRevision.update(n=>n+1);}return undefined;
  }
  let cache=source&&measured.get(source.dom),rect:Rect|null;
  if(source&&cache?.has(source.key))rect=cache.get(source.key)!;
  else{
    rect=measureVisiblePlotBounds(root,element);
    if(source){if(!cache)measured.set(source.dom,cache=new Map());if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(source.key,rect);}
  }
  const previous=bounds.get(element.id);
  bounds.set(element.id,{root,rect,width:element.width,height:element.height});if(!previous||!same(previous.rect,rect))plotBoundsRevision.update(n=>n+1);
  return rect;
}

/** Visible bounds are offsets in the placement frame. Rotate/flip around the
 * ORIGINAL pivot; shrinking the selection must never move the artwork. */
export function plotAwareSelectionBBox(elements:readonly SceneElement[]):Rect|null {
  const rects:Rect[]=[];
  for(const el of elements){
    const visible=el.type==='plot'?localPlotVisibleBounds(el.id,el.width,el.height):undefined;
    if(visible===null)continue;
    if(visible===undefined){rects.push(rotatedAABB(el));continue;}
    const x=el.x+(el.flipX?el.width-visible.x-visible.w:visible.x),y=el.y+(el.flipY?el.height-visible.y-visible.h:visible.y),center={x:el.x+el.width/2,y:el.y+el.height/2};
    const corners=[[x,y],[x+visible.w,y],[x+visible.w,y+visible.h],[x,y+visible.h]].map(([x,y])=>rotatePoint({x,y},center,el.rotation??0));
    const left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y));rects.push({x:left,y:top,w:Math.max(...corners.map(p=>p.x))-left,h:Math.max(...corners.map(p=>p.y))-top});
  }
  return unionRect(rects);
}

/** Pointer filtering is only for a narrowed plot. Ordinary plot whitespace
 * keeps its existing whole-placement selection behavior. */
export function plotVisiblePointContains(element:SceneElement,point:{x:number;y:number}):boolean {
  if(element.type!=='plot')return true;
  const r=localPlotVisibleBounds(element.id,element.width,element.height);if(r===undefined)return true;if(r===null)return false;
  const p=rotatePoint(point,{x:element.x+element.width/2,y:element.y+element.height/2},-(element.rotation??0));
  const x=element.x+(element.flipX?element.width-r.x-r.w:r.x),y=element.y+(element.flipY?element.height-r.y-r.h:r.y);
  return p.x>=x-1e-6&&p.x<=x+r.w+1e-6&&p.y>=y-1e-6&&p.y<=y+r.h+1e-6;
}

/** Same rotated-rectangle law as normal marquee selection, with a virtual
 * visible frame. Its centre is rotated around the original placement pivot;
 * constructing an offset box with the original rotation alone would shift it. */
export function plotAwareRectIntersectsElement(rect:Rect,element:SceneElement):boolean {
  if(element.type!=='plot')return rectIntersectsElement(rect,element);
  const r=localPlotVisibleBounds(element.id,element.width,element.height);if(r===undefined)return rectIntersectsElement(rect,element);if(r===null)return false;
  const x=element.x+(element.flipX?element.width-r.x-r.w:r.x),y=element.y+(element.flipY?element.height-r.y-r.h:r.y);
  const center=rotatePoint({x:x+r.w/2,y:y+r.h/2},{x:element.x+element.width/2,y:element.y+element.height/2},element.rotation??0);
  return rectIntersectsElement(rect,{...element,x:center.x-r.w/2,y:center.y-r.h/2,width:r.w,height:r.h});
}
