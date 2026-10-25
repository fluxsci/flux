import { width,height,type Box,type LayoutAxis,type LayoutColorbar } from './model';
export type Domains=Record<string,Record<string,number[]>>;
/** Axes.apply_aspect, in physical points (so fig_aspect is already included). */
export function applyAspect(a:LayoutAxis|LayoutColorbar,box:Box,domains:Domains):Box {
  const d=domains[a.id],transform=(key:string,v:number)=>a.ticking[key].scale==='log'?Math.log(v):v;
  const inverse=(key:string,v:number)=>a.ticking[key].scale==='log'?Math.exp(v):v;
  const span=(key:string)=>Math.max(Math.abs(transform(key,d[key][1])-transform(key,d[key][0])),1e-30);
  const value='parents' in a?a.dataAspect??'auto':a.aspect;
  const ratio=a.boxAspect??(typeof value==='number'&&a.adjustable==='box'?value*(a.dataRatio??span('y')/span('x')):null);
  let b=box;
  if(ratio!=null&&ratio>0){
    const w=Math.min(width(box),height(box)/ratio),h=w*ratio;
    const anchors:Record<string,number[]>={C:[.5,.5],SW:[0,0],S:[.5,0],SE:[1,0],E:[1,.5],NE:[1,1],N:[.5,1],NW:[0,1],W:[0,.5]};
    const [ax,ay]=(typeof a.anchor==='string'?anchors[a.anchor]??anchors.C:a.anchor)??[.5,.5];
    const x=box.x0+(width(box)-w)*ax,y=box.y0+(height(box)-h)*(1-ay);
    b={x0:x,x1:x+w,y0:y,y1:y+h};
  }
  if('parents' in a||a.adjustable!=='datalim'||typeof a.aspect!=='number')return b;
  const xs=span('x'),ys=span('y'),dr=height(b)/width(b)/a.aspect,expand=dr*xs/ys-1;
  if(Math.abs(expand)<.005)return b;
  const limits=a.dataLim;
  const dataSpan=(key:string)=>limits?.[key]?.every(v=>v!=null)?1.05*(transform(key,limits[key][1]!)-transform(key,limits[key][0]!)):0;
  const xr=dataSpan('x'),yr=dataSpan('y'),xm=xs-xr,ym=ys-yr,Y=dr*xs,X=ys/dr;
  const adjustY=a.sharey?false:!!a.sharex||(xm>0&&ym>0?((Y-yr>0&&expand<0)||(X-xr<0&&expand>0)):expand>0);
  const key=adjustY?'y':'x',size=adjustY?Y:X,center=(transform(key,d[key][0])+transform(key,d[key][1]))/2;
  const sign=d[key][1]>=d[key][0]?1:-1;
  d[key]=[inverse(key,center-sign*size/2),inverse(key,center+sign*size/2)];
  return b;
}
