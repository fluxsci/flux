import fs from 'node:fs';import {DOMParser} from 'linkedom';import {harness} from './lib/harness.mjs';import {buildRelayoutModel,solveRelayout,applyRelayout} from '../src/lib/plot/relayout';
const h=harness('verify-relayout-perf'),svg=fs.readFileSync('scripts/fixtures/relayout/hexmatrix.svg','utf8'),m=JSON.parse(fs.readFileSync('scripts/fixtures/relayout/hexmatrix.fluxplot.json','utf8')),sourceRoot=new DOMParser().parseFromString(svg,'image/svg+xml').documentElement as unknown as Element,root=sourceRoot.cloneNode(true) as Element;
const begin=performance.now(),model=buildRelayoutModel(m,root),buildMs=performance.now()-begin;if(!model.supported)throw Error('Dense model refused');const solve=[],apply=[];let bindMs=0;
for(let i=0;i<125;i++){let t=performance.now();const s=solveRelayout(model,{wPt:410+i*.11,hPt:260+i*.07});solve.push(performance.now()-t);t=performance.now();applyRelayout(root,model,s);const dt=performance.now()-t;if(!i)bindMs=dt;else if(i>24)apply.push(dt);}
const cold=[];for(let i=0;i<40;i++){// Clone a pristine source, as mount does at release.
 const native=sourceRoot.cloneNode(true) as Element;
 const s=solveRelayout(model,{wPt:430+i*.13,hPt:280+i*.09}),t=performance.now();applyRelayout(native,model,s);if(i>9)cold.push(performance.now()-t);
}
const p95=(v:number[])=>v.slice().sort((a,b)=>a-b)[Math.floor(v.length*.95)];const metrics={nodes:root.querySelectorAll('*').length+1,modelBuildMs:buildMs,firstApplyMs:bindMs,solveP95Ms:p95(solve),applyP95Ms:p95(apply),freshCloneApplyP95Ms:p95(cold)};
fs.mkdirSync('test-results/relayout',{recursive:true});fs.writeFileSync('test-results/relayout/perf.json',JSON.stringify(metrics,null,2)+'\n');h.ok(metrics.modelBuildMs<=15,`model build ${buildMs.toFixed(2)} ms`);h.ok(metrics.applyP95Ms<=10,`dense exact apply p95 ${metrics.applyP95Ms.toFixed(2)} ms`);// Fresh-DOM allocation and GC are reported here, but the end-to-end
// release budget is measured in Chrome by verify-scale-relayout-release.
h.ok(metrics.nodes>=3143,'production dense fixture');await h.done();
