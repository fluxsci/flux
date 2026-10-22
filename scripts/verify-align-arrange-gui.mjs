import assert from 'node:assert/strict';
import {launch,waitFor,waitForFrame,realErrors,shot,clickMode} from './lib/driver.mjs';
import {layoutFixture,seedLayout,readLayout,openArrange,panelButton} from './lib/alignArrangeFixture.mjs';
const {browser,page}=await launch({width:1400,height:960});
try{
 await layoutFixture(page);
 const initial=await readLayout(page);
 await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[aria-label="Flux Align"]'));
 assert.deepEqual((await readLayout(page)).elements,initial.elements,'A never moves artwork');assert.equal((await readLayout(page)).history.past,0);
 await page.keyboard.press('KeyW');let state=await readLayout(page);assert.ok(state.elements.every(e=>e.y===90));assert.equal(state.history.past,1);
 await page.keyboard.press('Escape');assert.equal((await readLayout(page)).state,null);
 await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');assert.deepEqual((await readLayout(page)).elements,initial.elements);
 await page.keyboard.down('Shift');await page.keyboard.press('KeyL');await page.keyboard.up('Shift');assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.activeTool)),'arrow');
 await page.keyboard.press('KeyL');assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.activeTool)),'line');
 await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);await page.keyboard.press('Space');await waitForFrame(page);
 state=await readLayout(page);assert.equal(state.state.mode,'arrange');assert.equal(state.state.topology,'row');assert.deepEqual(state.elements,initial.elements,'regular row including transverse offset is identity');assert.equal(state.history.past,0);
 await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'align');await page.keyboard.press('Escape');
 // Reference alignment remains fixed across successive operations.
 await page.keyboard.press('KeyA');await waitForFrame(page);await page.select('.align-arrange-panel select','reference');
 await page.select('[aria-label="Alignment reference object"]','e:layout-1');await page.evaluate(()=>document.querySelector('.align-arrange-panel').focus());await page.keyboard.press('KeyW');
 state=await readLayout(page);assert.ok(state.elements.every(e=>e.y===110));assert.equal(state.state.referenceId,'e:layout-1');
 await page.keyboard.press('Escape');await seedLayout(page);await openArrange(page);
 // Explicit reflow is a visit; changing topology and escaping restores exact entry.
 await page.keyboard.press('KeyG');state=await readLayout(page);assert.ok(state.history.past<=1);await page.keyboard.press('KeyA');await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial.elements);assert.equal((await readLayout(page)).history.past,0);
 // Commit, Undo and Redo; pending undo cancels instead of consuming older history.
 await openArrange(page);await page.keyboard.press('KeyA');const column=(await readLayout(page)).elements;await page.keyboard.press('Enter');assert.equal((await readLayout(page)).history.past,1);
 await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');assert.deepEqual((await readLayout(page)).elements,initial.elements);
 await openArrange(page);await page.keyboard.press('KeyG');await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Shift');await page.keyboard.up('Control');assert.deepEqual((await readLayout(page)).elements,column,'redo cancels pending visit and preserves old redo branch');
 await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);await panelButton(page,'Align bottom');await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'arrange','pointer activation returns focus to surface');
 await page.keyboard.press('Escape');
 // One object defaults to figure alignment; empty panel permits ordinary selection.
 await page.evaluate(()=>window.__flux.fig.selection.set(new Set(['layout-0'])));await page.keyboard.press('KeyA');assert.equal((await readLayout(page)).state.alignTarget,'figure');await page.keyboard.press('KeyD');assert.equal((await readLayout(page)).elements[0].x,940);await page.keyboard.press('Escape');
 await seedLayout(page);await page.evaluate(()=>window.__flux.fig.selection.set(new Set()));await page.keyboard.press('KeyA');assert.equal((await readLayout(page)).state.count,0);
 const el=await page.$('[data-editor-element-id="layout-0"]');await el.click();await waitForFrame(page);assert.equal((await readLayout(page)).state,null);assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.selection).size),1);
 // Selection changes and external edits cannot leave stale controllers/transforms.
 await seedLayout(page);await openArrange(page);await page.keyboard.press('KeyG');await page.evaluate(()=>window.__flux.fig.selection.set(new Set(['layout-0'])));assert.equal((await readLayout(page)).state,null);
 await seedLayout(page);await openArrange(page);await page.keyboard.press('KeyA');await page.evaluate(()=>window.__flux.fig.commit(p=>p.figures[0].elements[0].fill='#ff0000'));assert.equal((await readLayout(page)).state,null);assert.equal((await readLayout(page)).elements[0].fill,'#ff0000');
 await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);await shot(page,'flux-align');await page.keyboard.press('Space');await waitForFrame(page);await shot(page,'flux-arrange');await page.keyboard.press('Escape');
 await clickMode(page,'Slide');await seedLayout(page);await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[aria-label="Flux Align"]'));await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'arrange');await page.keyboard.press('KeyA');await page.keyboard.press('Escape');assert.equal((await readLayout(page)).history.past,0,'Slide uses same cancellation contract');
 assert.deepEqual(realErrors(page),[]);console.log('PASS Align/Arrange keyboard, references, history, lifecycle and Figure/Slide panel');
}finally{await browser.close();}
