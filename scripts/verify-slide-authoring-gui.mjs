// Approved figures/slides overhaul: drive user-facing commands and verify
// their document effects. Fixtures are only the isolated in-memory demo.
import assert from 'node:assert/strict';
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from './lib/driver.mjs';
const {browser,page}=await launch({width:1440,height:1000});
let passed=0;
const check=(condition,message)=>{assert.ok(condition,message);passed++;console.log('  ✓ '+message);};
const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const clickText=async(selector,text)=>{const hit=await page.evaluate(({selector,text})=>{const el=[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===text);el?.click();return !!el;},{selector,text});assert.ok(hit,`button ${text}`);await paint();};
const read=()=>page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId),p=f.get(f.fig.project),s=f.get(f.slide.deckOverlay).slides.find(s=>s.id===sid);return {elements:p.figures.find(x=>x.id===sid).elements,beats:s.beats,active:f.get(f.slide.activeBeat),selection:[...f.get(f.fig.selection)]};});
try{
  await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:300});
  assert.ok(await clickMode(page,'Slide',{settle:300}));
  await waitFor(page,()=>!!window.__flux?.get(window.__flux.slide.deckOverlay),null,{timeout:15000,label:'deck load'});
  const initial=await read();
  check(initial.elements.filter(e=>e.type==='text').every(e=>e.color!=='#222222'),'dark-theme starter text uses presentation colors');
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.fig.commit(p=>p.figures.find(x=>x.id===sid).elements.push({type:'rect',id:'authoring-box',name:'Measured result',x:123,y:90,width:90,height:65,rotation:25,opacity:.6,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}));f.fig.selectOnly('authoring-box');});
  await clickText('.deckbar button','Animate ⏱');
  await clickText('.animator .actions button','Appear');
  let state=await read();
  check(state.beats[1].tracks.length===1,'visible Appear action inserts an effect');
  await page.click('.track-label');await page.keyboard.press('ArrowRight');
  state=await read();check(state.elements.find(e=>e.id==='authoring-box').x===123,'timeline arrow never nudges selected canvas object');
  await page.keyboard.press('Backspace');state=await read();
  check(state.elements.some(e=>e.id==='authoring-box')&&state.beats.every(b=>b.tracks.length===0),'timeline Backspace deletes only the effect');
  await clickText('.animator .actions button','Appear');
  await clickText('.animator .actions button','Emphasize');
  await clickText('.animator .actions button','Disappear');state=await read();
  check(state.beats[1].tracks.length===3,'adding emphasis and exit preserves entrance');
  check(state.beats[1].tracks.every((t,i,a)=>!i||t.start>=a[i-1].start+a[i-1].duration),'same-target effects sequence without overlap by default');
  const geometries=await page.$$eval('.lane-row[data-track-id] .target-label',els=>els.map(el=>({x:el.getBoundingClientRect().x,width:el.getBoundingClientRect().width,text:el.textContent})));
  check(geometries.every(g=>g.width>=200&&g.x===geometries[0].x),'fixed object labels stay readable independently of duration');
  // One earlier transformation, followed by a separate step with no transform.
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{const s=f.slideOps.slideById(d,sid);f.slideOps.setTransform(d,sid,s.beats[1].id,'authoring-box',{state:{x:250}});f.slideOps.addBeat(d,sid,{label:'Later conclusion'});});f.slide.activeBeat.set(2);});await paint();
  await clickText('.edit-switch button','Edit after step 2');
  state=await read();check(state.elements.find(e=>e.id==='authoring-box').x===250,'After-step view includes earlier transformation');
  // Real figure commit hits the synchronous adapter (the same boundary as a nudge).
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.fig.commit(p=>p.figures.find(x=>x.id===sid).elements.find(e=>e.id==='authoring-box').x=310);});
  state=await read();
  check(state.beats[1].tracks.find(t=>t.preset==='transform').to.state.x===250,'editing a later step never rewrites the earlier transformation');
  check(state.beats[2].tracks.find(t=>t.preset==='transform').to.state.x===310,'later edit creates that step’s sparse transformation');
  await clickText('.edit-switch button','Design');state=await read();
  check(state.elements.find(e=>e.id==='authoring-box').x===123,'Design restores canonical base geometry');
  await page.evaluate(()=>window.__flux.slide.activeBeat.set(1));await paint();state=await read();
  check(state.elements.find(e=>e.id==='authoring-box').x===123,'step browsing does not change Design edit destination');
  // Fit tracks the reduced stage pane after opening/resizing the Animator.
  await clickText('.edit-statebar button','Fit');
  const fit=await page.evaluate(()=>{const f=window.__flux,v=f.get(f.fig.viewport),stage=f.get(f.slide.deckOverlay).stage,r=document.querySelector('.canvas-wrap').getBoundingClientRect();return {bottom:v.panY+stage.height*v.zoom,height:r.height,right:v.panX+stage.width*v.zoom,width:r.width};});
  check(fit.bottom<=fit.height&&fit.right<=fit.width,'Fit keeps the entire stage within the pane above the dock');
  await clickText('.animator .transport button','Slide');
  await waitFor(page,()=>!!document.querySelector('.preview-overlay'),null,{timeout:3000,label:'preview visible'});
  await page.waitForFunction(()=>document.querySelector('.animator .transport button')?.textContent.includes('Pause'),{timeout:3000});
  await clickText('.animator .transport button','Ⅱ Pause');
  check(await page.$('.preview-overlay'),'pause retains an inspectable frame');
  await clickText('.animator .transport button','■ Stop');
  check(!(await page.$('.preview-overlay')),'Stop immediately returns to editing');
  // Native ruler scrubbing remains inspection: it cannot author or dirty state.
  await page.evaluate(()=>window.__flux.slide.activeBeat.set(1));await paint();
  const beforeScrub=await page.evaluate(()=>{const f=window.__flux;return {deck:JSON.stringify(f.slide.currentDeck()),destination:JSON.stringify(f.get(f.slide.editDestination)),dirty:f.get(f.fig.dirty)};});
  const ruler=await page.$eval('.ruler',e=>{const r=e.getBoundingClientRect();return{x:r.x+45,y:r.y+r.height/2};});
  await page.mouse.click(ruler.x,ruler.y);await paint();
  const afterScrub=await page.evaluate(()=>{const f=window.__flux;return {deck:JSON.stringify(f.slide.currentDeck()),destination:JSON.stringify(f.get(f.slide.editDestination)),dirty:f.get(f.fig.dirty),preview:!!document.querySelector('.preview-overlay')};});
  check(afterScrub.preview&&afterScrub.deck===beforeScrub.deck&&afterScrub.destination===beforeScrub.destination&&afterScrub.dirty===beforeScrub.dirty,'ruler scrubbing inspects a frame without authoring state or changing edit destination');
  await clickText('.animator .transport button','■ Stop');
  // Preview owns a captured deck: every history route must invalidate it,
  // including the shared toolbar and keymap outside the animation dock.
  const originalDuration=(await read()).beats[1].tracks[0].duration;
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{const t=f.slideOps.slideById(d,sid).beats[1].tracks[0];t.duration+=800;});});await paint();
  const scrubPaused=async()=>{const p=await page.$eval('.ruler',e=>{const r=e.getBoundingClientRect();return{x:r.x+45,y:r.y+r.height/2};});await page.mouse.click(p.x,p.y);await paint();assert.ok(await page.$('.preview-overlay'),'paused preview before history');};
  await scrubPaused();await page.click('[aria-label="Undo"]');await paint();
  check(!(await page.$('.preview-overlay'))&&(await read()).beats[1].tracks[0].duration===originalDuration,'toolbar Undo closes paused preview and restores the previous animation');
  await scrubPaused();await page.evaluate(()=>document.querySelector('.animator').focus());
  await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Shift');await page.keyboard.up('Control');await paint();
  check(!(await page.$('.preview-overlay'))&&(await read()).beats[1].tracks[0].duration===originalDuration+800,'timeline Redo closes paused preview and restores the changed animation');
  await scrubPaused();await page.evaluate(()=>document.activeElement?.blur());
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await paint();
  check(!(await page.$('.preview-overlay'))&&(await read()).beats[1].tracks[0].duration===originalDuration,'global Undo works from a paused preview and invalidates its deck snapshot');
  const tracksBefore=JSON.stringify((await read()).beats[1].tracks);
  const bar=await page.$eval('.lane-row[data-track-id] .trk',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  await page.mouse.move(bar.x,bar.y);await page.mouse.down();await page.mouse.move(bar.x+55,bar.y,{steps:4});await page.mouse.up();await paint();
  check((await read()).beats[1].tracks[0].start>0,'dragging the bar body retimes the effect');
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await paint();
  check(JSON.stringify((await read()).beats[1].tracks)===tracksBefore,'one Undo restores the complete retiming gesture');
  const edge=await page.$eval('.lane-row[data-track-id] .trk .edge',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  await page.mouse.move(edge.x,edge.y);await page.mouse.down();await page.mouse.move(edge.x+40,edge.y,{steps:4});await page.mouse.up();await paint();
  check((await read()).beats[1].tracks[0].duration>JSON.parse(tracksBefore)[0].duration,'dragging the right edge changes duration');
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await paint();
  // Group a complete selection, then Alt-drag the group to a new named step.
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>f.slideOps.addBeat(d,sid,{label:'Copied build'}));f.slide.activeBeat.set(1);document.querySelector('.animator').focus();});await paint();
  await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.press('KeyG');await page.keyboard.up('Control');await paint();
  const source=(await read()).beats[1];check(source.groups?.length===1&&source.tracks.every(t=>t.groupId===source.groups[0].id),'select-all and Group organize the entire step with one command owner');
  const group=await page.$eval('.group-span',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  const destination=await page.$eval('.step[data-step-index="3"]',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  await page.keyboard.down('Alt');await page.mouse.move(group.x,group.y);await page.mouse.down();await page.mouse.move(destination.x,destination.y,{steps:8});await page.mouse.up();await page.keyboard.up('Alt');await paint();
  state=await read();const copies=state.beats[3];
  check(copies.tracks.length===source.tracks.length&&state.beats[1].tracks.length===source.tracks.length&&copies.tracks.every(t=>!source.tracks.some(o=>o.id===t.id)),'Alt-dragging a group to a named step copies all effects with new identities');
  check(copies.groups?.[0]?.label===source.groups[0].label&&copies.tracks.every(t=>t.groupId===copies.groups[0].id),'group copy preserves its name and membership in the destination');
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await paint();
  check((await read()).beats[3].tracks.length===0,'one Undo reverses the complete group-copy gesture');
  check(realErrors(page).length===0,'console remains clean: '+realErrors(page).join('; '));
  await page.screenshot({path:'test-results/slide-authoring-overhaul.png',fullPage:true});
  console.log(`##VERIFY## ${JSON.stringify({name:'slide-authoring-gui',passed,failed:0})}`);
}finally{await browser.close();}
