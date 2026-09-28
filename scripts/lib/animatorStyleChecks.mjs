// F2 integration coverage: fixtures enter through public ops; every edit uses the real UI.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { waitFor } from './driver.mjs';
const shots = 'notes/flux_animation_v2/workers/out/shots/F2';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const paint = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function clickText(page, selector, text) {
  const handle = await page.evaluateHandle(({selector,text}) => [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text), {selector,text});
  assert.ok(handle.asElement(), `visible action ${text}`); await handle.click(); await handle.dispose(); await paint(page);
}
async function field(page, selector, value) {
  await page.$eval(selector, (e, value) => { e.value = String(value); e.dispatchEvent(new Event('change', {bubbles:true})); }, value); await paint(page);
}
async function shot(page, name) { mkdirSync(shots, {recursive:true}); await paint(page); await page.screenshot({path:`${shots}/${name}.png`}); }
const read = page => page.evaluate(() => { const f=window.__flux, d=f.slide.currentDeck(), s=d.slides.find(s=>s.id===f.get(f.fig.activeFigureId)); return {styles:d.animStyles, slide:s, tracks:s.beats[f.get(f.slide.activeBeat)].tracks}; });
async function select(page, ids) {
  for (let i=0;i<ids.length;i++) { if(i)await page.keyboard.down(mod); await page.click(`.lane-row[data-track-id="${ids[i]}"] .track-label`); if(i)await page.keyboard.up(mod); }
  await paint(page);
}
async function bar(page, id) { return page.$eval(`.lane-row[data-track-id="${id}"] .trk`, e=>({left:parseFloat(e.style.left),width:parseFloat(e.style.width)})); }
async function styleAction(page, label) { await page.click('[aria-label="Animation style"]'); await clickText(page,'.style-menu button',label); }
async function lockScale(page) {
  const r=await page.$eval('.ruler',e=>{const r=e.getBoundingClientRect();return {x:r.x+100,y:r.y+10};});
  await page.mouse.move(r.x,r.y);await page.keyboard.down(mod);await page.mouse.wheel({deltaY:-1});await page.keyboard.up(mod);await paint(page);
}
async function seed(page, name) {
  const ids=await page.evaluate(name=>{
    const f=window.__flux;let sid;f.slide.commitDeckLive(d=>sid=f.slideOps.addSlide(d,{name:`F2 ${name}`,layout:'blank'}).id);f.slide.selectSlide(sid);const targets=['a','b','c','d'].map(x=>`f2-${name}-${x}`);
    f.fig.commit(p=>{const s=p.figures.find(s=>s.id===sid);targets.forEach((id,i)=>s.elements.push({id,type:'rect',name:['Lead','Follow','Plain','Fourth'][i],x:50+i*130,y:180,width:90,height:70,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}));});
    const tids=[];let bi;
    f.slide.commitDeckLive(d=>{const s=f.slideOps.slideById(d,sid),b=f.slideOps.addBeat(d,sid,{label:name});bi=s.beats.indexOf(b);
      targets.forEach((target,i)=>tids.push(f.slideOps.appendAnimation(d,sid,b.id,{target,preset:'fade',start:i*50,duration:300}).id));
    });f.slide.activeBeat.set(bi);return {targets,tids};
  },name);await paint(page);await select(page,[ids.tids[0]]);return ids;
}
async function pickLike(page, trackIds, target, capture=false) {
  await select(page,trackIds);
  await page.click(`.lane-row[data-track-id="${trackIds[0]}"] .trk`,{button:'right'});
  await clickText(page,'[role=menu] button','Animate like…');
  assert.ok(await page.$('[aria-label="Animate like pick"]'),'Animate like armed');
  if(capture)await shot(page,'05-animate-like-armed');
  const el=await page.$(`.canvas-wrap .el[data-editor-element-id="${target}"]`);
  assert.ok(el,`canvas target ${target}`);await el.click();await paint(page);
}
export async function verifyLinkedStyles(page, ok) {
  await page.setViewport({width:1600,height:1000});
  const {targets,tids}=await seed(page,'styles');
  await page.evaluate(()=>{const f=window.__flux;f.slide.commitDeckLive(d=>f.slideOps.addAnimStyle(d,{name:'Gentle reveal',family:'appearance',track:{preset:'fade',start:200,duration:900,easing:'linear'}},'f2-style'));});
  await select(page,tids.slice(0,2));await page.click('[aria-label="Animation style"]');await shot(page,'01-style-picker');
  await page.click('.style-option[data-style-id="f2-style"]');await paint(page);
  let state=await read(page), a=await bar(page,tids[0]), b=await bar(page,tids[1]);
  ok(state.tracks.slice(0,2).every(t=>t.styleId==='f2-style'&&!Object.hasOwn(t,'start')&&!Object.hasOwn(t,'duration')) && Math.abs(a.left/a.width-200/900)<.001 && a.left===b.left,'picker writes style links and both lanes inherit the style’s resolved start and duration');
  await lockScale(page);await select(page,[tids[0]]);await field(page,'.props [data-fld="d"]',450);
  state=await read(page);ok(state.tracks[0].duration===450&&!!await page.$('[data-override="duration"]'),'duration edit writes a local override and shows the override/reset idiom');
  await shot(page,'02-linked-duration-override');
  await page.click('[aria-label="Use style duration"]');await paint(page);state=await read(page);
  ok(!Object.hasOwn(state.tracks[0],'duration')&&Number(await page.$eval('.props [data-fld="d"]',e=>e.value))===900,'use style deletes the own duration and restores the inherited value');
  await field(page,'.props [data-fld="p"]','fadeRise');state=await read(page);
  ok(state.tracks[0].preset==='fadeRise'&&state.styles.find(s=>s.id==='f2-style').track.preset==='fade'&&!!await page.$('[data-override="preset"]'),'preset edits remain local and show their override');await shot(page,'15-preset-override');
  await page.click('[aria-label="Use style preset"]');await paint(page);state=await read(page);
  ok(state.tracks[0].preset==='fade'&&Object.hasOwn(state.tracks[0],'preset'),'preset reset copies the style preset while retaining the family-defining own field');
  await field(page,'.props [data-fld="p"]','fadeRise');
  await styleAction(page,'Edit style…');await shot(page,'03-editing-style');
  ok((await page.$eval('.editing-style',e=>e.textContent)).includes('2 tracks'),'style editor names the shared style and counts linked tracks');
  const before=await bar(page,tids[0]);
  const propagation=await page.evaluate(async ids=>{
    const e=document.querySelector('.props [data-fld="d"]'),start=performance.now();e.value='1200';e.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>requestAnimationFrame(r));
    return {ms:performance.now()-start,widths:ids.map(id=>parseFloat(document.querySelector(`.lane-row[data-track-id="${id}"] .trk`).style.width))};
  },tids.slice(0,2));
  state=await read(page);ok(state.styles.find(s=>s.id==='f2-style').track.duration===1200&&propagation.widths.every(w=>Math.abs(w-before.width*1200/900)<.1),'editing the style changes BOTH real bars by the next animation frame');
  ok(state.tracks[0].preset==='fadeRise','editing shared duration preserves a linked effect’s local preset override');
  await clickText(page,'.editing-style button','Back to effect');await page.click('[aria-label="Use style preset"]');await styleAction(page,'Detach');state=await read(page);
  ok(!state.tracks[0].styleId&&state.tracks[0].duration===1200&&state.tracks[0].start===200&&state.tracks[0].easing==='linear','Detach materializes the resolved fields onto the track');
  await select(page,[tids[2]]);await styleAction(page,'Save as new style…');await shot(page,'07-save-style-name');
  await page.type('[aria-label="New animation style name"]','Plain reveal');await clickText(page,'.style-save button','Save');state=await read(page);
  ok(state.styles.some(s=>s.name==='Plain reveal'&&s.id===state.tracks[2].styleId),'inline Save as new style creates a deck style and links the plain track');
  await pickLike(page,[tids[0],tids[3]],targets[1],true);state=await read(page);
  ok(state.tracks[0].styleId==='f2-style'&&state.tracks[3].styleId==='f2-style','Animate like links a multi-selection to the picked object’s existing style');
  await select(page,[tids[2]]);await styleAction(page,'Detach');
  await pickLike(page,[tids[3]],targets[2]);state=await read(page);
  ok(state.styles.some(s=>s.name==='Like Plain'&&s.id===state.tracks[2].styleId)&&state.tracks[3].styleId===state.tracks[2].styleId,'Animate like creates Like ‹object label› from an unstyled source and links both effects');
  const tx=await page.evaluate(target=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);let id;f.slide.commitDeckLive(d=>{const s=f.slideOps.slideById(d,sid);id=f.slideOps.setTransform(d,sid,s.beats[f.get(f.slide.activeBeat)].id,target,{state:{x:650}}).id;});return id;},targets[3]);
  await select(page,[tids[0],tx]);ok(await page.$eval('[aria-label="Animation style"]',e=>e.disabled)&&/one family/.test(await page.$eval('.style-reason',e=>e.textContent)),'mixed-family selection disables the picker with a reason');await shot(page,'08-mixed-family');
  await pickLike(page,[tx],targets[1]);
  ok(await page.evaluate(()=>document.body.textContent.includes('Family mismatch: transform track cannot link to appearance style')),'Animate like reports the shared op’s family refusal');await shot(page,'09-family-refusal');
  // The X-ray keeps its selection in the shared stores; use its actual chord and row.
  await page.evaluate(targets=>{document.activeElement?.blur();window.__flux.fig.selection.set(new Set(targets));},targets.slice(0,2));
  await page.keyboard.down(mod);await page.keyboard.press('KeyG');await page.keyboard.up(mod);
  await page.keyboard.down('Alt');await page.keyboard.press('KeyR');await page.keyboard.up('Alt');await page.waitForSelector('.xray');
  await waitFor(page,()=>!!document.activeElement?.closest('.xray'),null,{label:'X-ray keyboard focus'});
  await page.keyboard.press('6');await paint(page);
  ok(!!await page.$('[aria-label="Animate like pick"]')&&!await page.$('.xray'),'X-ray 6 arms Animate like from its real object selection');
  await page.keyboard.press('Escape');await paint(page);ok(!await page.$('[aria-label="Animate like pick"]'),'Escape cancels Animate like');
  // A linked effect saved into the global library must capture inherited fields.
  await select(page,[tids[1]]);await page.click('.props .saveas');await page.type('.props .psave input','Linked library reveal');await clickText(page,'.props .psave button','Save');
  await waitFor(page,()=>JSON.parse(localStorage.getItem('flux.presets.animations')||'[]').some(p=>p.payload.name==='Linked library reveal'),null,{label:'linked preset saved'});
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('flux.presets.animations')).find(p=>p.payload.name==='Linked library reveal'));
  ok(saved.payload.track.duration===1200&&saved.payload.track.start===200,'Save as preset captures the resolved linked track settings');
  await page.evaluate(target=>window.__flux.fig.selectOnly(target),targets[0]);await clickText(page,'.animator .bar button','☆ Library');await shot(page,'06-library-copy-and-link');
  await page.click('.animlib [title="Apply Linked library reveal as a linked style"]');await paint(page);state=await read(page);
  const libraryTrack=state.tracks.find(t=>t.target===targets[0]&&t.styleId&&state.styles.find(s=>s.id===t.styleId)?.name==='Linked library reveal');
  ok(!!libraryTrack&&!Object.hasOwn(libraryTrack,'duration')&&state.styles.find(s=>s.id===libraryTrack.styleId).track.duration===1200,'library linked apply creates a deck style and links the new track');
  await select(page,[tids[1]]);await clickText(page,'.animator .bar button','☆ Library');await clickText(page,'.animlib .tab','Templates');
  await page.type('.animlib .save input','Resolved library template');await clickText(page,'.animlib .save button','Save selection');
  await waitFor(page,()=>JSON.parse(localStorage.getItem('flux.presets.animTemplates')||'[]').some(p=>p.payload.name==='Resolved library template'),null,{label:'resolved template saved'});
  const template=await page.evaluate(()=>JSON.parse(localStorage.getItem('flux.presets.animTemplates')).find(p=>p.payload.name==='Resolved library template').payload);
  ok(template.slots[0].track.duration===1200&&template.slots[0].track.start===200,'saved template slots capture resolved linked timing');await page.click('.animlib .x');
  // Off is an explicit override; reset returns to inheritance (including params).
  await page.evaluate(tid=>{const f=window.__flux;f.slide.commitDeckLive(d=>f.slideOps.setAnimStyle(d,'f2-style',{track:{preset:'writeOn',stagger:{perMs:45},influence:{in:50,out:60},params:{direction:'rtl'}}}));f.slide.selTrackIds.set([tid]);},tids[1]);await paint(page);
  await field(page,'.props [data-fld="g"]',0);await page.click('.props .advanced summary');await clickText(page,'.props .ichip','ease');
  await page.evaluate(()=>{const s=[...document.querySelectorAll('.props select')].find(s=>[...s.options].some(o=>o.value==='rtl'));s.value='ltr';s.dispatchEvent(new Event('change',{bubbles:true}));});await paint(page);state=await read(page);
  let t=state.tracks.find(t=>t.id===tids[1]);ok(t.stagger?.perMs===0&&t.influence?.in===0&&t.influence?.out===0&&JSON.stringify(t.params)==='{}','off edits write stagger/influence/params sentinels on linked tracks');
  for(const key of ['stagger','influence','params'])await page.click(`[aria-label="Use style ${key}"]`);await paint(page);state=await read(page);t=state.tracks.find(t=>t.id===tids[1]);
  ok(['stagger','influence','params'].every(k=>!Object.hasOwn(t,k))&&Number(await page.$eval('.props [data-fld="g"]',e=>e.value))===45,'use style removes sentinel overrides and the inherited controls return');
  // Keep 40 linked lanes live while the real style field changes.
  await page.evaluate(target=>{const f=window.__flux,sid=f.get(f.fig.activeFigureId);f.slide.commitDeckLive(d=>{const b=f.slideOps.slideById(d,sid).beats[f.get(f.slide.activeBeat)];for(let i=0;i<39;i++){const t=f.slideOps.appendAnimation(d,sid,b.id,{target,preset:'fade'});f.slideOps.linkTrackStyle(d,sid,t.id,'f2-style');}});},targets[1]);await paint(page);
  await styleAction(page,'Edit style…');
  const times=await page.evaluate(async()=>{const input=document.querySelector('.props [data-fld="t"]'),f=window.__flux,times=[];let all=true;for(let i=0;i<20;i++){const start=performance.now();input.value=String(250+i*10);input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));times.push(performance.now()-start);const s=f.slide.currentDeck().slides.find(s=>s.id===f.get(f.fig.activeFigureId)),tracks=s.beats[f.get(f.slide.activeBeat)].tracks.filter(t=>t.styleId==='f2-style');const lefts=tracks.map(t=>parseFloat(document.querySelector(`.lane-row[data-track-id="${t.id}"] .trk`).style.left));all&&=lefts.length>=40&&lefts.every(x=>x===lefts[0]);}return {times,all};});
  const p95=[...times.times].sort((a,b)=>a-b)[Math.ceil(times.times.length*.95)-1];
  ok(times.all&&p95<=100,`40 linked lanes retime in one frame; style-field input-to-paint p95 ${p95.toFixed(1)} ms ≤ 100 ms`);
  writeFileSync(`${shots}/style-edit-performance.json`,JSON.stringify({...times,p95,propagation},null,2));
  await clickText(page,'.editing-style button','Back to effect');
  // Save/insert through the actual slide-preset UI, removing styles first so import must restore them.
  await clickText(page,'.inspector-tabs button','Slide');await clickText(page,'.rail button','Save as preset…');
  await page.$eval('[aria-label="Slide presets"] input',e=>{e.value='F2 portable styles';e.dispatchEvent(new Event('input',{bubbles:true}));});await clickText(page,'[aria-label="Slide presets"] button','Save preset');
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Slide presets"]'));
  await page.evaluate(()=>{const f=window.__flux;f.slide.commitDeckLive(d=>{for(const s of [...(d.animStyles??[])])f.slideOps.deleteAnimStyle(d,s.id,{detach:true});});});
  await clickText(page,'.filmstrip button','+ Preset');await page.waitForSelector('.preset-pick:not(:disabled)');await clickText(page,'.preset-pick','F2 portable styles');await paint(page);state=await read(page);
  ok(state.styles?.some(s=>s.name==='Gentle reveal')&&state.slide.beats.some(b=>b.tracks.some(t=>t.styleId===state.styles.find(s=>s.name==='Gentle reveal')?.id)),'saved slide preset restores referenced styles and remaps links on insert');
}

