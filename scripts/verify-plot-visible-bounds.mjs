import assert from 'node:assert/strict';
import {launch,waitFor,waitForFrame,shot,realErrors} from './lib/driver.mjs';
import {layoutFixture} from './lib/alignArrangeFixture.mjs';
import {hiddenPanelSvg} from './lib/plotResizeFixFixture.ts';
const {browser,page}=await launch({width:1500,height:1000});
const read=()=>page.evaluate(()=>{
 const F=window.__flux,s=F.fig,e=F.get(s.project).figures.flatMap(f=>f.elements).find(e=>e.id==='hidden-plot'),box=document.querySelector('.sel-chrome .sel-box'),hit=document.querySelector('[data-editor-element-id="hidden-plot"] .plot-hit-area');
 const r=Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(hit.getAttribute(k))]));
 return{element:structuredClone(e),selection:[...F.get(s.selection)],visible:r.width||r.height?{x:r.x-e.x,y:r.y-e.y,w:r.width,h:r.height}:null,measurements:window.__plotBoundsReads??0,box:box?Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(box.getAttribute(k))])):null,history:s.historyStats()};
});
const change=async patch=>{await page.evaluate(patch=>{const s=window.__flux.fig;s.commit(p=>{const e=p.figures.flatMap(f=>f.elements).find(e=>e.id==='hidden-plot');for(const [key,value]of Object.entries(patch)){if(value===null)delete e[key];else e[key]=value;}});},patch);await waitForFrame(page);};
const undo=async()=>{await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await waitForFrame(page);};
try{
 await layoutFixture(page);
 await page.evaluate(svg=>{
  const F=window.__flux,s=F.fig;F.plot.cachePlot('hidden-asset',svg);
  s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId));f.elements=[{id:'hidden-plot',type:'plot',assetId:'hidden-asset',x:80,y:100,width:400,height:200,rotation:0}];p.assets.push({id:'hidden-asset',name:'Panels',kind:'svg',path:'assets/panels.svg',naturalWidth:400,naturalHeight:200});});
  s.selection.set(new Set(['hidden-plot']));s.viewport.set({panX:60,panY:60,zoom:1});s.resetHistory();s.dirty.set(false);
 },hiddenPanelSvg);
 await waitFor(page,()=>!!document.querySelector('[data-editor-element-id="hidden-plot"] svg'));await waitForFrame(page);
 const native=await read();assert.equal(native.box.width,400,'unhidden plots retain the placement frame');
 await page.evaluate(()=>{const original=SVGGraphicsElement.prototype.getBBox;SVGGraphicsElement.prototype.getBBox=function(...args){if(this.closest('[data-editor-element-id="hidden-plot"]'))window.__plotBoundsReads=(window.__plotBoundsReads??0)+1;return original.apply(this,args);};});
 await change({overrides:{'panel.right':{hidden:true}}});let hidden=await read();
 assert(hidden.visible.w>95&&hidden.visible.w<105,'selection hugs remaining panel');assert(hidden.box.width<105);assert.equal(hidden.element.width,400,'hiding never rewrites saved placement');
 const hit=await page.$eval('[data-editor-element-id="hidden-plot"] .plot-hit-area',n=>({x:Number(n.getAttribute('x')),w:Number(n.getAttribute('width'))}));assert.equal(hit.w,hidden.visible.w,'transparent hit area follows visible ink');
 // A lazy refresh inside a hidden keep-alive pane must not publish empty bounds.
 await page.evaluate(svg=>{document.querySelector('.figure-mode').style.display='none';window.__flux.plot.cachePlot('hidden-asset',svg);},hiddenPanelSvg);await waitForFrame(page);
 await page.evaluate(()=>{document.querySelector('.figure-mode').style.display='';window.dispatchEvent(new Event('flux:pane-shown'));});await waitForFrame(page);
 hidden=await read();assert(hidden.box.width>95&&hidden.box.width<105,'hidden-pane cache refresh preserves the selection on return');
 // Painted source backgrounds do not keep the hidden half selectable. A
 // marquee that only touches that half must also miss the plot.
 const client=async(x,y)=>page.evaluate(([x,y])=>{const h=document.querySelector('.figure-mode .canvas-host').getBoundingClientRect(),F=window.__flux,v=F.get(F.fig.viewport);return{x:h.x+v.panX+x*v.zoom,y:h.y+v.panY+y*v.zoom};},[x,y]);
 const emptyPoint=await client(380,160);await page.mouse.click(emptyPoint.x,emptyPoint.y);await waitForFrame(page);assert.deepEqual((await read()).selection,[],'hidden-area background click deselects');
 const ma=await client(480,270),mb=await client(300,110);await page.mouse.move(ma.x,ma.y);await page.mouse.down();await page.mouse.move(mb.x,mb.y,{steps:6});await page.mouse.up();await waitForFrame(page);assert.deepEqual((await read()).selection,[],'marquee over hidden panel misses plot');
 const visiblePoint=await client(130,170);await page.mouse.click(visiblePoint.x,visiblePoint.y);await waitForFrame(page);assert.deepEqual((await read()).selection,['hidden-plot'],'visible panel remains selectable');
 // Repeated viewport updates project cached world geometry; they never remeasure.
 await page.evaluate(()=>{const s=window.__flux.fig;for(let i=0;i<20;i++)s.viewport.set({panX:60+i,panY:60,zoom:1+i*.005});});await waitForFrame(page);
 assert.equal((await read()).measurements,hidden.measurements,'pan/zoom does not measure plot ink');
 // Re-mounting identical content (Undo of a hide, culling, figure switches) reuses its measurement.
 await change({overrides:{}});await change({overrides:{'panel.right':{hidden:true}}});const remounted=await read();
 assert.equal(remounted.measurements,hidden.measurements,'re-mounting measured content does not walk the plot again');assert.deepEqual(remounted.visible,hidden.visible,'reused bounds match the measured ones');
 // Snapping aligns to the drawn panel, not to the hidden half's placement edge.
 await page.evaluate(()=>{const F=window.__flux,s=F.fig;s.commit(p=>{p.figures.find(f=>f.id===F.get(s.activeFigureId)).elements.push({id:'snap-probe',type:'rect',name:'Probe',x:300,y:340,width:40,height:30,rotation:0,fill:'#888',stroke:'none',strokeWidth:0,cornerRadius:0});});s.selection.set(new Set(['snap-probe']));});await waitForFrame(page);
 const visibleRight=80+remounted.visible.x+remounted.visible.w,from=await client(320,355),to=await client(320+visibleRight+3-300,355);
 await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();await waitForFrame(page);
 const probeX=await page.evaluate(()=>{const F=window.__flux;return F.get(F.fig.project).figures.flatMap(f=>f.elements).find(e=>e.id==='snap-probe').x;});
 assert(Math.abs(probeX-visibleRight)<.01,`a moved element snaps to the visible edge (${probeX} vs ${visibleRight})`);
 await page.evaluate(()=>{const F=window.__flux,s=F.fig;s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId));f.elements=f.elements.filter(e=>e.id!=='snap-probe');});s.selection.set(new Set(['hidden-plot']));s.resetHistory();});await waitForFrame(page);
 await page.evaluate(()=>window.__flux.fig.viewport.set({panX:60,panY:60,zoom:1}));await waitForFrame(page);
 // Real resize anchored to the visible corner; artwork and Undo must stay coherent.
 await page.evaluate(()=>window.__flux.fig.resetHistory());const corner=await page.$('.sel-chrome .zone.corner[data-h="se"]');assert(corner);const cb=await corner.boundingBox();
 await page.mouse.move(cb.x+cb.width/2,cb.y+cb.height/2);await page.mouse.down();await page.mouse.move(cb.x+cb.width/2+50,cb.y+cb.height/2+30,{steps:6});await waitForFrame(page);
 const middle=await read();assert(middle.box.width>hidden.box.width+35&&middle.box.width<hidden.box.width+65,'mid-drag chrome follows the visible frame without jumping to the hidden width');
 await page.mouse.up();await waitForFrame(page);
 const resized=await read();assert(resized.element.width>400);assert(resized.box.width>hidden.box.width+35,'visible corner follows resize');assert.equal(resized.history.past,1);await undo();assert.deepEqual((await read()).element,hidden.element,'resize Undo restores full placement and hidden overrides');
 // Rotation/flip use the original pivot, rather than shifting artwork to a new box centre.
 await change({rotation:90,flipX:true});const rotated=await read();assert(Math.abs(rotated.box.width-hidden.visible.h)<1);assert(Math.abs(rotated.box.height-hidden.visible.w)<1);
 const rotatedEmpty=await client(280,100);await page.mouse.click(rotatedEmpty.x,rotatedEmpty.y);await waitForFrame(page);assert.deepEqual((await read()).selection,[],'rotation/flip hidden area does not select');
 const ra=await client(370,220),rb=await client(190,40);await page.mouse.move(ra.x,ra.y);await page.mouse.down();await page.mouse.move(rb.x,rb.y,{steps:6});await page.mouse.up();await waitForFrame(page);assert.deepEqual((await read()).selection,[],'rotated hidden-area marquee misses');
 const painted=await page.$('[id="hidden-plot__panel.left"] rect'),paintedBox=await painted.boundingBox();await page.mouse.click(paintedBox.x+paintedBox.width/2,paintedBox.y+paintedBox.height/2);await waitForFrame(page);assert.deepEqual((await read()).selection,['hidden-plot'],'rotated/flipped visible ink still selects');
 await change({rotation:0,flipX:false,crop:{x:0,y:0,width:200,height:200},width:200});const cropped=await read();assert(cropped.box.width<110,'cropped hidden plot still hugs visible panel');
 // Ctrl-drag crop from the visible corner must not jump its underlying window.
 await page.evaluate(()=>window.__flux.fig.resetHistory());const cropHandle=await page.$('.sel-chrome .zone.corner[data-h="se"]'),ch=await cropHandle.boundingBox();
 await page.keyboard.down('Control');await page.mouse.move(ch.x+ch.width/2,ch.y+ch.height/2);await page.mouse.down();await page.mouse.move(ch.x+ch.width/2-5,ch.y+ch.height/2-5,{steps:3});await page.mouse.up();await page.keyboard.up('Control');await waitForFrame(page);
 const cropResult=await read();assert(cropResult.element.width>180,'crop responds to pointer delta without jumping to hidden edge');await undo();assert.deepEqual((await read()).element,cropped.element,'crop Undo restores exact geometry');
 await change({crop:null,width:400,overrides:{'panel.left':{hidden:true},'panel.right':{hidden:true}}});const empty=await read();assert.equal(empty.visible,null,'all hidden parts have no visible bounds');assert.equal(empty.box,null,'all hidden artwork has no selection chrome');
 await change({overrides:{}});assert.equal((await read()).box.width,400,'showing parts restores the full placement frame immediately');
 await page.keyboard.press('Escape');const whitespace=await client(280,160);await page.mouse.click(whitespace.x,whitespace.y);await waitForFrame(page);assert.deepEqual((await read()).selection,['hidden-plot'],'ordinary unhidden plot whitespace remains selectable');
 // Native getBBox includes invisible out-of-domain geometry. Its clipped:true
 // option is ignored by Chromium156, so content-time clip-chain bounds matter.
 const originalRect='<rect x="10" y="20" width="100" height="100" fill="#5678aa"/>';
 const clippedSvg=hiddenPanelSvg.replace(originalRect,'<g clip-path="url(#axes-clip)"><path id="outside-data" d="M -500 80 L 800 80" fill="none" stroke="#5678aa" stroke-width="4"/></g>').replace('</svg>','<defs><clipPath id="axes-clip"><rect x="10" y="20" width="100" height="100"/></clipPath></defs></svg>');
 await page.evaluate(svg=>window.__flux.plot.cachePlot('hidden-asset',svg),clippedSvg);await change({overrides:{'panel.right':{hidden:true}}});const clipped=await read();
 assert(clipped.visible.x>=9.9&&clipped.visible.w<=100.1,'rect clip excludes out-of-limits data from hidden-panel bounds');assert(clipped.visible.h>60,'stroke and label ink remain included');
 const nativeClip=await page.$eval('[id="hidden-plot__outside-data"]',n=>{const a=n.getBBox(),b=n.getBBox({clipped:true});return{raw:[a.x,a.y,a.width,a.height],option:[b.x,b.y,b.width,b.height]};});assert(nativeClip.raw[2]>1000,'fixture really extends far beyond axes');console.log('Installed browser getBBox clip probe: '+JSON.stringify(nativeClip));
 const clippedEmpty=await client(380,180);await page.mouse.click(clippedEmpty.x,clippedEmpty.y);await waitForFrame(page);assert.deepEqual((await read()).selection,[],'clipped-away data does not keep hidden-area background selectable');
 const transformedClipSvg=clippedSvg.replace('<clipPath id="axes-clip">','<clipPath id="axes-clip" transform="translate(15 0)">');
 await page.evaluate(svg=>window.__flux.plot.cachePlot('hidden-asset',svg),transformedClipSvg);await waitForFrame(page);const translatedClip=await read();assert(Math.abs(translatedClip.visible.x+translatedClip.visible.w-125)<.1,'clipPath transforms move the actual clipping boundary');
 const nestedClipSvg=clippedSvg.replace('<g id="panel.left" data-role="plot-area">','<g id="panel.left" data-role="plot-area" clip-path="url(#outer-clip)">').replace('</defs></svg>','<clipPath id="outer-clip"><path d="M 0 0 H 80 V 180 H 0 Z"/></clipPath></defs></svg>');
 await page.evaluate(svg=>window.__flux.plot.cachePlot('hidden-asset',svg),nestedClipSvg);await waitForFrame(page);const nestedClip=await read();assert(nestedClip.visible.x>=9.9&&Math.abs(nestedClip.visible.x+nestedClip.visible.w-80)<.1,'ancestor clip chains intersect conservatively, including path clips');
 const boxClipSvg=hiddenPanelSvg.replace(originalRect,'<g clip-path="url(#box-clip)"><rect x="0" y="0" width="400" height="200" fill="#5678aa"/></g>').replace('</svg>','<defs><clipPath id="box-clip" clipPathUnits="objectBoundingBox"><rect x="0.025" y="0.1" width="0.25" height="0.5"/></clipPath></defs></svg>');
 await page.evaluate(svg=>window.__flux.plot.cachePlot('hidden-asset',svg),boxClipSvg);await waitForFrame(page);const bboxClip=await read();assert(bboxClip.visible.x>=9.9&&bboxClip.visible.w<=100.1,'objectBoundingBox clipping maps through the owner geometry');
 await change({rotation:35,flipX:true});const tiltedClip=await read();assert(tiltedClip.visible.x>=9.9&&tiltedClip.visible.w<=100.1,'clip bounds remain in the original placement frame under rotation/flip');
 // Root viewport clipping is separate from internal clipping. Explicit visible
 // overflow must preserve real overhang, while hidden overflow clips it.
 const viewport=await page.evaluate(async()=>{
  const {measureVisiblePlotBounds}=await import('/src/lib/plot/visibleBounds.ts'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','400');svg.setAttribute('height','200');svg.setAttribute('viewBox','0 0 400 200');svg.setAttribute('preserveAspectRatio','none');svg.innerHTML='<rect x="-50" y="20" width="500" height="100" fill="black"/>';document.body.appendChild(svg);
  try{svg.style.overflow='visible';const visible=measureVisiblePlotBounds(svg,{width:400,height:200});svg.style.overflow='hidden';const hidden=measureVisiblePlotBounds(svg,{width:400,height:200});return{visible,hidden};}finally{svg.remove();}
 });
 assert(viewport.visible.x<=-49.9&&viewport.visible.w>=499.9,'visible overflow preserves actual overhanging paint');assert(Math.abs(viewport.hidden.x)<.1&&Math.abs(viewport.hidden.w-400)<.1,'uncropped hidden root overflow clips to the viewport');
 await shot(page,'plot-visible-bounds');assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-plot-visible-bounds',ok:true}));
}finally{await browser.close();}
