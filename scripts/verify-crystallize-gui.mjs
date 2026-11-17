// Crystallize on the real canvas (Figure and Slide): the corner offer beside a loose selection,
// its hover preview, the click, Shift+A, one Undo, the notice, and the passive pink guides that
// take over afterwards. The planner itself is pinned by verify-crystallize.ts (pure).
import assert from 'node:assert/strict';
import {launch,waitFor,waitForFrame,realErrors,shot,clickMode} from './lib/driver.mjs';
import {layoutFixture,seedLayout,readLayout} from './lib/alignArrangeFixture.mjs';
const {browser,page}=await launch({width:1400,height:960});
// The owner's Figure 7 (2026-11-17): a loose 3 × 3, a loose row, a loose column.
const box=(x,y,fill)=>({x,y,width:56,height:58,fill,stroke:'#222222',strokeWidth:2});
const loose=[
 ...[[76.7,172.2],[152.6,169.4],[226.9,163.4],[91.2,251],[160.2,259.1],[237.1,251],[70.7,326.5],[147.5,326.5],[219.6,330.6]].map(([x,y])=>box(x,y,'#d95f02')),
 ...[[330.4,251],[396.9,255.6],[461.4,251]].map(([x,y])=>box(x,y,'#228833')),
 ...[[537.8,179.7],[546.4,245.3],[537.8,310.9]].map(([x,y])=>box(x,y,'#3171b2')),
];
const select=(from,to)=>page.evaluate((from,to)=>{const F=window.__flux,s=F.fig,f=F.get(s.project).figures.find(f=>f.id===F.get(s.activeFigureId));s.selection.set(new Set(f.elements.slice(from,to).map(e=>e.id)));},from,to);
const rectOf=sel=>page.$eval(sel,e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,cx:r.x+r.width/2,cy:r.y+r.height/2,w:r.width,h:r.height};});
const shiftA=async()=>{await page.keyboard.down('Shift');await page.keyboard.press('KeyA');await page.keyboard.up('Shift');await waitForFrame(page);};
const undo=async()=>{await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await waitForFrame(page);};
const distinct=values=>new Set(values).size;
async function scenario(mode){
 await seedLayout(page,loose);await select(0,9);await waitFor(page,()=>!!document.querySelector('[data-crystallize]'),null,{label:`${mode}: offer beside a loose selection`});
 const before=await readLayout(page);
 assert.equal(await page.$('[data-arrange-gap]'),null,`${mode}: a loose selection has no pink guides yet`);
 const offer=await rectOf('[data-crystallize]'),selection=await rectOf('.canvas-host .sel-box');
 assert.ok(offer.x>=selection.right&&offer.y>=selection.bottom,`${mode}: the offer sits just outside the bottom-right corner`);
 assert.ok(offer.x-selection.right<24&&offer.y-selection.bottom<24&&Math.abs(offer.w-22)<1.5,`${mode}: close to the corner, and small`);
 assert.match(await page.$eval('[data-crystallize] title',e=>e.textContent),/Crystallize · Grid 3 × 3 \(Shift\+A\)/,`${mode}: the offer names what it found and its key`);
 // Hover previews the arrangement without touching the model.
 await page.mouse.move(offer.cx,offer.cy);await waitFor(page,()=>document.querySelectorAll('.crystal-preview rect').length===9,null,{label:`${mode}: hover previews nine places`});
 assert.equal(await page.$$eval('.crystal-preview line',n=>n.length),4,`${mode}: and the four gutters of a 3 × 3`);
 assert.deepEqual((await readLayout(page)).elements,before.elements,`${mode}: a preview moves nothing`);assert.equal((await readLayout(page)).history.past,0);
 if(mode==='Figure')await shot(page,'flux-crystallize-offer-preview');
 // Click: one step, selection kept, guides and a short notice.
 await page.mouse.click(offer.cx,offer.cy);await waitFor(page,()=>!!document.querySelector('[data-crystallize-notice]'),null,{label:`${mode}: notice`});
 let state=await readLayout(page);const grid=state.elements.slice(0,9);
 assert.equal(state.history.past,1,`${mode}: Crystallize is one Undo step`);
 assert.equal(distinct(grid.map(e=>e.x)),3,`${mode}: three columns, each on one x`);assert.equal(distinct(grid.map(e=>e.y)),3,`${mode}: three rows, each on one y`);
 const xs=[...new Set(grid.map(e=>e.x))].sort((a,b)=>a-b),ys=[...new Set(grid.map(e=>e.y))].sort((a,b)=>a-b);
 assert.ok(Math.abs((xs[1]-xs[0])-(xs[2]-xs[1]))<1e-6&&Math.abs((ys[1]-ys[0])-(ys[2]-ys[1]))<1e-6,`${mode}: one gap per axis`);
 const whole=v=>Math.abs(v-Math.round(v))<1e-6;
 assert.ok(whole(xs[1]-xs[0]-56)&&whole(ys[1]-ys[0]-58),`${mode}: whole-pixel gaps (${xs[1]-xs[0]-56}, ${ys[1]-ys[0]-58})`);
 assert.deepEqual(state.elements.slice(9),before.elements.slice(9),`${mode}: unselected objects never move`);
 assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.selection).size),9,`${mode}: the selection survives the click`);
 assert.equal(await page.$('[data-crystallize]'),null,`${mode}: the offer is spent`);
 assert.equal(await page.$$eval('[data-arrange-gap]',n=>n.length),4,`${mode}: the pink guides appear without opening the tool`);
 assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Grid 3 × 3');
 if(mode==='Figure')await shot(page,'flux-crystallize-done');
 await waitFor(page,()=>!document.querySelector('[data-crystallize-notice]'),null,{label:`${mode}: the notice retires on its own`,timeout:4000});
 // Shift+A on what is already regular: says so, changes nothing.
 await shiftA();assert.equal((await readLayout(page)).history.past,1,`${mode}: a regular selection is left alone`);assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Grid 3 × 3');
 await undo();assert.deepEqual((await readLayout(page)).elements,before.elements,`${mode}: Undo restores every hand-placed position`);
 await waitFor(page,()=>!!document.querySelector('[data-crystallize]'),null,{label:`${mode}: the offer returns after Undo`});
 // Shift+A: row and column, recognized from the selection alone.
 await select(9,12);await waitForFrame(page);await shiftA();state=await readLayout(page);
 assert.equal(distinct(state.elements.slice(9,12).map(e=>e.y)),1,`${mode}: the green three are a row`);assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Row of 3');
 await select(12,15);await waitForFrame(page);await shiftA();state=await readLayout(page);
 assert.equal(distinct(state.elements.slice(12,15).map(e=>e.x)),1,`${mode}: the blue three are a column`);assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Column of 3');
 assert.equal(state.history.past,2);assert.deepEqual(state.elements.slice(0,9),before.elements.slice(0,9));
 // "One more green square below the left-most": the best grid for four is 2 × 2.
 await seedLayout(page,[...loose.slice(9,12),box(331,326,'#228833')]);await waitFor(page,()=>!!document.querySelector('[data-crystallize]'));
 assert.match(await page.$eval('[data-crystallize] title',e=>e.textContent),/Grid 2 × 2/);await shiftA();state=await readLayout(page);
 assert.equal(distinct(state.elements.map(e=>e.x)),2);assert.equal(distinct(state.elements.map(e=>e.y)),2);assert.equal(state.elements[3].x,state.elements[0].x,`${mode}: the fourth stays under the first`);
 // The tool surface owns its own visit: no offer, and Shift+A is not a tool key.
 await seedLayout(page,loose);await select(0,9);await waitFor(page,()=>!!document.querySelector('[data-crystallize]'));
 await page.keyboard.press('KeyA');await waitFor(page,()=>!!document.querySelector('.align-arrange-panel.placed'));
 assert.equal(await page.$('[data-crystallize]'),null,`${mode}: no offer while Align & Arrange is open`);await shiftA();
 assert.deepEqual((await readLayout(page)).elements,before.elements,`${mode}: Shift+A does nothing inside the tool`);await page.keyboard.press('Escape');
 await waitFor(page,()=>!!document.querySelector('[data-crystallize]'),null,{label:`${mode}: closing the tool brings the offer back`});
 // A drag of the selection is never caught by the offer, which hides for the gesture.
 const grab=await rectOf('[data-editor-element-id="layout-4"]');
 await page.mouse.move(grab.cx,grab.cy);await page.mouse.down();await page.mouse.move(grab.cx+30,grab.cy+12,{steps:4});await waitForFrame(page);
 assert.equal(await page.$('[data-crystallize]'),null,`${mode}: the offer is hidden during a drag`);
 await page.mouse.up();await waitFor(page,()=>!!document.querySelector('[data-crystallize]'),null,{label:`${mode}: and returns at the moved corner`});
 state=await readLayout(page);assert.ok(Math.abs(state.elements[4].x-before.elements[4].x-30)<1.01,`${mode}: the drag moved the selection`);
 const moved=await rectOf('[data-crystallize]'),movedBox=await rectOf('.canvas-host .sel-box');assert.ok(moved.x>=movedBox.right&&moved.y>=movedBox.bottom,`${mode}: the offer follows the selection`);
 // A corner panned off the canvas keeps the offer reachable inside it.
 await page.evaluate(()=>window.__flux.fig.viewport.set({panX:-140,panY:-260,zoom:3}));await waitForFrame(page);
 const host=await rectOf('.canvas-host'),clamped=await rectOf('[data-crystallize]');
 assert.ok(clamped.x>=host.x&&clamped.right<=host.right+.5&&clamped.y>=host.y&&clamped.bottom<=host.bottom+.5,`${mode}: an off-screen corner clamps the offer into the canvas`);
 await page.evaluate(()=>window.__flux.fig.viewport.set({panX:40,panY:50,zoom:1}));await waitForFrame(page);
}
try{
 await layoutFixture(page);
 await scenario('Figure');
 // Typing wins: Shift+A in a field is a capital A.
 await seedLayout(page,loose);await select(0,9);await waitForFrame(page);const typedBefore=await readLayout(page);
 const field=await page.$('.inspector input:not([type="checkbox"]):not([type="color"])');assert.ok(field,'an Inspector field to type in');
 await field.focus();await shiftA();assert.deepEqual((await readLayout(page)).elements,typedBefore.elements,'Shift+A in an input never crystallizes');
 await page.keyboard.press('Escape');await page.evaluate(()=>document.activeElement?.blur());
 // Piles and single objects are refused quietly, with a reason.
 await seedLayout(page,[box(100,100,'#d95f02'),box(110,106,'#d95f02')]);await waitForFrame(page);assert.equal(await page.$('[data-crystallize]'),null,'a pile gets no offer');
 await shiftA();assert.equal((await readLayout(page)).history.past,0);
 await waitFor(page,()=>/on top of each other/.test(document.body.textContent),null,{label:'a refusal says why'});
 await clickMode(page,'Slide');await scenario('Slide');
 assert.deepEqual(realErrors(page),[]);
 console.log('PASS Crystallize: offer, preview, click, Shift+A, Undo, notice, passive guides, refusals, Figure and Slide');
}finally{await browser.close();}
