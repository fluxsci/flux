import {harness} from './lib/harness.mjs';import {plot,project} from './lib/relayoutFixture';import {applySourceUpdates} from '../src/lib/plot/sourceSync';
const h=harness('verify-relayout-sourcesync');
const p=project([plot('native'),plot('scaled','asset',{contentScale:2,width:960,height:614.4}),plot('custom','asset',{width:700,height:200}),plot('stretch','asset',{width:700,height:200,layoutMode:'stretch'})]);
applySourceUpdates(p,[{assetId:'asset',width:960,height:614.4,layoutSupported:true}]);const e=p.figures[0].elements;
h.eq([e[0].width,e[0].height],[960,614.4],'untouched follows new native');h.eq([e[1].width,e[1].height],[1920,1228.8],'scaled untouched follows native');h.eq([e[2].width,e[2].height],[700,200],'custom reflow figsize retained');h.eq([e[3].width,e[3].height],[1400,400],'stretch preserves old scaling law');h.eq([p.assets[0].naturalWidth,p.assets[0].naturalHeight],[960,614.4],'asset dimensions refreshed');
await h.done();
