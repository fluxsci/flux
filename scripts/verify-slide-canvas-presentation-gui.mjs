// Real Canvas regressions for the presentation adapter: camera geometry,
// inverse drag coordinates, stage targeting, and transient hidden-state ghosts.
import assert from 'node:assert/strict';
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from './lib/driver.mjs';
const {browser,page}=await launch({width:1440,height:1000});
let passed=0;
const check=(c,m)=>{assert.ok(c,m);console.log('  ✓ '+m);passed++;};
const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const clickText=async(sel,txt)=>{assert.ok(await page.evaluate(({sel,txt})=>{const e=[...document.querySelectorAll(sel)].find(e=>e.textContent.trim()===txt);e?.click();return !!e;},{sel,txt}));await paint();};
const geom=async id=>page.$eval(`[data-editor-element-id="${id}"]`,e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,opacity:getComputedStyle(e).opacity};});
const read=()=>page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);return {deck:f.slide.currentDeck(),elements:f.get(f.fig.project).figures.find(x=>x.id===sid).elements,selection:[...f.get(f.fig.selection)],viewport:f.get(f.fig.viewport),presentation:f.get(f.slide.slideCanvasPresentation)};});
try{
 await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:300});await clickMode(page,'Slide',{settle:300});
 await waitFor(page,()=>!!window.__flux?.get(window.__flux.slide.deckOverlay),null,{timeout:15000,label:'deck'});
 await page.evaluate(()=>{
  const f=window.__flux,sid=f.get(f.fig.activeFigureId);
  f.plot.cachePlot('camera-plot',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" width="100" height="80"><rect id="plot.back" width="100" height="80" fill="#292725"/><rect id="series.bar" x="25" y="20" width="20" height="45" fill="#d0a215"/></svg>`);
  f.slide.commitDeckLive(d=>{
   const s=f.slideOps.slideById(d,sid);s.elements=[{type:'rect',id:'camera-box',name:'Camera target',x:80,y:80,width:30,height:25,rotation:0,opacity:.7,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}];
   f.slideOps.addPlotToSlide(d,sid,{assetId:'camera-plot',x:140,y:100,width:100,height:80});s.elements.at(-1).id='camera-plot-el';
   const b1=f.slideOps.addBeat(d,sid,{label:'Close view'});f.slideOps.appendAnimation(d,sid,b1.id,{id:'camera-move',target:'@camera',preset:'camera',to:{x:100,y:100,zoom:2},duration:500});
   f.slideOps.appendAnimation(d,sid,b1.id,{target:'camera-box',preset:'highlight',duration:500});f.slideOps.appendAnimation(d,sid,b1.id,{target:'camera-plot-el',part:'series.bar',preset:'highlight',duration:500});
   const b2=f.slideOps.addBeat(d,sid,{label:'Hide annotations'});f.slideOps.appendAnimation(d,sid,b2.id,{target:'camera-box',preset:'fadeOut',duration:500});f.slideOps.appendAnimation(d,sid,b2.id,{target:'camera-plot-el',part:'series.bar',preset:'fadeOut',duration:500});
  });f.slide.activeBeat.set(1);f.fig.viewport.set({zoom:1,panX:30,panY:30});
 });
 await clickText('.deckbar button','Animate ⏱');
 await clickText('.edit-switch button','Edit after step 1');
 const before=await read(),r=await geom('camera-box');
 const host=await page.$eval('.canvas-wrap',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y}});
 const st=before.deck.stage,v=before.viewport;
 check(Math.abs(r.x-(host.x+v.panX+v.zoom*(st.width/2-100*2+80*2)))<2&&Math.abs(r.w-30*v.zoom*2)<1,'camera endpoint and Canvas geometry use the same stage transform');
 await page.mouse.click(r.x+r.w/2,r.y+r.h/2);await paint();
 check((await read()).selection.includes('camera-box'),'clicking camera-projected geometry selects its actual object');
 // Disable grid snapping for a measured world-space drag.
 await page.evaluate(async()=>{const {settings}=await import('/src/lib/settings.ts');settings.update(s=>({...s,snapGrid:false,snapPixel:false}));});
 const selected=await geom('camera-box');
 await page.mouse.move(selected.x+selected.w/2,selected.y+selected.h/2);await page.mouse.down();await page.keyboard.down('Alt');await page.mouse.move(selected.x+selected.w/2+24,selected.y+selected.h/2+12,{steps:4});await page.mouse.up();await page.keyboard.up('Alt');await paint();
 let state=await read();const moved=state.elements.find(e=>e.id==='camera-box');
 const dx=moved.x-80,dy=moved.y-80;
 check(Math.abs(dx-24/(v.zoom*2))<1&&Math.abs(dy-12/(v.zoom*2))<1,`drag inverses the camera zoom into world units (${dx.toFixed(2)}, ${dy.toFixed(2)})`);
 await page.keyboard.press('ArrowRight');await paint();state=await read();
 check(Math.abs(state.elements.find(e=>e.id==='camera-box').x-moved.x-1)<.01,'canvas nudge remains one authored unit under camera zoom');
 const cameraBase=state.deck.slides[0].elements.find(e=>e.id==='camera-box');check(cameraBase.x===80&&cameraBase.y===80,'camera endpoint edits leave original Design geometry intact');
 await clickText('.edit-switch button','Design');state=await read();
 check(state.elements.find(e=>e.id==='camera-box').x===80&&JSON.stringify(state.viewport)===JSON.stringify(v),'returning to Design restores geometry and the user’s base viewport');
 // Hover full-object and exact semantic-part labels. Read actual SVG geometry.
 const tids=await page.evaluate(()=>{const f=window.__flux,s=f.slide.composedSlide(f.get(f.fig.activeFigureId));return {whole:s.beats[1].tracks.find(t=>t.target==='camera-box'&&t.preset==='highlight').id,part:s.beats[1].tracks.find(t=>t.part==='series.bar').id};});
 await page.hover(`[data-track-id="${tids.whole}"] .track-label`);await paint();
 let hi=await page.$eval('.presentation-target',e=>({w:+e.getAttribute('width'),h:+e.getAttribute('height')}));
 const whole=await geom('camera-box');check(Math.abs(hi.w-whole.w-6)<2,'whole-track hover outlines the real object bounds');
 await page.hover(`[data-track-id="${tids.part}"] .track-label`);await paint();
 hi=await page.$eval('.presentation-target',e=>({w:+e.getAttribute('width'),h:+e.getAttribute('height')}));
 const part=await page.$eval('.canvas-wrap [id="camera-plot-el__series.bar"]',e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height};});
 check(Math.abs(hi.w-part.w-6)<2&&Math.abs(hi.h-part.h-6)<2,`semantic-track hover outlines only the matching plot part (${JSON.stringify({hi,part})})`);
 await page.evaluate(()=>window.__flux.slide.activeBeat.set(2));await paint();await clickText('.edit-switch button','Edit after step 2');
 const ghost=await geom('camera-box');state=await read();
 check(state.presentation.hiddenElementIds.includes('camera-box')&&Math.abs(+ghost.opacity-.25)<.01,'hidden endpoint remains visible as a quarter-opacity editing ghost');
 await page.mouse.click(ghost.x+ghost.w/2,ghost.y+ghost.h/2);await paint();check((await read()).selection.includes('camera-box'),'hidden ghost can be selected on its camera-projected geometry');
 const partOpacity=await page.$eval('.canvas-wrap [id="camera-plot-el__series.bar"]',e=>getComputedStyle(e).opacity);
 check(Math.abs(+partOpacity-.25)<.01,'hidden semantic part receives transient ghost appearance');
 state=await read();const persisted=state.deck.slides[0].elements;
 check(persisted.every(e=>!e.hidden)&&persisted.find(e=>e.id==='camera-box').opacity===.7&&!JSON.stringify(persisted).includes('0.25'),'ghost opacity and visibility never enter saved model');
 await page.click('.ghost-toggle input');await paint();
 check(+(await geom('camera-box')).opacity===0,'Show hidden off removes ghost appearance');
 check(realErrors(page).length===0,'clean console: '+realErrors(page).join('; '));
 await page.screenshot({path:'test-results/slide-canvas-presentation.png'});
 console.log(`##VERIFY## ${JSON.stringify({name:'slide-canvas-presentation-gui',passed,failed:0})}`);
}finally{await browser.close();}
