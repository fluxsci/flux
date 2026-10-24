import type { Project,SemanticPlotElement } from '../../types';
import type { FluxPlotManifest } from '../types';
import { setBoxDim } from '../../ops';
import { buildRelayoutModel, targetFigureSize } from "./model";
import { solveRelayout } from "./solve";
import { stretchReport } from "./report";
import { matchPlotArea, plotArea, type MatchDimension } from "./match";

export function resizePlot(project:Project,id:string,size:{width?:number;height?:number;unit?:"in"|"cm"|"pt"|"px";keepAspect?:boolean},manifest?:FluxPlotManifest){
  const el=project.figures.flatMap(f=>f.elements).find(e=>e.id===id);
  if(el?.type!=="plot")throw new Error(`Plot not found: ${id}`);
  if(size.width==null&&size.height==null)throw new Error("Specify a width or height");
  if([size.width,size.height].some(v=>v!=null&&(!(v>0)||!Number.isFinite(v))))throw new Error("Plot size must be positive and finite");
  if(size.unit&&!['in','cm','pt','px'].includes(size.unit))throw Error('Unknown size unit');
  const next={...el};
  const factor={in:96,cm:96/2.54,pt:96/72,px:1}[size.unit??"in"]*(el.contentScale??1),base={w:el.width,h:el.height};
  const lock=el.lockAspect;
  if(size.keepAspect!==undefined)next.lockAspect=size.keepAspect;
  try{if(size.width!=null)setBoxDim(next,"w",size.width*factor,base);if(size.height!=null)setBoxDim(next,"h",size.height*factor,base);}
  finally{if(lock===undefined)delete next.lockAspect;else next.lockAspect=lock;}
  const model=buildRelayoutModel(manifest);
  const report=next.layoutMode==="stretch"?stretchReport("layout:stretch"):model.supported?solveRelayout(model,targetFigureSize(next)).report:model.report;
  el.width=next.width;el.height=next.height;return report;
}
export function matchPlotAreas(project:Project,elIds:string[],options:{dimension:MatchDimension;reference?:string;panel?:string},manifests:Record<string,FluxPlotManifest>){
  if(!["height","width","both"].includes(options.dimension))throw new Error("Choose height, width or both");
  if(new Set(elIds).size!==elIds.length)throw Error("Plot targets must be distinct");
  const all=project.figures.flatMap(f=>f.elements),elements=elIds.map(id=>all.find(e=>e.id===id));
  if(elements.length<2||elements.some(e=>e?.type!=="plot"))throw new Error("Select two or more plots");
  const plots=elements as SemanticPlotElement[],reference=plots.find(e=>e.id===(options.reference??elIds[0]));
  if(!reference)throw new Error("Reference must be one of the selected plots");
  const models=plots.map(e=>{const m=buildRelayoutModel(manifests[e.assetId]);if(!m.supported||e.layoutMode==="stretch")throw new Error(`Plot ${e.id} must support reflow to match its plot area`);return m;});
  const referenceModel=models[plots.indexOf(reference)],area=plotArea(referenceModel,targetFigureSize(reference),options.panel);
  const plans=plots.map((e,i)=>e===reference?null:matchPlotArea(models[i],targetFigureSize(e),area,options.dimension,{panel:options.panel,keepAspect:e.lockAspect}));
  return plots.flatMap((e,i)=>{
    const plan=plans[i];if(!plan)return [];
    const factor=(e.contentScale??1)/.75;
    setBoxDim(e,"w",plan.size.wPt*factor);setBoxDim(e,"h",plan.size.hPt*factor);
    return [{element:e.id,width:e.width,height:e.height,report:plan.report}];
  });
}
