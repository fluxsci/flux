// Crystallize on the real canvas (Figure and Slide): the corner offer beside a loose selection,
// its hover preview, the click, Shift+A, one Undo, the notice, and the passive pink guides that
// take over afterwards. Fluxplots line up on their AXES (measured on the rendered spines), with
// Alt for bounding boxes. The planner itself is pinned by verify-crystallize.ts (pure).
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
// Three real fluxplots of different sizes, hand-placed in a loose row.
const boxplot={svg:fs.readFileSync(new URL('./fixtures/plots/mpl_boxplot_FLUXPLOT.svg',import.meta.url),'utf8'),manifest:JSON.parse(fs.readFileSync(new URL('./fixtures/plots/mpl_boxplot_FLUXPLOT.fluxplot.json',import.meta.url),'utf8'))};
const plotRow=[{id:'axes-a',x:40,y:70,width:240,height:144},{id:'axes-b',x:310,y:104,width:300,height:180},{id:'axes-c',x:650,y:52,width:200,height:120}];
async function seedPlots(){
 await page.evaluate(async({boxplot,plotRow})=>{
  const F=window.__flux,s=F.fig;F.layout.closeAlignArrange(true);F.layout.setArrangementAnchor(.5,.5);
  const root=F.get(F.shell.currentProject).path;await window.fig.mkdir(root+'/fig/assets');
  await window.fig.writeText(root+'/fig/assets/axes-box.svg',boxplot.svg);await window.fig.writeText(root+'/fig/assets/axes-box.fluxplot.json',JSON.stringify(boxplot.manifest));
  F.plot.cachePlot('axes-box',boxplot.svg,boxplot.manifest);
  s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId));f.x=0;f.y=0;f.width=1000;f.height=700;
   if(!p.assets.some(a=>a.id==='axes-box'))p.assets.push({id:'axes-box',name:'box',kind:'svg',path:'assets/axes-box.svg',naturalWidth:240,naturalHeight:144});
   f.elements=plotRow.map((e,i)=>({name:`Plot ${i+1}`,type:'plot',assetId:'axes-box',rotation:0,...e}));});
  s.selection.set(new Set(plotRow.map(e=>e.id)));s.viewport.set({panX:40,panY:50,zoom:1});s.resetHistory();s.dirty.set(false);document.activeElement?.blur();
 },{boxplot,plotRow});
 await waitFor(page,()=>['axes-a','axes-b','axes-c'].every(id=>!!document.getElementById(`${id}__axis.x.spine`)),null,{label:'three plots mounted inline'});await waitForFrame(page);
}
/** Screen position of a plot's rendered spine: y of the bottom X spine, x of the left Y spine. */
const spines=axis=>page.evaluate(axis=>['axes-a','axes-b','axes-c'].map(id=>{
 const part=document.getElementById(`${id}__axis.${axis}.spine`),path=part?.matches('path')?part:part?.querySelector('path');if(!path)throw new Error(`Missing rendered ${axis} spine of ${id}`);
 const m=path.getScreenCTM(),p=path.getPointAtLength(0);return axis==='x'?m.b*p.x+m.d*p.y+m.f:m.a*p.x+m.c*p.y+m.e;}),axis);
