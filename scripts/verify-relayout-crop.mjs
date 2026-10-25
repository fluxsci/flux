import assert from 'node:assert/strict';import {launch,waitForFrame,realErrors} from './lib/driver.mjs';import {relayoutFixture,state} from './lib/relayoutUiFixture.mjs';
const {browser,page}=await launch({width:1500,height:1000});
try{
 const crop={x:48,y:30.72,width:384,height:245.76};await relayoutFixture(page,[{crop}]);
 await page.evaluate(()=>window.__flux.fig.commit(p=>{const e=p.figures.flatMap(f=>f.elements).find(e=>e.id==='reflow-0');e.width=720;e.height=460.8;}));await waitForFrame(page);
 const s=await state(page);assert.deepEqual(s.elements[0].crop,crop);const vb=s.plots[0].viewBox.split(' ').map(Number);for(const [i,v]of [54,34.56,432,276.48].entries())assert(Math.abs(vb[i]-v)<1e-6);
 assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-relayout-crop',ok:true}));
}finally{await browser.close();}
