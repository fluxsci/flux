import type { Model3dElement,Scene3dManifest,Vec3,Scene3dPart } from './types';
import type { PartOverride } from '../types';
import type { OrbitPose } from './orbit';
import type { FurnitureLayout } from './furnitureLayout';
import { project,pixelsPerUnit } from './orbit';
import { buildScene3dPartIndex,scene3dFields,resolveScene3dPartStyle } from './scene3d';
import { resolvedColormap } from './colormap';
import { niceTicks,tickLabel } from './ticks';
import { transformPoint } from './glbCore.mjs';
export interface FurnitureNode {tag:'g'|'text'|'line'|'path'|'rect'|'defs'|'linearGradient'|'stop';key:string;partId?:string;attrs:Record<string,string|number>;text?:string;children?:FurnitureNode[]}
export interface FurnitureSvg {under:string;over:string;underNodes:FurnitureNode[];overNodes:FurnitureNode[]}
const ID=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const num=(n:number)=>String(Number(n.toFixed(6))||0);
const sourceFont=(font:string)=>font.includes(',')||/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace)$/i.test(font)?font:`${font}, sans-serif`;
export function serializeFurniture(nodes:readonly FurnitureNode[]):string{return nodes.map(n=>`<${n.tag}${Object.entries(n.attrs).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>` ${k}="${esc(typeof v==='number'?num(v):v)}"`).join('')}>${n.text!=null?esc(n.text):''}${n.children?serializeFurniture(n.children):''}</${n.tag}>`).join('');}
export const furniturePartDomId=(elementId:string,partId:string)=>`${elementId}__${partId}`;
/** Attribute-node descriptions support all live hosts; the serializer is shared by static engines. */
export function furnitureNodes(manifest:Scene3dManifest|null|undefined,el:Model3dElement,pose:OrbitPose,layout:FurnitureLayout):Pick<FurnitureSvg, "underNodes"|"overNodes"> {
 if(!manifest)return {underNodes:[],overNodes:[]};
 const under:FurnitureNode[]=[],over:FurnitureNode[]=[],parts=buildScene3dPartIndex(manifest),fields=scene3dFields(manifest),style=manifest.style??{},ink=style.ink??'#100F0F',muted=style.muted??'#6F6E69',fs=layout.fontSize,lw=(style.lineWidthPt??.6)*4/3,toWorld=manifest.toWorld??ID;
 const override=(id:string):PartOverride=>resolveScene3dPartStyle(manifest,el.overrides,id,{index:parts});
 const add=(layer:FurnitureNode[],id:string,tag:FurnitureNode['tag'],key:string,attrs:Record<string,string|number>,text?:string,children?:FurnitureNode[])=>{
  const o=override(id);if(o.hidden||Object.values(attrs).some(v=>typeof v==='number'&&!Number.isFinite(v)))return;
  const a={...attrs};if(o.fill!=null&&(tag==='text'||!['colorbar','legend','scalebar'].includes(parts[id]?.role)))a.fill=o.fill;if(o.stroke!=null)a.stroke=o.stroke;if(o.strokeWidth!=null)a['stroke-width']=o.strokeWidth;if(o.opacity!=null&&o.opacity!==1)a.opacity=o.opacity;
  if(tag==='text'){a['font-family']=o.fontFamily??sourceFont(style.font??'Inter');a['font-size']=o.fontSize??a['font-size']??fs;a['font-weight']=o.fontWeight??400;if(o.fontStyle)a['font-style']=o.fontStyle;if(o.textDecoration)a['text-decoration']=o.textDecoration;}
  if(o.dx||o.dy)a.transform=`translate(${num(o.dx??0)} ${num(o.dy??0)})${a.transform?' '+a.transform:''}`;
  layer.push({tag,key,partId:id,attrs:a,...(text!=null?{text}:{}),...(children?{children}:{})});
 };
 const projected=(p:{x:number;y:number;depth?:number})=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&(pose.projection!=='perspective'||p.depth==null||p.depth>=pose.near);
 const line=(layer:FurnitureNode[],id:string,key:string,a:{x:number;y:number;depth?:number},b:{x:number;y:number;depth?:number},attrs:Record<string,string|number>={})=>{if(projected(a)&&projected(b))add(layer,id,'line',key,{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:ink,'stroke-width':lw,...attrs});};
 const text=(layer:FurnitureNode[],id:string,key:string,x:number,y:number,label:string,attrs:Record<string,string|number>={})=>add(layer,id,'text',key,{x,y,fill:ink,'font-size':fs,'text-anchor':'middle',...attrs},label);
 const world=(p:Vec3)=>transformPoint(toWorld,p);
 const screen=(p:Vec3)=>project(world(p),pose,layout.viewport);
 if(manifest.axes?.kind==='box'){
  // Bounds are world coordinates; axis limits are data coordinates. A proper
  // rotation's inverse is its transpose (exact for all signed-axis writers).
  const dataBounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  for(let mask=0;mask<8;mask++){const p=[0,1,2].map(i=>manifest.bounds?((mask>>i)&1?manifest.bounds.max[i]:manifest.bounds.min[i]):((mask>>i)&1?1:-1));for(let i=0;i<3;i++){const v=toWorld[i*4]*p[0]+toWorld[i*4+1]*p[1]+toWorld[i*4+2]*p[2];dataBounds.min[i]=Math.min(dataBounds.min[i],v);dataBounds.max[i]=Math.max(dataBounds.max[i],v);}}
  const labels=['x','y','z'] as const,axes=labels.map(k=>manifest.axes?.[k]),limits=axes.map((a,i)=>a?.lim??[dataBounds.min[i],dataBounds.max[i]]);
  const center=limits.map(v=>(v[0]+v[1])/2) as Vec3;
  const dirs=labels.map((_,axis)=>{const v=[0,0,0] as Vec3;v[axis]=1;const end=world(v),origin=world([0,0,0]);return end.map((n,i)=>n-origin[i]) as Vec3;});
  const back=dirs.map(d=>d.reduce((sum,n,i)=>sum+n*pose.direction[i],0)>=0?0:1);
  // Panes face away from the viewer in original data coordinates.
  for(let axis=0;axis<3;axis++){
   const other=[0,1,2].filter(i=>i!==axis),corners=[[0,0],[1,0],[1,1],[0,1]].map(([a,b])=>{const p=[...center] as Vec3;p[axis]=limits[axis][back[axis]];p[other[0]]=limits[other[0]][a];p[other[1]]=limits[other[1]][b];return screen(p);});
   if(corners.some(p=>!projected(p)))continue;
   add(under,`axes.${labels[axis]}.pane`,'path',`pane-${axis}`,{d:corners.map((p,i)=>`${i?'L':'M'}${num(p.x)} ${num(p.y)}`).join(' ')+'Z',fill:muted,'fill-opacity':.06,stroke:muted,'stroke-opacity':.25,'stroke-width':lw});
  }
  const labelledEdges:Array<{x1:number;y1:number;x2:number;y2:number}>=[];
  const boxCorners=Array.from({length:8},(_,mask)=>screen(limits.map((lim,i)=>lim[(mask>>i)&1]) as Vec3)).filter(projected);
  for(let axis=0;axis<3;axis++){
   const label=labels[axis],other=[0,1,2].filter(i=>i!==axis),candidates:Array<{a:Vec3;b:Vec3;y:number;depth:number}>=[];
   for(let k=0;k<4;k++){const a=[...center] as Vec3,b=[...center] as Vec3;a[axis]=limits[axis][0];b[axis]=limits[axis][1];for(let j=0;j<2;j++)a[other[j]]=b[other[j]]=limits[other[j]][(k>>j)&1];const m=screen(a.map((v,i)=>(v+b[i])/2) as Vec3);if(!projected(m)||!projected(screen(a))||!projected(screen(b)))continue;candidates.push({a,b,y:m.y,depth:m.depth});}
   if(!candidates.length)continue;
   // Label a silhouette edge: the lowest interior edge can put an upright
   // axis through the mesh and send its ticks along the axis into each other.
   // This convex-box test also works under perspective and arbitrary roll.
   const silhouette=candidates.filter(edge=>{const a=screen(edge.a),b=screen(edge.b),length=Math.hypot(b.x-a.x,b.y-a.y);if(length<1)return false;const distances=boxCorners.map(p=>((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))/length);return distances.every(d=>d>=-1e-6)||distances.every(d=>d<=1e-6);});
   const edges=silhouette.length?silhouette:candidates;
   // At a cardinal azimuth two data axes can project onto the same line.
   // Use the opposite silhouette for the second one instead of stacking labels.
   const overlaps=(edge:typeof edges[number])=>{const a=screen(edge.a),b=screen(edge.b),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);return labelledEdges.some(e=>{const ex=e.x2-e.x1,ey=e.y2-e.y1;return Math.abs(dx*ey-dy*ex)<1e-6*len*Math.hypot(ex,ey)&&Math.abs(dx*(e.y1-a.y)-dy*(e.x1-a.x))<fs*len;})?1:0;};
   edges.sort((a,b)=>overlaps(a)-overlaps(b)||(Math.abs(b.y-a.y)>1e-6?b.y-a.y:a.depth-b.depth));const edge=edges[0],a=screen(edge.a),b=screen(edge.b),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},origin=screen(center);
   const length=Math.hypot(b.x-a.x,b.y-a.y);if(length<1)continue;
   let ox=-(b.y-a.y)/length,oy=(b.x-a.x)/length;
   if(ox*(mid.x-origin.x)+oy*(mid.y-origin.y)<0){ox=-ox;oy=-oy;}
   labelledEdges.push({x1:a.x,y1:a.y,x2:b.x,y2:b.y});
   line(under,`axes.${label}.axis`,`axis-${label}`,a,b);
   const ticks=axes[axis]?.ticks??niceTicks(limits[axis][0],limits[axis][1]);
   ticks.forEach((value,ti)=>{if(value<limits[axis][0]||value>limits[axis][1])return;const p=[...edge.a] as Vec3;p[axis]=value;const at=screen(p);if(!projected(at))return;
    line(under,`axes.${label}.ticks`,`tick-${label}-${ti}`,at,{x:at.x+ox*4,y:at.y+oy*4});text(under,`axes.${label}.ticks`,`tick-label-${label}-${ti}`,at.x+ox*(fs*.9+4),at.y+oy*(fs*.9+4)+fs*.3,axes[axis]?.tickLabels?.[ti]??tickLabel(value),{'text-anchor':ox<-.5?'end':ox>.5?'start':'middle'});
    if(manifest.axes?.grid!==false)for(const plane of other){const across=other.find(i=>i!==plane)!,p1=[...center] as Vec3,p2=[...center] as Vec3;p1[axis]=p2[axis]=value;p1[plane]=p2[plane]=limits[plane][back[plane]];p1[across]=limits[across][0];p2[across]=limits[across][1];line(under,`axes.${label}.grid`,`grid-${label}-${ti}-${plane}`,screen(p1),screen(p2),{stroke:muted,'stroke-opacity':.3});}
   });
   const titleX=mid.x+ox*(fs*3.4),titleY=mid.y+oy*(fs*3.4),angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
   const uprightAngle=angle>90?angle-180:angle< -90?angle+180:angle;
   text(under,`axes.${label}.label`,`axis-label-${label}`,titleX,titleY+fs*.3,parts[`axes.${label}.label`]?.text??axes[axis]?.label??label,{transform:`rotate(${num(uprightAngle)} ${num(titleX)} ${num(titleY)})`});
  }
 }else if(manifest.axes?.kind==='triad'){
  const origin={x:layout.viewport.x+30,y:layout.viewport.y+layout.viewport.height-30},labels=['x','y','z'];
  for(let axis=0;axis<3;axis++){const unit=[0,0,0] as Vec3;unit[axis]=1;const a=world([0,0,0]),b=world(unit),dir=b.map((n,i)=>n-a[i]);const dx=dir.reduce((n,v,i)=>n+v*pose.right[i],0),dy=-dir.reduce((n,v,i)=>n+v*pose.up[i],0);const tip={x:origin.x+dx*22,y:origin.y+dy*22};line(over,`axes.${labels[axis]}.axis`,`triad-${axis}`,origin,tip);text(over,`axes.${labels[axis]}.label`,`triad-label-${axis}`,origin.x+dx*32,origin.y+dy*32+fs*.3,labels[axis]);}
 }
 for(const slot of layout.scalebars){const part=parts[slot.partId],ppu=pixelsPerUnit(pose,layout.viewport);if(!part?.length||ppu==null)continue;const origin=world([0,0,0]),unit=world([1,0,0]),unitLength=Math.hypot(...unit.map((v,i)=>v-origin[i])),length=part.length*ppu*unitLength;
  line(over,part.id,'scale-line',{x:slot.x,y:slot.y},{x:slot.x+length,y:slot.y},{'stroke-width':Math.max(lw,1.5)});text(over,part.id,'scale-label',slot.x+length/2,slot.y-fs*.7,part.label??`${tickLabel(part.length)}${manifest.units?' '+manifest.units:''}`);}
 for(const slot of layout.colorbars){const part=parts[slot.partId],fieldId=typeof part?.field==='string'?part.field:'',field=fields[fieldId];if(!field)continue;const o=el.fields?.[fieldId],range=o?.range??field.range,stops=resolvedColormap(field,o),id=`${el.id}__${part.id}__gradient`;
  over.push({tag:'defs',key:id,attrs:{},children:[{tag:'linearGradient',key:id+'-gradient',attrs:{id,x1:'0%',x2:'0%',y1:'100%',y2:'0%'},children:stops.map(([v,color],i)=>({tag:'stop',key:`stop-${i}`,attrs:{offset:`${v*100}%`,'stop-color':color}}))}]});
  add(over,part.id,'rect','colorbar',{x:slot.x,y:slot.y,width:slot.width,height:slot.height,fill:`url(#${id})`,stroke:muted,'stroke-width':lw});
  const labelSize=override(part.id).fontSize??fs;
  const ticks=o?.range?niceTicks(range[0],range[1]):field.ticks??niceTicks(range[0],range[1]);ticks.forEach((value,i)=>{if(value<range[0]||value>range[1])return;const y=slot.y+slot.height*(range[1]===range[0]?.5:1-(value-range[0])/(range[1]-range[0]));line(over,part.id,`cbar-tick-${i}`,{x:slot.x+slot.width,y},{x:slot.x+slot.width+3,y});text(over,part.id,`cbar-label-${i}`,slot.x+slot.width+6,y+labelSize*.3,tickLabel(value),{'text-anchor':'start'});});
  if(field.label)text(over,part.id,'cbar-title',slot.x,slot.y-labelSize*1.05,field.label,{'text-anchor':'start'});
 }
 for(const slot of layout.legends){const part=parts[slot.partId];(part?.entries??[]).forEach((id,i)=>{const entry=parts[id];if(!entry)return;const y=slot.y+i*layout.lineHeight,o=override(id);add(over,part.id,'rect',`legend-swatch-${i}`,{x:slot.x,y:y-fs*.7,width:fs,height:fs,fill:o.fill??entry.color??el.fill,opacity:o.hidden?0:o.opacity??entry.opacity??1});text(over,part.id,`legend-label-${i}`,slot.x+fs*1.5,y+fs*.2,entry.label??id,{'text-anchor':'start'});});}
 if(layout.title){const slot=layout.title,part=parts[slot.partId];text(over,slot.partId,'title',slot.x+slot.width/2,slot.y+slot.height*.7,part?.text??part?.label??'',{'font-size':(style.titleSizePt??8)*4/3});}
 function group(nodes:FurnitureNode[]):FurnitureNode[]{const grouped:FurnitureNode[]=[],byPart=new Map<string,FurnitureNode>();for(const node of nodes){if(!node.partId){grouped.push(node);continue;}let g=byPart.get(node.partId);if(!g){g={tag:'g',key:node.partId,partId:node.partId,attrs:{id:furniturePartDomId(el.id,node.partId),'data-part-id':node.partId,'data-role':parts[node.partId]?.role??'axis'},children:[]};byPart.set(node.partId,g);grouped.push(g);}g.children!.push(node);}return grouped;}
 const underNodes=group(under),overNodes=group(over);return {underNodes,overNodes};
}

export function furnitureSvg(manifest:Scene3dManifest|null|undefined,el:Model3dElement,pose:OrbitPose,layout:FurnitureLayout):FurnitureSvg {
 const nodes=furnitureNodes(manifest,el,pose,layout);
 return {...nodes,under:serializeFurniture(nodes.underNodes),over:serializeFurniture(nodes.overNodes)};
}
