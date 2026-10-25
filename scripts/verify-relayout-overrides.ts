import {harness} from './lib/harness.mjs';import {fixture,plot} from './lib/relayoutFixture';import {relayoutPlot} from '../src/lib/plot/relayout';import {prefixIds,applyOverrides} from '../src/lib/plot/parse';import {resolveTargets} from '../src/lib/plot/tree';
const h=harness('verify-relayout-overrides'),f=fixture();prefixIds(f.root,'p');
const el=plot('p','asset',{width:900,height:500}),r=relayoutPlot(f.root,f.manifest,el),clones=[...f.root.querySelectorAll('[data-relayout-tick]')];h.ok(clones.length>0,'resize creates new values');
const groups=Object.keys((await import('../src/lib/plot/parse')).buildPartIndex(r.manifest!)),key=groups.find(k=>k.endsWith('axis.y.tick-labels'))!;h.ok(resolveTargets(r.manifest,key).some(id=>id.includes('.r')),'group expands to relayout clones');
applyOverrides(f.root,{[key]:{fill:'#ff0000',hidden:true},'figure.title':{dx:7,dy:3}},'p',r.manifest);
for(const node of clones.filter(n=>n.getAttribute('data-role')==='tick-label'&&n.getAttribute('data-axis')==='y'))h.ok((node as SVGElement).style.display==='none','group hides clones');
const snapshot=(node:Element):unknown=>[node.tagName,[...node.attributes].map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),[...node.childNodes].map(n=>n.nodeType===1?snapshot(n as Element):n.textContent)];
const first=snapshot(f.root);const next=relayoutPlot(f.root,f.manifest,el);applyOverrides(f.root,{[key]:{fill:'#ff0000',hidden:true},'figure.title':{dx:7,dy:3}},'p',next.manifest);h.eq(snapshot(f.root),first,'dxdy and clone overrides idempotent');
// An offset absent in the native SVG can appear after a retick.
{
 const f=fixture('offset'),m=structuredClone(f.manifest),axis=m.layout!.axes[0],id=axis.axisStyle.x.offsetText!;
 const t=m.layout!.texts[id];axis.axisStyle.x.offsetSpec={id,anchor:t.anchor,font:t.font,ha:t.ha,va:t.va,rotation:t.rotation};axis.axisStyle.x.offsetText=null;
 f.root.querySelector(`[id="${id}"]`)?.remove();delete m.layout!.frames[id];delete m.layout!.texts[id];const pristine=String(f.root);
 const {buildRelayoutModel,solveRelayout,applyRelayout,restoreRelayout}=await import('../src/lib/plot/relayout');const model=buildRelayoutModel(m,f.root);if(!model.supported)throw Error('offset model');
 const sol=solveRelayout(model,{wPt:540,hPt:300});applyRelayout(f.root,model,sol);
 h.ok(!!f.root.querySelector(`[id="${id}"] text`)?.textContent,'missing native offset created');
 const {resolveTargets}=await import('../src/lib/plot/tree');h.ok(resolveTargets(m,'axis.x',f.root).includes(id),'axis group reaches synthesized offset');restoreRelayout(f.root);h.eq(String(f.root),pristine,'synthetic offset restoration');
}
// An active data view owns its retick. Retained values keep semantic ids and
// their own edits, dropped values stay dormant, and genuinely new ids inherit
// only group edits. Removing the view restores the original nodes and ids.
{
 const f=fixture(),el=plot('p','asset',{width:720,height:500}),view={x:{domain:[2,8] as [number,number]}};
 prefixIds(f.root,'p');const r=relayoutPlot(f.root,f.manifest,{...el,view});
 const {preparePlotView,applyPlotView}=await import('../src/lib/plot/projectDom');
 const leaf=Object.entries(r.manifest!.layout!.frames).find(([id,frame])=>frame.f==='axis'&&frame.axis==='x'&&frame.part==='ticklabel'&&frame.value===4&&!frame.minor)![0],id='p__'+leaf;
 preparePlotView(f.root,r.manifest,view,'p');applyOverrides(f.root,{'axis.x.tick-labels':{fill:'#205ea6'},[leaf]:{fill:'#d14d41',fontSize:17,dx:3,hidden:false}},'p',r.manifest);applyPlotView(f.root,r.manifest,view,'p');
 const kept=f.root.querySelector(`[id="${id}"]`)!;h.ok(kept.hasAttribute('data-projection-tick'),'view keeps original semantic tick id');
 h.eq((kept.querySelector('text') as SVGElement).style.fill,'#d14d41','retained view tick keeps its leaf paint');h.eq((kept.querySelector('text') as SVGElement).style.fontSize,'17px','retained view tick keeps font edit');h.eq((kept.getAttribute('transform')!.match(/translate\(3 0\)/g)??[]).length,1,'retained value nudge applied exactly once');
 for(const n of Array.from(f.root.querySelectorAll('[data-projection-tick]')).filter(n=>n.id.includes('.ticklabel.')&&n.id.includes('.view.')))h.eq((n.querySelector('text') as SVGElement).style.fill,'#205ea6','new view value inherits only group paint');
 const first=snapshot(f.root);applyPlotView(f.root,r.manifest,view,'p');h.eq(snapshot(f.root),first,'view-retick overrides and dxdy repeat without accumulation');
 applyPlotView(f.root,r.manifest,{x:{domain:[5,8]}},'p');h.eq((f.root.querySelector(`[id="${id}"]`) as SVGElement).style.display,'none','dropped viewed value stays dormant despite hidden:false');
 applyPlotView(f.root,r.manifest,view,'p');h.eq((f.root.querySelector(`[id="${id}"] text`) as SVGElement).style.fill,'#d14d41','view value revives with its original edit');
 applyPlotView(f.root,r.manifest,undefined,'p');h.ok(!f.root.querySelector('[id$=".projection-original"]'),'view removal restores every original semantic id');h.ok(!f.root.querySelector('[data-projection-tick]'),'view removal drops disposable guides');
}
await h.done();
