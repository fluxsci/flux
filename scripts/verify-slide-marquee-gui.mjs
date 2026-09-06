// Timeline marquee gate: real pointer/keyboard gestures; only isolated fixture
// creation and state observations use the dev handle. No persisted user data.
import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,APP_URL,waitFor,realErrors} from './lib/driver.mjs';
const {browser,page}=await launch({width:1500,height:1080});
let passed=0;
const check=(value,message)=>{assert.ok(value,message);passed++;console.log('  ✓ '+message);};
const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const eq=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const state=()=>page.evaluate(()=>{const f=window.__flux;return {tracks:f.get(f.slide.selTrackIds),elements:[...f.get(f.fig.selection)],deck:JSON.stringify(f.slide.currentDeck()),history:JSON.stringify(f.fig.historyStats()),dirty:f.get(f.fig.dirty),destination:JSON.stringify(f.get(f.slide.editDestination)),highlight:[...document.querySelectorAll('.trk.sel')].map(e=>e.closest('[data-track-id]')?.dataset.trackId),marquee:!!document.querySelector('.timeline-marquee')};});
const pristine=(before,after)=>before.deck===after.deck&&before.history===after.history&&before.dirty===after.dirty&&before.destination===after.destination;
const box=selector=>page.$eval(selector,e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};});
const bar=id=>box(`[data-track-id="${id}"] .trk`);
const row=async id=>{const lane=await box(`[data-track-id="${id}"]`),cell=await box(`[data-track-id="${id}"] .time-cell`);return{...lane,x:cell.x,width:cell.width,right:cell.right};};
const clickTrack=async id=>{await page.click(`[data-track-id="${id}"] .track-label`);await paint();};
async function gesture(from,to,{modifier,live,cancel}={}){
  if(modifier)await page.keyboard.down(modifier);
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:4});await paint();
  if(live)await live();
  if(cancel==='Escape')await page.keyboard.press('Escape');
  if(cancel==='pointercancel')await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1})));
  await page.mouse.up();if(modifier)await page.keyboard.up(modifier);await paint();
}
const clickText=async(selector,text)=>{check(await page.evaluate(({selector,text})=>{const b=[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===text);b?.click();return !!b;},{selector,text}),`control available: ${text}`);await paint();};
try{
  await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:200});await clickMode(page,'Slide',{settle:200});
  await waitFor(page,()=>!!window.__flux?.get(window.__flux.slide.deckOverlay),null,{timeout:15000,label:'slide deck'});
  const fixture=await page.evaluate(async()=>{
    const f=window.__flux,sid=f.get(f.fig.activeFigureId);
    const {timelinePxPerMs}=await import('/src/shell/modes/slide/animator/animatorState.ts');timelinePxPerMs.set(.3);
    const {slideLayout}=await import('/src/shell/modes/slide/slideLayoutStore.ts');slideLayout.update(s=>({...s,animatorH:590}));
    const rect=(id,i)=>({id,type:'rect',name:id,x:40+i*60,y:50,width:45,height:35,rotation:0,opacity:1,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:4});
    f.plot.cachePlot('marquee-plot','<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60"><circle id="series.point.0" cx="20" cy="30" r="5"/><circle id="series.point.1" cx="50" cy="30" r="5"/><circle id="series.point.2" cx="80" cy="30" r="5"/></svg>',{spec:'fluxplot',schemaVersion:'0.2.0',axes:[],series:[],parts:{id:'figure',role:'figure',children:[{id:'series',role:'series',children:[0,1,2].map(i=>({id:`series.point.${i}`,role:'point',index:i}))}]}});
    const result=f.slide.commitDeckLive(d=>{
      const s=f.slideOps.slideById(d,sid);s.elements=[rect('object-a',0),rect('object-b',1),rect('object-c',2)];s.beats=[s.beats[0]];s.beats[0].tracks=[];
      f.slideOps.addPlotToSlide(d,sid,{assetId:'marquee-plot',x:250,y:50,width:100,height:60});s.elements.at(-1).id='plot-el';
      const beat=f.slideOps.addBeat(d,sid,{label:'Marquee fixture'});
      beat.tracks=[{id:'track-a',target:'object-a',preset:'fade',start:200,duration:200},{id:'track-b',target:'object-b',preset:'transform',to:{state:{x:160}},start:260,duration:300},{id:'track-c',target:'object-c',preset:'highlight',start:2100,duration:200},{id:'track-tail',target:'plot-el',part:'series',preset:'stagger',params:{child:'fade'},stagger:{perMs:120,by:'index'},start:600,duration:100}];
      const ghosts=f.slideOps.addGhostTransform(d,sid,beat.id,'object-a',{count:2,original:'stay',start:1100,duration:300});
      f.slideOps.setTrackGroup(d,sid,beat.id,ghosts.groupId,{collapsed:true});
      return {group:ghosts.groupId,ghostTracks:ghosts.trackIds,beat:beat.id};
    });f.slide.activeBeat.set(1);f.fig.clearSelection();f.slide.selTrackIds.set([]);return result;
  });
  await clickText('.deckbar button','Animate ⏱');
  await waitFor(page,()=>!window.__flux.get(window.__flux.fig.dirty),null,{timeout:8000,label:'fixture autosave'});
  await clickTrack('track-c');
  let baseline=await state();
  let a=await bar('track-a'),b=await bar('track-b'),ra=await row('track-a'),rb=await row('track-b');
  const forward={from:{x:ra.x+12,y:ra.y+12},to:{x:Math.max(a.right,b.right)+12,y:rb.bottom-2}};
  await gesture(forward.from,forward.to,{live:async()=>{const current=await state();check(current.marquee&&eq(current.highlight,['track-a','track-b']),'marquee highlights intersecting appearance and transform bars while dragging');check(eq(current.elements,baseline.elements),'live preview retains the prior canvas selection until release');}});
  let current=await state();
  check(eq(current.tracks,['track-a','track-b'])&&eq(current.elements,['object-a','object-b']),'release selects exactly the intersecting effects and their objects');
  check(!current.tracks.includes('track-c')&&pristine(baseline,current),'nonintersecting effects stay out and marquee changes no deck, history, dirty state or edit destination');
  a=await bar('track-a');b=await bar('track-b');ra=await row('track-a');rb=await row('track-b');
  await gesture({x:Math.max(a.right,b.right)+12,y:rb.bottom-2},{x:ra.x+12,y:ra.y+12});check(eq((await state()).tracks,['track-a','track-b']),'reverse-direction marquee has the same intersection semantics');
  // Each supported modifier unions with the existing selection.
  for(const modifier of ['Shift','Control','Meta']){
    await clickTrack('track-c');b=await bar('track-b');rb=await row('track-b');
    await gesture({x:rb.x+8,y:rb.y+2},{x:b.right+8,y:rb.bottom-2},{modifier});
    check(eq((await state()).tracks,['track-b','track-c']),`${modifier}-drag adds intersections to the prior selection`);
  }
  // A click on a row's empty time area has a different contract from its bar.
  rb=await row('track-b');
  await page.keyboard.down('Shift');await page.mouse.click(rb.x+10,rb.y+3);await page.keyboard.up('Shift');await paint();
  check(eq((await state()).tracks,['track-b','track-c']),'modified empty click preserves selection');
  await page.mouse.click(rb.x+10,rb.y+3);await paint();check(!(await state()).tracks.length,'unmodified empty click clears effect selection');
  for(const cancel of ['Escape','pointercancel']){
    await clickTrack('track-c');baseline=await state();
    a=await bar('track-a');b=await bar('track-b');ra=await row('track-a');rb=await row('track-b');
    await gesture({x:ra.x+12,y:ra.y+12},{x:Math.max(a.right,b.right)+12,y:rb.bottom-2},{cancel});current=await state();
    check(eq(current.tracks,['track-c'])&&eq(current.elements,baseline.elements)&&!current.marquee&&pristine(baseline,current),`${cancel} cancels a marquee and restores prior selection without authoring`);
  }
  // Tail-only intersection must include the effect even outside its solid bar.
  const tail=await box('[data-track-id="track-tail"] .tail'),tailRow=await row('track-tail');
  check(tail.width>20,'semantic fixture produces a visible stagger tail');
  await gesture({x:tail.x+8,y:tailRow.y+2},{x:tail.right-4,y:tailRow.bottom-2});
  check(eq((await state()).tracks,['track-tail']),'intersecting only the stagger tail selects its effect');
  const groupRow=await box(`[data-group-id="${fixture.group}"] .time-cell`),span=await box(`[data-group-id="${fixture.group}"] .group-span`);
  check(!await page.$(`[data-track-id="${fixture.ghostTracks[0]}"]`),'ghost group is collapsed in the actual timeline');
  await gesture({x:span.x-12,y:groupRow.y+2},{x:span.right+8,y:groupRow.bottom-2},{live:async()=>check(!!await page.$(`[data-group-id="${fixture.group}"] .group-span.sel`),'collapsed group span highlights live before release')});
  check(eq((await state()).tracks,fixture.ghostTracks),'intersecting a collapsed group span selects all its ghost birth tracks');
  // A selected-only filter keeps the original row set while the marquee is live.
  await clickTrack('track-a');await page.keyboard.down('Shift');await page.click('[data-track-id="track-b"] .track-label');await page.keyboard.up('Shift');await paint();
  await page.click('.step-controls .filter input');await paint();
  baseline=await state();b=await bar('track-b');rb=await row('track-b');
  const filteredRows=await page.$$eval('.lane-row[data-track-id]',els=>els.map(e=>e.dataset.trackId));
  await gesture({x:rb.x+5,y:rb.y+2},{x:b.right+10,y:rb.bottom-2},{live:async()=>check(eq(await page.$$eval('.lane-row[data-track-id]',els=>els.map(e=>e.dataset.trackId)),filteredRows),'selected-only rows remain stable during the drag')});
  check(eq((await state()).tracks,['track-b'])&&pristine(baseline,await state()),'filtered marquee commits the visible intersection without document edits');
  await page.click('.step-controls .filter input');await paint();
  // Retiming, duration handles, and ruler scrub still own their gestures.
  await clickTrack('track-b');baseline=await state();b=await bar('track-b');
  await gesture({x:b.x+b.width/2,y:b.y+b.height/2},{x:b.x+b.width/2+35,y:b.y+b.height/2});
  current=await state();check(JSON.parse(current.deck).slides[0].beats[1].tracks.find(t=>t.id==='track-b').start>260&&!current.marquee,'bar-body drag still retimes its effect');
  await page.click('[aria-label="Undo"]');await paint();check((await state()).deck===baseline.deck,'retiming remains one undoable authoring gesture');
  const edge=await box('[data-track-id="track-b"] .edge');
  await gesture({x:edge.x+edge.width/2,y:edge.y+edge.height/2},{x:edge.x+edge.width/2+35,y:edge.y+edge.height/2});
  check(JSON.parse((await state()).deck).slides[0].beats[1].tracks.find(t=>t.id==='track-b').duration>300,'duration-handle drag still resizes its effect');
  await page.click('[aria-label="Undo"]');await paint();baseline=await state();
  const ruler=await box('.ruler');await gesture({x:ruler.x+100,y:ruler.y+8},{x:ruler.x+180,y:ruler.y+8});
  check(!!await page.$('.preview-overlay')&&!await page.$('.timeline-marquee')&&pristine(baseline,await state()),'ruler drag still scrubs playback without marquee or authoring');
  await clickText('.animator .transport button','■ Stop');
  // A larger authored scene exercises offset math and selection cost. All rows
  // are mounted; the scroll viewport reveals only a small contiguous subset.
  await page.evaluate(async()=>{const {timelinePxPerMs}=await import('/src/shell/modes/slide/animator/animatorState.ts');timelinePxPerMs.set(1);});
  await page.evaluate(()=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{const s=f.slideOps.slideById(d,sid);s.elements=Array.from({length:125},(_,i)=>({id:`dense-el-${i}`,type:'rect',name:`Dense ${i}`,x:10+(i%20)*25,y:10+Math.floor(i/20)*25,width:18,height:18,rotation:0,opacity:1,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}));s.beats[1].groups=[];s.beats[1].tracks=s.elements.map((el,i)=>({id:`dense-${i}`,target:el.id,preset:'fade',start:1200,duration:100}));});f.fig.clearSelection();f.slide.selTrackIds.set([]);});await paint();
  await waitFor(page,()=>!window.__flux.get(window.__flux.fig.dirty),null,{timeout:8000,label:'dense fixture autosave'});
  await page.$eval('.timeline-scroll',e=>{e.scrollLeft=10000;e.scrollTop=30*48;});await paint();
  const offsets=await page.$eval('.timeline-scroll',e=>({x:e.scrollLeft,y:e.scrollTop}));check(offsets.x>0&&offsets.y>0,'timeline fixture has both horizontal and vertical scroll offsets');
  const dense=await bar('dense-50'),denseRow=await row('dense-50');baseline=await state();
  await gesture({x:dense.x-14,y:denseRow.y+2},{x:dense.right+14,y:denseRow.bottom-2});
  check(eq((await state()).tracks,['dense-50'])&&pristine(baseline,await state()),'scrolled marquee uses content coordinates rather than viewport origins');
  // Start above one row, scroll the viewport under a held pointer, then end
  // over a later row. The complete swept content band remains selected.
  await page.$eval('.timeline-scroll',e=>{e.scrollTop=30*45;});await paint();
  const first=await bar('dense-50'),firstRow=await row('dense-50');
  await page.mouse.move(first.x-14,firstRow.y+2);await page.mouse.down();await page.mouse.move(first.right+14,firstRow.bottom-2);await paint();
  await page.$eval('.timeline-scroll',e=>{e.scrollTop+=30*10;});await paint();
  const lastRow=await row('dense-60');await page.mouse.move(first.right+14,lastRow.bottom-2);await paint();await page.mouse.up();await paint();
  check(eq((await state()).tracks,Array.from({length:11},(_,i)=>`dense-${50+i}`)),'manual scrolling during marquee preserves its anchored content selection');
  // Hold near the lower edge without further pointer movement. The viewport
  // must keep scrolling, and cancel must stop that loop while preserving the
  // prior committed selection and all authoring state.
  await page.$eval('.timeline-scroll',e=>{e.scrollTop=30*45;});await paint();
  baseline=await state();
  const edgeBar=await bar('dense-50'),edgeRow=await row('dense-50');
  const edgeViewport=await page.$eval('.timeline-scroll',e=>({top:e.scrollTop,bottom:e.getBoundingClientRect().top+e.clientTop+e.clientHeight}));
  await page.mouse.move(edgeBar.x-14,edgeRow.y+2);await page.mouse.down();
  await page.mouse.move(edgeBar.right+14,edgeViewport.bottom-6);
  await waitFor(page,top=>document.querySelector('.timeline-scroll').scrollTop>top+30,edgeViewport.top,{timeout:1500,interval:20,label:'held marquee edge autoscroll'});
  current=await state();
  check(current.marquee&&eq(current.tracks,baseline.tracks)&&eq(current.elements,baseline.elements)&&pristine(baseline,current),'holding a marquee at the edge autoscrolls without committing selection or edits');
  await page.keyboard.press('Escape');await page.mouse.up();await paint();
  const stopped=await page.evaluate(async()=>{
    const area=document.querySelector('.timeline-scroll'),positions=[area.scrollTop];
    for(let i=0;i<4;i++){await new Promise(r=>requestAnimationFrame(r));positions.push(area.scrollTop);}
    return positions;
  });
  current=await state();
  check(stopped.every(top=>top===stopped[0])&&!current.marquee&&eq(current.tracks,baseline.tracks)&&eq(current.elements,baseline.elements)&&pristine(baseline,current),'Escape and release stop edge autoscroll across subsequent paints and preserve prior selection/history');
  // Pointermove-to-next-paint includes matching over all 125 candidates.
  await page.$eval('.timeline-scroll',e=>{e.scrollTop=0;});await paint();
  const perfBar=await bar('dense-2'),perfRow=await row('dense-2');
  await page.mouse.move(perfBar.x-14,perfRow.y+2);await page.mouse.down();
  const latency=await page.evaluate(async({x,y})=>{const start=performance.now();window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:x,clientY:y,pointerId:1}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {ms:performance.now()-start,marquee:!!document.querySelector('.timeline-marquee'),selected:[...document.querySelectorAll('.trk.sel')].map(e=>e.closest('[data-track-id]').dataset.trackId)};},{x:perfBar.right+14,y:perfRow.bottom+5*30-2});
  await page.mouse.up();await paint();
  check(latency.marquee&&eq(latency.selected,Array.from({length:6},(_,i)=>`dense-${i+2}`)),'125-track measurement includes an active marquee and the expected live highlights');
  check(latency.ms<=100,`125-track marquee paints within 100ms (${latency.ms.toFixed(1)}ms)`);
  check(realErrors(page).length===0,'renderer remains free of errors');
  await page.screenshot({path:'test-results/slide-timeline-marquee.png'});
  console.log(`##VERIFY## ${JSON.stringify({script:'verify-slide-marquee-gui',ok:true,checks:passed,failed:0})}`);
}catch(error){console.error(error);console.error('Renderer errors',realErrors(page));await page.screenshot({path:'test-results/slide-timeline-marquee-failure.png'}).catch(()=>{});console.log(`##VERIFY## ${JSON.stringify({script:'verify-slide-marquee-gui',ok:false,checks:passed+1,failed:1})}`);process.exitCode=1;}finally{await browser.close();}
