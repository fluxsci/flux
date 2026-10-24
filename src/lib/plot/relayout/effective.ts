import type { FluxPlotManifest } from "../types";
import type { RelayoutSolution } from "./solve";
const memo=new WeakMap<FluxPlotManifest,WeakMap<RelayoutSolution,FluxPlotManifest>>();
export function effectiveManifest(manifest:FluxPlotManifest,sol:RelayoutSolution):FluxPlotManifest {
  if(sol.identity)return manifest;
  let cache=memo.get(manifest);if(!cache)memo.set(manifest,cache=new WeakMap());const hit=cache.get(sol);if(hit)return hit;
  const axes=manifest.axes.map(a=>{
    const id=a.svgId??a.id;if(!id)return a;
    const b=sol.axesBox[id];if(!b)return a;
    const out={...a,pixelBox:{...b}};
    for(const key of ["x","y","x2","y2"] as const){const axis=a[key];if(!axis)continue;
      const vertical=key.startsWith("y"),captureId=key==="x2"||key==="y2"?id+"."+key:id,captureKey=key.startsWith("x")?"x":"y",tick=sol.ticks[captureId]?.[captureKey],box=sol.axesBox[captureId]??b;
      const domain=sol.domains[captureId]?.[captureKey]??axis.domain;
      out[key]={...axis,domain:domain as [number,number],anchors:[{data:domain[0],svg:vertical?box.y1:box.x0},{data:domain[1],svg:vertical?box.y0:box.x1}],
        ...(tick?{ticks:tick.values.map((value,i)=>({value,label:tick.labels[i]}))}:{})};
    }
    return out;
  });
  const layout=manifest.layout!,cloneIds=new Map<string,string[]>();
  for(const [id,frame]of Object.entries(layout.frames)){
    if(frame.f!=='axis'||frame.value==null||!frame.axis||!frame.axes)continue;
    const set=sol.ticks[frame.axes]?.[frame.axis];if(!set?.reticked)continue;
    const family=id.replace(/\.[^.]+$/,''),native=Object.entries(layout.frames).filter(([other,f])=>other.replace(/\.[^.]+$/,'')===family&&f.value!=null).map(([,f])=>f.value!),values=frame.minor?set.minor:set.values;
    const domain=sol.domains[frame.axes][frame.axis],[lo,hi]=domain.slice().sort((a,b)=>a-b);
    cloneIds.set(id,values.flatMap((v,i)=>v>=lo&&v<=hi&&!native.some(n=>Math.abs(n-v)<=1e-9*Math.max(1e-300,Math.abs(v),Math.abs(n)))?[family+`.r${i}`]:[]));
  }
  const visit=(node:NonNullable<FluxPlotManifest['parts']>):NonNullable<FluxPlotManifest['parts']>=>({...node,...(node.members?{members:[...new Set(node.members.flatMap(id=>[id,...(cloneIds.get(id)??[])]))]}:{}),...(node.children?{children:node.children.map(visit)}:{})});
  const parts=manifest.parts?visit(manifest.parts):manifest.parts;
  const guides=manifest.guides?.map(g=>{
    const id=g.svgId??g.id,b=sol.axesBox[id];if(!b||g.role!=='colorbar')return g;
    const vertical=g.orientation==='vertical',key=vertical?'y':'x',d=sol.domains[id]?.[key],fit=sol.fits[id]?.[key];if(!d||!fit)return g;
    return {...g,axisLength:vertical?b.y1-b.y0:b.x1-b.x0,ticks:sol.ticks[id]?.[key]?.values??g.ticks,anchors:d.map(value=>({value,svg:fit.m*(fit.log?Math.log(value):value)+fit.c}))};
  });
  const out={...manifest,parts,guides,size:{width:sol.wPt,height:sol.hPt,unit:"pt"},axes};cache.set(sol,out);return out;
}
