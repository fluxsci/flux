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
 // Compact panes stay present; inactive controls activate and act in one click.
 await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);
 assert.equal(await page.$$eval('.tool-pane',nodes=>nodes.length),2,'both tools remain visible');
 await page.hover('.arrange-pane .anchor-section h3');await page.mouse.wheel({deltaY:40});await waitForFrame(page);
 assert.equal((await readLayout(page)).state.mode,'align','scrolling passive pane space never activates Arrange');assert.deepEqual((await readLayout(page)).elements,initial.elements);
 await page.click('.topologies button[title^="Reflow as column"]');await waitForFrame(page);
 state=await readLayout(page);assert.equal(state.state.mode,'arrange');assert.equal(state.state.topology,'column','one inactive-pane click performs column reflow');
 await page.click('[aria-label="Align bottom"]');await waitForFrame(page);state=await readLayout(page);
 assert.equal(state.state.mode,'align');assert.ok(state.elements.every(e=>e.y+e.height===state.elements[0].y+state.elements[0].height),'one inactive-pane click performs alignment');
 await page.focus('[aria-label="Align left"]');await page.keyboard.press('Space');await waitForFrame(page);state=await readLayout(page);
 assert.equal(state.state.mode,'align','Space activates a focused action instead of switching panes');assert.ok(state.elements.every(e=>e.x===state.elements[0].x));
 await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);
 const field='.arrange-pane .nf input';await page.focus(field);await waitForFrame(page);
 assert.equal((await readLayout(page)).state.mode,'arrange','keyboard focus starts numeric ownership in inactive pane');
 await page.click(field,{count:3});await page.keyboard.type('12.125a');await waitForFrame(page);
 assert.equal(await page.$eval(field,e=>e.value),'12.125a','typed A remains a field character');assert.equal((await readLayout(page)).state.topology,'row');assert.deepEqual((await readLayout(page)).elements,initial.elements,'numeric typing is transient');
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial.elements);
 // Idle precision is cosmetic; focusing/accepting an unchanged value is identity.
 const fractional=[{x:20,y:60,width:60,height:40},{x:80.12345678912345,y:60,width:60,height:40}];
 await seedLayout(page,fractional);await openArrange(page);const precise=await readLayout(page);
 assert.equal(await page.$eval(field,e=>e.value),'0.123','idle spacing display is concise');
 await page.focus(field);assert.equal(Number(await page.$eval(field,e=>e.value)),precise.state.gapX,'editing exposes full existing precision');
 await page.keyboard.press('Enter');await waitForFrame(page);assert.deepEqual((await readLayout(page)).elements,precise.elements,'accepting untouched rounded field never quantizes artwork');assert.equal((await readLayout(page)).history.past,0);
 await page.keyboard.press('Escape');
 // The compact surface stacks at small widths and keeps both tools reachable.
 await page.setViewport({width:480,height:760,deviceScaleFactor:2});await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);
 const compact=await page.evaluate(()=>{const p=document.querySelector('.align-arrange-panel'),b=p.getBoundingClientRect(),body=p.querySelector('.body');return {bounds:{x:b.x,y:b.y,right:b.right,bottom:b.bottom},overflow:body.scrollWidth>body.clientWidth,panes:[...p.querySelectorAll('.tool-pane')].map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:r.width};})};});
 assert.ok(compact.bounds.x>=7&&compact.bounds.y>=7&&compact.bounds.right<=473&&compact.bounds.bottom<=753,'small panel stays inside viewport margins');assert.equal(compact.overflow,false,'small panel has no horizontal overflow');assert.ok(compact.panes.every(p=>p.width>0&&p.left>=compact.bounds.x&&p.right<=compact.bounds.right&&p.bottom<=753),'both compact panes fit in the small viewport');
 await shot(page,'flux-align-arrange-compact-dpr2');await page.keyboard.press('Escape');await page.setViewport({width:1400,height:960,deviceScaleFactor:1});
 // Scientific trace stack: negative envelope spacing exposes close baselines
 // while each curve retains its original 500 × 140 drawing geometry.
 await page.setViewport({width:1600,height:1050,deviceScaleFactor:1});
 const waveform='M 0 70 L 80 70 C 100 70 108 0 125 0 C 145 0 140 140 165 140 C 185 140 200 70 225 70 L 500 70';
 await seedLayout(page,Array.from({length:4},(_,i)=>({type:'path',name:`Trace ${i+1}`,x:100,y:40+i*160,width:500,height:140,d:waveform,closed:false,fill:'none',stroke:'#252523',strokeWidth:2})));
 await openArrange(page);const tracesBefore=await readLayout(page),traceCenter=tracesBefore.state.bounds.y+tracesBefore.state.bounds.h/2;assert.equal(tracesBefore.state.topology,'column');
 await page.click(field,{count:3});await page.keyboard.type('-95');await page.keyboard.press('Enter');await waitForFrame(page);
 const traces=await readLayout(page);assert.equal(traces.state.gapY,-95);assert.equal(traces.state.bounds.y+traces.state.bounds.h/2,traceCenter,'overlapping traces preserve the selected center');
 for(let i=1;i<traces.elements.length;i++){assert.equal(traces.elements[i].y-traces.elements[i-1].y,45,'waveform baselines are 45px apart');assert.equal(traces.elements[i].y-traces.elements[i-1].y-traces.elements[i-1].height,-95,'waveform edge gap is negative95');}
 assert.ok(traces.elements.every(e=>e.d===waveform&&e.width===500&&e.height===140),'overlap never distorts waveform paths');
 const traceGuide=await page.$eval('[data-arrange-gap="y"]',e=>{const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});await page.mouse.move(traceGuide.x,traceGuide.y);await waitForFrame(page);assert.equal(await page.$eval('.gap-badge text',e=>e.textContent),'-95');
 assert.notEqual(await page.$eval('.gap-badge rect',e=>getComputedStyle(e).fill),'none','spacing badge has a solid background');await shot(page,'flux-arrange-overlapping-waveforms');
 await page.keyboard.press('Escape');await page.setViewport({width:1400,height:960,deviceScaleFactor:1});
 await seedLayout(page);await page.keyboard.press('KeyA');await waitForFrame(page);await shot(page,'flux-align');await page.keyboard.press('Space');await waitForFrame(page);await shot(page,'flux-arrange');await page.keyboard.press('Escape');
 await clickMode(page,'Slide');await seedLayout(page);await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('[aria-label="Flux Align"]'));await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'arrange');await page.keyboard.press('KeyA');await page.keyboard.press('Escape');assert.equal((await readLayout(page)).history.past,0,'Slide uses same cancellation contract');
 assert.deepEqual(realErrors(page),[]);console.log('PASS Align/Arrange keyboard, references, history, lifecycle and Figure/Slide panel');
}finally{await browser.close();}
