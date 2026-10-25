import { parseMplPath,writeMplPath } from './path';
/** Preserve head ink while the shaft follows the connection between text and xy. */
export function arrowPaths(paths:string[],bbox:number[],delta:number[],target:number[],oldTarget:number[],shrinkA:number):string[] {
  const parsed=paths.map(parseMplPath);if(!parsed[0])return paths;
  const c=parsed[0].vertices,start=[c[0],c[1]],end=[c[c.length-2],c[c.length-1]];
  const center=[(bbox[0]+bbox[2])/2+delta[0],(bbox[1]+bbox[3])/2+delta[1]];
  const vx=target[0]-center[0],vy=target[1]-center[1],distance=Math.hypot(vx,vy);if(distance<1e-6)return paths;
  const ux=vx/distance,uy=vy/distance,hw=(bbox[2]-bbox[0])/2+2,hh=(bbox[3]-bbox[1])/2+2;
  const edge=Math.min(Math.abs(hw/(ux||1e-30)),Math.abs(hh/(uy||1e-30)));
  const nextStart=[center[0]+ux*(edge+shrinkA),center[1]+uy*(edge+shrinkA)];
  const tipGap=Math.hypot(oldTarget[0]-end[0],oldTarget[1]-end[1]),nextEnd=[target[0]-ux*tipGap,target[1]-uy*tipGap];
  const ox=end[0]-start[0],oy=end[1]-start[1],nx=nextEnd[0]-nextStart[0],ny=nextEnd[1]-nextStart[1],den=ox*ox+oy*oy;
  if(den<1e-12)return paths;
  const a=(nx*ox+ny*oy)/den,b=(ny*ox-nx*oy)/den,scale=Math.hypot(a,b);
  return parsed.map((p,i)=>{
    if(!p)return paths[i];const out={...p,vertices:p.vertices.slice()};
    for(let j=0;j<out.vertices.length;j+=2){
      const x=p.vertices[j]-(i?end[0]:start[0]),y=p.vertices[j+1]-(i?end[1]:start[1]),k=i?1/scale:1;
      out.vertices[j]=(i?nextEnd:nextStart)[0]+k*(a*x-b*y);out.vertices[j+1]=(i?nextEnd:nextStart)[1]+k*(b*x+a*y);
    }
    return writeMplPath(out,{sx:1,sy:1,tx:0,ty:0});
  });
}
