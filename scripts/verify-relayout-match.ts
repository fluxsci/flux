import {harness} from './lib/harness.mjs';import {fixture,plot,project} from './lib/relayoutFixture';import {plotArea,matchPlotArea} from '../src/lib/plot/relayout/match';import {matchPlotAreas,resizePlot} from '../src/lib/plot/relayout/ops';
const h=harness('verify-relayout-match'),f=fixture(),native={wPt:360,hPt:230.4},wanted=plotArea(f.model,native);
for(const dimension of ['width','height','both'] as const){const r=matchPlotArea(f.model,{wPt:500,hPt:350},wanted,dimension),a=plotArea(f.model,r.size);for(const key of dimension==='both'?['width','height'] as const:[dimension])h.ok(Math.abs(a[key]-wanted[key])<.05,`${dimension}: converges on ${key}`);h.ok(r.iterations<=36,'bounded iterations');}
const p=project([plot('a'),plot('b','asset',{width:700,height:450})]),ref={...p.figures[0].elements[0]};matchPlotAreas(p,['b','a'],{dimension:'both',reference:'a'},{asset:f.manifest});h.eq(p.figures[0].elements[0],ref,'reference unchanged');
resizePlot(p,'b',{width:5,height:3.2,unit:'in',keepAspect:false},f.manifest);h.ok(p.figures[0].elements[1].width===480,'physical units');
const before=JSON.stringify(p);try{matchPlotAreas(p,['a','missing'],{dimension:'height'},{asset:f.manifest});h.fail('invalid selection accepted');}catch{}h.eq(JSON.stringify(p),before,'invalid match atomic');
const aspect=fixture('image-equal'),flat=matchPlotArea(aspect.model,{wPt:600,hPt:160},{width:500,height:500},'width');h.ok(flat.report.warnings.length>0,'aspect-flat constraint reported');
const tiny=matchPlotArea(f.model,native,{width:.00001,height:.00001},'both');h.ok(!((await import('../src/lib/plot/relayout/solve')).solveRelayout(f.model,tiny.size)).collapsed,'infeasible request clamps to a feasible figure');h.ok(tiny.report.warnings.some(w=>w.code.startsWith('match:infeasible')),'infeasible clamp has reason');
{
 const shared=fixture('shared'),line=fixture('line'),reference=plot('reference','r'),target=plot('target','t',{width:600,height:430}),p=project([reference,target]),panel=shared.model.layout.axes[0].id;
 const wanted=plotArea(shared.model,{wPt:reference.width*.75,hPt:reference.height*.75},panel);
 matchPlotAreas(p,[reference.id,target.id],{dimension:'height',reference:reference.id,panels:{[reference.id]:panel}},{r:shared.manifest,t:line.manifest});
 const got=plotArea(line.model,{wPt:target.width*.75,hPt:target.height*.75});
 h.ok(Math.abs(got.height-wanted.height)<.05,'selected reference panel matches target union');
 h.eq(reference.height,307.2,'panel reference size stays fixed');
}
await h.done();
