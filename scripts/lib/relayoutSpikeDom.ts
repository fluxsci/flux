import { parseMplPath, writeMplPath } from "../../src/lib/plot/relayout/path";
import type { Box } from "./relayoutSpike";
interface Affine {sx:number;sy:number;tx:number;ty:number}
const affine=(a:Box,b:Box):Affine=>{const sx=(b.x1-b.x0)/(a.x1-a.x0),sy=(b.y1-b.y0)/(a.y1-a.y0);return {sx,sy,tx:b.x0-a.x0*sx,ty:b.y0-a.y0*sy};};
export function bindSpike(root:Element, boxes:Box[]) {
  const areas=Array.from(root.querySelectorAll('[data-role="plot-area"]'));
  const paths:{el:Element;path:NonNullable<ReturnType<typeof parseMplPath>>;axis:number}[]=[];
  const points:{el:Element;x:number;y:number;axis:number}[]=[];
  const clips:{el:Element;axis:number}[]=[];
  const ids=new Map(Array.from(root.querySelectorAll('[id]')).map(el=>[el.id,el]));
  const clipIds=new Set<string>();
  areas.forEach((area,axis)=>{
    for(const el of Array.from(area.querySelectorAll('*'))){
      if(el.closest('defs'))continue;
      const clip=/url\(#([^)]*)\)/.exec(el.getAttribute('clip-path')??'');
      if(clip&&!clipIds.has(clip[1])){
        clipIds.add(clip[1]);const rect=ids.get(clip[1])?.querySelector('rect');
        if(rect)clips.push({el:rect,axis});
      }
      if(el.tagName.toLowerCase()==='path'){
        const path=parseMplPath(el.getAttribute('d')??'');
        if(path)paths.push({el,path,axis});
      }else if(el.tagName.toLowerCase()==='use')points.push({el,axis,x:Number(el.getAttribute('x')),y:Number(el.getAttribute('y'))});
    }
  });
  return {
    vertices:paths.reduce((s,p)=>s+p.path.vertices.length/2,0), paths:paths.length, points:points.length,
    apply(targets:Box[]){
      const fits=boxes.map((b,i)=>affine(b,targets[i]));
      for(const p of paths)p.el.setAttribute('d',writeMplPath(p.path,fits[p.axis]));
      for(const p of points){const a=fits[p.axis];p.el.setAttribute('x',String(p.x*a.sx+a.tx));p.el.setAttribute('y',String(p.y*a.sy+a.ty));}
      for(const {el,axis} of clips){const b=targets[axis];el.setAttribute('x',String(b.x0));el.setAttribute('y',String(b.y0));el.setAttribute('width',String(b.x1-b.x0));el.setAttribute('height',String(b.y1-b.y0));}
    }
  };
}
