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
 // A single X-ray panel scopes that plot; an unscoped target uses its union.
 await relayoutFixture(page,[{}, {width:600,height:430}],'shared');await page.evaluate(()=>{const F=window.__flux;F.fig.selection.set(new Set(['reflow-0','reflow-1']));const panel=F.get(F.plot.plotManifests)['relayout-asset'].layout.axes[0].id;F.fig.setPartSelections([{elementId:'reflow-0',partId:panel}]);});
 await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[data-match-panel-scope]'));
 assert(await page.$eval('[aria-label="Match plot area height"]',b=>!b.disabled),'panel-scoped Match enabled');
 assert(await page.$eval('.spine-buttons button',b=>b.disabled),'ordinary alignment remains blocked for drilled parts');
 await page.click('[aria-label="Match plot area height"]');await waitForFrame(page);
 const areas=await page.evaluate(async()=>{const F=window.__flux,{buildRelayoutModel}=await import('/src/lib/plot/relayout/model.ts'),{plotArea}=await import('/src/lib/plot/relayout/match.ts'),m=buildRelayoutModel(F.get(F.plot.plotManifests)['relayout-asset']),els=F.figures()[0].elements;return els.map((e,i)=>plotArea(m,{wPt:e.width*.75,hPt:e.height*.75},i===0?m.layout.axes[0].id:undefined).height)});
 assert(Math.abs(areas[0]-areas[1])<.1,'selected panel and target union heights match');assert.equal((await state(page)).history.past,1);
 await page.keyboard.press('Escape');await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await waitForFrame(page);assert.equal((await state(page)).elements[1].height,430);
 await page.evaluate(()=>{const F=window.__flux;F.fig.setPartSelections([]);F.fig.commit(p=>p.figures[0].elements[1].locked=true);});await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[data-match-plot-area]'));assert(await page.$eval('[aria-label="Match plot area height"]',b=>b.disabled),'Match refuses a locked target atomically');
 assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-relayout-match-ui',ok:true,matchMs}));
}finally{await browser.close();}
