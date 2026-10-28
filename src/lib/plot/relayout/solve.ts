import type { RelayoutModel, Box, LayoutAxis, LayoutColorbar } from "./model";
import { asBox, height, width, unionBoxes } from "./model";
import { gridPositions, slotBox } from "./gridPositions";
import { ticksAt, type TickSet } from "./ticking";
import type { RelayoutReport } from "./report";
import type { Fits } from "../project";
import { constrainedLayout } from "./constrained";
import { applyAspect,type Domains } from "./aspect";
import { labelWidth } from "./mathLabel";
import { legendBox as placeLegend,bestLegend } from "./legend";
export interface RelayoutSolution {
  key:string;wPt:number;hPt:number;identity:boolean;collapsed:boolean;
  domains:Domains; axesBox:Record<string,Box>; fits:Record<string,Fits>;ticks:Record<string,Record<string,TickSet>>;
  decor:Record<string,[number,number]>;legend:Record<string,Box>;report:RelayoutReport;
}
const memo=new WeakMap<RelayoutModel,Map<string,RelayoutSolution>>();
const fractionBox=(p:number[],w:number,h:number):Box=>({x0:p[0]*w,x1:(p[0]+p[2])*w,y0:(1-p[1]-p[3])*h,y1:(1-p[1])*h});
const sum=(v:number[])=>v.reduce((a,b)=>a+b,0);
const near=(a:number,b:number)=>Math.abs(a-b)<=1e-9*Math.max(1e-300,Math.abs(a),Math.abs(b));
function fontWidth(model:RelayoutModel,text:string,fontId:string):number {
  const f=model.layout.fonts[fontId];if(!f)return 0;
  return labelWidth(text,f);
}
function tickExtents(model:RelayoutModel,a:LayoutAxis|LayoutColorbar,key:string,set:TickSet,domain=a.ticking[key].domain) {
  const style=a.axisStyle[key],texts=model.layout.texts;
  const old=(model.tickLabels.get(a.id+'/'+key)??[]).map(v=>({t:v.text,value:v.value}));
  const [lo,hi]=domain.slice().sort((a,b)=>a-b);
  const visible=old.filter(t=>t.value!=null&&t.value>=lo&&t.value<=hi);
  const baseW=Math.max(0,...visible.map(v=>v.t.bbox[2]-v.t.bbox[0]));
  const baseH=Math.max(0,...visible.map(v=>v.t.bbox[3]-v.t.bbox[1]));
  const sizes=set.values.map((value,i)=>{
    const reuse=old.find(t=>near(t.value??NaN,value)&&t.t.text===set.labels[i]);
    const w=!set.labels[i]?0:reuse?reuse.t.bbox[2]-reuse.t.bbox[0]:fontWidth(model,set.labels[i],style.font);
    const h=!set.labels[i]?0:reuse?reuse.t.bbox[3]-reuse.t.bbox[1]:baseH||model.layout.fonts[style.font]?.sizePt||10;
    const rot=style.labelRotation??0,r=rot*Math.PI/180;
    return {beforeY:!set.labels[i]?0:reuse?reuse.t.anchor[1]-reuse.t.bbox[1]:old[0]?.t.anchor[1]-old[0]?.t.bbox[1]||h*.38,afterY:!set.labels[i]?0:reuse?reuse.t.bbox[3]-reuse.t.anchor[1]:old[0]?.t.bbox[3]-old[0]?.t.anchor[1]||h*.62,w:reuse?w:Math.abs(w*Math.cos(r))+Math.abs(h*Math.sin(r)),h:reuse?h:Math.abs(w*Math.sin(r))+Math.abs(h*Math.cos(r))};
  });
  // With no visible labels, Matplotlib places the axis title against the
  // spine, retaining only the outward extent of any surviving tick marks.
  // Padding belongs to a label; no ticks at all also removes the tick length.
  const within=(v:number)=>v>=lo&&v<=hi;
  const labelsVisible=set.values.some((v,i)=>within(v)&&!!set.labels[i])||set.minor.some((v,i)=>within(v)&&!!set.minorLabels[i]);
  const outward=style.tickDir==='in'?0:style.tickDir==='inout'?.5:1;
  const remaining=outward*(set.values.some(within)?style.tickLenPt:set.minor.some(within)?style.minorTickLenPt??2:0);
  const gapDelta=labelsVisible?0:remaining-(style.tickPadPt+outward*style.tickLenPt);
  return {baseW,baseH,visible:visible.length>0,sizes,gapDelta,maxW:Math.max(0,...sizes.filter((_,i)=>set.values[i]>=lo&&set.values[i]<=hi).map(v=>v.w)),
    maxH:Math.max(0,...sizes.filter((_,i)=>set.values[i]>=lo&&set.values[i]<=hi).map(v=>v.h))};
}
function margins(model:RelayoutModel,a:LayoutAxis|LayoutColorbar,b:Box,ticks:Record<string,TickSet>,domains?:Domains):number[] {
  const m=a.margins.slice();
  for(const key of ["x","y"]){
    if(!a.axisStyle[key]||!ticks[key])continue;
    const s=a.axisStyle[key],extent=tickExtents(model,a,key,ticks[key],domains?.[a.id]?.[key]);
    if(!extent.visible)continue;
    if(key==="y"){
      m[s.side==="right"?2:0]+=extent.maxW-extent.baseW+extent.gapDelta;if(s.labelTop&&s.labelBottom)m[s.side==="right"?0:2]+=extent.maxW-extent.baseW+extent.gapDelta;
      const [lo,hi]=domains?.[a.id]?.[key]??a.ticking[key].domain,scale=(v:number)=>a.ticking[key].scale==='log'?Math.log(v):v;
      let top=0,bottom=0;
      ticks[key].values.forEach((v,i)=>{if(v<Math.min(lo,hi)||v>Math.max(lo,hi))return;const at=(scale(v)-scale(lo))/(scale(hi)-scale(lo))*height(b),h=extent.sizes[i].h;top=Math.max(top,at+extent.sizes[i].beforeY-height(b));bottom=Math.max(bottom,extent.sizes[i].afterY-at);});
      const old=asBox(a.pixelBox),oldTexts=(model.tickLabels.get(a.id+'/'+key)??[]).filter(v=>v.value>=Math.min(...a.ticking[key].domain)&&v.value<=Math.max(...a.ticking[key].domain)).map(v=>v.text);
      const oldTop=Math.max(0,...oldTexts.map(t=>old.y0-t.bbox[1])),oldBottom=Math.max(0,...oldTexts.map(t=>t.bbox[3]-old.y1));
      m[3]=Math.max(m[3]<=oldTop+1e-6?0:m[3],top);m[1]=Math.max(m[1]<=oldBottom+1e-6?0:m[1],bottom);
    }
    else {
      m[s.side==="top"?3:1]+=extent.maxH-extent.baseH+extent.gapDelta;if(s.labelTop&&s.labelBottom)m[s.side==="top"?1:3]+=extent.maxH-extent.baseH+extent.gapDelta;
      const [lo,hi]=domains?.[a.id]?.[key]??a.ticking[key].domain,span=width(b),scale=(v:number)=>a.ticking[key].scale==="log"?Math.log(v):v;
      let left=0,right=0;
      ticks[key].values.forEach((v,i)=>{
        if(v<Math.min(lo,hi)||v>Math.max(lo,hi))return;
        const at=(scale(v)-scale(lo))/(scale(hi)-scale(lo))*span,w=extent.sizes[i].w;
        const before=s.labelHa==="left"?0:s.labelHa==="right"?w:w/2;
        left=Math.max(left,before-at);right=Math.max(right,at+w-before-span);
      });
      const ys=a.axisStyle.y;
      if(!ys||ys.side!=="left"&&!(ys.labelTop&&ys.labelBottom)||!ticks.y)m[0]=Math.max(0,left);
      else m[0]=Math.max(m[0],left);
      if(!ys||ys.side!=="right"&&!(ys.labelTop&&ys.labelBottom))m[2]=Math.max(0,right);
      else m[2]=Math.max(m[2],right);
    }
  }
  for(const cb of model.layout.colorbars.filter(cb=>cb.inset?.parent===a.id)){
    const q=cb.inset!.bounds!,c={x0:b.x0+q[0]*width(b),x1:b.x0+(q[0]+q[2])*width(b),y0:b.y1-(q[1]+q[3])*height(b),y1:b.y1-q[1]*height(b)},t=ticksForAxes(model,{[cb.id]:c},domains)[cb.id],cm=margins(model,cb,c,t,domains);
    m[0]=Math.max(m[0],b.x0-c.x0+cm[0]);m[1]=Math.max(m[1],c.y1-b.y1+cm[1]);m[2]=Math.max(m[2],c.x1-b.x1+cm[2]);m[3]=Math.max(m[3],b.y0-c.y0+cm[3]);
  }
  const title=a.title?.center?model.layout.texts[a.title.center]:undefined,offsetId=a.axisStyle.y?.offsetText,offset=offsetId?model.layout.texts[offsetId]:undefined;
  if(title&&offset){
    const tx=b.x0+width(b)*.5,tw=title.bbox[2]-title.bbox[0],ow=fontWidth(model,ticks.y?.offset??offset.text,offset.font),left=a.axisStyle.y.side==='right'?b.x1:b.x0;
    if(tx-tw/2<left+ow&&tx+tw/2>left)m[3]=Math.max(m[3],a.margins[3]+asBox(a.pixelBox).y0-offset.bbox[1]);
  }
  for(const id of a.extraLayoutIds??[]){
    const leg=model.layout.legends.find(l=>l.id===id);
    let extra:Box|undefined;
    if(leg)extra=placeLegend(leg,b,{x0:0,y0:0,x1:model.layout.figure.widthPt,y1:model.layout.figure.heightPt},leg.locRequested,model);
    const text=model.layout.texts[id],frame=model.layout.frames[id];
    if(text&&frame){
      const point=framePoint(model,frame,b,{wPt:model.layout.figure.widthPt,hPt:model.layout.figure.heightPt});
      if(point)extra={x0:point[0]+text.bbox[0]-text.anchor[0],x1:point[0]+text.bbox[2]-text.anchor[0],y0:point[1]+text.bbox[1]-text.anchor[1],y1:point[1]+text.bbox[3]-text.anchor[1]};
    }
    if(extra){m[0]=Math.max(m[0],b.x0-extra.x0);m[1]=Math.max(m[1],extra.y1-b.y1);m[2]=Math.max(m[2],extra.x1-b.x1);m[3]=Math.max(m[3],b.y0-extra.y0);}
  }
  return m;
}
function framePoint(model:RelayoutModel,frame:import("../types.gen").LayoutFrame,b:Box,size:{wPt:number;hPt:number}):[number,number]|null {
  const ax=frame.axes?model.axes.get(frame.axes):undefined;
  const data=(key:string,value:number)=>{const domain=ax!.ticking[key].domain,log=ax!.ticking[key].scale==="log",f=(v:number)=>log?Math.log(v):v;const u=(f(value)-f(domain[0]))/(f(domain[1])-f(domain[0]));return key==="x"?b.x0+u*width(b):b.y1-u*height(b);};
  const mapped=(f:import("../types.gen").LayoutEndpoint,key:'x'|'y')=>{
    if(f.nativePt&&ax&&!['linear','log'].includes(ax.ticking[key].scale)){const old=asBox(ax.pixelBox);return key==='x'?b.x0+(f.nativePt[0]-old.x0)/width(old)*width(b):b.y0+(f.nativePt[1]-old.y0)/height(old)*height(b);}
    return data(key,f.pt[key==='x'?0:1]);
  };
  const endpoint=(f:import("../types.gen").LayoutEndpoint):[number,number]=>f.f==="figure"?[f.pt[0]*size.wPt,(1-f.pt[1])*size.hPt]:f.f==="axes"?[b.x0+f.pt[0]*width(b),b.y1-f.pt[1]*height(b)]:[mapped(f,"x"),mapped(f,"y")];
  if(frame.f==="offset"&&frame.base){const p=endpoint(frame.base);return [p[0]+(frame.offsetPt?.[0]??0),p[1]-(frame.offsetPt?.[1]??0)];}
  if(frame.f==="axes"&&frame.frac)return [b.x0+frame.frac[0]*width(b),b.y1-frame.frac[1]*height(b)];
  if(frame.f==="figure"&&frame.frac)return [frame.frac[0]*size.wPt,(1-frame.frac[1])*size.hPt];
  return null;
}
function ticksForAxes(model:RelayoutModel,boxes:Record<string,Box>,domains?:Domains):RelayoutSolution["ticks"] {
  const out:RelayoutSolution["ticks"]={};
  for(const a of model.axes.values()){
    const b=boxes[a.id];if(!b)continue;out[a.id]={};
    for(const [key,tick]of Object.entries(a.ticking))out[a.id][key]=ticksAt(domains?{...tick,domain:domains[a.id][key]}:tick,key.startsWith("x")?width(b):height(b),model.layout.fonts[a.axisStyle[key].font]?.sizePt??10,key.startsWith("y"));
  }
  return out;
}
export function solveRelayout(model:RelayoutModel,target:{wPt:number;hPt:number}):RelayoutSolution {
  const {wPt:w,hPt:h}=target;
  if(!(w>0&&h>0&&Number.isFinite(w)&&Number.isFinite(h)))throw new Error("Figure size must be positive and finite");
  const key=`${w.toFixed(6)}x${h.toFixed(6)}`;let cache=memo.get(model);if(!cache)memo.set(model,cache=new Map());
  const hit=cache.get(key);if(hit){cache.delete(key);cache.set(key,hit);return hit;}
  const l=model.layout,identity=Math.abs(w-l.figure.widthPt)<.01&&Math.abs(h-l.figure.heightPt)<.01;
  const domains:Domains=Object.fromEntries([...model.axes.values()].map(a=>[a.id,Object.fromEntries(Object.entries(a.ticking).map(([k,t])=>[k,(identity?t.domain:a.initialDomain?.[k]??t.domain).slice()]))]));
  const aspect=(a:LayoutAxis|LayoutColorbar,b:Box)=>applyAspect(a,b,domains);
  let collapsed=false,feedback=false;
  let boxes:Record<string,Box>={};
  const positions=gridPositions(l,w,h);
  for(const a of l.axes)boxes[a.id]=a.initialPosition&&l.engine.kind!=="none"?fractionBox(a.initialPosition,w,h):a.slot&&a.positionMode==="grid"&&l.engine.kind!=="none"?slotBox(a.slot,positions.get(a.slot.grid)!,l):fractionBox(a.position,w,h);
  for(const cb of l.colorbars)boxes[cb.id]=fractionBox(cb.initialPosition??cb.position??[0,0,1,1],w,h);
  let ticks=ticksForAxes(model,boxes,domains);
  const rect=l.engine.rect??[0,0,1,1];
  if(l.engine.kind==="constrained"&&!identity){
    const result=constrainedLayout(model,w,h,boxes,(a,b)=>{
      const current=ticksForAxes(model,{[a.id]:b},domains)[a.id];
      return margins(model,a,b,current,domains);
    },aspect);
    boxes=result.boxes;collapsed=result.collapsed;feedback=result.feedback;
  }
  if(l.engine.kind==="tight"&&!identity){
    // _auto_adjust_subplotpars: sum the decorations across each shared edge.
    for(const g of l.grids.filter(g=>!g.parent)){
      const hs=Array.from({length:g.nrows},()=>Array(g.ncols+1).fill(0)),vs=Array.from({length:g.nrows+1},()=>Array(g.ncols).fill(0));
      for(const a of l.axes.filter(a=>a.slot?.grid===g.id&&a.inLayout)){
        const [left,bottom,right,top]=margins(model,a,boxes[a.id],ticks[a.id],domains),s=a.slot!;
        for(let r=s.rows[0];r<=s.rows[1];r++){hs[r][s.cols[0]]+=left;hs[r][s.cols[1]+1]+=right;}
        for(let c=s.cols[0];c<=s.cols[1];c++){vs[s.rows[0]][c]+=top;vs[s.rows[1]+1][c]+=bottom;}
      }
      const pad=(l.engine.pad??1.08)*(l.engine.fontPt??10),wp=(l.engine.wPad??l.engine.pad??1.08)*(l.engine.fontPt??10),hp=(l.engine.hPad??l.engine.pad??1.08)*(l.engine.fontPt??10);
      // get_tight_layout_figure's second pass: a rect (figure fractions) moves every edge inward
      // by its offset on top of the decoration margins.
      const left=Math.max(0,...hs.map(v=>v[0]))+pad+rect[0]*w,right=Math.max(0,...hs.map(v=>v.at(-1)!))+pad+(1-rect[2])*w;
      const top=Math.max(0,...vs[0])+pad+(1-rect[3])*h,bottom=Math.max(0,...vs.at(-1)!)+pad+rect[1]*h;
      const gapx=g.ncols>1?Math.max(0,...hs.flatMap(v=>v.slice(1,-1)))+wp:0;
      const gapy=g.nrows>1?Math.max(0,...vs.slice(1,-1).flat())+hp:0;
      const iw=(w-left-right-gapx*(g.ncols-1))/sum(g.widthRatios),ih=(h-top-bottom-gapy*(g.nrows-1))/sum(g.heightRatios);
      if(!(iw>0&&ih>0)){collapsed=true;continue;}
      const xs=[left],ys=[top];for(const v of g.widthRatios)xs.push(xs.at(-1)!+v*iw+gapx);for(const v of g.heightRatios)ys.push(ys.at(-1)!+v*ih+gapy);
      for(const a of l.axes.filter(a=>a.slot?.grid===g.id&&a.inLayout)){const s=a.slot!;boxes[a.id]={x0:xs[s.cols[0]],x1:xs[s.cols[1]+1]-gapx,y0:ys[s.rows[0]],y1:ys[s.rows[1]+1]-gapy};}
    }
  }
  for(const a of l.axes){
    if(a.inset?.parent&&a.inset.bounds){const p=boxes[a.inset.parent],b=a.inset.bounds;if(p)boxes[a.id]={x0:p.x0+b[0]*width(p),x1:p.x0+(b[0]+b[2])*width(p),y0:p.y1-(b[1]+b[3])*height(p),y1:p.y1-b[1]*height(p)};}
    boxes[a.id]=aspect(a,boxes[a.id]);
  }
  for(const cb of l.colorbars){
    if(cb.inset?.parent&&cb.inset.bounds){const p=boxes[cb.inset.parent],q=cb.inset.bounds;if(p){boxes[cb.id]={x0:p.x0+q[0]*width(p),x1:p.x0+(q[0]+q[2])*width(p),y0:p.y1-(q[1]+q[3])*height(p),y1:p.y1-q[1]*height(p)};continue;}}
    if(l.engine.kind==="constrained"&&!identity)continue;
    if(l.engine.kind==="none"){boxes[cb.id]=aspect(cb,fractionBox(cb.position??[0,0,1,1],w,h));continue;}
    const p=unionBoxes(cb.parents.map(id=>boxes[id]).filter(Boolean));if(!Number.isFinite(p.x0))continue;
    const v=["left","right"].includes(cb.location),long=(v?height(p):width(p))*cb.shrink;
    const thick=Math.min(long/(cb.aspect as number),(v?width(p):height(p))*cb.fraction),len=thick*(cb.aspect as number);
    const anchor=Array.isArray(cb.anchor)?cb.anchor:[0,.5];
    const pad=cb.padFrac*(v?width(p):height(p));
    let x=p.x0,y=p.y0;
    if(v){y=p.y0+(height(p)-len)*(1-anchor[1]);x=cb.location==="right"?p.x1+pad:p.x0-pad-thick;}
    else{x=p.x0+(width(p)-len)*anchor[0];y=cb.location==="top"?p.y0-pad-thick:p.y1+pad;}
    boxes[cb.id]={x0:x,y0:y,x1:x+(v?thick:len),y1:y+(v?len:thick)};
  }
  if(identity)boxes=Object.fromEntries([...model.axes.values()].map(a=>[a.id,asBox(a.pixelBox??[])]));
  ticks=ticksForAxes(model,boxes,domains);
  const fits:Record<string,Fits>={};
  for(const a of model.axes.values()){
    const b=boxes[a.id];if(!b)continue;
    const make=(key:string)=>{const d=domains[a.id][key],log=a.ticking[key].scale==="log",f=(v:number)=>log?Math.log(v):v;const p0=key.startsWith("x")?b.x0:b.y1,p1=key.startsWith("x")?b.x1:b.y0,m=(p1-p0)/(f(d[1])-f(d[0]));return {m,c:p0-m*f(d[0]),log};};
    fits[a.id]={x:make("x"),y:make("y")};
  }
  const decor:Record<string,[number,number]>={};
  for(const [id,frame]of model.textFrames){
    const text=l.texts[id];if(!text)continue;
    const a=frame.axes?model.axes.get(frame.axes):null,b=frame.axes?boxes[frame.axes]:null,old=a?asBox(a.pixelBox??[]):null;
    let [x,y]=text.anchor;
    if(frame.f==="figure"&&frame.frac){x=frame.frac[0]*w;y=(1-frame.frac[1])*h;}
    else if(frame.f==="axes"&&frame.frac&&b){x=b.x0+frame.frac[0]*width(b);y=b.y1-frame.frac[1]*height(b);}
    else if(frame.f==="offset"&&b){const p=framePoint(model,frame,b,target);if(p)[x,y]=p;}
    else if(frame.f==="title"&&b&&old){const fraction=frame.slot==="left"?0:frame.slot==="right"?1:.5;x=b.x0+fraction*width(b);y+=b.y0-old.y0;}
    else if(frame.f==="axis"&&b&&old){
      const vertical=frame.axis?.startsWith("y"),style={...a!.axisStyle[frame.axis??"x"],side:frame.part==="title"?a!.axisStyle[frame.axis??"x"].labelSide??a!.axisStyle[frame.axis??"x"].side:frame.side??a!.axisStyle[frame.axis??"x"].side};
      if(frame.part==="ticklabel"&&frame.value!=null){const fit=fits[frame.axes!][vertical?"y":"x"],v=fit.m*(fit.log?Math.log(frame.value):frame.value)+fit.c;
        if(!['linear','log'].includes(a!.ticking[frame.axis!].scale)){
          if(vertical){x+=style.side==='right'?b.x1-old.x1:b.x0-old.x0;y=b.y0+(text.anchor[1]-old.y0)/height(old)*height(b);}
          else{x=b.x0+(text.anchor[0]-old.x0)/width(old)*width(b);y+=style.side==='top'?b.y0-old.y0:b.y1-old.y1;}
          decor[id]=[x,y];continue;
        }
        const domain=a!.ticking[frame.axis!].domain,scale=(v:number)=>a!.ticking[frame.axis!].scale==='log'?Math.log(v):v,u=(scale(frame.value)-scale(domain[0]))/(scale(domain[1])-scale(domain[0]));
        if(vertical){x+=style.side==="right"?b.x1-old.x1:b.x0-old.x0;y=v+y-(old.y1+(old.y0-old.y1)*u);}
        else{x=v+x-(old.x0+(old.x1-old.x0)*u);y+=style.side==="top"?b.y0-old.y0:b.y1-old.y1;}
      }else if(frame.part==='offset'){
        if(vertical){x+=style.side==='right'?b.x1-old.x1:b.x0-old.x0;y+=b.y0-old.y0;}
        else{x+=b.x1-old.x1;y+=style.side==='top'?b.y0-old.y0:b.y1-old.y1;}
      }else if(vertical){x+=style.side==="right"?b.x1-old.x1:b.x0-old.x0;y+=((b.y0+b.y1)-(old.y0+old.y1))/2;}
      else{x+=((b.x0+b.x1)-(old.x0+old.x1))/2;y+=style.side==="top"?b.y0-old.y0:b.y1-old.y1;}
    }
    if(frame.f==='axis'&&frame.part==='title'&&b&&a&&a.axisStyle[frame.axis!]?.labelAuto){
      const k=frame.axis!,ext=tickExtents(model,a,k,ticks[a.id][k],domains[a.id][k]),s=a.axisStyle[k];
      if(!ext.visible){}else if(k==='y')x+=(s.labelSide==='right'?1:-1)*(ext.maxW-ext.baseW+ext.gapDelta);else y+=(s.labelSide==='top'?-1:1)*(ext.maxH-ext.baseH+ext.gapDelta);
    }
    if(frame.f==='title'&&b&&a){
      const offsetId=a.axisStyle.y?.offsetText,offset=offsetId?model.layout.texts[offsetId]:null;
      if(offset){const tx=x,tw=text.bbox[2]-text.bbox[0],ow=fontWidth(model,ticks[a.id].y.offset,offset.font),left=a.axisStyle.y.side==='right'?b.x1:b.x0;
        const nativeLift=old!.y0-text.anchor[1]-(a.title?.padPt??6),lift=tx-tw/2<left+ow&&tx+tw/2>left?old!.y0-offset.bbox[1]:0;y+=nativeLift-lift;
      }
    }
    if(frame.f==='figure'&&l.engine.kind==='constrained'){
      if(id===l.figure.supylabel&&l.figure.auto?.supylabel!==false)x=l.engine.wPad??3;
      if(id===l.figure.supxlabel&&l.figure.auto?.supxlabel!==false)y=h-(l.engine.hPad??3);
      if(id===l.figure.suptitle&&l.figure.auto?.suptitle!==false)y=l.engine.hPad??3;
    }
    decor[id]=[x,y];
  }
  const legend:Record<string,Box>={};
  for(const leg of l.legends){
    const owner=leg.owner==="figure"?{x0:0,y0:0,x1:w,y1:h}:boxes[leg.owner];if(!owner)continue;
    const figure={x0:0,y0:0,x1:w,y1:h};
    legend[leg.id]=leg.locRequested==='best'?bestLegend(leg,model,owner,figure,fits):placeLegend(leg,owner,figure,leg.locRequested,model);
  }
  const retickedAxes=[...new Set([...model.axes.values()].flatMap(a=>Object.entries(ticks[a.id]??{}).filter(([k,t])=>t.reticked&&(JSON.stringify(t.values)!==JSON.stringify(a.ticking[k].values)||JSON.stringify(t.labels)!==JSON.stringify(a.ticking[k].labels))).map(([k])=>k)))];
  const report:RelayoutReport={status:identity||l.engine.kind==='none'&&!retickedAxes.length?'exact':'reflowed',warnings:[],...(retickedAxes.length&&!identity?{retickedAxes}:{})};
  if(!identity)for(const a of model.axes.values())for(const [k,tick]of Object.entries(a.ticking)){
    if(!tick.retick&&(['custom','category','date'].includes(tick.major.kind)||tick.formatter.kind==='custom'))report.warnings.push({code:'ticks:fixed',ids:[a.id+'.'+k]});
    const b=boxes[a.id],set=ticks[a.id][k],extent=tickExtents(model,a,k,set,domains[a.id][k]);if(!extent.visible)continue;
    const fit=fits[a.id][k==='y'?'y':'x'],domain=domains[a.id][k],intervals=set.values.flatMap((v,i)=>{if(v<Math.min(...domain)||v>Math.max(...domain))return [];const at=fit.m*(fit.log?Math.log(v):v)+fit.c,len=k==='y'?extent.sizes[i].h:extent.sizes[i].w;return [[at-len/2,at+len/2]];}).sort((a,b)=>a[0]-b[0]);
    if(intervals.some((r,i)=>i>0&&r[0]<intervals[i-1][1]-.3))report.warnings.push({code:'ticks:crowded',ids:[a.id+'.'+k]});
  }
  for(const legend of l.legends)if(legend.locRequested==='best'&&!legend.collision)report.warnings.push({code:'legend:positional',ids:[legend.id]});
  if(feedback)report.warnings.push({code:'ticks:feedback'});
  const version=model.manifest.generator?.matplotlib;
  if(!identity&&version&&!version.startsWith('3.11.'))report.warnings.push({code:'matplotlib:'+version+' unverified'});
  if(!identity)for(const a of model.axes.values())for(const [k,set]of Object.entries(ticks[a.id]??{})){
    const font=l.fonts[a.axisStyle[k].font];
    if(set.labels.some((label,i)=>label!==a.ticking[k].labels?.[i]&&[...label.replace(/\\[a-zA-Z]+|[${}^]/g,'').replaceAll('-', '−')].some(c=>c!==' '&&font.advances[c]===undefined&&c!=='×')))report.warnings.push({code:'font:unmeasured',ids:[a.id+'.'+k]});
  }
  if(collapsed)report.warnings.push({code:"layout:collapsed"});
  if(report.warnings.some(w=>['ticks:crowded','legend:positional','font:unmeasured','ticks:feedback','layout:collapsed'].includes(w.code)||w.code.startsWith('matplotlib:')))report.status='approximate';
  const result={key,wPt:w,hPt:h,identity,collapsed,domains,axesBox:boxes,fits,ticks,decor,legend,report};
  cache.set(key,result);while(cache.size>32)cache.delete(cache.keys().next().value!);return result;
}
