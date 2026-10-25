import assert from 'node:assert/strict';import {launch,waitFor,waitForFrame,shot,realErrors} from './lib/driver.mjs';import {relayoutFixture,state} from './lib/relayoutUiFixture.mjs';
const {browser,page}=await launch({width:1500,height:1000});
try{
 await relayoutFixture(page);await waitFor(page,()=>!!document.querySelector('[data-plot-layout]'));
 assert.match(await page.$eval('[data-relayout-status]',n=>n.textContent),/Reflowed|Exact/);
 const selector=await page.evaluate(()=>{const n=[...document.querySelectorAll('.row.wh .nf')].find(n=>n.textContent.includes('W'));return n?'.row.wh .nf input':null;});assert(selector);
 await page.click(selector,{count:3});await page.keyboard.type('720');await page.keyboard.press('Enter');await waitForFrame(page);
 let s=await state(page);assert.equal(s.elements[0].width,720);assert.equal(s.plots[0].viewBox,'0 0 540 230.4');assert.equal(s.history.past,1);
 await page.evaluate(()=>[...document.querySelectorAll('[data-plot-layout] button')].find(b=>b.textContent.trim()==='Stretch').click());await waitForFrame(page);s=await state(page);assert.equal(s.elements[0].layoutMode,'stretch');assert.equal(s.plots[0].viewBox,'0 0 360 230.4');
 await page.evaluate(()=>[...document.querySelectorAll('[data-plot-layout] button')].find(b=>b.textContent.trim()==='Reflow').click());await waitForFrame(page);
 await page.evaluate(()=>[...document.querySelectorAll('[data-plot-layout] button')].find(b=>b.textContent.trim()==='Native size').click());await waitForFrame(page);s=await state(page);assert.equal(s.elements[0].width,480);assert.equal(s.elements[0].height,307.2);assert.equal(s.elements[0].layoutMode,undefined);
 await shot(page,'relayout-inspector');assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-relayout-inspector',ok:true}));
}finally{await browser.close();}
