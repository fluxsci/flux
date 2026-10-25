import type { SemanticPlotElement } from "../../types";
import type { FluxPlotManifest } from "../types";
interface Mount {root:Element;manifest:FluxPlotManifest;base:SemanticPlotElement;nodes:number;active:boolean;paint:(element:SemanticPlotElement)=>void}
const mounts=new Map<string,Mount>();
export const LIVE_REFLOW_NODE_LIMIT=2000;
export function registerRelayoutPreview(root:Element,manifest:FluxPlotManifest|undefined,element:SemanticPlotElement,paint:(element:SemanticPlotElement)=>void):()=>void {
  if(!manifest?.layout?.supported||element.layoutMode==="stretch")return ()=>{};
  const mount:Mount={root,manifest,base:{...element},nodes:root.querySelectorAll("*").length+1,active:false,paint};
  mounts.set(element.id,mount);
  return ()=>{if(mounts.get(element.id)===mount)mounts.delete(element.id);};
}
/** The wrapper resize transform cancels the old SVG viewport size. The inner
 * viewBox reflows while rotation, centre resize and flips keep the existing law. */
function paintRelayoutPreviews(elements:readonly import("../../types").Element[]):void {
  const active=new Set<string>();
  for(const element of elements){
    if(element.type!=="plot")continue;
    const m=mounts.get(element.id);
    if(!m||m.nodes>LIVE_REFLOW_NODE_LIMIT)continue;
    active.add(element.id);const start=performance.now();m.paint(element);relayoutPreviewStats.paints++;relayoutPreviewStats.samples.push(performance.now()-start);if(relayoutPreviewStats.samples.length>512)relayoutPreviewStats.samples.shift();m.active=true;
  }
  for(const [id,m]of mounts)if(m.active&&!active.has(id)){m.paint(m.base);m.active=false;}
}

export const relayoutPreviewStats={paints:0,samples:[] as number[]};
let pending:readonly import('../../types').Element[]|null=null,scheduled=false;
/** One write per paint opportunity, always using the latest pointer sample. */
export function updateRelayoutPreviews(elements:readonly import('../../types').Element[]):void {
  pending=elements;if(scheduled)return;scheduled=true;
  const paint=()=>{scheduled=false;const next=pending;pending=null;if(next)paintRelayoutPreviews(next);};
  if(typeof requestAnimationFrame==='function')requestAnimationFrame(paint);else queueMicrotask(paint);
}
