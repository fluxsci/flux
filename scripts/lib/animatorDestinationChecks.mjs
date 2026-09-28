// D2: public ops seed hand-offs; real inspector controls author every edit.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const paint = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const read = page => page.evaluate(() => { const f=window.__flux; return f.slide.currentDeck().slides.find(s=>s.id===f.get(f.fig.activeFigureId)); });
async function click(page, selector, text) {
  const handle=await page.evaluateHandle(({selector,text})=>[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===text),{selector,text});
  assert.ok(handle.asElement(),`action ${text}`); await handle.click(); await handle.dispose(); await paint(page);
}
async function select(page,id) { await page.click(`.lane-row[data-track-id="${id}"] .track-label`); await paint(page); }
const track = s => s.beats.flatMap(b=>b.tracks).find(t=>t.to?.become);
export async function verifyDestinations(page,ok) {
  await page.setViewport({width:1600,height:1000});
  const ids=await page.evaluate(async()=>{
    const f=window.__flux, {compileSlide}=await import('/src/lib/slide/compile.ts');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><path id="axis.x.spine" d="M20 100H180" stroke="#333" fill="none"/><path id="axis.y.spine" d="M20 100V10" stroke="#333" fill="none"/><rect id="box.2" x="65" y="35" width="30" height="40" fill="#4385be"/><rect id="box.3" x="130" y="20" width="25" height="55" fill="#d14d41"/></svg>';
    const manifest={spec:'fluxplot',schemaVersion:'0.2.0',axes:[],series:[],parts:{id:'figure',role:'figure',children:[{id:'axis.x',role:'axis',axis:'x',children:[{id:'axis.x.spine',role:'spine'}]},{id:'axis.y',role:'axis',axis:'y',children:[{id:'axis.y.spine',role:'spine'}]},{id:'box.2',role:'box',label:'Box #2'},{id:'box.3',role:'box',label:'Box #3'}]},build:{order:['axis.x','axis.y','box.2','box.3'],presets:{box:{animation:'fade-in',durationMs:300}}}};
    f.plot.cachePlot('d2-asset',svg,manifest);
    let sid,tid;
    f.slide.commitDeckLive(d=>{
      const s=f.slideOps.addSlide(d,{layout:'blank',name:'D2 Destination'});sid=s.id;
      s.elements=[{id:'d2-path',name:'path 1',type:'path',x:50,y:70,width:110,height:60,rotation:0,closed:false,d:'M0 60L55 0L110 60',nodes:[{x:0,y:60,type:'corner'},{x:55,y:0,type:'corner'},{x:110,y:60,type:'corner'}],stroke:'#333',strokeWidth:3,fill:'none'},
        {id:'d2-plot',name:'Plot 1',type:'plot',assetId:'d2-asset',x:300,y:50,width:240,height:144,rotation:0},
        {id:'d2-ellipse',type:'ellipse',x:80,y:220,width:80,height:60,rotation:0,fill:'#e68',stroke:'none',strokeWidth:0}];
      const b=f.slideOps.addBeat(d,sid,{label:'Landing'});
      tid=f.slideOps.becomeTransform(d,sid,b.id,'d2-path',{element:'d2-plot',parts:['axis.x.spine','axis.y.spine']},{mode:'handoff',duration:740,compiled:compileSlide(s,d.stage,{plotManifest:id=>f.get(f.plot.plotManifests)[id]})}).trackId;
    });f.slide.selectSlide(sid);f.slide.activeBeat.set(1);return {sid,tid};
  });
  await paint(page);await select(page,ids.tid);await click(page,'.inspector-tabs button','Animation');
  ok(await page.$eval('.dest .dv',e=>e.textContent.trim())==='hands off to Plot 1 › X axis spine, Y axis spine · pair: auto','Destination names both human-readable spine parts');
  ok(await page.$eval(`.lane-row[data-track-id="${ids.tid}"] .track-label`,e=>e.textContent.includes('path 1 → Plot 1 › X axis spine + 1')&&e.textContent.includes('Transform · Become')),'hand-off lane names both sides and Transform · Become');
  ok(!await page.$('.props .delta')&&!await page.$('[aria-label="Animation plot part"]'),'hand-off hides Δ and the transform part selector');
  for(const pair of ['spatial','order','tile','auto','data']) {
    await page.select('[aria-label="Hand-off pair"]',pair);await paint(page);
    ok(track(await read(page)).to.become.pair===pair,`Pair writes ${pair} through the real inspector`);
  }
  await click(page,'[aria-label="Hand-off reveal"] button','draw');
  ok(track(await read(page)).to.become.reveal==='draw','Reveal draw writes the hand-off record');
  await click(page,'[aria-label="Hand-off reveal"] button','flip');
  ok(track(await read(page)).to.become.reveal==='flip','Reveal flip writes the hand-off record');
  mkdirSync('test-results/d2',{recursive:true});await page.screenshot({path:'test-results/d2/destination.png'});
  const before=JSON.stringify(await read(page));
  await click(page,'.dest button','↔ Swap direction');
  let s=await read(page),t=track(s);
  ok(t.target==='d2-plot'&&JSON.stringify(t.parts)===JSON.stringify(['axis.x.spine','axis.y.spine'])&&JSON.stringify(t.to.become.ref)==='{"element":"d2-path"}'&&!s.beats.flatMap(b=>b.tracks).some(t=>t.id===ids.tid),'Swap writes destination parts as the new SOURCE and the old source as destination; old track is gone');
  ok(t.duration===740&&t.to.become.pair==='data'&&t.to.become.reveal==='flip','Swap preserves timing, pairing and reveal');
  ok(await page.$eval(`.lane-row[data-track-id="${t.id}"] .track-label`,e=>e.textContent.includes('Plot 1 › X axis spine + 1 → path 1')),'reverse lane describes a part-set source');
  await page.click('[aria-label="Undo"]');await paint(page);
  ok(JSON.stringify(await read(page))===before,'ONE undo restores the exact original hand-off and both objects');
  await select(page,ids.tid);
  await page.evaluate(tid=>{const f=window.__flux;f.slide.commitDeckLive(d=>{
    const s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId)),b=s.beats[1];
    const style=f.slideOps.addAnimStyle(d,{name:'D2 flight',family:'transform',track:{preset:'transform',duration:900,easing:'quadIn',influence:{in:20,out:35}}});
    f.slideOps.linkTrackStyle(d,s.id,tid,style.id);
    const lead=f.slideOps.appendAnimation(d,s.id,b.id,{target:'d2-ellipse',preset:'fade',duration:300});
    const follower=f.slideOps.appendAnimation(d,s.id,b.id,{target:'d2-path',preset:'dim',duration:100,anchor:{trackId:tid,edge:'end',offsetMs:11}});
    f.slideOps.setTrackAnchor(d,s.id,tid,{trackId:lead.id,edge:'end',offsetMs:35});
    f.slideOps.groupTracks(d,s.id,b.id,[tid,follower.id],'Linked flight');
  });},ids.tid);await paint(page);
  const styledBefore=JSON.stringify(await read(page)),styleId=track(JSON.parse(styledBefore)).styleId;
  await click(page,'.dest button','↔ Swap direction');s=await read(page);t=track(s);
  ok(t.styleId===styleId&&!Object.hasOwn(t,'duration')&&!Object.hasOwn(t,'easing')&&t.anchor?.offsetMs===35,'Swap retains linked style inheritance and its timing anchor');
  ok(s.beats[1].tracks.find(t=>t.preset==='dim').anchor.trackId===t.id&&s.beats[1].groups.some(g=>g.id===t.groupId&&g.label==='Linked flight'),'Swap rebinds timing followers and preserves the lane group');
  ok(Number(await page.$eval('.props [data-fld="d"]',e=>e.value))===900,'reversed inspector still resolves the inherited duration');
  await page.click('[aria-label="Undo"]');await paint(page);
  ok(JSON.stringify(await read(page))===styledBefore,'ONE undo restores the exact styled hand-off, followers and group');
  await page.click('[aria-label="Undo"]');await paint(page);await select(page,ids.tid);
  ok(await page.$eval('.dest',e=>e.textContent.includes('Auto-animate the rest…')),'a part hand-off offers Auto-animate the rest…');
  await click(page,'.dest button','Auto-animate the rest…');
  s=await read(page);
  const built=s.beats.flatMap((b,i)=>b.tracks.filter(t=>t.generatedBy==='auto-reveal').map(t=>({t,i})));
  ok(built.length===2&&built.every(({t,i})=>i>1&&t.target==='d2-plot'&&['box.2','box.3'].includes(t.part)),'Auto-animate rest builds only boxes, after the landing step');
  ok(!await page.$eval('.dest',e=>e.textContent.includes('Auto-animate the rest…')),'rest action disappears once the plot has appearance tracks');
  await page.click('[aria-label="Undo"]');await paint(page);
  // A whole-plot hand-off already reveals every part: nothing is left to build.
  await page.evaluate(()=>{const f=window.__flux;f.slide.commitDeckLive(d=>{const s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId));f.slideOps.becomeTransform(d,s.id,s.beats[1].id,'d2-path',{element:'d2-plot'},{mode:'handoff'});});});await paint(page);await select(page,ids.tid);
  ok(JSON.stringify(track(await read(page)).to.become.ref)==='{"element":"d2-plot"}'&&!!await page.$('.dest')&&!await page.$eval('.dest',e=>e.textContent.includes('Auto-animate the rest…')),'a whole-plot hand-off offers no Auto-animate the rest…');
  await page.click('[aria-label="Undo"]');await paint(page);
  // Whole-object hand-off → the inline, two-click consume path.
  await page.evaluate(()=>{const f=window.__flux;f.slide.commitDeckLive(d=>{const s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId));f.slideOps.becomeTransform(d,s.id,s.beats[1].id,'d2-path',{element:'d2-ellipse'},{mode:'handoff'});});});await paint(page);await select(page,ids.tid);
  const consumeBefore=JSON.stringify(await read(page));
  await click(page,'.dest button','Consume instead');
  ok(JSON.stringify(await read(page))===consumeBefore&&!!await page.$('.dest .warn'),'first Consume click only arms inline confirmation');
  await click(page,'.dest button','Cancel');
  ok(JSON.stringify(await read(page))===consumeBefore,'Cancel leaves the hand-off untouched');
  await click(page,'.dest button','Consume instead');await click(page,'.dest button','Confirm Consume');
  s=await read(page);t=track(s);
  ok(!s.elements.some(e=>e.id==='d2-ellipse')&&t.to.state.type==='ellipse'&&t.to.become.mode==='consume','confirmed Consume removes the ellipse and writes its type into the endpoint');
  ok(await page.$eval('.dest .dv',e=>e.textContent.trim())==='Became an ellipse (consumed)','consumed Destination states the completion explicitly');
  await page.click('[aria-label="Undo"]');await paint(page);
  ok(JSON.stringify(await read(page))===consumeBefore,'ONE undo restores the consumed ellipse and hand-off record');
  // Labels for authored box names, larger part sets and multiple plots.
  await page.evaluate(async()=>{const f=window.__flux,{compileSlide}=await import('/src/lib/slide/compile.ts');f.slide.commitDeckLive(d=>{const s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId));s.elements.push({...s.elements.find(e=>e.id==='d2-plot'),id:'d2-second',name:'Plot 2',x:600});f.slideOps.becomeTransform(d,s.id,s.beats[1].id,'d2-path',{element:'d2-plot',parts:['box.2','axis.x.spine','axis.y.spine']},{mode:'handoff',compiled:compileSlide(s,d.stage,{plotManifest:id=>f.get(f.plot.plotManifests)[id]})});});});await paint(page);await select(page,ids.tid);
  ok(await page.$eval('.dest .dv',e=>e.textContent.includes('Plot 1 › Box #2 + 2')),'three destination parts collapse to the first human label plus count');
  ok(await page.$eval(`.lane-row[data-track-id="${ids.tid}"] .track-label`,e=>e.textContent.includes('P1 · Plot 1 › Box #2 + 2')),'hand-off lane retains the destination P-tag');
  await click(page,'.dest button','↔ Swap direction');s=await read(page);t=track(s);
  ok(await page.$eval(`.lane-row[data-track-id="${t.id}"] .track-label`,e=>e.textContent.includes('P1 · Plot 1 › Box #2 + 2 → path 1')),'part-set SOURCE uses human box labels and retains its P-tag');
  await page.click('[aria-label="Undo"]');await paint(page);
  // A destination group cannot be a source; the refusal is visible before clicking.
  await page.evaluate(()=>{const f=window.__flux;f.slide.commitDeckLive(d=>{const s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId));s.groups={destination:{id:'destination',name:'Destination group'}};s.elements.find(e=>e.id==='d2-ellipse').groupId='destination';f.slideOps.becomeTransform(d,s.id,s.beats[1].id,'d2-path',{element:'d2-ellipse',group:'destination'},{mode:'handoff'});});});await paint(page);await select(page,ids.tid);
  ok(await page.$$eval('.dest button',els=>{const b=els.find(e=>e.textContent.includes('Swap direction'));return b.disabled&&b.title.includes('Groups cannot')&&!els.some(e=>e.textContent==='Consume instead');}),'group destination disables Swap with a reason and offers no Consume');
  // Real Canvas drill and the real Zoom action use the evaluated part outline.
  await page.evaluate(()=>{const f=window.__flux;f.slide.commitDeckLive(d=>{const s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId));f.slideOps.removeTracks(d,s.id,s.beats.flatMap(b=>b.tracks.map(t=>t.id)));});f.slide.setEditDestination({kind:'design'});f.slide.selTrackIds.set([]);f.fig.selection.set(new Set());});await paint(page);
  await click(page,'.edit-statebar button','Fit');
  const box=await page.$eval('.canvas-wrap [id="d2-plot__box.2"]',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  const mod=process.platform==='darwin'?'Meta':'Control';await page.keyboard.down(mod);await page.mouse.click(box.x,box.y);await page.keyboard.up(mod);await paint(page);
  ok(await page.evaluate(()=>window.__flux.get(window.__flux.fig.partSelections).some(p=>p.elementId==='d2-plot'&&p.partId==='box.2')),'Ctrl-click drills the real rendered Box #2');
  const expected=await page.evaluate(async()=>{const f=window.__flux,{compileSlide}=await import('/src/lib/slide/compile.ts'),{targetOutlines}=await import('/src/lib/slide/targetGeometry.ts'),d=f.slide.currentDeck(),s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId));const frame=compileSlide(s,d.stage,{plotManifest:id=>f.get(f.plot.plotManifests)[id]}).sample(f.get(f.slide.activeBeat));const o=targetOutlines({element:'d2-plot',parts:['box.2']},frame,{manifest:id=>f.get(f.plot.plotManifests)[id],plotRoot:id=>f.plot.plotDom.get(id)})[0].bbox;return{x:o.x+o.w/2,y:o.y+o.h/2,zoom:Math.max(1.05,Math.min(d.stage.width/o.w,d.stage.height/o.h)*.82)};});
  await click(page,'.animator .bar button','🎥 Zoom');s=await read(page);const camera=s.beats.at(-1).tracks.find(t=>t.target==='@camera');
  ok(camera&&['x','y','zoom'].every(k=>Math.abs(camera.to[k]-expected[k])<1e-8),'Zoom frames the drilled box’s targetOutlines bbox with the 0.82 rule');
  await page.screenshot({path:'test-results/d2/camera-to-box.png'});
  // M5 integration: the stage-level camera lane stays selectable while a drilled part is selected.
  await select(page,camera.id);
  ok(await page.evaluate(id=>{const f=window.__flux,ids=f.get(f.slide.selTrackIds);return ids.length===1&&ids[0]===id&&!!document.querySelector('[aria-label="Camera path"]');},camera.id),'clicking a drilled-part camera lane selects its track and shows the Path row');
  await page.evaluate(()=>{const f=window.__flux;f.slide.activeBeat.set(1);f.fig.selection.set(new Set(['d2-plot']));f.fig.setPartSelections([{elementId:'d2-plot',partId:'box.2'},{elementId:'d2-plot',partId:'box.3'}]);});await paint(page);
  await click(page,'.animator .bar button','🎥 Zoom');s=await read(page);
  const unionCamera=s.beats.at(-1).tracks.find(t=>t.target==='@camera');
  ok(Math.abs(unionCamera.to.x-(300+(65+155)/2*1.2))<1e-8&&Math.abs(unionCamera.to.y-(50+(20+75)/2*1.2))<1e-8&&unionCamera.to.zoom<camera.to.zoom,'Zoom unions every selected part rather than using only the primary');
  await page.evaluate(()=>{const f=window.__flux;f.slide.activeBeat.set(1);f.fig.setPartSelections([]);});await paint(page);
  await click(page,'.animator .bar button','🎥 Zoom');s=await read(page);
  const wholeCamera=s.beats.at(-1).tracks.find(t=>t.target==='@camera');
  ok(wholeCamera.to.x===420&&wholeCamera.to.y===122&&wholeCamera.to.zoom<unionCamera.to.zoom,'Zoom without drilled parts keeps whole-element framing');
  // Invalid saved records still diagnose and open the owning track for repair.
  const issues=await page.evaluate(async()=>{
    const f=window.__flux,{compileSlide}=await import('/src/lib/slide/compile.ts');let sid;
    f.slide.commitDeckLive(d=>{
      const s=f.slideOps.addSlide(d,{layout:'blank',name:'D2 Issues'});sid=s.id;
      const rect=id=>({id,type:'rect',x:40,y:40,width:50,height:30,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0});
      s.elements=['issue-missing','issue-overlap-a','issue-overlap-b','issue-unborn','issue-parent'].map(rect);
      s.elements.push({id:'issue-plot',type:'plot',assetId:'d2-asset',name:'Plot',x:300,y:50,width:240,height:144,rotation:0});
      const b=f.slideOps.addBeat(d,sid,{label:'Broken landings'}),later=f.slideOps.addBeat(d,sid,{label:'Birth'});
      const ghost=f.slideOps.addGhostTransform(d,sid,later.id,'issue-parent',{count:1});
      const add=(id,target,ref)=>f.slideOps.setAnimation(d,sid,b.id,{id,target,preset:'transform',to:{state:{},become:{mode:'handoff',ref}}});
      add('missing-parts','issue-missing',{element:'issue-plot',parts:['absent.part']});
      add('first-landing','issue-overlap-a',{element:'issue-plot',parts:['box.2']});
      add('overlap-landing','issue-overlap-b',{element:'issue-plot',parts:['box.2']});
      add('unborn-landing','issue-unborn',{element:ghost.elementIds[0]});
      const textA=f.slideOps.addSlideText(d,sid,{text:'From',x:40,y:160,width:100,height:35});
      const textB=f.slideOps.addSlideText(d,sid,{text:'To',x:220,y:160,width:100,height:35});
      add('no-outline',textA,{element:textB});
    });f.slide.selectSlide(sid);f.slide.activeBeat.set(1);
    const d=f.slide.currentDeck(),s=d.slides.find(s=>s.id===sid);
    return compileSlide(s,d.stage,{plotManifest:id=>f.get(f.plot.plotManifests)[id]}).issues.filter(i=>['missing-parts','overlap-landing','unborn-landing','no-outline'].includes(i.trackId));
  });await paint(page);
  ok(issues.length===4,'compiler reports missing parts, overlapping hand-offs, unborn destination and no-outline pair');
  await page.$eval('.animation-issues',e=>e.open=true);
  for(const issue of issues){
    await click(page,'.animation-issues button',issue.reason);
    ok(await page.evaluate(id=>{const f=window.__flux;return f.get(f.slide.selTrackIds).join()===id&&f.get(f.slide.activeBeat)===1&&!!document.querySelector('.props .dest');},issue.trackId),`${issue.trackId}: issue click selects its track and opens Animation properties`);
  }
}
