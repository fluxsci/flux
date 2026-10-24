import assert from 'node:assert/strict';import {launch,waitForFrame,waitFor,realErrors} from './lib/driver.mjs';import {relayoutFixture,state} from './lib/relayoutUiFixture.mjs';
const {browser,page}=await launch({width:1700,height:1050});
try{
 await relayoutFixture(page,[{}, {width:600,height:430}]);await page.evaluate(()=>window.__flux.fig.selection.set(new Set(['reflow-0','reflow-1'])));await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[data-match-plot-area]'));
 await page.click('[aria-label="Match plot area height"]');await waitForFrame(page);
 const s=await state(page);assert(Math.abs(s.elements[1].height-s.elements[0].height)<.1);assert.equal(s.history.past,1);
 await page.keyboard.press('Escape');await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await waitForFrame(page);assert.equal((await state(page)).elements[1].height,430);
 await relayoutFixture(page,[{}, {width:600,height:430},{width:500,height:350},{width:750,height:460}]);await page.evaluate(()=>window.__flux.fig.selection.set(new Set(['reflow-0','reflow-1','reflow-2','reflow-3'])));await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[data-match-plot-area]'));
 await page.evaluate(()=>{document.querySelector('[aria-label="Match plot area height"]').addEventListener('pointerdown',()=>{window.__matchStart=performance.now()},{once:true})});
 await page.click('[aria-label="Match plot area height"]');await waitForFrame(page);const matchMs=await page.evaluate(()=>performance.now()-window.__matchStart);assert(matchMs<=100,`four-plot Match ${matchMs} ms`);const four=await state(page);assert(four.elements.every(e=>Math.abs(e.height-four.elements[0].height)<.1));assert.equal(four.history.past,1);
 assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-relayout-match-ui',ok:true,matchMs}));
}finally{await browser.close();}
