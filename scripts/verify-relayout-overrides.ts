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
await h.done();