const spreadOf=values=>Math.max(...values)-Math.min(...values);
const previewRects=()=>page.$$eval('.crystal-preview rect',n=>n.map(r=>[Number(r.getAttribute('x')),Number(r.getAttribute('y'))]));
async function plotScenario(){
 await seedPlots();await waitFor(page,()=>!!document.querySelector('[data-crystallize][data-crystallize-on="axes"]'),null,{label:'plots: the offer is on axes'});
 const before=await readLayout(page);assert.ok(spreadOf(await spines('x'))>20,'plots: the hand-placed X axes are nowhere near one line');
 const title=await page.$eval('[data-crystallize] title',e=>e.textContent);
 assert.match(title,/Crystallize · Row of 3 · on axes \(Shift\+A\)/,'plots: the offer says it is on axes');assert.match(title,/Alt-click: bounding boxes instead \(Shift\+Alt\+A\)/,'plots: and how to get boxes');
 // Hover: three places, two gutters, and the ONE line the X axes will share.
 const offer=await rectOf('[data-crystallize]');await page.mouse.move(offer.cx,offer.cy);
 await waitFor(page,()=>document.querySelectorAll('.crystal-preview rect').length===3&&document.querySelectorAll('.crystal-rails line').length===1,null,{label:'plots: hover previews places and the shared axis line'});
 const rail=await page.$eval('.crystal-rails line',l=>({y1:Number(l.getAttribute('y1')),y2:Number(l.getAttribute('y2')),x1:Number(l.getAttribute('x1')),x2:Number(l.getAttribute('x2'))}));
 assert.equal(rail.y1,rail.y2,'plots: the rail is horizontal');assert.ok(rail.x2-rail.x1>700,'plots: and runs along the whole row');
 const onAxes=await previewRects();await shot(page,'flux-crystallize-axes-preview');
 // Alt, while hovering, previews the bounding-box arrangement instead; releasing it returns.
 await page.keyboard.down('Alt');await waitFor(page,()=>document.querySelector('[data-crystallize]')?.getAttribute('data-crystallize-on')==='boxes'&&!document.querySelector('.crystal-rails line'),null,{label:'plots: Alt previews boxes'});
 const onBoxes=await previewRects();assert.equal(onBoxes.length,3);assert.ok(onBoxes.some((r,i)=>Math.abs(r[1]-onAxes[i][1])>2),'plots: the box preview is a different arrangement');
 await page.keyboard.up('Alt');await waitFor(page,()=>document.querySelectorAll('.crystal-rails line').length===1,null,{label:'plots: releasing Alt returns to axes'});
 assert.deepEqual((await readLayout(page)).elements,before.elements,'plots: previews move nothing');
 // Click: the rendered X axes land on one line, and the pink guides take over.
 await page.mouse.click(offer.cx,offer.cy);await waitFor(page,()=>!!document.querySelector('[data-crystallize-notice]'),null,{label:'plots: notice'});await waitForFrame(page);
 assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Row of 3 · on axes');
 const lined=await spines('x');assert.ok(spreadOf(lined)<.05,`plots: three rendered X axes share one line (${lined})`);
 let state=await readLayout(page);assert.equal(state.history.past,1,'plots: one Undo step');
 const bottoms=state.elements.map(e=>e.y+e.height);assert.ok(spreadOf(bottoms)>5,'plots: which their boxes do not');
 const gaps=[state.elements[1].x-state.elements[0].x-240,state.elements[2].x-state.elements[1].x-300];assert.ok(Math.abs(gaps[0]-gaps[1])<1e-6,'plots: even gaps between the boxes');
 assert.equal(await page.$$eval('[data-arrange-gap]',n=>n.length),2,'plots: the pink guides appear for an on-axes row');assert.equal(await page.$('[data-crystallize]'),null,'plots: the offer is spent');
 await shot(page,'flux-crystallize-axes-done');const axesModel=state.elements;
 await shiftA();assert.equal((await readLayout(page)).history.past,1,'plots: Shift+A again changes nothing');
 // Shift+Alt+A on the hand-placed row: bounding boxes instead, the guides all the same.
 await undo();assert.deepEqual((await readLayout(page)).elements,before.elements,'plots: Undo restores the hand-placed row');
 await page.keyboard.down('Shift');await page.keyboard.down('Alt');await page.keyboard.press('KeyA');await page.keyboard.up('Alt');await page.keyboard.up('Shift');await waitForFrame(page);
 state=await readLayout(page);assert.equal(state.history.past,1,'plots: Shift+Alt+A is one step');assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Row of 3');
 assert.ok(spreadOf(await spines('x'))>2,'plots: boxes leave the axes off one line');const boxModel=state.elements;
 const edges=[0,.5,1].map(f=>spreadOf(boxModel.map(e=>e.y+f*e.height)));assert.ok(Math.min(...edges)<1e-6,'plots: and the boxes share an edge or center');
 assert.equal(await page.$$eval('[data-arrange-gap]',n=>n.length),2,'plots: the pink guides appear for the box row too');
 assert.equal(await page.$('[data-crystallize]'),null,'plots: a deliberate box row is not offered its axes straight back');
 // Alt-click on the offer is the same bounding-box arrangement as the key.
 await undo();await waitFor(page,()=>!!document.querySelector('[data-crystallize]'),null,{label:'plots: the offer returns after Undo'});const again=await rectOf('[data-crystallize]');
 await page.mouse.move(again.cx,again.cy);await page.keyboard.down('Alt');await page.mouse.click(again.cx,again.cy);await page.keyboard.up('Alt');await waitForFrame(page);
 state=await readLayout(page);assert.deepEqual(state.elements,boxModel,'plots: Alt-click applies the box arrangement');assert.equal(state.history.past,1);
 await shiftA();state=await readLayout(page);assert.equal(state.history.past,2,'plots: Shift+A on a box row is still a decision');assert.ok(spreadOf(await spines('x'))<.05,'plots: and puts the axes back on one line');
 // A column shares its Y axes.
 await page.evaluate(()=>{const F=window.__flux,s=F.fig;s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId));[[60,40],[95,220],[48,440]].forEach(([x,y],i)=>{f.elements[i].x=x;f.elements[i].y=y;});});});await waitForFrame(page);
 assert.ok(spreadOf(await spines('y'))>10);await shiftA();assert.equal(await page.$eval('[data-crystallize-notice] text',e=>e.textContent),'Column of 3 · on axes');
 assert.ok(spreadOf(await spines('y'))<.05,'plots: a column\'s rendered Y axes share one line');assert.equal(await page.$$eval('[data-arrange-gap]',n=>n.length),2);
}
try{
 await layoutFixture(page);
 await scenario('Figure');
 await plotScenario();
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
 console.log('PASS Crystallize: offer, preview, click, Shift+A, Undo, notice, passive guides, refusals, plots on axes (Alt: boxes), Figure and Slide');
}finally{await browser.close();}
