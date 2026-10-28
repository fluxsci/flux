import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {launch,gotoApp,clickMode,waitFor,waitForFrame,realErrors,APP_URL} from './lib/driver.mjs';
const {browser,page}=await launch({width:1600,height:1050});
async function seed(){
  await page.evaluate(()=>{const F=window.__flux,s=F.fig;
    s.commit(p=>{const f=p.figures[0];p.figures=[f];f.x=0;f.y=0;f.width=500;f.height=350;delete f.groups;
      f.elements=[{id:'overhang',type:'rect',x:450,y:100,width:160,height:120,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}];
      s.activeCanvasId.set(f.canvasId);s.activeFigureId.set(f.id);
    });s.clearSelection();s.activeTool.set('select');s.viewport.set({panX:80,panY:80,zoom:1});s.resetHistory();s.dirty.set(false);
  });await waitForFrame(page);
}
const state=()=>page.evaluate(()=>{const F=window.__flux,s=F.fig;return {figures:structuredClone(F.get(s.project).figures),selection:[...F.get(s.selection)],frame:F.get(s.selectedFrameId),h:s.historyStats(),dirty:F.get(s.dirty)}});
const point=(x,y)=>page.evaluate(([x,y])=>{const h=document.querySelector('.figure-mode .canvas-host').getBoundingClientRect(),F=window.__flux,v=F.get(F.fig.viewport);return {x:h.x+v.panX+x*v.zoom,y:h.y+v.panY+y*v.zoom}},[x,y]);
const key=async(mod,code)=>{await page.keyboard.down(mod);await page.keyboard.press(code);await page.keyboard.up(mod);await waitForFrame(page)};
try{
  await gotoApp(page,{url:`${APP_URL}?fixture=demo`});await clickMode(page,'Figure');
  await waitFor(page,()=>!!window.__flux?.fig&&!!document.querySelector('.canvas-host'));
  await seed();
  // An actual palette command arms placement; overlapping click resolves to
  // the exact nearest available point, without moving existing artwork.
  await key('Control','KeyK');await page.waitForSelector('[aria-label="Search commands"]');
  await page.type('[aria-label="Search commands"]','New figure');await page.keyboard.press('Enter');
  await page.waitForSelector('.placement-hint');
  await waitFor(page,()=>!document.querySelector('.cp'));
  let p=await point(100,100);await page.mouse.move(p.x,p.y);await waitForFrame(page);
  const ghost=await page.evaluate(()=>{const g=document.querySelector('.placement-ghost'),h=document.querySelector('.figure-mode .canvas-host').getBoundingClientRect(),r=g?.getBoundingClientRect();return r&&{x:r.x-h.x,y:r.y-h.y,w:r.width,h:r.height};});
  const ghostAt=await point(100,430),hostAt=await page.evaluate(()=>{const h=document.querySelector('.figure-mode .canvas-host').getBoundingClientRect();return {x:h.x,y:h.y};});
  assert.ok(ghost&&Math.abs(ghost.x-(ghostAt.x-hostAt.x))<1&&Math.abs(ghost.y-(ghostAt.y-hostAt.y))<1&&Math.abs(ghost.w-680)<1&&Math.abs(ghost.h-850)<1,`placement ghost previews the resolved frame: ${JSON.stringify(ghost)}`);
  await page.mouse.click(p.x,p.y);await waitForFrame(page);
  let s=await state();assert.equal(s.figures.length,2);assert.equal(s.h.past,1);
  const placed=s.figures[1];assert.equal(placed.x,100);assert.equal(placed.y,430);assert.equal(s.frame,placed.id);
  await key('Control','KeyZ');assert.equal((await state()).figures.length,1);
  await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Shift');await page.keyboard.up('Control');
  assert.deepEqual((await state()).figures[1],placed,'redo restores exact identity and placement');
  await seed();
  await key('Control','KeyK');await page.type('[aria-label="Search commands"]','New figure');await page.keyboard.press('Enter');await page.waitForSelector('.placement-hint');await waitFor(page,()=>!document.querySelector('.cp'));
  await page.keyboard.press('Escape');assert.equal(await page.$('.placement-hint'),null);assert.equal((await state()).h.past,0);
  await key('Control','KeyK');await page.type('[aria-label="Search commands"]','New figure');await page.keyboard.press('Enter');await page.waitForSelector('.placement-hint');await waitFor(page,()=>!document.querySelector('.cp'));
  await key('Alt','KeyR');assert.equal(await page.$('.placement-hint'),null,'choosing another tool cancels pending placement');
  const drawA=await point(60,250),drawB=await point(120,300);await page.mouse.move(drawA.x,drawA.y);await page.mouse.down();await page.mouse.move(drawB.x,drawB.y,{steps:4});await page.mouse.up();await waitForFrame(page);
  assert.equal((await state()).figures.length,1,'next rectangle press cannot place a stale figure');assert.equal((await state()).figures[0].elements.length,2,'the new tool draws normally');await key('Control','KeyZ');
  // Whole-frame Alt-duplicate starts after slop, leaves original stationary,
  // preserves family, and cancels back to the exact source view/history.
  let title=await point(80,-12);
  await page.keyboard.down('Alt');await page.mouse.click(title.x,title.y);await page.keyboard.up('Alt');
  assert.equal((await state()).figures.length,1,'Alt-click creates no copy');assert.equal((await state()).h.past,0);
  await page.keyboard.down('Alt');await page.mouse.move(title.x,title.y);await page.mouse.down();await page.mouse.move(title.x+95,title.y+65,{steps:5});await waitForFrame(page);
  s=await state();assert.equal(s.figures.length,2,'copy exists during drag');assert.equal(s.figures[0].x,0);assert.equal(s.figures[0].y,0);
  await page.mouse.up();await page.keyboard.up('Alt');await waitForFrame(page);
  s=await state();assert.equal(s.figures[1].x,95);assert.equal(s.figures[1].y,65);assert.equal(s.figures[1].family,s.figures[0].family);assert.equal(s.figures[1].number,s.figures[0].number+1);assert.equal(s.h.past,1);
  await key('Control','KeyZ');assert.equal((await state()).figures.length,1);
  const beforeCancel=await state();
  await page.keyboard.down('Alt');await page.mouse.move(title.x,title.y);await page.mouse.down();await page.mouse.move(title.x+55,title.y+45,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Alt');await waitForFrame(page);
  const cancelled=await state();assert.deepEqual(cancelled.figures,beforeCancel.figures);assert.deepEqual(cancelled.h,beforeCancel.h);assert.equal(cancelled.frame,beforeCancel.frame);
  await page.keyboard.down('Alt');await page.keyboard.down('Shift');await page.mouse.move(title.x,title.y);await page.mouse.down();await page.mouse.move(title.x+95,title.y+18,{steps:4});await page.mouse.up();await page.keyboard.up('Shift');await page.keyboard.up('Alt');await waitForFrame(page);
  s=await state();assert.equal(s.figures[1].x,95);assert.equal(s.figures[1].y,0,'Shift keeps whole-frame duplication on its dominant axis');
  // Resize an edge outside the frame, then marquee from canvas background.
  await seed();await page.evaluate(()=>window.__flux.fig.selection.set(new Set(['overhang'])));await waitForFrame(page);
  const edge=await point(610,160);assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.getAttribute('data-h'),edge),'e');
  await page.mouse.move(edge.x,edge.y);await page.mouse.down();await page.mouse.move(edge.x+30,edge.y,{steps:4});await page.mouse.up();await waitForFrame(page);
  assert.equal((await state()).figures[0].elements[0].width,190,'outside edge really resizes');
  await key('Control','KeyZ');await page.keyboard.press('Escape');
  const a=await point(650,250),b=await point(420,60);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();await waitForFrame(page);
  assert.deepEqual((await state()).selection,['overhang'],'marquee may start outside the figure');
  // Begun outside every frame, the marquee selects in the frame it covers, not
  // only the active one; a plain click there still deselects.
  await page.evaluate(()=>{const F=window.__flux,s=F.fig;s.commit(p=>{const a=p.figures[0],b=structuredClone(a);b.id='fig-other';b.x=800;b.y=0;delete b.referenceKey;delete b.number;delete b.family;b.elements=[{id:'in-other',type:'rect',x:50,y:50,width:100,height:80,rotation:0,fill:'#d14d41',stroke:'none',strokeWidth:0,cornerRadius:0}];p.figures.push(b);});s.activeFigureId.set(F.get(s.project).figures[0].id);s.clearSelection();});await waitForFrame(page);
  const c=await point(760,30),d=await point(900,200);await page.mouse.move(c.x,c.y);await page.mouse.down();await page.mouse.move(d.x,d.y,{steps:8});await page.mouse.up();await waitForFrame(page);
  assert.deepEqual((await state()).selection,['in-other'],'an outside marquee selects in the frame it covers');
  assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.activeFigureId)),'fig-other','that frame becomes active');
  await page.mouse.click(c.x,c.y);await waitForFrame(page);
  assert.deepEqual((await state()).selection,[],'an outside click deselects');
  assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.activeFigureId)),'fig-other','a plain outside click keeps the active frame');
  await seed();
  await key('Alt','KeyR');assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.activeTool)),'rect','Alt+R selects rectangle');
  await page.focus('.inspector input');await page.keyboard.press('KeyR');
  assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.activeTool)),'rect','typing R does not invoke canvas shortcuts');await page.evaluate(()=>document.activeElement.blur());
  // Real clipboard write; source path is resolved against the project root.
  const root=await page.evaluate(async()=>{const F=window.__flux,s=F.fig;const root=F.get(s.embeddedProjectRoot)||F.get(s.projectDir);await window.fig.writeText(`${root}/plots/test.svg`,'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#4385be"/></svg>');s.activeTool.set('select');await F.io.importPlotsFromPaths([`${root}/plots/test.svg`]);return root;});
  // The clipboard permission belongs to the isolated browser profile.
  await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin,['clipboard-read','clipboard-sanitized-write']);
  await page.keyboard.down('Alt');await page.keyboard.down('Shift');await page.keyboard.press('KeyC');await page.keyboard.up('Shift');await page.keyboard.up('Alt');
  await waitFor(page,()=>document.body.textContent.includes('Plot path copied'));
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),`${root}/plots/test.svg`);
  const stored=await page.evaluate(()=>{const F=window.__flux,s=F.fig;let path;s.commit(p=>{const id=[...F.get(s.selection)][0],e=p.figures.flatMap(f=>f.elements).find(e=>e.id===id);delete e.source;path=p.assets.find(a=>a.id===e.assetId).path;});return path;});
  await page.keyboard.down('Alt');await page.keyboard.down('Shift');await page.keyboard.press('KeyC');await page.keyboard.up('Shift');await page.keyboard.up('Alt');
  await waitFor(page,async()=>await navigator.clipboard.readText()!==`${window.__flux.get(window.__flux.fig.embeddedProjectRoot)}/plots/test.svg`);
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),`${root}/fig/${stored}`,'unlinked plots resolve within fig/assets');
  // Several selected plots copy one path per line, in selection order.
  await page.evaluate(async root=>{const F=window.__flux,s=F.fig;await window.fig.writeText(`${root}/plots/second.svg`,'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#879a39"/></svg>');const first=[...F.get(s.selection)][0];await F.io.importPlotsFromPaths([`${root}/plots/second.svg`]);s.selection.set(new Set([first,...F.get(s.selection)]));},root);await waitForFrame(page);
  await page.keyboard.down('Alt');await page.keyboard.down('Shift');await page.keyboard.press('KeyC');await page.keyboard.up('Shift');await page.keyboard.up('Alt');
  await waitFor(page,async()=>(await navigator.clipboard.readText()).includes('\n'));
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),`${root}/fig/${stored}\n${root}/plots/second.svg`,'several plots copy one path per line');
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/oct27-figure.png'});
  assert.deepEqual(realErrors(page),[]);
  // The shared shortcut also runs in Slide. Deck-owned and project-resolved
  // paths have different owners; use the actual projection and clipboard. A
  // fresh saved fixture keeps the deliberately mutated Figure test model out
  // of this independent mode's persistence baseline.
  await gotoApp(page,{url:`${APP_URL}?fixture=demo`});await clickMode(page,'Slide');await waitFor(page,()=>!!window.__flux.slide.currentDeck(),null,{label:'healthy Slide fixture'});
  const slidePaths=await page.evaluate(async()=>{
    const F=window.__flux,s=F.fig,root=F.get(s.embeddedProjectRoot)||F.get(s.projectDir),svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#4385be"/></svg>';
    const local={id:'copy-local-asset',kind:'svg',name:'Local',path:'assets/local.svg',naturalWidth:100,naturalHeight:100},external={id:'copy-external-asset',kind:'svg',name:'External',path:'fig/assets/copy-external.svg',naturalWidth:100,naturalHeight:100};
    const deck=structuredClone(F.slide.currentDeck());deck.id='copy-path-a';deck.assets=[local];deck.slides=[{id:'copy-slide',elements:[{id:'copy-local',type:'plot',assetId:local.id,x:100,y:100,width:100,height:100,rotation:0},{id:'copy-external',type:'plot',assetId:external.id,x:250,y:100,width:100,height:100,rotation:0}],beats:[{id:'copy-base',tracks:[]}]}];
    await window.fig.mkdir(`${root}/slides/${deck.id}/assets`);await window.fig.mkdir(`${root}/fig/assets`);await window.fig.writeText(`${root}/slides/${deck.id}/${local.path}`,svg);await window.fig.writeText(`${root}/${external.path}`,svg);
    const {setAssetData}=await import('/src/lib/assets.ts');for(const asset of [local,external]){setAssetData(asset.id,'data:image/svg+xml;base64,'+btoa(svg));F.plot.cachePlot(asset.id,svg);}
    const assets=[local,external],externalIds=new Set([external.id]);F.slide.loadDeckModel(deck,assets,externalIds);s.selection.set(new Set(['copy-local']));s.activeTool.set('select');document.activeElement?.blur();
    window.__oct27ClipboardDeck={deck,assets,externalIds};return{local:`${root}/slides/${deck.id}/${local.path}`,external:`${root}/${external.path}`};
  });await waitForFrame(page);
  for(const [elementId,expected]of [['copy-local',slidePaths.local],['copy-external',slidePaths.external]]){
    await page.evaluate(id=>window.__flux.fig.selection.set(new Set([id])),elementId);await waitForFrame(page);
    await page.keyboard.down('Alt');await page.keyboard.down('Shift');await page.keyboard.press('KeyC');await page.keyboard.up('Shift');await page.keyboard.up('Alt');
    await waitFor(page,async expected=>await navigator.clipboard.readText()===expected,expected);
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expected,'Slide clipboard uses the actual asset owner');assert.equal(await page.evaluate(path=>window.fig.exists(path),expected),true,'copied Slide path exists in the fixture');
  }
  const switched=await page.evaluate(async()=>{
    const F=window.__flux,{selectedPlotPaths}=await import('/src/lib/figure/commands.ts'),{deck,assets,externalIds}=window.__oct27ClipboardDeck;
    F.fig.selection.set(new Set(['copy-local']));const pending=selectedPlotPaths();
    F.slide.loadDeckModel({...structuredClone(deck),id:'copy-path-b'},assets,externalIds);
    try{return await pending;}finally{F.slide.loadDeckModel(deck,assets,externalIds);F.fig.dirty.set(false);}
  });assert.deepEqual(switched,[],'deck switch during async path resolution cannot combine old asset and new deck ownership');
  await page.screenshot({path:'test-results/oct27-slide-paths.png'});
  assert.deepEqual(realErrors(page),[]);console.log('OCT27 FIGURE GUI: PASS — palette placement, frame duplication/cancel/undo, outside handles/marquee, tool/input routing, Figure/Slide clipboard ownership and deck-switch race');
}finally{await browser.close()}
