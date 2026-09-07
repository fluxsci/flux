import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {launch,gotoApp,clickMode,waitFor,waitForFrame,realErrors} from './lib/driver.mjs';
const {browser,page}=await launch({width:1280,height:900});
const read=()=>page.evaluate(()=>{const F=window.__flux,s=F.fig,p=F.get(s.project),f=p.figures.find(f=>f.id===F.get(s.activeFigureId));return{elements:f.elements,history:s.historyStats(),dirty:F.get(s.dirty),selection:[...F.get(s.selection)]}});
async function select(ids){await page.evaluate(ids=>window.__flux.fig.selection.set(new Set(ids)),ids);await waitForFrame(page);}
async function field(label,action){return page.evaluate(([label,action])=>{const input=[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent.trim()===label)?.querySelector('input');if(!input)throw Error('Missing '+label);if(action==='focus'){input.focus();input.select()}return{value:input.value,disabled:input.matches(':disabled')}} ,[label,action]);}
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});
 for(const mode of ['Figure','Slide']){
  await clickMode(page,mode);await waitFor(page,()=>!!document.querySelector('.canvas-host'));
  await page.evaluate(()=>{const F=window.__flux,s=F.fig;
   s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId));f.elements.push(
    {id:'polish-text',type:'text',text:'Original',x:40,y:60,width:120,height:25,rotation:0,fontSize:16,fontFamily:'Arial',fontWeight:400,fontStyle:'normal',align:'left',color:'#111111',sizing:'fixed'},
    {id:'polish-rect',type:'rect',name:'Polish rectangle',x:200,y:120,width:120,height:100,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0,lockAspect:true});
   });s.resetHistory();s.dirty.set(false);
  });
  await select(['polish-text']);
  const before=await read();
  await page.focus('.inspector textarea');await page.keyboard.type(' first second');
  assert.equal((await read()).history.past,before.history.past+1,mode+': text typing coalesces');
  await page.keyboard.press('Escape');
  assert.equal((await read()).elements.find(e=>e.id==='polish-text').text,'Original');
  assert.equal((await read()).history.past,before.history.past,mode+': text cancel leaves no history');
  await page.focus('.inspector textarea');await page.keyboard.type(' accepted');await page.keyboard.press('Tab');
  assert.equal((await read()).history.past,before.history.past+1);
  await page.evaluate(()=>window.__flux.fig.undo());assert.equal((await read()).elements.find(e=>e.id==='polish-text').text,'Original');
  await select(['polish-rect']);
  await field('W','focus');await page.keyboard.type('240/2');await page.keyboard.press('Enter');
  const noOp=await read();assert.equal(noOp.history.past,0,mode+': unchanged expression is a no-op');
  // Drag through the 1px clamp, then back to 200. Proportions come from the
  // original pointer-down box, never the temporarily clamped secondary axis.
  const point=await page.evaluate(()=>{const n=[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent.trim()==='W').querySelector('.lb'),b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x-200,point.y);await page.mouse.move(point.x+80,point.y);await page.mouse.up();
  const rect=(await read()).elements.find(e=>e.id==='polish-rect');assert.equal(rect.width,200);assert.ok(Math.abs(rect.height-200/1.2)<1e-9,mode+': scrub preserves original aspect through minimum');
  await page.evaluate(()=>window.__flux.fig.undo());
  await select(['polish-text','polish-rect']);
  for (const label of ['Gap','Scale %']) {
   const beforeParameter=await read();
   await field(label,'focus');await page.keyboard.type('70');await page.keyboard.press('Enter');
   assert.deepEqual(await read(),beforeParameter,mode+': local '+label+' typing does not edit or dirty the project');
   const p=await page.evaluate(label=>{const n=[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent.trim()===label).querySelector('.lb');n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}},label);
   await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+20,p.y);await page.keyboard.press('Escape');await page.mouse.up();
   assert.equal((await field(label)).value,'70',mode+': local parameter cancellation restores its value');
   assert.deepEqual(await read(),beforeParameter,mode+': local scrub leaves history, dirty state and content unchanged');
  }
  await select(['polish-rect']);
  const beforeColor=await read();
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('KeyF');
  await waitFor(page,()=>!!document.querySelector('.field .colorbtn'));
  await page.evaluate(()=>[...document.querySelectorAll('.field')].find(n=>n.querySelector('.label')?.textContent.trim()==='fill color').querySelector('button').click());
  await waitFor(page,()=>!!document.querySelector('.cs .exp'));await page.click('.cs .exp');
  await page.click('.cs input.hex',{count:3});await page.keyboard.type('#ff0000');
  assert.equal((await read()).elements.find(e=>e.id==='polish-rect').fill,'#ff0000',mode+': full picker previews color');
  await page.keyboard.press('Escape');assert.equal((await read()).elements.find(e=>e.id==='polish-rect').fill,'#4385be');
  assert.deepEqual((await read()).history,beforeColor.history,mode+': color cancel restores history and redo');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.__flux.fig.commit(p=>{const f=p.figures.find(f=>f.elements.some(e=>e.id==='polish-rect'));f.groups={...f.groups,'polish-locked':{id:'polish-locked',name:'Locked parent',locked:true}};f.elements.find(e=>e.id==='polish-rect').groupId='polish-locked'}));
  await waitForFrame(page);assert.equal((await field('X')).disabled,true,mode+': inherited lock is visibly read-only');
  assert.equal(await page.$eval('.inspector',n=>n.textContent.includes('locked or hidden')),true);
  const lockedBefore=await read();await page.keyboard.press('ArrowRight');assert.equal((await read()).elements.find(e=>e.id==='polish-rect').x,lockedBefore.elements.find(e=>e.id==='polish-rect').x);
  const layoutKey='flux.'+mode.toLowerCase()+'.layout';
  const layoutBefore=await page.evaluate(key=>localStorage.getItem(key),layoutKey),beforeRail=await read();
  // Paper remains mounted with the same sidebar label; target this editor's
  // handle, then prove the actual pointer will hit it before testing the drag.
  const rail=await page.$(mode==='Figure'?'.figure-mode [aria-label="Resize sidebar (double-click resets)"]':'.slide-mode [aria-label="Resize slide list"]'),rb=await rail.boundingBox();
  assert.equal(await rail.evaluate(n=>{const b=n.getBoundingClientRect();return n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}),true,mode+': rail is the visible pointer target');
  await page.mouse.move(rb.x+rb.width/2,rb.y+rb.height/2);await page.mouse.down();await page.mouse.move(rb.x+rb.width/2+50,rb.y+rb.height/2);
  assert.notEqual(await page.evaluate(key=>localStorage.getItem(key),layoutKey),layoutBefore,mode+': rail resizes live');
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),layoutKey),layoutBefore,mode+': rail cancellation restores preferences');
  assert.deepEqual(await read(),beforeRail,mode+': rail cancellation preserves selection and project history');
  if(mode==='Slide') {
   assert.equal(await page.$$eval('.frame-resize-handle',n=>n.length),0,'deck stage has no per-slide resize handles');
   assert.equal(await page.evaluate(async()=>{const {dispatchCommand}=await import('/src/lib/bridge/commands.ts');try{await dispatchCommand({type:'resize_figure_frame',x:0,y:0,width:320,height:240});return false}catch{return true}}),true,'live bridge also rejects individual slide frame resizing');
   assert.deepEqual(await read(),beforeRail,'rejected slide frame command preserves history');
  }

 }
 await clickMode(page,'Figure');
 for(const width of [940,1024,1600]){
  await page.setViewport({width,height:900});await waitForFrame(page);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.figure-mode .toolbar button')].every(n=>{const b=n.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight})),true,`toolbar fits ${width}px`);
 }
 await page.setViewport({width:940,height:900});await waitForFrame(page);
 await page.click('button[title="All project figures, references, sources and usages"]');
 await waitFor(page,()=>!!document.querySelector('[role=dialog][aria-label="Project figures"]'));
 const focus=await page.evaluate(()=>{const d=document.querySelector('[role=dialog][aria-label="Project figures"]'),els=[...d.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter(e=>e.getClientRects().length);els.at(-1).focus();return els[0].outerHTML});
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.outerHTML),focus,'catalog traps forward Tab');
 mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/figure-polish-catalog-940.png'});
 await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement?.title),'All project figures, references, sources and usages','catalog restores invoking focus');
 assert.deepEqual(realErrors(page),[]);console.log('FIGURE CONTROLS GUI: PASS');
}finally{await browser.close()}
