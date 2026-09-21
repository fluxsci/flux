import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,waitFor,waitForFrame,realErrors} from './lib/driver.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const {browser,page}=await launch({width:1500,height:950});
try{
await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');
const svg=readFileSync('scripts/fixtures/pre-regen/06_scatter_regression.svg','utf8');
const manifest=JSON.parse(readFileSync('scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json','utf8'));
await page.evaluate((svg,manifest)=>{const F=window.__flux,s=F.fig;F.io.reimportPlot('review-asset',svg,manifest);s.commit(p=>{const f=p.figures[0];p.figures=[f];Object.assign(f,{x:0,y:0,width:800,height:600});f.elements=[{id:'review-plot',type:'plot',assetId:'review-asset',x:100,y:100,width:400,height:280,rotation:0,overrides:{}}];s.activeFigureId.set(f.id);s.activeCanvasId.set(f.canvasId)});s.viewport.set({panX:60,panY:60,zoom:0.8});},svg,manifest);
await waitFor(page,()=>!!document.getElementById('review-plot__axis.x.ticklabel.2'));
await page.evaluate(()=>{const s=window.__flux.fig;s.selection.set(new Set(['review-plot']));s.partSelection.set({elementId:'review-plot',partId:'axis.x.ticklabel.2'})});await waitForFrame(page);
const read=()=>page.evaluate(()=>{const part=document.getElementById('review-plot__axis.x.ticklabel.2').getBoundingClientRect();const box=document.querySelector('.part-box').getBoundingClientRect();return {partX:part.x,partY:part.y,outlineX:box.x,outlineY:box.y,dx:box.x-(part.x-2),dy:box.y-(part.y-2)}});
const results=[{phase:'rest',...await read()}];
for(const panX of [110,163,216]){await page.evaluate(panX=>window.__flux.fig.viewport.update(v=>({...v,panX})),panX);await waitForFrame(page);results.push({phase:'pan '+panX,...await read()})}
for(const result of results){assert.ok(Math.abs(result.dx)<1,JSON.stringify(result));assert.ok(Math.abs(result.dy)<1,JSON.stringify(result));}
// A changed semantic override must remeasure after the DOM update.
await page.evaluate(()=>{const s=window.__flux.fig;s.commit(p=>p.figures[0].elements[0].overrides['axis.x.ticklabel.2']={fontSize:26,dx:13})});await waitForFrame(page);
const override=await read();assert.ok(Math.abs(override.dx)<1,JSON.stringify(override));assert.ok(Math.abs(override.dy)<1,JSON.stringify(override));
await page.evaluate(()=>window.__flux.fig.viewport.update(v=>({...v,zoom:1.1})));await waitForFrame(page);
const zoom=await read();assert.ok(Math.abs(zoom.dx)<1,JSON.stringify(zoom));assert.ok(Math.abs(zoom.dy)<1,JSON.stringify(zoom));
// Actual pointer previews and commits use the mounted Canvas. Compare rendered
// DOM geometry as well as the unchanged authoring model before pointer-up.
const gestures=[];
async function seedElement(kind,rotation,flip=false){
  await page.evaluate(({kind,rotation,flip})=>{
    const F=window.__flux,s=F.fig;
    s.clearSelection();s.activeTool.set('select');s.captionOpen.set(false);s.nodeEditId.set(null);
    F.settings.update(v=>({...v,snapPixel:false,snapGrid:false,snapObjects:false}));
    const base={id:'geometry-target',x:140,y:120,width:140,height:90,rotation,flipX:flip,fill:'#d95f02',stroke:'#222222',strokeWidth:2};
    const el=kind==='text'?{...base,type:'text',text:'Scientific text',fontSize:24,fontFamily:'Arial',fontWeight:400,fontStyle:'normal',align:'left',color:'#222222'}:
      kind==='path'?{...base,type:'path',d:'M0 0 L140 0 L110 90 L0 60 Z',closed:true,nodes:[{x:0,y:0,type:'corner'},{x:140,y:0,type:'corner'},{x:110,y:90,type:'corner'},{x:0,y:60,type:'corner'}]}:
      kind==='line'?{...base,type:'line',width:0,height:0,x1:0,y1:0,x2:140,y2:90}:
      kind==='plot'?{...base,type:'plot',assetId:'review-asset',overrides:{},crop:{x:10,y:10,width:250,height:180}}:
      {...base,type:'rect',cornerRadius:0};
    s.commit(p=>{const f=p.figures[0];p.figures=[f];Object.assign(f,{x:0,y:0,width:850,height:650});delete f.groups;f.elements=[el];if(kind==='plot'&&!p.assets.some(a=>a.id==='review-asset'))p.assets.push({id:'review-asset',kind:'svg',name:'review.svg',path:'assets/review.svg',naturalWidth:400,naturalHeight:300});s.activeFigureId.set(f.id);s.activeCanvasId.set(f.canvasId)});
    s.viewport.set({panX:65,panY:55,zoom:1});s.selection.set(new Set(['geometry-target']));s.resetHistory();s.dirty.set(false);
  },{kind,rotation,flip});await waitForFrame(page);
}
const rectOf=selector=>page.evaluate(selector=>{const n=document.querySelector(selector);if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}},selector);
const state=()=>page.evaluate(()=>{const F=window.__flux;return{el:structuredClone(F.figures()[0].elements[0]),history:F.fig.historyStats()}});
const closeRect=(a,b,label)=>{assert.ok(a&&b,label+' exists');for(const key of ['x','y','w','h'])assert.ok(Math.abs(a[key]-b[key])<0.75,`${label} ${key}: ${a[key]} vs ${b[key]}`)};
for(const kind of ['rect','text','path'])for(const rotation of [0,30,45,90]){
  await seedElement(kind,rotation,rotation===30||rotation===90);
  const before=await state();
  const handle=await page.evaluate(()=>{const n=document.querySelectorAll('.handle')[4],r=n?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null});
  assert.ok(handle,`${kind}/${rotation} southeast handle exists`);
  await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+48,handle.y+31,{steps:5});await waitForFrame(page);
  const during=await state(),preview=await rectOf('.overlay-svg > g[style*="will-change"]');
  assert.deepEqual(during.el,before.el,`${kind}/${rotation} preview leaves authored coordinates intact`);assert.equal(during.history.past,0);
  if(kind==='path'&&rotation===45){mkdirSync('test-results/out',{recursive:true});await page.screenshot({path:'test-results/out/v020-geometry-resize-preview.png'});}
  await page.mouse.up();await waitForFrame(page);
  const after=await state(),rendered=await rectOf('.scene [data-editor-element-id="geometry-target"]');
  closeRect(preview,rendered,`${kind}/${rotation} rendered preview/commit`);assert.equal(after.history.past,1);assert.notDeepEqual(after.el,before.el);
  if(kind==='text')assert.equal(after.el.fontSize,before.el.fontSize,'Resize keeps authored font size');
  await page.evaluate(()=>window.__flux.fig.undo());assert.deepEqual((await state()).el,before.el,`${kind}/${rotation} exact undo`);
  gestures.push({kind,rotation,flip:!!before.el.flipX,preview,rendered});
}
// Lines use endpoint handles (rotation about the actual line midpoint), not a
// degenerate rectangular selection. Their preview is in the scene slot itself.
for(const rotation of [0,30,45,90]){
  await seedElement('line',rotation,true);const before=await state();
  const endpoints=await page.evaluate(()=>[...document.querySelectorAll('.endpoint-handle')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}));
  assert.equal(endpoints.length,2);const h=endpoints[1];await page.mouse.move(h.x,h.y);await page.mouse.down();await page.mouse.move(h.x+31,h.y-27,{steps:5});await waitForFrame(page);
  assert.deepEqual((await state()).el,before.el);const preview=await rectOf('.scene [data-editor-element-id="geometry-target"]');
  await page.mouse.up();await waitForFrame(page);const after=await state(),rendered=await rectOf('.scene [data-editor-element-id="geometry-target"]');
  closeRect(preview,rendered,`line/${rotation} preview/commit`);assert.equal(after.history.past,1);
  const final=await page.evaluate(()=>[...document.querySelectorAll('.endpoint-handle')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}));
  assert.ok(Math.hypot(final[0].x-endpoints[0].x,final[0].y-endpoints[0].y)<0.75,'opposite endpoint stays pinned');
  assert.ok(Math.hypot(final[1].x-h.x-31,final[1].y-h.y+27)<0.75,'dragged endpoint follows actual pointer');gestures.push({kind:'line',rotation,preview,rendered});
}
await seedElement('plot',0,true);const cropBefore=await state();
const cropHandle=await page.evaluate(()=>{const r=document.querySelectorAll('.handle')[4].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
const modifier=await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform)?'Meta':'Control');
await page.keyboard.down(modifier);await page.mouse.move(cropHandle.x,cropHandle.y);await page.mouse.down();await page.mouse.move(cropHandle.x-28,cropHandle.y-18,{steps:5});await waitForFrame(page);
const cropPreview=await rectOf('.crop-outline');assert.deepEqual((await state()).el,cropBefore.el,'crop preview leaves authored model intact');
await page.mouse.up();await page.keyboard.up(modifier);await waitForFrame(page);const cropAfter=await state();
closeRect(cropPreview,await rectOf('.sel-box'),'flipped crop preview/commit');assert.notDeepEqual(cropAfter.el.crop,cropBefore.el.crop);assert.equal(cropAfter.history.past,1);
// A real pointerenter must paint settled hover inside the standing 100 ms budget.
await seedElement('rect',0);await page.evaluate(()=>window.__flux.fig.clearSelection());await page.mouse.move(3,3);await waitForFrame(page);
const hoverPoint=await rectOf('.scene [data-editor-element-id="geometry-target"]');
await page.evaluate(()=>{window.__geometryHover=new Promise(resolve=>{const host=document.querySelector('.canvas-host');const enter=e=>{if(!e.target.closest?.('[data-editor-element-id="geometry-target"]'))return;host.removeEventListener('pointerover',enter,true);const start=performance.now();const check=()=>{if(document.querySelector('.hover-box,.hover-trace'))requestAnimationFrame(()=>resolve(performance.now()-start));else requestAnimationFrame(check)};requestAnimationFrame(check)};host.addEventListener('pointerover',enter,true)})});
await page.mouse.move(hoverPoint.x+hoverPoint.w/2,hoverPoint.y+hoverPoint.h/2);const hoverMs=await page.evaluate(()=>window.__geometryHover);assert.ok(hoverMs<=100,`settled hover ${hoverMs} ms exceeds 100 ms`);
// Use two real mouse down/up pairs for the terminal double-click; Chrome's
// second pointerdown has detail=2 and must finish without another authored node.
await page.evaluate(()=>{const F=window.__flux,s=F.fig;s.clearSelection();s.commit(p=>p.figures[0].elements=[]);s.activeTool.set('pen');s.resetHistory()});await waitForFrame(page);
const points=await page.evaluate(()=>{const h=document.querySelector('.canvas-host').getBoundingClientRect(),v=window.__flux.get(window.__flux.fig.viewport);return[[130,150],[270,180],[360,290]].map(([x,y])=>({x:h.x+v.panX+x*v.zoom,y:h.y+v.panY+y*v.zoom}))});
for(const p of points.slice(0,2))await page.mouse.click(p.x,p.y);
const end=points[2];await page.mouse.move(end.x,end.y);await page.mouse.down();await page.mouse.up();await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});await waitForFrame(page);
const pen=await page.evaluate(()=>structuredClone(window.__flux.figures()[0].elements));assert.equal(pen.length,1);assert.equal(pen[0].type,'path');assert.equal(pen[0].nodes.length,3,'terminal double-click authors exactly one final node');
for(let n=1;n<pen[0].nodes.length;n++)assert.ok(Math.hypot(pen[0].nodes[n].x-pen[0].nodes[n-1].x,pen[0].nodes[n].y-pen[0].nodes[n-1].y)>0,'no zero-length terminal segment');
mkdirSync('test-results/out',{recursive:true});await page.screenshot({path:'test-results/out/v020-geometry-pen.png'});
assert.deepEqual(realErrors(page),[]);
const evidence={results,override,zoom,gestures,crop:{preview:cropPreview,before:cropBefore.el,after:cropAfter.el},hoverMs,pen};writeFileSync('test-results/out/v020-geometry-gui.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
console.log('V020 geometry GUI PASS: mounted preview/commit for rect/text/path/line at 0/30/45/90, flips, crop, exact undo, settled hover <=100ms, real terminal pen double-click');
}finally{await browser.close()}
