import {harness} from './lib/harness.mjs';import {fixture,plot} from './lib/relayoutFixture';import {relayoutPlot,restoreRelayout} from '../src/lib/plot/relayout';
const h=harness('verify-relayout-identity');
for(const name of ['line','scatter-sizes','colorbar','annotation','fluxbox','log']){
 const f=fixture(name),native=String(f.root);relayoutPlot(f.root,f.manifest,plot());h.eq(String(f.root),native,`${name}: native bytes`);
 relayoutPlot(f.root,f.manifest,plot('p','asset',{width:700,height:180}));const changed=String(f.root);h.ok(changed!==native,`${name}: changed geometry`);
 relayoutPlot(f.root,f.manifest,plot('p','asset',{width:700,height:180}));h.eq(String(f.root),changed,`${name}: repeat bytes`);
 relayoutPlot(f.root,f.manifest,plot());h.eq(String(f.root),native,`${name}: A B A bytes`);
 relayoutPlot(f.root,f.manifest,plot('p','asset',{width:700,height:180}));relayoutPlot(f.root,f.manifest,plot('p','asset',{width:700,height:180,layoutMode:'stretch'}));h.eq(String(f.root),native,`${name}: switching to Stretch restores native bindings`);
 restoreRelayout(f.root);h.eq(String(f.root),native,`${name}: restore bytes`);
}
await h.done();
