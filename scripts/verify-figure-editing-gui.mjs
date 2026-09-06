import assert from 'node:assert/strict';
import { launch, gotoApp, clickMode, waitFor, waitForFrame, realErrors } from './lib/driver.mjs';
const {browser,page}=await launch({width:1600,height:1050});
const results=[];
async function record(name,extra={}) {
  await waitForFrame(page);
  const state=await page.evaluate(()=>{
    const F=window.__flux, f=F.fig;
    const g=F.get(f.project).figures.find(g=>g.id===F.get(f.activeFigureId));
    const b=document.querySelector('.sel-box');
    return {selection:[...F.get(f.selection)],elements:g.elements.map(e=>({id:e.id,x:e.x,y:e.y,width:e.width,height:e.height,locked:e.locked})),box:b?Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(b.getAttribute(k))])):null,history:f.historyStats(),guides:g.guides,dirty:F.get(f.dirty)};
  });
  results.push({name,...extra,...state});console.log(JSON.stringify(results.at(-1)));
}
async function seed(opts={}) {
  await page.evaluate(opts=>{
    const F=window.__flux, s=F.fig;
    s.clearSelection();s.activeTool.set('select');s.captionOpen.set(false);s.nodeEditId.set(null);
    s.commit(p=>{
      const f=p.figures[0];p.figures=[f];f.x=0;f.y=0;f.width=800;f.height=600;delete f.groups;delete f.guides;
      f.elements=[{type:'rect',id:'review-a',name:'Review A',x:40,y:40,width:120,height:100,rotation:0,fill:'#d95f02',stroke:'#222222',strokeWidth:2,cornerRadius:0},{type:'rect',id:'review-b',name:'Review B',x:300,y:240,width:160,height:120,rotation:0,fill:'#4385be',stroke:'#222222',strokeWidth:2,cornerRadius:0}];
      if(opts.aspect) f.elements[0].lockAspect=true;
      if(opts.locked) f.elements[0].locked=true;
      s.activeFigureId.set(f.id);s.activeCanvasId.set(f.canvasId);
    });
    F.settings.update(v=>({...v,showRulers:true,snapPixel:false,snapGrid:false}));
    s.viewport.set({panX:80,panY:80,zoom:1});s.resetHistory();s.dirty.set(false);
  },opts);
  await waitForFrame(page);
}
async function pt(x,y){return page.evaluate(([x,y])=>{const h=document.querySelector('.canvas-host').getBoundingClientRect();const v=window.__flux.get(window.__flux.fig.viewport);return {x:h.x+v.panX+x*v.zoom,y:h.y+v.panY+y*v.zoom}},[x,y]);}
async function clickEl(x,y){const p=await pt(x,y);await page.mouse.click(p.x,p.y);await waitForFrame(page);}
async function prime(ids){await page.evaluate(ids=>{const f=window.__flux.fig;f.selection.set(new Set(ids));f.resetHistory();f.dirty.set(false)},ids);await waitForFrame(page);}
try {
  await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo',settle:1000});await clickMode(page,'Figure');
  await waitFor(page,()=>!!window.__flux?.fig&&!!document.querySelector('.canvas-host'));
  await seed();await prime(['review-a']);await record('selection baseline A');
  await page.evaluate(()=>[...document.querySelectorAll('.sidebar .layer .item')].find(n=>n.textContent.trim()==='Review B').click());
  await record('sidebar selects B (box should be x380 y320 w160 h120)');

  await page.keyboard.press('Escape');await record('Escape clears selection (box should be absent)');
  await clickEl(360,280);await record('canvas selects B (box should match B after pointer-up)');

  await seed();await prime(['review-a']);
  await page.evaluate(()=>window.__flux.fig.commit(p=>p.figures[0].elements[0].x=70));
  const p=await pt(110,85);await page.keyboard.down('Alt');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Alt');
  await record('Alt-down then Escape without drag (A should retain previous x70 edit)');

  await seed();await prime(['review-a']);const m=await pt(90,90);
  await page.mouse.move(m.x,m.y);await page.mouse.down();await page.mouse.move(m.x+53,m.y+37,{steps:5});
  await page.evaluate(()=>document.querySelector('.canvas-host').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1,pointerType:'mouse'})));
  await page.mouse.up();await record('pointercancel move (A should remain x40 y40)');

  await seed({aspect:true});await prime(['review-a']);
  const h=await page.evaluate(()=>{const n=[...document.querySelectorAll('.handle')].find(n=>n.getAttribute('style')?.includes('ew-resize')&&Number(n.getAttribute('x'))>200);if(!n)return null;const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});
  if(h){await page.mouse.move(h.x,h.y);await page.mouse.down();await page.mouse.move(h.x-40,h.y,{steps:6});await page.mouse.up();await record('aspect-locked east handle dragged inward 40px (width should shrink below120)');} else console.log('NO EAST HANDLE');

  await seed({locked:true});await prime(['review-a','review-b']);
  const k=await pt(360,290);await page.mouse.move(k.x,k.y);await page.mouse.down();await page.mouse.move(k.x+51,k.y+32,{steps:6});await page.mouse.up();
  await record('mixed locked/free selection moved from B (locked A should remain x40 y40)');

  await seed();await prime(['review-a']);
  const scrub=await page.evaluate(()=>{const n=[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent.trim()==='X')?.querySelector('.lb');if(!n)return null;const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});
  if(scrub){await page.mouse.move(scrub.x,scrub.y);await page.mouse.down();await page.mouse.move(scrub.x+35,scrub.y,{steps:6});await page.keyboard.press('Escape');await page.mouse.up();await record('Escape during numeric scrub (A should return to x40)');}


  assert.deepEqual(results[1].box, {x:380,y:320,width:160,height:120}, 'selection-only Layers click updates bounds');
  assert.equal(results[2].box,null,'Escape removes overlay');
  assert.equal(results[4].elements[0].x,70,'Alt click cancel preserves preceding edit');
  assert.equal(results[4].history.past,1);
  assert.equal(results[5].elements[0].x,40,'pointer cancellation never commits');
  assert.equal(results[5].history.past,0);
  assert.equal(results[6].elements[0].width,80,'aspect side handle shrinks');
  assert.equal(results[7].elements[0].x,40,'mixed locked target stays pinned');
  assert.notEqual(results[7].elements[1].x,300);
  assert.equal(results[8].elements[0].x,40,'scrub Escape restores baseline');
  assert.deepEqual(results[8].selection,['review-a'],'scrub Escape preserves selection');
  assert.equal(results[8].history.past,0);
  assert.equal(results[8].dirty,false);

  // All eight frame hit areas are exercised with real pointers at two zooms.
  for (const zoom of [0.5, 1.25]) {
    for (const handle of ['nw','n','ne','e','se','s','sw','w']) {
      await seed();
      await page.evaluate(zoom=>{
        const F=window.__flux,s=F.fig;
        s.commit(p=>{const f=p.figures[0];f.x=-30;f.y=-15;f.width=500;f.height=350;f.guides={x:[20],y:[30]};});
        s.viewport.set({panX:100,panY:100,zoom});s.selectFrame(F.figures()[0].id);s.resetHistory();s.dirty.set(false);
      },zoom);
      await waitForFrame(page);
      const before=await page.evaluate(()=>{const F=window.__flux;return {figure:structuredClone(F.figures()[0]),viewport:F.get(F.fig.viewport)}});
      const target=await page.$(`[data-frame-handle="${handle}"]`);
      assert.ok(target,`frame handle ${handle} exists`);
      const bounds=await target.boundingBox();
      const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
      const dx=handle.includes('w')?-24:handle.includes('e')?24:0;
      const dy=handle.includes('n')?-20:handle.includes('s')?20:0;
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:4});
      const live=await page.evaluate(()=>{const F=window.__flux;return {figure:structuredClone(F.figures()[0]),preview:F.get(F.fig.figureFramePreview),history:F.fig.historyStats()}});
      assert.deepEqual(live.figure,before.figure,'frame preview never mutates authoring model');
      assert.equal(live.history.past,0,'frame preview has no history entry');
      assert.ok(live.preview,'Inspector receives live frame dimensions');
      await page.mouse.up();await waitForFrame(page);
      const after=await page.evaluate(()=>{const F=window.__flux;return {figure:structuredClone(F.figures()[0]),viewport:F.get(F.fig.viewport),history:F.fig.historyStats()}});
      assert.equal(after.history.past,1,'frame release is one undo');
      assert.deepEqual(after.viewport,before.viewport,'frame resize keeps viewport');
      for(let i=0;i<2;i++){
        assert.equal(after.figure.x+after.figure.elements[i].x,before.figure.x+before.figure.elements[i].x,'artwork world x pinned');
        assert.equal(after.figure.y+after.figure.elements[i].y,before.figure.y+before.figure.elements[i].y,'artwork world y pinned');
        assert.equal(after.figure.elements[i].width,before.figure.elements[i].width,'artwork size preserved');
      }
      assert.ok(after.figure.width>before.figure.width || after.figure.height>before.figure.height);
      await page.evaluate(()=>window.__flux.fig.undo());await waitForFrame(page);
      assert.deepEqual(await page.evaluate(()=>structuredClone(window.__flux.figures()[0])),before.figure,'undo restores frame, objects and guides');
      // Existing redo must survive a cancelled frame resize.
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();
      const cancelled=await page.evaluate(()=>({f:structuredClone(window.__flux.figures()[0]),h:window.__flux.fig.historyStats()}));
      assert.deepEqual(cancelled.f,before.figure);assert.equal(cancelled.h.future,1);
    }
  }

  await seed();await prime(['review-a']);await page.keyboard.press('f');await page.waitForSelector('.fluxFigMenu');
  const field=async(label,selector='input')=>page.evaluateHandle(([label,selector])=>[...document.querySelectorAll('.fluxFigMenu .field')].find(n=>n.querySelector('.label')?.textContent.trim()===label)?.querySelector(selector),[label,selector]);
  let input=await field('width');await input.click();await input.evaluate(n=>n.select());await page.keyboard.type('240');await page.keyboard.press('Tab');
  let state=await page.evaluate(()=>({e:structuredClone(window.__flux.figures()[0].elements[0]),h:window.__flux.fig.historyStats()}));
  assert.equal(state.e.width,240,'mouse typing keeps the final zero');assert.equal(state.e.fill,'#d95f02','typing does not invoke no-fill');assert.equal(state.h.past,1);
  await page.evaluate(()=>window.__flux.fig.undo());
  input=await field('x position');await input.click();await input.evaluate(n=>n.select());await page.keyboard.type('175');await page.keyboard.press('Escape');await waitForFrame(page);
  state=await page.evaluate(()=>({e:structuredClone(window.__flux.figures()[0].elements[0]),h:window.__flux.fig.historyStats()}));
  assert.equal(state.e.x,40,'field Escape restores baseline');assert.equal(state.h.future,1,'field cancel preserves redo');
  const toggle=await field('no fill (outline only)','button');await toggle.click();
  assert.equal(await page.evaluate(()=>window.__flux.fig.historyStats().past),1,'mouse toggle owns one undo');
  await page.evaluate(()=>window.__flux.fig.undo());
  assert.equal(await page.evaluate(()=>window.__flux.figures()[0].elements[0].fill),'#d95f02');
  // Mixed selection: an intrinsic path bbox must not be edited as a rectangle.
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{const F=window.__flux,s=F.fig;s.commit(p=>p.figures[0].elements.push({type:'path',id:'path',x:200,y:40,width:80,height:80,rotation:0,d:'M 0 0 L 80 80',closed:false,fill:'none',stroke:'#222222',strokeWidth:2}));s.selection.set(new Set(['review-a','path']));s.resetHistory();});
  await page.keyboard.press('f');await page.waitForSelector('.fluxFigMenu');
  input=await field('width');await input.click();await input.evaluate(n=>n.select());await page.keyboard.type('240');await page.keyboard.press('Tab');
  state=await page.evaluate(()=>structuredClone(window.__flux.figures()[0].elements));
  assert.equal(state[0].width,240);assert.equal(state.find(e=>e.id==='path').width,80);assert.equal(state.find(e=>e.id==='path').d,'M 0 0 L 80 80');
  // Exercise the live command surface, including failure-before-history and
  // the deck-stage guard. CLI/MCP cover this same pure operation separately.
  await page.keyboard.press('Escape');
  const bridge=await page.evaluate(async()=>{
    const {dispatchCommand}=await import('/src/lib/bridge/commands.ts');
    const F=window.__flux,s=F.fig,f=F.figures()[0],history=s.historyStats();let rejected=false;
    try{await dispatchCommand({type:'resize_figure_frame',figureId:f.id,x:0,y:0,width:0,height:100})}catch{rejected=true}
    const noHistory=JSON.stringify(history)===JSON.stringify(s.historyStats());
    const x=f.x,world=f.x+f.elements[0].x;
    await dispatchCommand({type:'resize_figure_frame',figureId:f.id,x:x-20,y:f.y,width:f.width+20,height:f.height});
    const pinned=F.figures()[0].x+F.figures()[0].elements[0].x===world;
    s.undo();return{rejected,noHistory,pinned};
  });
  assert.deepEqual(bridge,{rejected:true,noHistory:true,pinned:true},'live frame command validates before history and pins artwork');
  assert.deepEqual(realErrors(page),[]);
  console.log('FIGURE EDITING GUI: PASS — selection, cancellation, locks, frame edges/corners, zoom, property entry and history');
} finally {await browser.close()}