export async function verifyTimingAnchors(page, check) {
  const {tids}=await seed(page,'anchors');await lockScale(page);
  const drag=async(id,xEnd,yEnd,left=false,linked=false,release=true)=>{
    const point=await page.$eval(`.lane-row[data-track-id="${id}"] ${left?'.start-edge':'.trk'}`,e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    if(linked)await page.keyboard.down(mod);await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(xEnd,yEnd??point.y,{steps:5});
    if(release){await page.mouse.up();if(linked)await page.keyboard.up(mod);await paint(page);}return point;
  };
  const dest=await page.$eval(`.lane-row[data-track-id="${tids[0]}"] .trk`,e=>{const r=e.getBoundingClientRect();return {x:r.right,y:r.y+r.height/2};});
  await select(page,[tids[1]]);await drag(tids[1],dest.x,dest.y,true,true,false);await paint(page);
  check(await page.$eval('.guide.linked',e=>getComputedStyle(e).borderLeftStyle)==='solid','anchor magnet preview turns its alignment guide solid');await shot(page,'13-anchor-magnet-preview');
  await page.mouse.up();await page.keyboard.up(mod);await paint(page);
  let state=await read(page),t=state.tracks.find(t=>t.id===tids[1]);
  check(t.anchor?.trackId===tids[0]&&t.anchor.edge==='end'&&t.anchor.offsetMs===0&&!!await page.$(`.lane-row[data-track-id="${tids[1]}"] .anchor-glyph`),'Ctrl/⌘-dragging the left edge onto another bar’s end writes a zero-offset anchor and glyph');
  check((await page.$eval('.anchor-description',e=>e.textContent)).includes('after Lead end + 0 ms'),'anchored start row names the lane, edge and zero offset');await shot(page,'04-timing-anchor');
  await field(page,'[aria-label="Timing anchor offset"]',75);state=await read(page);
  check(state.tracks.find(t=>t.id===tids[1]).anchor.offsetMs===75,'the primary anchored control writes offsetMs');
  const followerBefore=await bar(page,tids[1]);
  await select(page,[tids[0]]);const origin=await page.$eval(`.lane-row[data-track-id="${tids[0]}"] .trk`,e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await drag(tids[0],origin.x+60,origin.y,false,false,false);await paint(page);
  const followerDuring=await bar(page,tids[1]);check(followerDuring.left>followerBefore.left,'retiming the anchor bar moves its follower LIVE before pointerup through resolveBeat');
  await page.mouse.up();await paint(page);const followerAfter=await bar(page,tids[1]);check(followerAfter.left===followerDuring.left,'committed follower geometry matches the drag preview');
  await select(page,[tids[1]]);const body=await page.$eval(`.lane-row[data-track-id="${tids[1]}"] .trk`,e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  const before=JSON.stringify((await read(page)).tracks);await drag(tids[1],body.x+30,body.y);state=await read(page);
  check(!state.tracks.find(t=>t.id===tids[1]).anchor&&await page.evaluate(()=>document.body.textContent.includes('Detached from ‹Lead›')),'plain drag detaches to absolute milliseconds and names the former lane in a toast');
  await page.keyboard.down(mod);await page.keyboard.press('KeyZ');await page.keyboard.up(mod);await paint(page);
  check(JSON.stringify((await read(page)).tracks)===before,'one Undo restores the complete anchor and timing gesture');
  // Compiler diagnostics remain visible for persisted bad anchors, with literal timing.
  await page.evaluate(id=>{const f=window.__flux;f.slide.commitDeckLive(d=>{const t=f.slideOps.findTrack(d,id).track;t.anchor={trackId:'missing',edge:'end'};t.start=125;});},tids[1]);await paint(page);
  check((await page.$eval('.anchor-issue',e=>e.textContent)).includes('Timing anchor is missing from this step')&&(await page.$eval('.start-row',e=>e.textContent)).includes('Start 125 ms'),'missing or cross-beat anchors show the compiler issue and literal fallback start');await shot(page,'10-anchor-issue');
  await page.click('[aria-label="Detach timing anchor"]');await page.click('[aria-label="Follow timing"]');await shot(page,'12-follow-timing-choices');
  await page.click('.anchor-choices button');await paint(page);state=await read(page);
  check(state.tracks.find(t=>t.id===tids[1]).anchor?.edge==='start','Follow timing also creates a start-edge anchor through the properties chooser');
  await select(page,tids.slice(0,2));await shot(page,'14-mixed-timing-anchors');
  check((await page.$eval('.anchor-description',e=>e.textContent))==='Mixed timing anchors','mixed anchored and absolute selections explain offset scope without naming a missing effect');
}
