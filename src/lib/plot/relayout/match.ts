import { unionBoxes, width, height, type RelayoutModel } from "./model";
import { solveRelayout } from "./solve";
import type { RelayoutReport } from "./report";
export type MatchDimension="width"|"height"|"both";
export function plotArea(model:RelayoutModel,size:{wPt:number;hPt:number},panel?:string){
  const sol=solveRelayout(model,size);
  const axes=model.layout.axes.filter(a=>!panel||a.id===panel||a.id.startsWith(panel+"."));
  if(!axes.length)throw new Error("No plot area in the selected panel");
  const box=unionBoxes(axes.map(a=>sol.axesBox[a.id]));return {width:width(box),height:height(box)};
}
export function matchPlotArea(model:RelayoutModel,size:{wPt:number;hPt:number},area:{width:number;height:number},dimension:MatchDimension,options:{panel?:string;keepAspect?:boolean}={}){
  const target={...size},warnings:RelayoutReport["warnings"]=[],ratio=size.wPt/size.hPt;
  let iterations=0,clamped=false;
  for(let round=0;round<(dimension==="both"?3:1);round++)for(const axis of dimension==="both"?["width","height"] as const:[dimension]){
    const key=axis==="width"?"wPt":"hPt",want=area[axis];
    let x=target[key],value=plotArea(model,target,options.panel)[axis];
    let previousX=x,previousValue=value;
    for(let i=0;i<6&&Math.abs(value-want)>=.05;i++){
      iterations++;
      const slope=i===0?value/x:(value-previousValue)/(x-previousX);
      if(!(slope>1e-9)){if(clamped){warnings.push({code:"match:infeasible clamped to minimum size"});break;}warnings.push({code:`aspect-locked: ${axis} follows ${axis==="width"?"height":"width"}`});break;}
      previousX=x;previousValue=value;
      x=Math.max(1,Math.min(100000,x+(want-value)/slope));
      const at=(v:number)=>({...target,[key]:v,...(options.keepAspect?key==='wPt'?{hPt:v/ratio}:{wPt:v*ratio}:{})});
      if(solveRelayout(model,at(x)).collapsed){
        let lo=x,hi=Math.max(previousX,x*2);
        for(let j=0;j<20&&solveRelayout(model,at(hi)).collapsed;j++)hi=Math.min(100000,hi*2);
        for(let j=0;j<20&&hi-lo>.01;j++){const mid=(lo+hi)/2;if(solveRelayout(model,at(mid)).collapsed)lo=mid;else hi=mid;}
        x=hi+.01;clamped=true;
      }
      target[key]=x;
      if(options.keepAspect){if(key==="wPt")target.hPt=x/ratio;else target.wPt=x*ratio;}
      value=plotArea(model,target,options.panel)[axis];
    }
    if(Math.abs(value-want)>=.05&&!warnings.length)warnings.push({code:"match:infeasible clamped to minimum size"});
  }
  if(clamped&&!warnings.some(w=>w.code.startsWith("match:infeasible")))warnings.push({code:"match:infeasible clamped to minimum size"});
  return {size:target,report:{...solveRelayout(model,target).report,warnings:[...solveRelayout(model,target).report.warnings,...warnings]},iterations};
}
