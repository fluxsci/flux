import assert from 'node:assert/strict';import {launch,waitForFrame,shot,realErrors} from './lib/driver.mjs';import {relayoutFixture,state} from './lib/relayoutUiFixture.mjs';
const {browser,page}=await launch({width:1600,height:1050});
try{
 await relayoutFixture(page);const original=await state(page);
 const handle=await page.$('.zone.corner[data-h="se"]');assert(handle,'southeast resize zone');const box=await handle.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+240,box.y+box.height/2+153.6,{steps:12});await waitForFrame(page);
 const mid=await state(page);assert.notEqual(mid.plots[0].textCount,original.plots[0].textCount,'ticks change during live resize');assert.notEqual(mid.plots[0].viewBox,original.plots[0].viewBox);await page.mouse.up();await waitForFrame(page);
 let s=await state(page);assert(Math.abs(s.elements[0].width-720)<1);assert(Math.abs(s.elements[0].height-460.8)<1);assert.match(s.plots[0].viewBox,/^0 0 540 /);assert.equal(s.history.past,1,'one undo');
 const clip=await page.$eval('[data-editor-element-id="reflow-0"] clipPath rect',n=>({x:Number(n.getAttribute('x')),width:Number(n.getAttribute('width'))}));assert(Math.abs(clip.x-46.265865)<.5);assert(Math.abs(clip.width-490.733895)<.5,'resized clip matches solved data area');
 const font=await page.$eval('[data-editor-element-id="reflow-0"] [data-role="tick-label"] text',n=>getComputedStyle(n).fontSize);assert.equal(font,'10px');
 await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await waitForFrame(page);assert.deepEqual((await state(page)).elements,original.elements,'undo native');
 await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Shift');await page.keyboard.up('Control');await waitForFrame(page);assert.equal((await state(page)).elements[0].width,s.elements[0].width,'redo reflow');
 await shot(page,'relayout-resize');assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-relayout-resize',ok:true}));
}finally{await browser.close();}
