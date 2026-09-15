// Transform ▸ Become in the editor: the pick flow with real controls and canvas
// gestures (draw the target with the Rect tool, click an existing object, cancel
// with Escape), the record it writes, the consumed target, After-step checkout,
// one-step Undo, the Properties pane's Destination row, and the chord.
import assert from 'node:assert/strict';
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from './lib/driver.mjs';
const {browser,page}=await launch({width:1500,height:1040});
let passed=0;
const check=(condition,message)=>{assert.ok(condition,message);passed++;console.log('  ✓ '+message);};
const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const clickText=async(selector,text)=>{await page.evaluate(({selector,text})=>{const el=[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===text||e.textContent.trim().startsWith(text));if(!el)throw new Error('Missing '+text);el.click();},{selector,text});await paint();};
const openTransform=async(item)=>{await clickText('.animator .actions button','Transform ▾');await page.waitForSelector('.menu button[role="menuitem"]');await clickText('.menu button[role="menuitem"]',item);};
const read=()=>page.evaluate(()=>{const f=window.__flux,d=f.slide.currentDeck(),id=f.get(f.fig.activeFigureId);return {slide:d.slides.find(s=>s.id===id),display:f.get(f.fig.project).figures.find(s=>s.id===id).elements,destination:f.get(f.slide.editDestination),selected:[...f.get(f.fig.selection)],tracks:f.get(f.slide.selTrackIds),beat:f.get(f.slide.activeBeat)};});
const center=id=>page.$eval(`[data-editor-element-id="${id}"]`,e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
try{
  await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:200});await clickMode(page,'Slide',{settle:200});
  await waitFor(page,()=>!!window.__flux?.get(window.__flux.slide.deckOverlay),null,{timeout:15000,label:'deck load'});
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{d.stage={width:640,height:360};const s=f.slideOps.slideById(d,sid);s.elements=[
    {id:'src-line',type:'line',name:'Arrow',x:60,y:200,width:0,height:0,rotation:0,x1:0,y1:0,x2:200,y2:-40,stroke:'#4385be',strokeWidth:4,arrowStart:false,arrowEnd:true},
    {id:'tgt-ellipse',type:'ellipse',name:'Blob',x:360,y:80,width:180,height:120,rotation:0,fill:'#d14d41',stroke:'#100f0f',strokeWidth:3},
    {id:'other',type:'rect',name:'Other',x:40,y:40,width:60,height:40,rotation:0,fill:'#879a39',stroke:'none',strokeWidth:0,cornerRadius:0}];
    s.beats=[s.beats[0]];s.beats[0].tracks=[];});f.fig.selectOnly('src-line');});await paint();
  await clickText('.deckbar button','Animate ⏱');await clickText('.edit-statebar button','Fit');
  // --- the menu is ONE class of action with three ways ---------------------------------
  await clickText('.animator .actions button','Transform ▾');await page.waitForSelector('.menu button[role="menuitem"]');
  const items=await page.$$eval('.menu button[role="menuitem"]',els=>els.map(e=>e.firstChild.textContent.trim()));
  check(items.join('|')==='Change|Ghost…|Become…','the Transform menu offers exactly Change · Ghost… · Become…');
  check(!(await page.$$eval('.animator .bar button',els=>els.some(e=>/Data morph|Ghost transform…/.test(e.textContent)))),'the old Change / Ghost transform… / Data morph… buttons are gone');
  await page.keyboard.press('Escape');await paint();
  // --- Become by clicking an existing object ---------------------------------------------
  await openTransform('Become…');
  let state=await read();
  check(!!await page.$('.become-bar')&&state.destination.kind==='after'&&state.beat===1&&state.slide.beats.length===2,'Become arms a pick bar, creates the first step and checks it out After');
  check(state.selected[0]==='src-line'&&await page.$eval('.become-bar .become-msg',e=>e.textContent.includes('Arrow')),'the bar names the source; the source stays selected while picking');
  const blob=await center('tgt-ellipse');await page.mouse.click(blob.x,blob.y);await paint();await paint();
  state=await read();
  const track=state.slide.beats[1].tracks.find(t=>t.target==='src-line');
  check(!!track&&track.preset==='transform'&&track.to.state.type==='ellipse'&&track.to.state.fill==='#d14d41'&&!state.slide.elements.some(e=>e.id==='tgt-ellipse'),'clicking the ellipse: the line\'s transform endpoint is the ellipse and the ellipse is consumed');
  check(!(await page.$('.become-bar'))&&state.destination.kind==='after'&&state.selected[0]==='src-line'&&state.tracks[0]===track.id,'the pick disarms, selects the transform and keeps the After checkout');
  check(state.display.find(e=>e.id==='src-line').type==='ellipse'&&state.slide.elements.find(e=>e.id==='src-line').type==='line','the canvas shows the source AS the ellipse; the document still holds the line');
  check(await page.$eval('.lane-row small',e=>e.textContent.trim())==='Transform · Become','the lane reads "Transform · Become"');
  check(await page.$eval('.props .dest .dv',e=>e.textContent.trim())==='Becomes an ellipse','the Properties pane summarizes the destination');
  // --- one Undo restores the target and removes the track ------------------------------
  await page.click('[aria-label="Undo"]');await paint();state=await read();
  check(state.slide.elements.some(e=>e.id==='tgt-ellipse')&&!state.slide.beats[1].tracks.length,'one Undo restores the consumed target and removes the transform together');
  await page.click('[aria-label="Redo"]');await paint();state=await read();
  check(!state.slide.elements.some(e=>e.id==='tgt-ellipse')&&state.slide.beats[1].tracks.length===1,'Redo re-applies the Become as one step');
  // --- Escape cancels the pick without changes; the chord arms it -------------------------
  await page.evaluate(()=>window.__flux.fig.selectOnly('other'));await paint();
  await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyE');await page.keyboard.up('Shift');await page.keyboard.up('Control');await paint();
  check(!!await page.$('.become-bar')&&await page.$eval('.become-bar .become-msg',e=>e.textContent.includes('Other')),'Ctrl+Shift+E arms Become for the selected object');
  const before=JSON.stringify((await read()).slide);
  await page.keyboard.press('Escape');await paint();
  check(!(await page.$('.become-bar'))&&JSON.stringify((await read()).slide)===before,'Escape cancels the pick with no document change');
  // --- Become by DRAWING the target with the Rect tool ----------------------------------------
  await openTransform('Become…');
  await clickText('.toolbar .tools button','Rect');
  const stage=await page.$eval('.canvas-wrap',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
  await page.mouse.move(stage.x+stage.w*0.55,stage.y+stage.h*0.6);await page.mouse.down();await page.mouse.move(stage.x+stage.w*0.7,stage.y+stage.h*0.8,{steps:6});await page.mouse.up();await paint();await paint();
  state=await read();
  const drawn=state.slide.beats[1].tracks.find(t=>t.target==='other');
  check(!!drawn&&!('type' in drawn.to.state)&&drawn.to.state.width>100&&drawn.to.state.fill!=='#879a39'&&state.slide.elements.length===2&&!(await page.$('.become-bar')),'drawing a rect while armed makes "Other" become it (same kind → an ordinary patch); the drawn rect is consumed');
  check(state.display.find(e=>e.id==='other').type==='rect'&&Math.abs(state.display.find(e=>e.id==='other').width-drawn.to.state.width)<0.01,'the canvas shows the drawn geometry as the After state');
  // --- the source itself is never a target; a video never takes part ---------------------------
  await openTransform('Become…');
  const self=await center('other');await page.mouse.click(self.x,self.y);await paint();
  check(!!await page.$('.become-bar'),'clicking the source itself keeps the pick armed');
  await page.keyboard.press('Escape');await paint();
  // --- Become from the Properties pane re-points an existing transform -------------------------
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{const s=f.slideOps.slideById(d,sid);s.elements.push({id:'late',type:'ellipse',name:'Late',x:500,y:250,width:80,height:80,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0});});});await paint();
  await page.evaluate(()=>{const f=window.__flux;f.slide.activeBeat.set(1);const s=f.slide.composedSlide(f.get(f.fig.activeFigureId));f.slide.selTrackIds.set([s.beats[1].tracks.find(t=>t.target==='src-line').id]);});await paint();
  await clickText('.inspector-tabs button','Animation');
  await clickText('.props .dacts button','Become an object…');
  check(!!await page.$('.become-bar')&&(await read()).selected[0]==='src-line','the pane\'s Become an object… arms the pick for that transform\'s target');
  const late=await center('late');await page.mouse.click(late.x,late.y);await paint();await paint();state=await read();
  const repointed=state.slide.beats[1].tracks.find(t=>t.target==='src-line');
  check(repointed.to.state.type==='ellipse'&&repointed.to.state.fill==='#4385be'&&!state.slide.elements.some(e=>e.id==='late')&&state.slide.beats[1].tracks.filter(t=>t.target==='src-line').length===1,'re-pointing replaces the endpoint on the SAME track (still one transform per object per step)');
  // --- playback: the preview plays the morph without errors ---------------------------------------
  await page.click('.step-controls button[title="Replay this step"]');
  await waitFor(page,()=>!!document.querySelector('.preview-overlay'),null,{timeout:3000,label:'preview'});
  await new Promise(r=>setTimeout(r,250));
  const mid=await page.evaluate(()=>{const el=document.querySelector('.preview-host [data-el-id="src-line"]');return el?el.innerHTML.includes('<path'):null;});
  check(mid===true,'the step preview renders the live morph path mid-flight');
  await clickText('.animator .transport button','■ Stop');
  check(realErrors(page).length===0,'no renderer errors');
  console.log(`##VERIFY## ${JSON.stringify({script:'verify-slide-become-gui',ok:true,checks:passed,failed:0})}`);
}catch(error){console.error(error);console.error('Renderer errors',realErrors(page));await page.screenshot({path:'test-results/slide-become-failure.png'}).catch(()=>{});console.log(`##VERIFY## ${JSON.stringify({script:'verify-slide-become-gui',ok:false,checks:passed+1,failed:1})}`);process.exitCode=1;}finally{await browser.close();}
