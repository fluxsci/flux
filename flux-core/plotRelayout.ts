import * as fs from "node:fs/promises";
import { mutateFigModel, projectAssetPath, safeId } from "./model";
import { setPlotLayoutMode as setMode } from "../src/lib/ops";
import * as ops from "../src/lib/plot/relayout/ops";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { MatchDimension } from "../src/lib/plot/relayout/match";
import type { Project } from "../src/lib/types";
async function manifestsFor(root:string,project:Project,ids:string[],figure?:string){
  const elements=project.figures.filter(f=>!figure||f.id===figure).flatMap(f=>f.elements);
  const plots=ids.map(id=>elements.find(e=>e.id===id));
  if(plots.some(e=>e?.type!=="plot"))throw new Error("Every target must be a plot in the requested figure");
  const manifests:Record<string,FluxPlotManifest>={};
  for(const plot of plots)if(plot?.type==="plot"&&!manifests[plot.assetId]){
    safeId("asset",plot.assetId);
    const file=await projectAssetPath(root,`fig/assets/${plot.assetId}.fluxplot.json`);
    try{manifests[plot.assetId]=JSON.parse(await fs.readFile(file,"utf8"));}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  return manifests;
}
export async function resizePlot(root:string,args:{figure?:string;element:string;width?:number;height?:number;unit?:"in"|"cm"|"pt"|"px";keepAspect?:boolean}){
  return mutateFigModel(root,"resize_plot",async({project})=>{
    const manifests=await manifestsFor(root,project,[args.element],args.figure);
    const el=project.figures.flatMap(f=>f.elements).find(e=>e.id===args.element)!;
    const report=ops.resizePlot(project,args.element,args,el.type==="plot"?manifests[el.assetId]:undefined);
    return {element:args.element,width:el.width,height:el.height,report};
  });
}
export async function matchPlotAreas(root:string,args:{figure?:string;elements:string[];dimension:MatchDimension;reference?:string;panel?:string}){
  return mutateFigModel(root,"match_plot_areas",async({project})=>{
    const manifests=await manifestsFor(root,project,args.elements,args.figure);
    return {matched:ops.matchPlotAreas(project,args.elements,args,manifests)};
  });
}
export async function setPlotLayoutMode(root:string,args:{figure?:string;elements:string[];mode:"auto"|"stretch"}){
  return mutateFigModel(root,"set_plot_layout_mode",async({project})=>{
    await manifestsFor(root,project,args.elements,args.figure);
    setMode(project,args.elements,args.mode==="auto"?null:"stretch");
    return {elements:args.elements,mode:args.mode};
  });
}
