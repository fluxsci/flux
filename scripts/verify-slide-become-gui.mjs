// Transform ▸ Become in the editor: the pick flow with real controls and canvas
// gestures (draw the target with the Rect tool, pick an existing object, cancel
// with Escape), the record it writes, the consumed target, After-step checkout,
// one-step Undo, the Properties pane's Destination row, and the chord.
// 2026-10-02 (Become picker, owner ask "A better 'Become' UI"): a pick no longer
// confirms on the first click — clicks toggle picks and b / Enter / the Become
// button confirm, a double-click picks + confirms; drawing joins the pick (Add
// mode) instead of being consumed at once; the canvas selection clears while
// picking. The mode itself is pinned by verify-become-picker-gui.mjs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from './lib/driver.mjs';
const {browser,page}=await launch({width:1500,height:1040});
let passed=0;
const check=(condition,message)=>{assert.ok(condition,message);passed++;console.log('  ✓ '+message);};
const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const clickText=async(selector,text)=>{await page.evaluate(({selector,text})=>{const el=[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===text||e.textContent.trim().startsWith(text));if(!el)throw new Error('Missing '+text);el.click();},{selector,text});await paint();};
const openTransform=async(item)=>{await clickText('.animator .actions button','Transform ▾');await page.waitForSelector('.menu button[role="menuitem"]');await clickText('.menu button[role="menuitem"]',item);};
const read=()=>page.evaluate(()=>{const f=window.__flux,d=f.slide.currentDeck(),id=f.get(f.fig.activeFigureId);return {slide:d.slides.find(s=>s.id===id),display:f.get(f.fig.project).figures.find(s=>s.id===id).elements,destination:f.get(f.slide.editDestination),selected:[...f.get(f.fig.selection)],tracks:f.get(f.slide.selTrackIds),beat:f.get(f.slide.activeBeat),presentation:f.get(f.slide.slideCanvasPresentation)};});
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
  check(items.join('|')==='Change|Ghost…|Become','the Transform menu offers exactly Change · Ghost… · Become');
  check(!(await page.$$eval('.animator .bar button',els=>els.some(e=>/Data morph|Ghost transform…/.test(e.textContent)))),'the old Change / Ghost transform… / Data morph… buttons are gone');
  await page.keyboard.press('Escape');await paint();
  // --- Become by clicking an existing object ---------------------------------------------
  await openTransform('Become');
  let state=await read();
  check(!!await page.$('.become-bar')&&state.destination.kind==='after'&&state.beat===1&&state.slide.beats.length===2,'Become arms a pick bar, creates the first step and checks it out After');
  check(!state.selected.length&&!!await page.$('[data-pick-source]')&&await page.$eval('.become-bar .become-msg',e=>e.textContent.includes('Arrow')),'the bar names the source; the selection clears and the source wears the pick outline');
  const legacyConsume=await page.evaluate(()=>{const f=window.__flux,d=structuredClone(f.slide.currentDeck()),sid=f.get(f.fig.activeFigureId),s=f.slideOps.slideById(d,sid);f.slideOps.becomeTransform(d,sid,s.beats[1].id,'src-line','tgt-ellipse');return s;});
  const blob=await center('tgt-ellipse');await page.mouse.click(blob.x,blob.y);await paint();
  check(!!await page.$('.become-bar')&&!(await read()).slide.beats[1].tracks.length,'a click picks the ellipse without confirming');
  await page.keyboard.press('b');await paint();await paint();
  state=await read();
  const track=state.slide.beats[1].tracks.find(t=>t.target==='src-line');
  legacyConsume.beats[1].tracks[0].id=track.id;
  check(JSON.stringify(state.slide)===JSON.stringify(legacyConsume),'loose-object consume preserves the legacy operation bytes, apart from the fresh track id');
  check(!!track&&track.preset==='transform'&&track.to.state.type==='ellipse'&&track.to.state.fill==='#d14d41'&&!state.slide.elements.some(e=>e.id==='tgt-ellipse'),'clicking the ellipse: the line\'s transform endpoint is the ellipse and the ellipse is consumed');
  check(!(await page.$('.become-bar'))&&state.destination.kind==='after'&&state.selected[0]==='src-line'&&state.tracks[0]===track.id,'the pick disarms, selects the transform and keeps the After checkout');
  check(state.display.find(e=>e.id==='src-line').type==='ellipse'&&state.slide.elements.find(e=>e.id==='src-line').type==='line','the canvas shows the source AS the ellipse; the document still holds the line');
  check(await page.$eval('.lane-row small',e=>e.textContent.trim())==='Transform · Become','the lane reads "Transform · Become"');
  check(await page.$eval('.props .dest .dv',e=>e.textContent.trim())==='Became an ellipse (consumed)','the Properties pane records the consumed destination');
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
  check(!(await page.$('.become-bar'))&&JSON.stringify((await read()).slide)===before&&(await read()).selected[0]==='other','Escape cancels the pick with no document change and restores the source selection');
  // --- Become by DRAWING the target with the Rect tool ----------------------------------------
  await openTransform('Become');
  await clickText('.toolbar .tools button','Rect');
  const stage=await page.$eval('.canvas-wrap',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
  await page.mouse.move(stage.x+stage.w*0.55,stage.y+stage.h*0.6);await page.mouse.down();await page.mouse.move(stage.x+stage.w*0.7,stage.y+stage.h*0.8,{steps:6});await page.mouse.up();await paint();await paint();
  check(!!await page.$('.become-bar')&&!(await read()).slide.beats[1].tracks.some(t=>t.target==='other')&&await page.$$eval('[data-pick-unit]',e=>e.length===1),'drawing while armed adds the rect to the pick (Add mode) instead of confirming');
  await page.keyboard.press('Enter');await paint();await page.keyboard.press('b');await paint();await paint();
  state=await read();
  const drawn=state.slide.beats[1].tracks.find(t=>t.target==='other');
  check(!!drawn&&!('type' in drawn.to.state)&&drawn.to.state.width>100&&drawn.to.state.fill!=='#879a39'&&state.slide.elements.length===2&&!(await page.$('.become-bar')),'Enter then b makes "Other" become the drawn rect (same kind → an ordinary patch); the drawn rect is consumed');
  check(state.display.find(e=>e.id==='other').type==='rect'&&Math.abs(state.display.find(e=>e.id==='other').width-drawn.to.state.width)<0.01,'the canvas shows the drawn geometry as the After state');
  // --- the source itself is never a target; a video never takes part ---------------------------
  await openTransform('Become');
  const self=await center('other');await page.mouse.click(self.x,self.y);await paint();
  check(!!await page.$('.become-bar'),'clicking the source itself keeps the pick armed');
  await page.keyboard.press('Escape');await paint();
  // --- Become from the Properties pane re-points an existing transform -------------------------
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{const s=f.slideOps.slideById(d,sid);s.elements.push({id:'late',type:'ellipse',name:'Late',x:500,y:250,width:80,height:80,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0});});});await paint();
  await page.evaluate(()=>{const f=window.__flux;f.slide.activeBeat.set(1);const s=f.slide.composedSlide(f.get(f.fig.activeFigureId));f.slide.selTrackIds.set([s.beats[1].tracks.find(t=>t.target==='src-line').id]);});await paint();
  await clickText('.inspector-tabs button','Animation');
  await clickText('.props .dacts button','Become');
  check(!!await page.$('.become-bar')&&await page.$eval('.become-bar .become-msg',e=>e.textContent.includes('Arrow')),'the pane\'s Become arms the pick for that transform\'s target');
  const late=await center('late');await page.mouse.click(late.x,late.y,{count:1});await page.mouse.click(late.x,late.y,{count:2});await paint();await paint();state=await read();
  const repointed=state.slide.beats[1].tracks.find(t=>t.target==='src-line');
  check(repointed.to.state.type==='ellipse'&&repointed.to.state.fill==='#4385be'&&!state.slide.elements.some(e=>e.id==='late')&&state.slide.beats[1].tracks.filter(t=>t.target==='src-line').length===1,'re-pointing replaces the endpoint on the SAME track (still one transform per object per step)');
  // --- playback: the preview plays the morph without errors ---------------------------------------
  await page.click('.step-controls button[title="Replay this step"]');
  await waitFor(page,()=>!!document.querySelector('.preview-overlay'),null,{timeout:3000,label:'preview'});
  await new Promise(r=>setTimeout(r,250));
  const mid=await page.evaluate(()=>{const el=document.querySelector('.preview-host [data-el-id="src-line"]');return el?el.innerHTML.includes('<path'):null;});
  check(mid===true,'the step preview renders the live morph path mid-flight');
  await clickText('.animator .transport button','■ Stop');
  // Hand-offs: real canvas picks, X-ray rows and Appear's split menu all
  // write the same source-owned record. A pre-existing empty Change gives
  // every route the same track identity for exact byte comparisons.
  const svg=readFileSync('scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.svg','utf8');
  const manifest=JSON.parse(readFileSync('scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.fluxplot.json','utf8'));
  await page.evaluate((svg,manifest)=>window.__flux.io.reimportPlot('bh-asset',svg,manifest),svg,manifest);
  const seed=async()=>{
    await page.evaluate(()=>{
      const f=window.__flux,sid=f.get(f.fig.activeFigureId);
      f.slide.setEditDestination({kind:'design'});
      f.slide.selTrackIds.set([]);f.fig.partSelection.set(null);f.fig.selection.set(new Set());
      f.slide.commitDeckLive(d=>{
        d.stage={width:640,height:360};
        const s=f.slideOps.slideById(d,sid);delete s.groups;
        s.elements=[
          {id:'bh-path',type:'path',name:'Path 1',x:50,y:100,width:170,height:100,rotation:0,d:'M0 100 L85 0 L170 100',nodes:[{x:0,y:100,type:'corner'},{x:85,y:0,type:'corner'},{x:170,y:100,type:'corner'}],closed:false,fill:'none',stroke:'#222222',strokeWidth:4},
          {id:'bh-plot',type:'plot',name:'Plot 1',assetId:'bh-asset',x:330,y:50,width:270,height:240,rotation:0,overrides:{}},
          {id:'bh-rect',type:'rect',name:'Rect 1',x:50,y:255,width:110,height:55,rotation:0,fill:'#879a39',stroke:'none',strokeWidth:0,cornerRadius:0},
          {id:'bh-rect2',type:'rect',name:'Rect 2',x:190,y:255,width:80,height:55,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0},
        ];
        s.beats=[{id:'bh-design',label:'Design',tracks:[]},{id:'bh-step',label:'Landing',tracks:[{id:'bh-track',target:'bh-path',preset:'transform',to:{state:{}},duration:600,easing:'smooth',start:0}]}];
      });
      f.slide.activeBeat.set(1);f.fig.selectOnly('bh-path');
    });
    await paint();await clickText('.edit-statebar button','Fit');
  };
  const handoff=state=>state.slide.beats.flatMap(b=>b.tracks).find(t=>t.to?.become?.mode==='handoff');
  const mod=process.platform==='darwin'?'Meta':'Control';
  // Clicks toggle picks now (no modifier needed); Shift / Ctrl are kept as the old habit.
  const confirm=async()=>{await page.keyboard.press('Enter');await paint();};
  const pickPart=async(pid,shift=false)=>{
    const point=await page.evaluate(pid=>{
      const wrapper=document.querySelector('[data-editor-element-id="bh-plot"]');
      const node=[...wrapper.querySelectorAll('[id]')].find(e=>e.id.endsWith('__'+pid));
      const path=node.matches('path')?node:node.querySelector('path');
      const p=path.getPointAtLength(path.getTotalLength()*.55),m=path.getScreenCTM();
      const q=new DOMPoint(p.x,p.y).matrixTransform(m);return{x:q.x,y:q.y};
    },pid);
    if(shift)await page.keyboard.down('Shift');await page.keyboard.down(mod);
    await page.mouse.click(point.x,point.y);await page.keyboard.up(mod);if(shift)await page.keyboard.up('Shift');await paint();
  };
  const clickObject=async(id,shift=false,alt=false)=>{const p=await center(id);if(shift)await page.keyboard.down('Shift');if(alt)await page.keyboard.down('Alt');await page.mouse.click(p.x,p.y);if(alt)await page.keyboard.up('Alt');if(shift)await page.keyboard.up('Shift');await paint();};
  const openPlotXray=async()=>{
    const p=await center('bh-plot');await page.mouse.move(p.x,p.y);await page.keyboard.down('Alt');await page.keyboard.press('KeyR');await page.keyboard.up('Alt');
    await waitFor(page,()=>document.activeElement?.classList.contains('xray'),null,{label:'X-ray keyboard focus'});
  };
  const pickRows=async()=>{
    // Expand axis rows with their real disclosure controls (containers stay
    // available here even though they are canvas drag scaffolding).
    for(const axis of ['axis.x','axis.y']){
      const row=await page.$(`.xray [data-rid="part:bh-plot__${axis}"]`);
      if(!await page.$(`.xray [data-rid="part:bh-plot__${axis}.spine"]`))await row.$eval('.tw',e=>e.click());
    }
    await page.click('.xray [data-rid="part:bh-plot__axis.x.spine"]');
    await page.keyboard.down(mod);await page.click('.xray [data-rid="part:bh-plot__axis.y.spine"]');await page.keyboard.up(mod);await paint();
  };
  await seed();await openTransform('Become');await pickPart('axis.x.spine');await confirm();state=await read();
  check(JSON.stringify(handoff(state)?.to.become.ref)==='{"element":"bh-plot","parts":["axis.x.spine"]}','picking a spine then Enter creates a part hand-off');
  check(state.destination.kind==='after'&&state.presentation.hiddenElementIds.includes('bh-path')&&state.presentation.partStates['bh-plot']['axis.x.spine'].visible,'After checkout reveals the spine and hides the path');
  check(await page.$eval('[data-editor-element-id="bh-path"]',e=>Number(e.getAttribute('opacity'))===.25),'the canvas paints the hidden source as a Show hidden ghost');
  await clickText('.edit-switch button','Design');state=await read();
  check(!state.presentation.hiddenElementIds.includes('bh-path')&&state.presentation.partStates['bh-plot']?.['axis.x.spine']?.visible===false,'Design restores the source and hides the future landing spine');
  check(await page.$eval('[data-editor-element-id="bh-plot"]',e=>[...e.querySelectorAll('[id]')].find(n=>n.id.endsWith('__axis.x.spine')).style.opacity==='0.25'),'the canvas paints the future spine as a Show hidden ghost in Design');
  await seed();await openTransform('Become');await pickPart('axis.x.spine',true);await pickPart('axis.y.spine',true);state=await read();
  check(!handoff(state)&&!!await page.$('.become-bar')&&await page.$$eval('[data-pick-unit]',els=>els.length===2),'Shift+Ctrl-click accumulates two outlined spines without committing');
  await page.screenshot({path:'test-results/slide-become-two-spines.png'});
  await page.keyboard.press('Enter');await paint();state=await read();
  check(JSON.stringify(handoff(state)?.to.become.ref)==='{"element":"bh-plot","parts":["axis.x.spine","axis.y.spine"]}','Enter commits one hand-off ref containing both spines');
  check(await page.evaluate(()=>{const toast=[...document.querySelectorAll('.toast')].reverse().find(el=>el.textContent.includes('hands off to')&&el.textContent.toLowerCase().includes('x axis spine + 1'));return !!toast&&[...toast.querySelectorAll('button')].some(b=>b.textContent.includes('Auto-animate the rest'));}),'a part hand-off toast offers Auto-animate the rest…');
  // One ref label (animator/shared.ts refLabel): the toast names both sides exactly as the lane does.
  const laneC=await page.$eval(`.lane-row[data-track-id="${handoff(state).id}"] .track-label`,e=>e.firstChild.textContent.trim());
  check(laneC==='Path 1 → Plot 1 › X axis spine + 1'&&await page.evaluate(()=>[...document.querySelectorAll('.toast')].some(el=>el.textContent.includes('‹Path 1› hands off to ‹Plot 1 › X axis spine + 1›'))),'the toast and the lane share one ref label ("Plot 1 › X axis spine + 1")');
  const pairBytes=JSON.stringify(state.slide);
  await seed();await openTransform('Become');await clickObject('bh-plot',false,true);await confirm();state=await read();
  check(JSON.stringify(handoff(state)?.to.become.ref)==='{"element":"bh-plot"}'&&state.slide.elements.some(e=>e.id==='bh-plot'),'Alt+click (the whole plot) then Enter hands off to the whole plot and retains it');
  check(await page.evaluate(()=>{const toast=[...document.querySelectorAll('.toast')].reverse().find(el=>/hands off to ‹Plot 1›/.test(el.textContent));return !!toast&&![...toast.querySelectorAll('button')].some(el=>el.textContent.includes('Auto-animate the rest'));}),'a whole-plot hand-off toast offers no Auto-animate the rest… (nothing is left to build)');
  await seed();await pickPart('peaches.box');await openTransform('Become');
  const barSource=await page.$eval('.become-bar .become-msg strong',e=>e.textContent.trim());
  await clickObject('bh-rect');await confirm();state=await read();
  check(await page.$eval(`.lane-row[data-track-id="${handoff(state).id}"] .track-label`,(e,src)=>e.firstChild.textContent.trim()===`${src} → Rect 1`,barSource),'the pick bar names a part-set source exactly as its lane does');
  check(handoff(state)?.target==='bh-plot'&&JSON.stringify(handoff(state)?.parts??[handoff(state)?.part])==='["peaches.box"]'&&handoff(state)?.to.become.ref.element==='bh-rect','a drilled box is the source of a part-level hand-off to a rect');
  await clickText('.props .dacts button','Become');await clickObject('bh-rect2');await confirm();state=await read();
  const retargeted=state.slide.beats[1].tracks.filter(t=>t.target==='bh-plot');
  check(retargeted.length===1&&JSON.stringify(retargeted[0].parts??[retargeted[0].part])==='["peaches.box"]'&&retargeted[0].to.become.ref.element==='bh-rect2'&&state.slide.elements.some(e=>e.id==='bh-rect2'),'inspector retargeting preserves the part source and the hand-off completion');
  const beforeSwap=JSON.stringify(state.slide), oldTrack=retargeted[0];
  await clickText('.props .dacts button','↔ Swap direction');state=await read();
  const swapped=state.slide.beats[1].tracks.find(t=>t.to?.become?.ref.element==='bh-plot');
  check(swapped?.target==='bh-rect2'&&JSON.stringify(swapped.to.become.ref.parts)==='["peaches.box"]'&&swapped.duration===oldTrack.duration&&state.tracks[0]===swapped.id,'the real Swap direction button uses the shared op, reverses part refs and selects the new lane');
  await page.click('[aria-label="Undo"]');await paint();
  check(JSON.stringify((await read()).slide)===beforeSwap,'one GUI Undo restores the exact pre-swap slide');
  await seed();await openTransform('Become');await openPlotXray();await pickRows();
  check(!handoff(await read()),'X-ray row picking never prematurely confirms the canvas pick');
  await page.keyboard.press('m');await paint();
  check(await page.$eval('.xray .am-ttl',e=>e.textContent.includes('Path 1')),'the destination menu names the waiting source');
  await page.keyboard.press('b');await paint();
  check(JSON.stringify((await read()).slide)===pairBytes,'X-ray b writes exactly the two-spine canvas hand-off bytes');
  await seed();await page.evaluate(()=>window.__flux.fig.selectOnly('bh-plot'));await openPlotXray();await pickRows();
  await page.keyboard.press('Escape');await paint();
  await page.click('[aria-label="Appear options"]');await clickText('.menu button[role="menuitem"]','Appear from…');
  check(await page.$eval('.become-msg',e=>e.textContent.includes('appears from')&&e.textContent.includes('+ 1')),'Appear from names the destination part set');
  // The path's midpoint is on the apex; its bounding-box center is empty.
  const pathPoint=await page.$eval('[data-editor-element-id="bh-path"] path',el=>{const p=el.getPointAtLength(el.getTotalLength()*.5),q=new DOMPoint(p.x,p.y).matrixTransform(el.getScreenCTM());return{x:q.x,y:q.y};});
  await page.mouse.click(pathPoint.x,pathPoint.y);await paint();await confirm();
  check(JSON.stringify((await read()).slide)===pairBytes,'Appear split-menu from two X-ray spines writes byte-identical hand-off');
  await seed();await page.evaluate(()=>window.__flux.fig.selectOnly('bh-plot'));await openPlotXray();await pickRows();await page.keyboard.press('m');await page.keyboard.press('5');await paint();
  await page.mouse.click(pathPoint.x,pathPoint.y);await paint();await confirm();
  check(JSON.stringify((await read()).slide)===pairBytes,'X-ray a then 5 authors the same hand-off from its destination');
  await seed();await openTransform('Become');await pickPart('axis.x.spine',true);const cancelBytes=JSON.stringify((await read()).slide);await page.keyboard.press('Escape');await paint();
  check(!await page.$('.become-bar')&&JSON.stringify((await read()).slide)===cancelBytes,'Escape discards accumulated picks without a track or document change');
  await seed();await openTransform('Become');await page.select('[aria-label="Become pairing"]','data');await pickPart('axis.x.spine');await confirm();
  check(handoff(await read())?.to.become.pair==='data','Pair by data is written on the hand-off record');
  // Several separate objects need W1's destination sets; until they exist the pick refuses clearly.
  const setsSupported=await page.evaluate(async()=>typeof (await import('/src/lib/slide/targets.ts')).normalizeRef==='function');
  if(!setsSupported){
    await seed();await openTransform('Become');await clickObject('bh-rect',true);await clickObject('bh-rect2',true);await page.keyboard.press('Enter');await paint();
    check(!handoff(await read())&&!!await page.$('.become-bar')&&await page.evaluate(()=>document.body.textContent.includes('Pick parts of one object, or one object')),'multiple whole objects are refused clearly and the pick stays armed');
    await page.keyboard.press('Escape');
  }
  await seed();await openTransform('Become');await pickPart('axis.x.spine',true);await pickPart('axis.y.spine',true);await clickText('.become-bar button','Become');await paint();
  await page.evaluate(()=>{const toast=[...document.querySelectorAll('.toast')].find(el=>el.textContent.toLowerCase().includes('x axis spine + 1'));const button=[...toast.querySelectorAll('button')].find(el=>el.textContent.includes('Auto-animate the rest'));button.click();});await paint();state=await read();
  const landingIndex=state.slide.beats.findIndex(b=>b.id==='bh-step'),generated=state.slide.beats.flatMap((b,i)=>b.tracks.filter(t=>t.generatedBy==='auto-reveal').map(t=>({t,i})));
  check(generated.length>0&&generated.every(({t,i})=>i>landingIndex&&!['axis.x.spine','axis.y.spine'].includes(t.part)),'toast Auto-animate the rest generates later reveals without the landed spines');
  check(state.presentation.partStates['bh-plot']['axis.x.spine'].visible&&state.presentation.partStates['bh-plot']['peaches.box'].visible===false,'landing shows the spines while the remaining plot waits for its later build');
  await page.screenshot({path:'test-results/slide-become-landing.png'});
  check(realErrors(page).length===0,'no renderer errors');
  console.log(`##VERIFY## ${JSON.stringify({script:'verify-slide-become-gui',ok:true,checks:passed,failed:0})}`);
}catch(error){console.error(error);console.error('Renderer errors',realErrors(page));await page.screenshot({path:'test-results/slide-become-failure.png'}).catch(()=>{});console.log(`##VERIFY## ${JSON.stringify({script:'verify-slide-become-gui',ok:false,checks:passed+1,failed:1})}`);process.exitCode=1;}finally{await browser.close();}
