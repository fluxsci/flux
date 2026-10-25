// P0 only: deliberately not connected to any production plot host.
import { maxNTicks, scalarLabels } from "../../src/lib/plot/ticks";
export interface Box { x0: number; y0: number; x1: number; y1: number }
interface Slot { grid: string; rows: number[]; cols: number[] }
interface Axis {
  id: string; box: Box; position: number[]; slot: Slot | null; margins: number[];
  aspect: string | number; boxAspect: number | null; adjustable: string;
  anchor: string | number[]; domain: number[][];
  tickMetrics: {fontPt:number; advances:Record<string,number>; visible:boolean; width:number; height:number}[];
  initialPosition: number[];
}
interface Colorbar extends Axis { parents: string[]; location: string; fraction: number; shrink: number; pad: number }
export interface SpikeModel {
  widthPt: number; heightPt: number;
  engine: { kind: string; wPad: number; hPad: number; wSpace: number; hSpace: number };
  grids: { id: string; nrows: number; ncols: number; widthRatios: number[]; heightRatios: number[]; wspace: number | null; hspace: number | null }[];
  axes: Axis[]; colorbars: Colorbar[];
}
export function solveSpike(m: SpikeModel, w: number, h: number): Box[] {
  if (m.engine.kind === "none") return m.axes.map(a => {
    const [x,y,aw,ah] = a.position;
    return { x0:x*w, x1:(x+aw)*w, y0:(1-y-ah)*h, y1:(1-y)*h };
  });
  let result = m.axes.map(a => {
    const [x,y,aw,ah]=a.initialPosition??a.position;
    return {x0:x*w,x1:(x+aw)*w,y0:(1-y-ah)*h,y1:(1-y)*h};
  });
  for (let pass=0;pass<2;pass++) {
    for (const grid of m.grids) {
      const members=m.axes.map((a,i)=>({a,i})).filter(({a})=>a.slot?.grid===grid.id);
      const left=Array(grid.ncols).fill(0), right=Array(grid.ncols).fill(0);
      const top=Array(grid.nrows).fill(0), bottom=Array(grid.nrows).fill(0);
      const wp=(grid.wspace ?? m.engine.wSpace)/2/grid.ncols*w;
      const hp=(grid.hspace ?? m.engine.hSpace)/2/grid.nrows*h;
      for (const {a,i} of members) {
        const s=a.slot!, [r0,r1]=s.rows, [c0,c1]=s.cols;
        let [l,b,r,t]=a.margins;
        const box=result[i], aw=box.x1-box.x0, ah=box.y1-box.y0;
        if(a.tickMetrics){
          const [xm,ym]=a.tickMetrics;
          const labelWidth=(text:string,met:typeof xm)=>Array.from(text).reduce((s,c)=>s+(met.advances[c]??0),0);
          if(ym.visible){
            const ticks=maxNTicks(...a.domain[1] as [number,number],{nbins:Math.max(1,Math.min(9,Math.floor(ah/ym.fontPt/2))),steps:[1,2,2.5,5,10]});
            const labels=scalarLabels(ticks);
            const [lo,hi]=a.domain[1].slice().sort((a,b)=>a-b);
            l+=Math.max(0,...labels.filter((_,j)=>ticks[j]>=lo&&ticks[j]<=hi).map(s=>labelWidth(s,ym)))-ym.width;
          }
          if(xm.visible){
            const ticks=maxNTicks(...a.domain[0] as [number,number],{nbins:Math.max(1,Math.min(9,Math.floor(aw/xm.fontPt/3))),steps:[1,2,2.5,5,10]});
            const labels=scalarLabels(ticks);
            const [lo,hi]=a.domain[0];
            let over=0;
            ticks.forEach((v,k)=>{if(v>=Math.min(lo,hi)&&v<=Math.max(lo,hi))over=Math.max(over,(v-lo)/(hi-lo)*aw+labelWidth(labels[k],xm)/2-aw);});
            r=Math.max(0,over);
          }
        }
        // The padding's inner edges are half the requested inter-subplot gap.
        l+=c0>0?Math.max(wp,m.engine.wPad):m.engine.wPad;
        r+=c1<grid.ncols-1?Math.max(wp,m.engine.wPad):m.engine.wPad;
        t+=r0>0?Math.max(hp,m.engine.hPad):m.engine.hPad;
        b+=r1<grid.nrows-1?Math.max(hp,m.engine.hPad):m.engine.hPad;
        for (const cb of m.colorbars.filter(cb=>cb.parents.includes(a.id))) {
          const box=result[i], width=box.x1-box.x0, height=box.y1-box.y0;
          const vertical=cb.location==="right"||cb.location==="left";
          const thick=Math.min((vertical?height:width)*cb.shrink/(cb.aspect as number),(vertical?width:height)*cb.fraction);
          const extra=thick+cb.pad*(vertical?width:height)+(vertical?cb.margins[0]+cb.margins[2]:cb.margins[1]+cb.margins[3]);
          if(cb.location==="right")r+=extra;
          else if(cb.location==="left")l+=extra;
          else if(cb.location==="top")t+=extra;
          else b+=extra;
        }
        left[c0]=Math.max(left[c0],l); right[c1]=Math.max(right[c1],r);
        top[r0]=Math.max(top[r0],t); bottom[r1]=Math.max(bottom[r1],b);
      }
      const sum=(v:number[])=>v.reduce((a,b)=>a+b,0);
      const iw=(w-sum(left)-sum(right))/sum(grid.widthRatios);
      const ih=(h-sum(top)-sum(bottom))/sum(grid.heightRatios);
      const xs=[0],ys=[0];
      for(let i=0;i<grid.ncols;i++)xs.push(xs[i]+left[i]+iw*grid.widthRatios[i]+right[i]);
      for(let i=0;i<grid.nrows;i++)ys.push(ys[i]+top[i]+ih*grid.heightRatios[i]+bottom[i]);
      for (const {a,i} of members) {
        const [r0,r1]=a.slot!.rows,[c0,c1]=a.slot!.cols;
        result[i]={x0:xs[c0]+left[c0],x1:xs[c1+1]-right[c1],y0:ys[r0]+top[r0],y1:ys[r1+1]-bottom[r1]};
      }
    }
  }
  return result;
}
