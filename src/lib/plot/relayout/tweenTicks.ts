import type {PartOverride} from '../../types';
import type {FluxPlotManifest} from '../types';
import {prefixIds,applyOverrides} from '../parse';
import {applyPlotTheme} from '../themeDom';
import type {DeckTheme} from '../../slide/types';
import {buildRelayoutModel} from './model';
import {applyRelayout} from './apply';
import {solveRelayout,type RelayoutSolution} from './solve';
import {effectiveManifest} from './effective';
/** Two small, retained tick-only SVGs. Data marks are never cloned per frame. */
export function createTickTween(root:Element,source:Element,manifest:FluxPlotManifest,elementId:string,from:{wPt:number;hPt:number},to:{wPt:number;hPt:number},theme:DeckTheme|null){
 const candidate=buildRelayoutModel(manifest);if(!candidate.supported)return null;const model=candidate;
 const endpoints=[solveRelayout(model,from),solveRelayout(model,to)];
 if(JSON.stringify(endpoints[0].ticks)===JSON.stringify(endpoints[1].ticks))return null;
 const original=new Map<Element,string|null>();
 const layers=endpoints.map((endpoint,index)=>{
  const layer=source.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','svg'),scope=elementId+'--ticks-'+index;
  layer.setAttribute('data-tween-ticks',String(index));layer.setAttribute('preserveAspectRatio','none');layer.setAttribute('x','0');layer.setAttribute('y','0');
  for(const defs of Array.from(source.children).filter(n=>n.tagName.toLowerCase()==='defs'))layer.appendChild(defs.cloneNode(true));
  const ids=new Set(Object.entries(model.layout.frames).filter(([,f])=>f.f==='axis'&&['tick','ticklabel','gridline','offset'].includes(f.part??'')).map(([id])=>id));
  for(const node of Array.from(source.querySelectorAll('[id]')))if(ids.has(node.id))layer.appendChild(node.cloneNode(true));
  prefixIds(layer,scope);applyPlotTheme(layer,manifest,theme);return {layer,scope,endpoint};
 });
 function clear(){for(const [el,v]of original){if(v==null)el.removeAttribute('visibility');else el.setAttribute('visibility',v);}original.clear();for(const {layer}of layers)layer.remove();}
 function paint(current:RelayoutSolution,t:number,overrides?:Record<string,PartOverride>){
  for(const node of Array.from(root.querySelectorAll('[data-role="tick"],[data-role="tick-label"],[data-role="gridline"],[data-role="colorbar-tick"],[data-role="colorbar-tick-label"],[data-role="tick-offset"]'))){
   if(layers.some(l=>l.layer.contains(node)))continue;if(!original.has(node))original.set(node,node.getAttribute('visibility'));node.setAttribute('visibility','hidden');
  }
  for(const [index,{layer,scope,endpoint}]of layers.entries()){
   const solution={...current,identity:false,ticks:endpoint.ticks};applyRelayout(layer,model,solution);
   layer.setAttribute('width',String(current.wPt));layer.setAttribute('height',String(current.hPt));layer.setAttribute('opacity',String(index?t:1-t));
   applyOverrides(layer,overrides,scope,effectiveManifest(manifest,solution));if(layer.parentNode!==root)root.appendChild(layer);
  }
 }
 return {paint,clear};
}
