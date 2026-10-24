import type { SemanticPlotElement } from "../../types";
import type { FluxPlotManifest } from "../types";
import { relayoutPlot } from "./index";
import { targetFigureSize } from "./model";
import { plotVariantBudget } from "../variantBudget";
interface Variant {root:Element;manifest:FluxPlotManifest;reflow:boolean}
const cache=new Map<string,{source:Element;manifest:FluxPlotManifest;variant:Variant;nodes:number}>();
const identities=new WeakMap<object,number>();let nextId=0;
const identity=(obj:object)=>{let id=identities.get(obj);if(!id)identities.set(obj,id=++nextId);return id;};
const metadata=new WeakMap<Element,Variant>();
function trim(limit=plotVariantBudget.limit){while(cache.size>16||plotVariantBudget.nodes>limit){const key=cache.keys().next().value;if(!key)break;plotVariantBudget.nodes-=cache.get(key)!.nodes;cache.delete(key);}}
plotVariantBudget.trim=(limit:number)=>{plotVariantBudget.limit=Math.max(0,limit);trim();};
export const relayoutRootInfo=(root:Element)=>metadata.get(root);
/** Immutable geometry variants. Source object identity is the asset-generation key. */
export function plotVariant(source:Element,manifest:FluxPlotManifest|undefined,el:SemanticPlotElement):Variant {
  const known=metadata.get(source);if(known)return known;
  if(!manifest?.layout||el.layoutMode==="stretch")return {root:source,manifest:manifest!,reflow:false};
  const size=targetFigureSize(el),key=`${el.assetId}/${identity(source)}/${identity(manifest)}/${size.wPt}/${size.hPt}/${JSON.stringify(el.crop??null)}`;
  const hit=cache.get(key);if(hit){cache.delete(key);cache.set(key,hit);return hit.variant;}
  const root=source.cloneNode(true) as Element,result=relayoutPlot(root,manifest,el);
  if(!result.reflow)return {root:source,manifest,reflow:false};
  root.setAttribute("width",`${size.wPt}pt`);root.setAttribute("height",`${size.hPt}pt`);
  const variant={root,manifest:result.manifest!,reflow:true};metadata.set(root,variant);
  const nodes=root.querySelectorAll("*").length+1;
  if(nodes<=plotVariantBudget.limit){cache.set(key,{source,manifest,variant,nodes});plotVariantBudget.nodes+=nodes;trim();}
  return variant;
}
