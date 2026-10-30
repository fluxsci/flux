import type {PlotView} from "../../types";
import {retickable,capturedAxis} from "../project";
import type { FluxPlotManifest } from "../types";
import { buildRelayoutModel, targetFigureSize } from "./model";
import { solveRelayout } from "./solve";
import { restoreRelayout, applyRelayout } from "./apply";
import { effectiveManifest } from "./effective";
import { stretchReport } from "./report";
export * from "./model";
export * from "./solve";
export * from "./apply";
export * from "./report";
export * from "./effective";
export interface RelayoutFrame {width:number;height:number;contentScale?:number;layoutMode?:"stretch";view?:PlotView;crop?:{x:number;y:number;width:number;height:number}}
/** Tick topology belongs to layout; changing only a viewed domain need not rebuild it. */
export function relayoutSkipTickAxes(manifest:FluxPlotManifest|undefined,view:PlotView|undefined):Set<string> {
  const axes=new Set<string>();
  if(manifest&&view)for(const axis of manifest.axes)for(const key of ['x','y','x2','y2'] as const)if(retickable(manifest,view,axis.panelId,key)){const capture=capturedAxis(manifest,axis.panelId,key);if(capture)axes.add(capture.id+'/'+(key.startsWith('x')?'x':'y'));}
  return axes;
}
export function relayoutPlot(root:Element,manifest:FluxPlotManifest|undefined,el:RelayoutFrame,tier:"exact"|"preview"="exact",options:{skipData?:boolean}={}) {
  if(el.layoutMode==="stretch"){restoreRelayout(root);return {reflow:false,manifest,report:stretchReport("layout:stretch")};}
  const model=buildRelayoutModel(manifest,root);if(!model.supported){restoreRelayout(root);return {reflow:false,manifest,report:model.report};}
  const sol=solveRelayout(model,targetFigureSize(el)),skipTickAxes=relayoutSkipTickAxes(model.manifest,el.view);
  applyRelayout(root,model,sol,tier,{...options,skipTickAxes});
  if(el.crop){
    const l=model.layout.figure,c=el.crop;
    root.setAttribute("viewBox",`${c.x/(l.widthPt/.75)*sol.wPt} ${c.y/(l.heightPt/.75)*sol.hPt} ${c.width/(l.widthPt/.75)*sol.wPt} ${c.height/(l.heightPt/.75)*sol.hPt}`);
  }
  return {reflow:true,manifest:effectiveManifest(model.manifest,sol),report:sol.report,solution:sol};
}
