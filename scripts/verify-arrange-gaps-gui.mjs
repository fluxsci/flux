import assert from 'node:assert/strict';
import {launch,waitForFrame,realErrors,shot} from './lib/driver.mjs';
import {layoutFixture,seedLayout,readLayout,openArrange} from './lib/alignArrangeFixture.mjs';
const {browser,page}=await launch({width:1500,height:950});
async function point(axis='x'){
 return page.evaluate(axis=>{
  const lines=[...document.querySelectorAll(`[data-arrange-gap="${axis}"]`)];
  for(const node of lines){const b=node.getBoundingClientRect();for(const t of [.25,.75,.5]){const x=b.x+b.width*t,y=b.y+b.height*t;if(document.elementFromPoint(x,y)===node)return{x,y};}}
  throw new Error('No real hittable gap '+axis);
 },axis);
}
const nearly=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} ≈ ${b}`);
try{
 await layoutFixture(page);const initial=(await readLayout(page)).elements;
 // Exact selections expose passive guides without opening a panel or writing
 // document/history. Their projection follows camera changes independently.
 assert.equal(await page.$('.align-arrange-panel'),null);
 assert.ok(await page.$('[data-arrange-gap="x"]'));
 assert.equal((await readLayout(page)).history.past,0);assert.equal((await readLayout(page)).dirty,false);
 async function projected(){return page.evaluate(()=>{const F=window.__flux,v=F.get(F.fig.viewport),plan=F.get(F.layout.arrangementLayout)??F.get(F.layout.passiveArrangement),g=plan.gaps.find(g=>g.axis==='x'),n=document.querySelector('[data-arrange-gap="x"]'),pin=document.querySelector('.gap-guides .pin'),f=F.get(F.fig.project).figures.find(f=>f.id===plan.figureId);return {actual:+n.getAttribute('x1'),expected:v.panX+(f.x+g.x1)*v.zoom,pin:+pin.getAttribute('cx'),expectedPin:v.panX+(f.x+plan.bounds.x+plan.bounds.w/2)*v.zoom};});}
 for(const v of [{panX:65,panY:80,zoom:1},{panX:100,panY:50,zoom:.5},{panX:10,panY:20,zoom:1.5}]){await page.evaluate(v=>window.__flux.fig.viewport.set(v),v);await waitForFrame(page);const pos=await projected();nearly(pos.actual,pos.expected);nearly(pos.pin,pos.expectedPin);}
 assert.deepEqual((await readLayout(page)).elements,initial);
 // The passive pin exposes a preference, not a document edit or tool visit.
 const savedAnchor=()=>page.evaluate(()=>window.__flux.get(window.__flux.layout.arrangementAnchor));
 await seedLayout(page);await page.click('[data-arrangement-anchor-toggle]');await page.click('.anchor-popover .anchor-choice[aria-label="Right"]');await waitForFrame(page);
 await page.keyboard.press('ArrowLeft');assert.deepEqual(await savedAnchor(),{x:.5,y:.5});await page.keyboard.press('Space');assert.equal((await readLayout(page)).state,null,'native radio activation does not open a tool');await page.keyboard.press('ArrowRight');
 assert.deepEqual(await savedAnchor(),{x:1,y:.5});assert.equal((await readLayout(page)).state,null);assert.equal(await page.$('.align-arrange-panel'),null);assert.deepEqual((await readLayout(page)).elements,initial);assert.equal((await readLayout(page)).history.past,0);assert.equal((await readLayout(page)).dirty,false);
 await shot(page,'flux-passive-anchor-picker');await page.keyboard.press('Escape');assert.equal(await page.$('.anchor-popover'),null,'Escape closes only the passive chooser');
 const rightPin=await page.evaluate(()=>{const F=window.__flux,v=F.get(F.fig.viewport),n=document.querySelector('.gap-guides .pin');return{actual:+n.getAttribute('cx'),expected:v.panX+290*v.zoom};});nearly(rightPin.actual,rightPin.expected);
 let preferencePoint=await point();await page.mouse.move(preferencePoint.x,preferencePoint.y);await page.mouse.down();await page.mouse.move(preferencePoint.x+8,preferencePoint.y);await page.mouse.up();await waitForFrame(page);
 assert.equal((await readLayout(page)).state,null);assert.deepEqual(await savedAnchor(),{x:1,y:.5},'passive drag release retains the chosen pin');nearly((await readLayout(page)).elements[2].x+60,290);
 await page.click('[data-arrangement-anchor-toggle]');await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');assert.deepEqual((await readLayout(page)).elements,initial);assert.deepEqual(await savedAnchor(),{x:1,y:.5},'document undo leaves anchor preference intact');
 await openArrange(page);assert.deepEqual((await readLayout(page)).state.anchor,{x:1,y:.5},'reopened Arrange uses the persistent pin');preferencePoint=await point();await page.mouse.move(preferencePoint.x,preferencePoint.y);await page.mouse.down();await page.mouse.move(preferencePoint.x+10,preferencePoint.y);await page.keyboard.press('Digit1');await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual((await readLayout(page)).state.anchor,{x:0,y:.5},'inner cancellation preserves the newly chosen anchor');await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial);await openArrange(page);assert.deepEqual((await readLayout(page)).state.anchor,{x:0,y:.5},'visit cancellation and reopen preserve anchor');await page.keyboard.press('Escape');
 // The same no-menu chooser supports column ends and grid corners.
 for(const [items,label,expected] of [
  [[{x:50,y:60,width:60,height:40},{x:50,y:130,width:60,height:40},{x:50,y:200,width:60,height:40}],'Bottom',{x:.5,y:1}],
  [[{x:50,y:60,width:60,height:40},{x:140,y:60,width:60,height:40},{x:50,y:130,width:60,height:40},{x:140,y:130,width:60,height:40}],'Bottom right',{x:1,y:1}]
 ]){
  await seedLayout(page,items);const before=await readLayout(page);await page.click('[data-arrangement-anchor-toggle]');await page.click(`.anchor-popover .anchor-choice[aria-label="${label}"]`);assert.deepEqual(await savedAnchor(),expected);assert.equal((await readLayout(page)).state,null);assert.deepEqual((await readLayout(page)).elements,before.elements);assert.equal((await readLayout(page)).history.past,0);
  const q=await point('y');await page.mouse.move(q.x,q.y);await page.mouse.down();await page.mouse.move(q.x,q.y+10);await page.mouse.up();const after=await readLayout(page);nearly(Math.max(...after.elements.map(e=>e.y+e.height)),Math.max(...before.elements.map(e=>e.y+e.height)));assert.equal(after.state,null);assert.deepEqual(await savedAnchor(),expected);
 }
 // Passive chrome follows pan but disappears while ordinary geometry is a
 // transient preview; cancellation restores guides at unchanged model bounds.
 for(const selector of ['[data-editor-element-id="layout-0"] rect','.zone.corner[data-h="se"]','.zone.rotate[data-zone="se"]']){
  await seedLayout(page);const target=await page.$eval(selector,n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(target.x,target.y);await page.mouse.down();await page.mouse.move(target.x+18,target.y+13);await waitForFrame(page);assert.equal(await page.$('[data-arrange-gap]'),null,'passive guides hidden during '+selector);await page.keyboard.press('Escape');await page.mouse.up();await waitForFrame(page);assert.ok(await page.$('[data-arrange-gap]'),'passive guides restored after '+selector);assert.deepEqual((await readLayout(page)).elements,initial);
 }
 await seedLayout(page);const panStart=await point();await page.mouse.move(panStart.x,panStart.y);await page.mouse.down({button:'middle'});await page.mouse.move(panStart.x+30,panStart.y+20);await waitForFrame(page);assert.ok(await page.$('[data-arrange-gap]'),'passive guides stay live during pan');let panProjected=await projected();nearly(panProjected.actual,panProjected.expected);await page.mouse.up({button:'middle'});
 await page.evaluate(()=>window.__flux.fig.viewport.set({panX:-10000,panY:0,zoom:1}));await waitForFrame(page);assert.equal(await page.$('[data-arrange-gap]'),null,'passive offscreen guides culled');
 await seedLayout(page);let passivePoint=await point();await page.mouse.move(passivePoint.x,passivePoint.y);await page.mouse.down();await page.mouse.move(passivePoint.x+10,passivePoint.y);await waitForFrame(page);
 assert.equal((await readLayout(page)).state.panelVisible,false);assert.equal(await page.$('.align-arrange-panel'),null);assert.deepEqual((await readLayout(page)).elements,initial);
 const previewPositions=()=>page.evaluate(()=>window.__flux.get(window.__flux.layout.arrangementPreview)?.plan.positions);
 const beforeHold=await previewPositions();await page.keyboard.down('Digit1');assert.deepEqual(await previewPositions(),beforeHold,'anchor press does not move geometry');assert.deepEqual((await readLayout(page)).state.anchor,{x:0,y:.5});
 await page.mouse.move(passivePoint.x+20,passivePoint.y);let held=await previewPositions();nearly(held[0].x,beforeHold[0].x);nearly(held[2].x-beforeHold[2].x,20);
 await page.keyboard.up('Digit1');assert.deepEqual(await previewPositions(),held,'anchor release does not move geometry');assert.deepEqual((await readLayout(page)).state.anchor,{x:0,y:.5},'keyup does not reset the pin');await page.keyboard.press('Digit2');assert.deepEqual(await previewPositions(),held);assert.deepEqual((await readLayout(page)).state.anchor,{x:.5,y:.5});
 await page.mouse.move(passivePoint.x+30,passivePoint.y);const centered=await previewPositions();nearly(centered[0].x,held[0].x-10);nearly(centered[2].x,held[2].x+10);
 await page.mouse.up();await waitForFrame(page);assert.equal((await readLayout(page)).state,null);assert.equal((await readLayout(page)).history.past,1);assert.ok(await page.$('[data-arrange-gap]'),'released gesture returns passive');
 await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');assert.deepEqual((await readLayout(page)).elements,initial,'passive drag is one undo');
 // A cancelled passive gesture never publishes positions or creates history.
 await seedLayout(page);passivePoint=await point();await page.mouse.move(passivePoint.x,passivePoint.y);await page.mouse.down();await page.mouse.move(passivePoint.x-40,passivePoint.y);nearly((await readLayout(page)).state.gapX,-10);await page.keyboard.press('Escape');await page.mouse.up();await waitForFrame(page);assert.equal((await readLayout(page)).state,null);assert.deepEqual((await readLayout(page)).elements,initial);assert.equal((await readLayout(page)).history.past,0);
 // Regular overlap recognizes signed gaps; irregular selection remains silent.
 await seedLayout(page,[{x:50,y:100,width:60,height:40},{x:100,y:100,width:60,height:40},{x:150,y:100,width:60,height:40}]);assert.ok(await page.$('[data-arrange-gap]'));nearly(await page.evaluate(()=>window.__flux.get(window.__flux.layout.passiveArrangement).gapX),-10);
 await seedLayout(page,[{x:50,y:100,width:60,height:40},{x:130,y:100,width:60,height:40},{x:250,y:100,width:60,height:40}]);assert.equal(await page.$('[data-arrange-gap]'),null);assert.equal((await readLayout(page)).history.past,0);
 // Untouched numeric acceptance preserves exact coordinates even when the
 // recognized regular gaps differ below the layout tolerance.
 await seedLayout(page,[{x:50,y:100,width:60,height:40},{x:140,y:100,width:60,height:40},{x:230.0000001,y:100,width:60,height:40}]);const epsilonStart=await readLayout(page);await openArrange(page);await page.click('.align-arrange-panel .nf input');await page.keyboard.press('Enter');const epsilonEnd=await readLayout(page);assert.deepEqual(epsilonEnd.elements,epsilonStart.elements,'untouched spacing never normalizes tiny gap differences');assert.equal(epsilonEnd.history.past,0);await page.keyboard.press('Escape');
 // Explicit Arrange guides track the same viewport while its plan is frozen.
 await seedLayout(page);await openArrange(page);await page.evaluate(()=>window.__flux.fig.viewport.set({panX:70,panY:60,zoom:.75}));await waitForFrame(page);const activeProjection=await projected();nearly(activeProjection.actual,activeProjection.expected);nearly(activeProjection.pin,activeProjection.expectedPin);await page.keyboard.press('Escape');

 for(const zoom of [.5,1,2])for(const anchor of ['Left','Center','Right']){
  await seedLayout(page);await page.evaluate(z=>window.__flux.fig.viewport.set({panX:20,panY:40,zoom:z}),zoom);await openArrange(page);
  await page.click(`.anchor-choice[aria-label="${anchor}"]`);await waitForFrame(page);const start=await readLayout(page),p=await point();
  await page.evaluate(()=>{window.__layoutWrites=0;window.__layoutStop=window.__flux.fig.project.subscribe(()=>window.__layoutWrites++);window.__layoutWrites=0;window.__layoutNode=document.querySelector('[data-editor-element-id="layout-0"]');});
  await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+20*zoom,p.y,{steps:5});await waitForFrame(page);
  let mid=await readLayout(page);assert.equal(mid.state.mode,'arrange');assert.equal(mid.preview,true);assert.deepEqual(mid.elements,start.elements,'drag leaves model untouched');nearly(mid.state.gapX,50);
  assert.equal(await page.evaluate(()=>window.__layoutWrites),0,'zero per-move model publications');assert.equal(await page.evaluate(()=>document.querySelector('[data-editor-element-id="layout-0"]')===window.__layoutNode),true,'scene wrapper retained');
  await page.mouse.up();await waitForFrame(page);const after=await readLayout(page);assert.equal(after.preview,false);assert.equal(after.history.past,1);assert.equal(await page.evaluate(()=>window.__layoutWrites),1,'one release publication');await page.evaluate(()=>window.__layoutStop());
  const ax=anchor==='Left'?0:anchor==='Center'?.5:1;
  nearly(after.elements[0].x+(after.elements[2].x+60-after.elements[0].x)*ax,50+240*ax);
  assert.deepEqual(after.elements.map(e=>e.y),initial.map(e=>e.y),'transverse positions preserved');
  await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial,'visit cancellation exact');assert.equal((await readLayout(page)).history.past,0);
 }
 // Inner cancellation preserves an earlier accepted gap; next Escape cancels visit.
 await seedLayout(page);await openArrange(page);let p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+15,p.y);await page.mouse.up();const prior=(await readLayout(page)).elements;
 p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+50,p.y);await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual((await readLayout(page)).elements,prior);assert.equal((await readLayout(page)).state.mode,'arrange');await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial);
 // Modifier transitions rebase at the last pointer position; first movement
 // after each key transition counts, without jumping or losing a delta.
 await seedLayout(page);await openArrange(page);p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+5,p.y);nearly((await readLayout(page)).state.gapX,35);
 await page.keyboard.down('Shift');await page.mouse.move(p.x+7,p.y);nearly((await readLayout(page)).state.gapX,55);
 await page.keyboard.up('Shift');await page.mouse.move(p.x+10,p.y);nearly((await readLayout(page)).state.gapX,58);
 await page.keyboard.down('Alt');await page.mouse.move(p.x+20,p.y);nearly((await readLayout(page)).state.gapX,59);
 await page.keyboard.up('Alt');await page.mouse.move(p.x+21,p.y);nearly((await readLayout(page)).state.gapX,60);
 assert.deepEqual((await readLayout(page)).elements,initial);await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.press('Escape');
 // Capture stays on the persistent overlay even if the original track is
 // culled. Cancellation routes restore just this drag's starting gap.
 for(const route of ['pointercancel','lostcapture','blur']){
  await seedLayout(page);await openArrange(page);p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+10,p.y);await page.mouse.up();
  const settled=await readLayout(page);p=await point();
  await page.evaluate(()=>{document.querySelector('.gap-guides').addEventListener('pointerdown',e=>window.__gapPointer=e.pointerId,{once:true,capture:true});});
  await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+25,p.y);
  assert.equal((await readLayout(page)).preview,true);
  await page.evaluate(route=>{const n=document.querySelector('.gap-guides'),id=window.__gapPointer;
   if(route==='pointercancel')n.dispatchEvent(new PointerEvent('pointercancel',{pointerId:id,bubbles:true}));
   else if(route==='lostcapture')n.releasePointerCapture(id);
   else window.dispatchEvent(new Event('blur'));
  },route);
  // Releasing capture delivers lostpointercapture before the next event.
  await page.mouse.move(p.x+26,p.y);await waitForFrame(page);
  const cancelled=await readLayout(page);assert.equal(cancelled.state.dragging,false,route);assert.equal(cancelled.preview,false,route);assert.deepEqual(cancelled.elements,settled.elements,route);nearly(cancelled.state.gapX,40);
  await page.mouse.up();await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial);
 }
 // The first center-anchored gutter leaves the viewport as spacing grows;
 // stable-owner capture continues and permits reversing back into the canvas.
 await seedLayout(page);await openArrange(page);p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+1000,p.y);await waitForFrame(page);
 nearly((await readLayout(page)).state.gapX,1030);assert.equal(await page.$('[data-arrange-gap="x"][data-gap-index="0"]'),null,'offscreen gutter is culled');
 await page.mouse.move(p.x+10,p.y);await page.mouse.up();nearly((await readLayout(page)).state.gapX,40);assert.equal((await readLayout(page)).history.past,1);await page.keyboard.press('Escape');
 // During a scrub navigation is frozen, including surface Space and wheel.
 await seedLayout(page);await openArrange(page);p=await point();const viewport=await page.evaluate(()=>window.__flux.get(window.__flux.fig.viewport));
 await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+10,p.y);await page.keyboard.press('Space');await page.mouse.wheel({deltaY:80});await waitForFrame(page);
 assert.equal((await readLayout(page)).state.mode,'arrange');assert.deepEqual(await page.evaluate(()=>window.__flux.get(window.__flux.fig.viewport)),viewport);await page.mouse.up();await page.keyboard.press('Escape');
 // Gap capture takes focus from a native control. Otherwise Space could
 // activate its old focused button, or edit a still-focused numeric draft.
 for(const focused of ['.anchor-choice[aria-label="Right"]','.align-arrange-panel .nf input']){
  await seedLayout(page);await openArrange(page);await page.focus(focused);p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+10,p.y);await page.keyboard.press('Space');
  const held=await readLayout(page);assert.equal(held.state.dragging,true,'Space cannot activate previously focused control');assert.equal(held.state.anchor.x,.5);assert.deepEqual(held.elements,initial);assert.equal(await page.$eval('.align-arrange-panel',n=>n===document.activeElement),true,'scrub owns panel focus');await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.press('Escape');
 }
 // Native button Space activates that button, not the panel shortcut. Radio
 // arrows change anchors; a surface Space switches exactly one view.
 await seedLayout(page);await openArrange(page);await page.focus('.anchor-choice[aria-label="Center"]');await page.keyboard.press('ArrowRight');assert.equal((await readLayout(page)).state.anchor.x,1);
 await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'arrange');assert.equal((await readLayout(page)).state.anchor.x,1);
 await page.focus('.align-arrange-panel');await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'align');
 const buttonBaseline=await readLayout(page);await page.focus('[aria-label="Align top"]');await page.keyboard.press('ArrowRight');assert.deepEqual((await readLayout(page)).elements,buttonBaseline.elements,'focused action button arrow never nudges canvas');assert.equal((await readLayout(page)).state.mode,'align');assert.equal((await readLayout(page)).history.past,buttonBaseline.history.past);
 await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'align','native Space activates alignment button');assert.ok((await readLayout(page)).elements.every(e=>e.y===90));
 await page.focus('.align-arrange-panel');await page.keyboard.press('Space');assert.equal((await readLayout(page)).state.mode,'arrange');
 await seedLayout(page);await openArrange(page);
 // A canvas clickaway commits the pending visit and consumes the pointerdown,
 // so dragging that same click cannot move selected objects.
 p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+10,p.y);await page.mouse.up();const committed=(await readLayout(page)).elements;
 const canvasPoint=await page.evaluate(()=>{const n=document.querySelector('[data-editor-element-id="layout-0"]'),b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});
 await page.mouse.move(canvasPoint.x,canvasPoint.y);await page.mouse.down();await page.mouse.move(canvasPoint.x+35,canvasPoint.y+25);await page.mouse.up();assert.equal((await readLayout(page)).state,null);assert.deepEqual((await readLayout(page)).elements,committed);assert.equal((await readLayout(page)).history.past,1);
 // A zero gap still has a real screen-sized hit band. Fractional scrubs do not round.
 await seedLayout(page,[{x:50,y:100,width:60,height:60},{x:110,y:100,width:60,height:60}]);await openArrange(page);p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+.25,p.y);await page.mouse.up();nearly((await readLayout(page)).state.gapX,.25);await page.keyboard.press('Escape');
 // Field previews are transient, inner Escape and invalid drafts never apply stale values.
 await seedLayout(page);await openArrange(page);await page.click('.align-arrange-panel .nf input',{count:3});await page.keyboard.type('12.5');let field=await readLayout(page);assert.deepEqual(field.elements,initial);nearly(field.state.gapX,12.5);assert.equal(field.history.past,0);
 await page.keyboard.press('Escape');assert.equal((await readLayout(page)).state.gapX,30);assert.deepEqual((await readLayout(page)).elements,initial);
 await page.click('.align-arrange-panel .nf input',{count:3});await page.keyboard.type('42');await page.keyboard.press('Enter');assert.equal((await readLayout(page)).history.past,1);const accepted=(await readLayout(page)).elements;
 await page.click('.align-arrange-panel .nf input',{count:3});await page.keyboard.type('99+');await page.keyboard.press('Enter');assert.equal(await page.$eval('.align-arrange-panel .nf input',n=>n.getAttribute('aria-invalid')),'true');await page.click('.align-arrange-panel header');assert.deepEqual((await readLayout(page)).elements,accepted,'invalid draft cancels stale valid preview');await page.keyboard.press('Escape');assert.deepEqual((await readLayout(page)).elements,initial);
 // Grid fields share a controller owner. Hover-wheel can hand ownership to
 // Y while X retains focus; later X typing must reacquire a transient edit.
 const crossGrid=[{x:50,y:60,width:60,height:40},{x:140,y:60,width:60,height:40},{x:50,y:130,width:60,height:40},{x:140,y:130,width:60,height:40}];
 const fieldX='.gap-fields > div:first-child input',fieldY='.gap-fields > div:nth-child(2) input';
 // Numeric shortcuts change only the edited grid axis and remain selected.
 await seedLayout(page,crossGrid);await openArrange(page);await page.click('.anchor-choice[aria-label="Bottom right"]');p=await point('y');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x,p.y+8);
 const previewBounds=()=>page.evaluate(()=>window.__flux.get(window.__flux.layout.arrangementPreview)?.plan.bounds);
 const preW=await previewBounds();await page.keyboard.down('Digit1');assert.deepEqual((await readLayout(page)).state.anchor,{x:1,y:0});assert.deepEqual(await previewBounds(),preW);
 await page.mouse.move(p.x,p.y+16);const topHeld=await previewBounds();nearly(topHeld.y,preW.y);await page.keyboard.up('Digit1');assert.deepEqual((await readLayout(page)).state.anchor,{x:1,y:0});assert.deepEqual(await previewBounds(),topHeld);await page.keyboard.press('Digit3');assert.deepEqual((await readLayout(page)).state.anchor,{x:1,y:1});assert.deepEqual(await previewBounds(),topHeld);
 await page.mouse.move(p.x,p.y+24);const bottomHeld=await previewBounds();nearly(bottomHeld.y+bottomHeld.h,topHeld.y+topHeld.h);await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.press('Escape');
 // Numeric hover-wheel and label scrubs use the same persistent pin contract.
 await seedLayout(page,crossGrid);await openArrange(page);const wheelPoint=await page.$eval(fieldX,n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(wheelPoint.x,wheelPoint.y);await page.mouse.wheel({deltaY:-100});const preWheelHold=await previewBounds();
 await page.keyboard.down('Digit1');assert.deepEqual((await readLayout(page)).state.anchor,{x:0,y:.5});await page.mouse.wheel({deltaY:-100});nearly((await previewBounds()).x,preWheelHold.x);await page.keyboard.up('Digit1');assert.deepEqual((await readLayout(page)).state.anchor,{x:0,y:.5});await new Promise(r=>setTimeout(r,250));assert.equal((await readLayout(page)).preview,false);
 const scrubLabel=await page.$eval('.gap-fields > div:first-child .lb',n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(scrubLabel.x,scrubLabel.y);await page.mouse.down();await page.mouse.move(scrubLabel.x+10,scrubLabel.y);const preScrubHold=await previewBounds();await page.keyboard.down('Digit3');assert.equal((await readLayout(page)).state.anchor.x,1);await page.mouse.move(scrubLabel.x+20,scrubLabel.y);const scrubRight=await previewBounds();nearly(scrubRight.x+scrubRight.w,preScrubHold.x+preScrubHold.w);await page.keyboard.up('Digit3');assert.equal((await readLayout(page)).state.anchor.x,1);await page.mouse.up();await page.keyboard.press('Escape');
 await seedLayout(page,crossGrid);await openArrange(page);await page.click(fieldX,{count:3});await page.keyboard.type('123wasd');assert.equal(await page.$eval(fieldX,n=>n.value),'123wasd');assert.deepEqual((await readLayout(page)).state.anchor,{x:.5,y:.5});assert.equal((await readLayout(page)).state.topology,'grid','typed digits and WASD never invoke layout commands');await page.keyboard.press('Escape');await page.keyboard.press('Escape');

 async function crossWheel(){await seedLayout(page,crossGrid);await openArrange(page);await page.click(fieldX,{count:3});await page.keyboard.type('12');const b=await page.$eval(fieldY,n=>{const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});await page.mouse.move(b.x,b.y);await page.mouse.wheel({deltaY:-100});}
 await crossWheel();await new Promise(r=>setTimeout(r,260));await waitForFrame(page);const settledWheel=await readLayout(page);assert.equal(await page.$eval(fieldX,n=>n===document.activeElement),true);
 await page.evaluate(()=>{window.__crossWrites=0;window.__crossStop=window.__flux.fig.project.subscribe(()=>window.__crossWrites++);window.__crossWrites=0;});
 await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type('23');assert.equal(await page.evaluate(()=>window.__crossWrites),0,'reacquired X typing never publishes model');assert.equal((await readLayout(page)).preview,true);assert.deepEqual((await readLayout(page)).elements,settledWheel.elements);await page.evaluate(()=>window.__crossStop());await page.keyboard.press('Escape');nearly((await readLayout(page)).state.gapX,12);await page.keyboard.press('Escape');
 // A stale X blur cannot finish the currently pending Y wheel transaction.
 await crossWheel();const foreign=await page.evaluate(()=>{const F=window.__flux,m=F.layout,s=F.fig,read=()=>({preview:!!F.get(m.arrangementPreview),elements:JSON.stringify(F.get(s.project).figures[0].elements)});const before=read();document.activeElement.blur();return{before,after:read()};});assert.equal(foreign.before.preview,true);assert.deepEqual(foreign.after,foreign.before,'foreign blur leaves Y wheel preview owned');await new Promise(r=>setTimeout(r,260));await page.keyboard.press('Escape');
 // Reacquiring X with an invalid draft must not let Y's delayed wheel timer
 // settle/cancel that X draft or replace its validity.
 await crossWheel();await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type('99+');const invalidCross=await readLayout(page);assert.equal(await page.$eval(fieldX,n=>n.getAttribute('aria-invalid')),'true');await new Promise(r=>setTimeout(r,260));assert.equal((await readLayout(page)).preview,true,'foreign wheel timer cannot settle X');assert.deepEqual((await readLayout(page)).elements,invalidCross.elements);await page.keyboard.press('Enter');assert.equal(await page.$eval(fieldX,n=>n===document.activeElement),true);await page.keyboard.press('Escape');nearly((await readLayout(page)).state.gapX,12);await page.keyboard.press('Escape');
 // A label scrub starts a fresh inner edit after a valid focused draft;
 // cancelling that scrub preserves the accepted draft, and typing can resume.
 await seedLayout(page,crossGrid);await openArrange(page);await page.click(fieldX,{count:3});await page.keyboard.type('12');const labelX=await page.$eval('.gap-fields > div:first-child .lb',n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(labelX.x,labelX.y);await page.mouse.down();await page.mouse.move(labelX.x+10,labelX.y);await page.keyboard.press('Escape');await page.mouse.up();nearly((await readLayout(page)).state.gapX,12);await page.keyboard.press('Escape');
 // The same field's pending wheel timer cannot finish a new label scrub.
 await seedLayout(page,crossGrid);await openArrange(page);const sameWheel=await page.$eval(fieldX,n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(sameWheel.x,sameWheel.y);await page.mouse.wheel({deltaY:-100});const wheelGap=(await readLayout(page)).state.gapX;const sameLabel=await page.$eval('.gap-fields > div:first-child .lb',n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(sameLabel.x,sameLabel.y);await page.mouse.down();await page.mouse.move(sameLabel.x+10,sameLabel.y);await new Promise(r=>setTimeout(r,260));assert.equal((await readLayout(page)).preview,true,'old wheel timer never accepts active label preview');await page.keyboard.press('Escape');await page.mouse.up();nearly((await readLayout(page)).state.gapX,wheelGap);await page.keyboard.press('Escape');
 // A selected source far beyond the cull buffer must mount and receive its
 // transient transform on the same frame that a shrinking gap brings it in.
 await seedLayout(page,Array.from({length:10},(_,i)=>({x:50+i*500,y:100,width:30,height:40})));await openArrange(page);await page.click('.anchor-choice[aria-label="Left"]');await waitForFrame(page);
 assert.equal(await page.$('[data-editor-element-id="layout-9"]'),null,'far selected source is culled while arranging');
 await page.click('.align-arrange-panel .nf input',{count:3});await page.keyboard.type('10');await waitForFrame(page);
 const entrant=await page.evaluate(()=>{const F=window.__flux,v=F.get(F.fig.viewport),host=document.querySelector('.canvas-host').getBoundingClientRect(),n=document.querySelector('[data-editor-element-id="layout-9"]');return {mounted:!!n,left:n?.getBoundingClientRect().left,expected:host.left+v.panX+(50+9*40)*v.zoom};});
 assert.equal(entrant.mounted,true,'destination entrant mounts');nearly(entrant.left,entrant.expected);assert.equal((await readLayout(page)).elements[9].x,4550,'entrant model remains frozen');assert.equal((await readLayout(page)).preview,true);
 await page.keyboard.press('Escape');await waitForFrame(page);assert.equal(await page.$('[data-editor-element-id="layout-9"]'),null,'cancel restores original cull set');await page.keyboard.press('Escape');
 // Grid axis independence and bottom-right anchor with unequal object sizes.
 await seedLayout(page,[{x:50,y:60,width:60,height:40},{x:140,y:60,width:40,height:40},{x:50,y:130,width:60,height:60},{x:140,y:130,width:40,height:60}]);await openArrange(page);await page.click('.anchor-choice[aria-label="Bottom right"]');const grid=await readLayout(page);p=await point('y');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x,p.y+20);await page.mouse.up();const g=await readLayout(page);assert.deepEqual(g.elements.map(e=>e.x),grid.elements.map(e=>e.x));nearly(g.elements[3].y+60,190);await shot(page,'flux-arrange-grid');
 // At overlapping hit bands choose the closest visible track (X is the
 // deterministic tie breaker). Y paints later here, but must not steal X.
 const cross=await page.evaluate(()=>{const x=document.querySelector('[data-arrange-gap="x"]').getBoundingClientRect(),y=document.querySelector('[data-arrange-gap="y"]').getBoundingClientRect();return{x:x.x,y:y.y};});
 for(const delta of [{x:1,y:3},{x:0,y:0}]){const before=await readLayout(page);await page.mouse.move(cross.x+delta.x,cross.y+delta.y);await page.mouse.down();await page.mouse.move(cross.x+delta.x+10,cross.y+delta.y);nearly((await readLayout(page)).state.gapX,before.state.gapX+10);nearly((await readLayout(page)).state.gapY,before.state.gapY);await page.keyboard.press('Escape');await page.mouse.up();}
 await page.keyboard.press('Escape');
 await page.keyboard.press('Escape');
 // The pin sits where people grab a selection (its centre by default): a press on it that MOVES
 // is an ordinary drag of the selection — it never opens the picker or eats the gesture.
 // (three in a row: the centre pin lies on the middle object, not on a gap guide — a press there
 // with no pin would drag the selection, so with the pin it must too)
 await seedLayout(page);const pinBefore=await readLayout(page);
 const pin=await page.$eval('[data-arrangement-anchor-toggle]',n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});
 await page.mouse.move(pin.x,pin.y);await page.mouse.down();await page.mouse.move(pin.x+30,pin.y+20,{steps:6});await page.mouse.up();await waitForFrame(page);
 const pinAfter=await readLayout(page);
 assert.ok(pinAfter.elements.every((e,i)=>Math.abs(e.x-pinBefore.elements[i].x-30)<1.5&&Math.abs(e.y-pinBefore.elements[i].y-20)<1.5),`a drag that starts on the pin moves the whole selection (${JSON.stringify(pinAfter.elements.map(e=>[e.x,e.y]))})`);
 assert.equal(await page.$('.anchor-popover'),null,'…and opens no picker');
 assert.equal(pinAfter.history.past,1,'…as one undoable move');
 await page.click('[data-arrangement-anchor-toggle]');assert.ok(await page.$('.anchor-popover'),'a click on the pin still opens the picker');await page.keyboard.press('Escape');
 assert.deepEqual(realErrors(page),[]);console.log('PASS anchored gap drag at three zooms, modifier rebasing, cancellation routes, focus, clickaway, transient fields, grid independence, and drags that start on the pin');
}finally{await browser.close();}
