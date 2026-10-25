import {harness} from './lib/harness.mjs';import {fixture,plot} from './lib/relayoutFixture';import {buildPlotMarkup} from '../src/lib/plot/inlineMarkup';import {relayoutPlot} from '../src/lib/plot/relayout';import {prefixIds,applyOverrides} from '../src/lib/plot/parse';import {preparePlotView,applyPlotView} from '../src/lib/plot/projectDom';import {parseMplPath} from '../src/lib/plot/relayout/path';import {transformToAncestor,applyToPoint} from '../src/lib/plot/svgMatrix';
const {renderSlide}=await import('../src/lib/slide/player/render');const {computeSlideAnims,applyAt,applyStatic}=await import('../src/lib/slide/player/player');const {FLUX_DARK}=await import('../src/lib/slide/theme');
import type{Slide}from'../src/lib/slide/types';import type{SemanticPlotElement}from'../src/lib/types';
const h=harness('verify-relayout-parity');
const a=fixture('line'),b=fixture('line-updated'),assets={A:a,B:b},ctx={theme:FLUX_DARK,plotRoot:(id:string)=>assets[id as 'A'|'B']?.root,plotManifest:(id:string)=>assets[id as 'A'|'B']?.manifest},stage={width:1600,height:900};
function vertices(root:Element,id:string){const el=root.querySelector(`[id="p__${id}"]`),path=el?.tagName.toLowerCase()==='path'?el:el?.querySelector('path');if(!path)return null;const p=parseMplPath(path.getAttribute('d')??'');if(!p)return null;const m=transformToAncestor(path,root),out=[];for(let i=0;i<p.vertices.length;i+=2){const q=applyToPoint({x:p.vertices[i],y:p.vertices[i+1]},m);out.push(q.x,q.y);}return out;}
function compare(actual:Element,expected:Element,label:string){for(const id of ['signal.line','axis.x.spine.bottom','axis.y.spine.left']){const x=vertices(actual,id),y=vertices(expected,id);h.ok(!!x&&!!y&&x.length===y.length&&x.every((v,i)=>Math.abs(v-y[i])<.05),`${label}: ${id} actual ${x?.slice(0,6)} expected ${y?.slice(0,6)}`);}h.eq(actual.getAttribute('viewBox'),expected.getAttribute('viewBox'),`${label}: viewBox`);}
for(const name of ['line','colorbar','annotation','fluxbox']){
 const f=fixture(name),el=plot('p','A',{width:720,height:210,overrides:{'figure.title':{dx:4,dy:3}}}),manual=f.root.cloneNode(true) as Element;prefixIds(manual,'p');const result=relayoutPlot(manual,f.manifest,el);preparePlotView(manual,result.manifest,el.view,'p');applyOverrides(manual,el.overrides,'p',result.manifest);applyPlotView(manual,result.manifest,el.view,'p');
 const markup=buildPlotMarkup(f.svg,el,el.overrides,f.manifest)!;const xml=new DOMParser().parseFromString(markup,'image/svg+xml').documentElement;
 for(const attr of ['x','y','width','height','preserveAspectRatio'])manual.setAttribute(attr,xml.getAttribute(attr)!);
 h.eq(String(manual),String(xml),`${name}: mount pipeline and inline bytes`);
}
for(const change of [{width:720,height:210},{width:720,height:600},{assetId:'B',width:700,height:260},{width:640,height:220,view:{x:{domain:[2,4] as [number,number]}}}]){
 const initial=plot('p','A'),end={...initial,...change} as SemanticPlotElement,slide:Slide={id:'s',elements:[initial],beats:[{id:'base',tracks:[]},{id:'change',tracks:[{target:'p',preset:'transform',duration:1000,easing:'linear',to:{...('assetId' in change?{assetId:change.assetId}:{}),state:Object.fromEntries(Object.entries(change).filter(([k])=>k!=='assetId'))}}]}]},host=document.createElement('div'),expectedHost=document.createElement('div');
 const rendered=renderSlide(host,slide,stage,ctx),specs=computeSlideAnims(slide,rendered,host,stage,ctx);
 applyAt(specs,1,500);h.ok(!!host.querySelector('svg'),'midpoint mounted');if(change.height===600)h.eq(host.querySelectorAll('[data-tween-ticks]').length,2,'two retained tick sets crossfade');applyStatic(specs,1);
 renderSlide(expectedHost,{id:'expected',elements:[end],beats:[{id:'base',tracks:[]}]},stage,ctx);
 const actual=host.querySelector('svg')!,expected=expectedHost.querySelector('svg')!;compare(actual,expected,JSON.stringify(change));
 h.eq([...actual.querySelectorAll('[data-projection-tick]')].map(n=>n.getAttribute('data-value')),[...expected.querySelectorAll('[data-projection-tick]')].map(n=>n.getAttribute('data-value')),'view tick endpoint parity');
 applyStatic(specs,0);renderSlide(expectedHost,{id:'initial',elements:[initial],beats:[{id:'base',tracks:[]}]},stage,ctx);compare(host.querySelector('svg')!,expectedHost.querySelector('svg')!,'reverse');
}
// A data view owns reticking on each side and for minor ticks independently.
// Far-side guides must not disappear, and log coefficients use measured math glyphs.
for(const [name,view] of [
 ['both-sides',{x:{domain:[2,4]},y:{domain:[-.5,.5]}}],
 ['log-subs',{x:{domain:[.1,1000],scale:'log'}}],
] as const){
 const f=fixture(name),el=plot('p','a',{width:720,height:500,view:view as SemanticPlotElement['view']}),root=f.root.cloneNode(true) as Element;
 prefixIds(root,'p');const layout=relayoutPlot(root,f.manifest,el);preparePlotView(root,layout.manifest,el.view,'p');applyPlotView(root,layout.manifest,el.view,'p');
 const clones=[...root.querySelectorAll('[data-projection-tick]')];h.ok(clones.length>0,`${name}: viewed ticks generated`);
 if(name==='both-sides')for(const axis of ['x','y']){
  const near=clones.filter(n=>n.id.includes('.'+axis+'.ticklabel.')&&!n.id.includes('secondary')),far=clones.filter(n=>n.id.includes('.'+axis+'.secondary.ticklabel.'));
  h.ok(near.length>0&&far.length===near.length,`${axis}: both sides retained`);h.eq(near.map(n=>n.textContent),far.map(n=>n.textContent),`${axis}: side label parity`);
 }
 if(name==='log-subs'){
  h.ok(clones.some(n=>n.id.includes('.minor.')), 'log view retains independent minor tick templates');
  h.ok(clones.some(n=>n.textContent?.includes('×')), 'log coefficient uses multiplication glyph');
 }
 h.ok(!clones.some(n=>n.textContent?.includes(String.raw`\times`)),`${name}: no literal math commands`);
 const first=String(root);applyPlotView(root,layout.manifest,el.view,'p');h.eq(String(root),first,`${name}: view retick is repeatable`);
}
// Regenerated plots retain legacy track bindings in offline payloads too.
{
 const {gatherPayload,portablePayload}=await import('../src/lib/slide/payload'),{createDeck}=await import('../src/lib/slide/ops'),{resolveTargets}=await import('../src/lib/plot/tree');
 const deck=createDeck({id:'aliases',withTitleSlide:false});deck.assets=[{id:'A',kind:'svg',name:'Line',path:'assets/a.svg',naturalWidth:480,naturalHeight:307.2}];
 deck.slides=[{id:'s',elements:[plot('p','A')],beats:[{id:'base',tracks:[]},{id:'alias',tracks:[{id:'alias-track',target:'p',part:'axis.x.spine',preset:'fade',duration:400}]}]}];
 const gathered=await gatherPayload('/scratch',deck,{readText:async path=>{if(path.endsWith('/a.svg'))return a.svg;if(path.endsWith('/A.fluxplot.json'))return JSON.stringify(a.manifest);throw Error('Missing '+path)},readFile:async()=>new Uint8Array()});
 h.eq(gathered.warnings,[],'legacy aliases count as covered animation parts');
 const portable=portablePayload(gathered.payload),manifest=portable.plots.A.manifest;
 h.eq(manifest.idAliases,a.manifest.idAliases,'portable deck keeps regenerated part aliases');
 h.eq(resolveTargets(manifest,'axis.x.spine'),['axis.x.spine.bottom'],'offline legacy spine resolves to real geometry');
}
await h.done();
