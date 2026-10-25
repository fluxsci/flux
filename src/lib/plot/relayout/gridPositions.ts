import type { FluxPlotLayout, LayoutSlot } from "../types.gen";
import type { Box } from "./model";
/** GridSpecBase.get_grid_positions: including ratios, spans and nested slots. */
export function gridPositions(layout:FluxPlotLayout,w:number,h:number):Map<string,Box[]> {
  const out=new Map<string,Box[]>(),p=layout.engine.subplotpars??{};
  const get=(id:string):Box[]=>{
    const hit=out.get(id);if(hit)return hit;
    const g=layout.grids.find(g=>g.id===id)!;
    let bounds={x0:(p.left??.125)*w,x1:(p.right??.9)*w,y0:(1-(p.top??.88))*h,y1:(1-(p.bottom??.11))*h};
    if(g.parent)bounds=slotBox(g.parent,get(g.parent.grid),layout);
    const ws=g.wspace??p.wspace??.2,hs=g.hspace??p.hspace??.2;
    const tw=bounds.x1-bounds.x0,th=bounds.y1-bounds.y0;
    const cw=tw/(g.ncols+ws*(g.ncols-1)),ch=th/(g.nrows+hs*(g.nrows-1));
    const norm=(v:number[])=>v.reduce((a,b)=>a+b,0);
    const widths=g.widthRatios.map(v=>v*cw*g.ncols/norm(g.widthRatios));
    const heights=g.heightRatios.map(v=>v*ch*g.nrows/norm(g.heightRatios));
    const xs=[bounds.x0],ys=[bounds.y0];
    for(const v of widths)xs.push(xs.at(-1)!+v+ws*cw);
    for(const v of heights)ys.push(ys.at(-1)!+v+hs*ch);
    const boxes:Box[]=[];
    for(let r=0;r<g.nrows;r++)for(let c=0;c<g.ncols;c++)boxes.push({x0:xs[c],y0:ys[r],x1:xs[c]+widths[c],y1:ys[r]+heights[r]});
    out.set(id,boxes);return boxes;
  };
  for(const grid of layout.grids)get(grid.id);
  return out;
}
export function slotBox(slot:LayoutSlot,boxes:Box[],layout:FluxPlotLayout):Box {
  const g=layout.grids.find(g=>g.id===slot.grid)!;
  const first=boxes[slot.rows[0]*g.ncols+slot.cols[0]],last=boxes[slot.rows[1]*g.ncols+slot.cols[1]];
  return {x0:first.x0,y0:first.y0,x1:last.x1,y1:last.y1};
}
