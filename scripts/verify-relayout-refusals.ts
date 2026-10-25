import fs from 'node:fs';import {harness} from './lib/harness.mjs';import {fixture,plot} from './lib/relayoutFixture';import {relayoutPlot,buildRelayoutModel} from '../src/lib/plot/relayout';
const h=harness('verify-relayout-refusals');
for(const n of ['polar','subfigures','3d']){const m=JSON.parse(fs.readFileSync(`scripts/fixtures/relayout/${n}/base.fluxplot.json`,'utf8')),model=buildRelayoutModel(m);h.ok(!model.supported&&model.report.status==='stretch'&&model.report.warnings.length>0,`${n}: stretch with reason`);}
const f=fixture();h.ok(!buildRelayoutModel({...f.manifest,layout:undefined}).supported,'legacy stretch');
const before=String(f.root),result=relayoutPlot(f.root,f.manifest,plot('p','asset',{layoutMode:'stretch',width:600}));h.ok(!result.reflow,'explicit stretch');h.eq(String(f.root),before,'fallback geometry untouched');
const bad=f.root.cloneNode(true) as Element;bad.querySelector('path')!.setAttribute('d','m 1 2 l 3 4');h.ok(!buildRelayoutModel(f.manifest,bad).supported,'relative path refuses even after manifest cache hit');
await h.done();
