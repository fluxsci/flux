import {ticksAt} from './ticking';
import { LayoutGrid,Solver } from "./layoutGrid";
import { asBox,unionBoxes,width,height,type Box,type RelayoutModel,type LayoutAxis,type LayoutColorbar } from "./model";
type Axis=LayoutAxis|LayoutColorbar;
const expanded=(box:Box,m:number[]):Box=>({x0:box.x0-m[0],x1:box.x1+m[2],y0:box.y0-m[3],y1:box.y1+m[1]});
const max=(v:number[])=>Math.max(0,...v);
export function constrainedLayout(model:RelayoutModel,w:number,h:number,initial:Record<string,Box>,measure:(a:Axis,b:Box)=>number[],applyAspect:(a:Axis,b:Box)=>Box){
  const l=model.layout,colorbars=l.colorbars.filter(cb=>!cb.inset&&cb.managed!==false),e=l.engine,solver=new Solver(),rect=e.rect??[0,0,1,1];
  const figure=new LayoutGrid(solver,1,1,[1],[1],{x0:rect[0]*w,x1:(rect[0]+rect[2])*w,y0:(1-rect[1]-rect[3])*h,y1:(1-rect[1])*h});
  const grids=new Map<string,LayoutGrid>(),containers:LayoutGrid[]=[];
  for(const g of l.grids){
    let parent=figure,inner=true;
    if(g.parent){parent=new LayoutGrid(solver,1,1,[1],[1],grids.get(g.parent.grid)!,g.parent.rows,g.parent.cols,false);containers.push(parent);inner=false;}
    grids.set(g.id,new LayoutGrid(solver,g.nrows,g.ncols,g.widthRatios,g.heightRatios,parent,[0,0],[0,0],inner));
  }
  let collapsedEver=false;
  let feedback=false;
  const tickKey=(boxes:Record<string,Box>)=>JSON.stringify([...model.axes.values()].map(a=>Object.entries(a.ticking).map(([key,t])=>ticksAt(t,key==='x'?width(boxes[a.id]):height(boxes[a.id]),l.fonts[a.axisStyle[key].font]?.sizePt??10,key==='y').values)));
  let slots=Object.fromEntries(Object.entries(initial).map(([id,b])=>[id,{...b}]));
  let boxes=Object.fromEntries([...model.axes.values()].filter(a=>slots[a.id]).map(a=>[a.id,applyAspect(a,slots[a.id])]));
  const cbSpans=(cb:LayoutColorbar)=>{
    const parents=cb.parents.map(id=>model.axes.get(id)).filter((a):a is LayoutAxis=>!!a?.slot);
    return {grid:parents[0]?.slot?.grid,rows:[Math.min(...parents.map(a=>a.slot!.rows[0])),Math.max(...parents.map(a=>a.slot!.rows[1]))],cols:[Math.min(...parents.map(a=>a.slot!.cols[0])),Math.max(...parents.map(a=>a.slot!.cols[1]))]};
  };
  let previousTicks=tickKey(boxes);
  for(let pass=0;pass<2;pass++){
    previousTicks=tickKey(boxes);
    for(const a of l.axes){
      if(!a.slot||!a.inLayout||a.positionMode!=="grid")continue;
      const gs=l.grids.find(g=>g.id===a.slot!.grid)!,grid=grids.get(gs.id)!;
      const [r0,r1]=a.slot.rows,[c0,c1]=a.slot.cols,slot=slots[a.id],actual=boxes[a.id];
      const margin=measure(a,actual),bbox=expanded(actual,margin);
      const wp=e.wPad??3,hp=e.hPad??3,wg=(gs.wspace??e.wSpace??0)/2/gs.ncols*w,hg=(gs.hspace??e.hSpace??0)/2/gs.nrows*h;
      const pads={leftcb:c0>0?Math.max(wp,wg):wp,rightcb:c1<gs.ncols-1?Math.max(wp,wg):wp,
        bottomcb:r1<gs.nrows-1?Math.max(hp,hg):hp,topcb:r0>0?Math.max(hp,hg):hp};
      const dec={left:slot.x0-bbox.x0,right:bbox.x1-slot.x1,top:slot.y0-bbox.y0,bottom:bbox.y1-slot.y1};
      for(const cb of colorbars.filter(cb=>cb.parents.includes(a.id))){
        const spans=cbSpans(cb),lg=grids.get(spans.grid??"");if(!lg||!boxes[cb.id])continue;
        const p=lg.box(spans.rows,spans.cols),vertical=["right","left"].includes(cb.location);
        const pad=cb.padFrac*(vertical?width(p):height(p)),cbb=expanded(boxes[cb.id],measure(cb,boxes[cb.id]));
        const thick=vertical?width(cbb):height(cbb);
        if(cb.location==="right"&&spans.cols[1]===c1)pads.rightcb+=thick+pad;
        if(cb.location==="left"&&spans.cols[0]===c0)pads.leftcb+=thick+pad;
        if(cb.location==="bottom"&&spans.rows[1]===r1)pads.bottomcb+=thick+pad;
        if(cb.location==="top"&&spans.rows[0]===r0)pads.topcb+=thick+pad;
        if(vertical){if(spans.rows[0]===r0&&cbb.y0<bbox.y0)dec.top+=bbox.y0-cbb.y0;if(spans.rows[1]===r1&&cbb.y1>bbox.y1)dec.bottom+=cbb.y1-bbox.y1;}
        else{if(spans.cols[0]===c0&&cbb.x0<bbox.x0)dec.left+=bbox.x0-cbb.x0;if(spans.cols[1]===c1&&cbb.x1>bbox.x1)dec.right+=cbb.x1-bbox.x1;}
      }
      grid.edit("left",c0,dec.left);grid.edit("right",c1,dec.right);grid.edit("top",r0,dec.top);grid.edit("bottom",r1,dec.bottom);
      grid.edit("leftcb",c0,pads.leftcb);grid.edit("rightcb",c1,pads.rightcb);grid.edit("topcb",r0,pads.topcb);grid.edit("bottomcb",r1,pads.bottomcb);
    }
    for(const [id,side]of [[l.figure.suptitle,"top"],[l.figure.supxlabel,"bottom"],[l.figure.supylabel,"left"]] as const){
      const t=id?l.texts[id]:null;if(t)figure.edit(side,0,(side==="left"?t.bbox[2]-t.bbox[0]+2*(e.wPad??3):t.bbox[3]-t.bbox[1]+2*(e.hPad??3)));
    }
    // match_submerged_margins across every spanning slot, including distinct grids.
    for(const orientation of ["cols","rows"] as const){
      const near=orientation==="cols"?"left":"top",far=orientation==="cols"?"right":"bottom";
      const spanning=l.axes.filter(a=>a.inLayout&&a.slot&&a.slot[orientation][1]>a.slot[orientation][0]);
      let maximumNear=0,maximumFar=0;
      for(const a of spanning){const lg=grids.get(a.slot!.grid)!,[first,last]=a.slot![orientation];for(let i=first+1;i<=last;i++)maximumNear=Math.max(maximumNear,lg.values[near][i]+lg.values[near+"cb"][i]);for(let i=first;i<last;i++)maximumFar=Math.max(maximumFar,lg.values[far][i]+lg.values[far+"cb"][i]);}
      for(const a of spanning){const lg=grids.get(a.slot!.grid)!,[first,last]=a.slot![orientation];for(let i=first+1;i<=last;i++)lg.edit(near,i,maximumNear-lg.values[near+"cb"][i]);for(let i=first;i<last;i++)lg.edit(far,i,maximumFar-lg.values[far+"cb"][i]);}
    }
    solver.updateVariables();
    const collapsed=[...grids.values()].some(g=>Array.from({length:g.rows},(_,r)=>Array.from({length:g.cols},(_,c)=>g.box([r,r],[c,c]))).flat().some(b=>width(b)<=0||height(b)<=0));
    if(collapsed)collapsedEver=true;
    if(!collapsed){
      for(const a of l.axes)if(a.slot&&a.inLayout&&a.positionMode==="grid")slots[a.id]=grids.get(a.slot.grid)!.box(a.slot.rows,a.slot.cols);
      boxes=Object.fromEntries([...model.axes.values()].filter(a=>slots[a.id]).map(a=>[a.id,applyAspect(a,slots[a.id])]));
      const offsets=new Map<string,Record<string,number>>();
      for(const cb of colorbars.slice().reverse()){
        const spans=cbSpans(cb),lg=grids.get(spans.grid??"");if(!lg)continue;
        const p=lg.box(spans.rows,spans.cols),outer=lg.cbBox(spans.rows,spans.cols),vertical=["right","left"].includes(cb.location);
        const anchor=Array.isArray(cb.anchor)?cb.anchor:[0,.5],fw=vertical?cb.fraction:cb.shrink,fh=vertical?cb.shrink:cb.fraction;
        const bw=width(p)*fw,bh=height(p)*fh;
        let x=p.x0+(width(p)-bw)*anchor[0],y=p.y0+(height(p)-bh)*(1-anchor[1]);
        const pad=cb.padFrac*(vertical?width(p):height(p)),margin=measure(cb,boxes[cb.id]);
        const tight=expanded(boxes[cb.id],margin),slot=slots[cb.id],off=offsets.get(cb.parents[0])??{left:0,right:0,top:0,bottom:0};offsets.set(cb.parents[0],off);
        if(cb.location==="right"){x=outer.x1+off.right+pad+slot.x0-tight.x0;off.right+=width(tight)+pad;}
        if(cb.location==="left"){x=outer.x0-width(tight)-pad+slot.x0-tight.x0-off.left;off.left+=width(tight)+pad;}
        if(cb.location==="top"){y=outer.y0-pad+slot.y1-tight.y1-bh-off.top;off.top+=height(tight)+pad;}
        if(cb.location==="bottom"){y=outer.y1+off.bottom+pad+height(tight)+slot.y1-tight.y1-bh;off.bottom+=height(tight)+pad;}
        slots[cb.id]={x0:x,x1:x+bw,y0:y,y1:y+bh};boxes[cb.id]=applyAspect(cb,slots[cb.id]);
      }
    }

    for(const g of grids.values())g.reset();figure.reset();
  }
  // Read-only extra tick pass: preserve matplotlib's two layout passes. A third
  // geometry mutation drifts from the truth renderer (notably aspect/colorbar).
  feedback=previousTicks!==tickKey(boxes);
  return {slots,boxes,collapsed:collapsedEver,feedback};
}
