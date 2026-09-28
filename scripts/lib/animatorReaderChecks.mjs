// F1's measured probe-script.mjs sequence, reused inside the hermetic authoring gate.
// Screenshots/JSON keep its five probes comparable; the anchored field now edits offset.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gotoApp, clickMode, waitFor, APP_URL } from './driver.mjs';
const outDir='notes/flux_animation_v2/workers/out/shots/F2';
export async function verifyResolvedReaders(page, check) {
  fs.mkdirSync(outDir,{recursive:true});
  const probe={steps:[]},prefix='f1-reprobe',url=APP_URL;
  const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const clickText=async(sel,text)=>{const e=await page.evaluateHandle(({sel,text})=>[...document.querySelectorAll(sel)].find(e=>e.textContent.trim()===text),{sel,text});assert.ok(e.asElement(),text);await e.click();await paint();};
  const state = async (label) => {
    const s = await page.evaluate(async () => {
      const { compileSlide } = await import("/src/lib/slide/compile.ts");
      const f = window.__flux, d = f.slide.currentDeck(), sid = f.get(f.fig.activeFigureId), slide = d.slides.find(s => s.id === sid);
      const tracks = slide.beats[1]?.tracks ?? [];
      const cues = compileSlide(slide, d.stage, d).cues[1]?.tracks.map(t => ({ id: t.track.id, preset: t.track.preset, start: t.start, duration: t.duration })) ?? [];
      const bars = [...document.querySelectorAll(".lane-row[data-track-id]")].map(r => { const b = r.querySelector(".trk"); const rr = b?.getBoundingClientRect(); return { id: r.dataset.trackId, left: rr && Math.round(rr.left), width: rr && Math.round(rr.width), title: b?.getAttribute("title") }; });
      const startInput = document.querySelector('input[data-fld="t"]')?.value ?? null;
      const durInput = document.querySelector('input[data-fld="d"]')?.value ?? null;
      return { tracks: tracks.map(t => ({ id: t.id, preset: t.preset, start: t.start, duration: t.duration, anchor: t.anchor, styleId: t.styleId })), cues, bars, startInput, durInput, startRow: document.querySelector(".start-row")?.textContent, animStyles: d.animStyles ?? null };
    });
    probe.steps.push({ label, ...s });
  };
  const shot = async (name) => { await paint(); await page.screenshot({ path: path.join(outDir, `${prefix}-${name}.png`) }); };
  await gotoApp(page, { url: url + "?fixture=demo", settle: 300 });
  await page.evaluate(() => { window.fig.exportSlideVideo = async () => ({ok:false,cancelled:true}); });
  if (!(await clickMode(page, "Slide", { settle: 300 }))) throw new Error("no Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 20000, label: "deck" });
  await page.evaluate(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.fig.commit(p => p.figures.find(x => x.id === sid).elements.push({ type: "rect", id: "probe-box", name: "Probe box", x: 140, y: 100, width: 120, height: 80, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 })); f.fig.selectOnly("probe-box"); });
  await clickText(".deckbar button", "Animate ⏱");
  await clickText(".animator .actions button", "Appear");
  await clickText(".animator .actions button", "Emphasize");
  await clickText(".animator .actions button", "Disappear");
  await state("01 Appear + Emphasize + Disappear on one object");
  await shot("01-animator-successive-effects");
  const ids = probe.steps[0].tracks.map(t => t.id);
  await page.click(`.lane-row[data-track-id="${ids[2]}"] .track-label`); await paint();
  await state("02 exit lane selected (Properties)");
  await shot("02-properties-exit-selected");
  await page.keyboard.down("Alt"); await page.keyboard.press("ArrowRight"); await page.keyboard.up("Alt"); await paint();
  await state("03 after Alt+ArrowRight on the exit");
  await shot("03-after-alt-right-nudge");
  await page.evaluate(() => { const i = document.querySelector('input[data-fld="t"]'); i.value = "1200"; i.dispatchEvent(new Event("change", { bubbles: true })); }); await paint();
  await state("03b Properties Start field set to 1200 on the exit");
  await shot("03b-properties-start-1200");
  await page.evaluate((entrance) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive(d => { f.slideOps.addAnimStyle(d, { name: "Slow reveal", family: "appearance", track: { preset: "fadeRise", duration: 900, easing: "linear" } }, "probe-style"); const r = f.slideOps.linkTrackStyle(d, sid, entrance, "probe-style"); if (!r.ok) throw new Error(r.reason); }); }, ids[0]);
  await page.click(`.lane-row[data-track-id="${ids[0]}"] .track-label`); await paint();
  await state("04 entrance linked to a 900 ms deck style");
  await shot("04-entrance-linked-to-style");

  const [initial,selected,nudged,edited,styled]=probe.steps;
  const geometry = s => {const scale=s.bars[0].width/s.cues.find(t=>t.id===s.bars[0].id).duration,origin=s.bars[0].left-s.cues.find(t=>t.id===s.bars[0].id).start*scale;return s.bars.every(b=>{const c=s.cues.find(t=>t.id===b.id);return Math.abs(b.left-origin-c.start*scale)<2&&Math.abs(b.width-c.duration*scale)<2;});};
  check(geometry(initial)&&initial.cues.map(t=>t.start).join(',')==='0,300,800','F1 reprobe: successive effect geometry agrees with compiled 0/300/800 ms');
  check(selected.startRow.includes('Start 800 ms')&&selected.startInput==='0','F1 reprobe: anchored exit displays resolved start and its zero offset');
  check(geometry(nudged)&&nudged.tracks[2].anchor.offsetMs>0&&nudged.bars[2].left>selected.bars[2].left,'F1 reprobe: Alt+Right updates the anchor offset AND the lane');
  check(geometry(edited)&&edited.tracks[2].anchor.offsetMs===1200&&edited.cues.find(t=>t.id===ids[2]).start===2000,'F1 reprobe: primary anchored input edits offset; literal start cannot silently lose the edit');
  check(geometry(styled)&&styled.durInput==='900','F1 reprobe: linked entrance displays its inherited 900 ms duration');
  fs.writeFileSync(path.join(outDir,'f1-reprobe.json'),JSON.stringify(probe,null,2));
  // Same-target order is start-sorted by the compiler. Style timing reverses
  // that order, making missing context observable in both static UI hosts.
  const slides=await page.evaluate(()=>{const f=window.__flux;let first,next;
    f.slide.commitDeckLive(d=>{first=f.slideOps.addSlide(d,{name:'Before linked reveal'}).id;next=f.slideOps.addSlide(d,{name:'Linked final frame'}).id;});f.slide.selectSlide(next);
    f.fig.commit(p=>p.figures.find(s=>s.id===next).elements.push({id:'reader-box',type:'rect',name:'Resolved final pose',x:100,y:100,width:200,height:100,fill:'#4385be',stroke:'none',strokeWidth:0,rotation:0,cornerRadius:0}));
    f.slide.commitDeckLive(d=>{const b=f.slideOps.addBeat(d,next,{label:'Order by resolved timing'});f.slideOps.addAnimStyle(d,{name:'Late entrance',family:'appearance',track:{preset:'fade',start:500,duration:900}},'reader-style');const t=f.slideOps.appendAnimation(d,next,b.id,{target:'reader-box',preset:'fade'});f.slideOps.linkTrackStyle(d,next,t.id,'reader-style');f.slideOps.appendAnimation(d,next,b.id,{target:'reader-box',preset:'fadeOut',start:200,duration:100});});return {first,next};});
  const opacity=sel=>page.$eval(sel,e=>Number(getComputedStyle(e).opacity));
  const thumb='.thumb-stage [data-el-id="reader-box"] .sl-effects';
  await page.waitForSelector(thumb);await page.waitForFunction(sel=>getComputedStyle(document.querySelector(sel)).opacity==='1',{},thumb);
  check(await opacity(thumb)===1,'filmstrip final pose consumes style-resolved compiled cue order');
  await page.evaluate(()=>window.__flux.slide.commitDeckLive(d=>window.__flux.slideOps.setAnimStyle(d,'reader-style',{track:{start:0}})));
  await page.waitForFunction(sel=>getComputedStyle(document.querySelector(sel)).opacity==='0',{},thumb);
  check(await opacity(thumb)===0,'a style-only edit invalidates the referenced slide thumbnail');
  await page.evaluate(({first})=>{const f=window.__flux;f.slide.commitDeckLive(d=>f.slideOps.setAnimStyle(d,'reader-style',{track:{start:500}}));f.slide.selectSlide(first);document.activeElement?.blur();},slides);
  await page.keyboard.down('Shift');await page.keyboard.press('F5');await page.keyboard.up('Shift');await page.waitForSelector('.present');await page.keyboard.press('s');
  const next='.next-scaled [data-el-id="reader-box"] .sl-effects';await page.waitForSelector(next);
  check(await opacity(next)===1,'presenter next-slide preview consumes the same style-resolved compiled cues');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.present'));
  await page.evaluate(async({next})=>{const f=window.__flux,{setAssetData}=await import('/src/lib/assets.ts');f.slide.selectSlide(next);
    setAssetData('reader-poster','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==');
    f.slide.commitDeckLive(d=>{d.assets.push({id:'reader-video',name:'reader.mp4',kind:'mp4',path:'assets/reader.mp4',naturalWidth:160,naturalHeight:90},{id:'reader-poster',name:'poster.png',kind:'png',path:'assets/poster.png',naturalWidth:1,naturalHeight:1});const target=f.slideOps.addVideoToSlide(d,next,{assetId:'reader-video',posterAssetId:'reader-poster',durationMs:5000,x:350,y:100,width:160,height:90});const b=f.slideOps.slideById(d,next).beats[1];f.slideOps.addAnimStyle(d,{name:'Late video',family:'media',track:{preset:'videoStart',start:2000,duration:0}},'reader-media');f.slideOps.setVideoTrack(d,next,b.id,target,'start');const t=b.tracks.find(t=>t.target===target);f.slideOps.linkTrackStyle(d,next,t.id,'reader-media');});},slides);await paint();
  await clickText('.deckbar button','Video…');await page.waitForSelector('[aria-labelledby="video-export-title"]');
  check((await page.$eval('.estimate',e=>e.textContent)).includes('10.0 seconds'),'video dialog resolves linked media start (1 s hold + 2 s start + 5 s clip + 2 s hold)');
  await page.screenshot({path:path.join(outDir,'11-resolved-video-estimate.png')});await clickText('dialog footer button','Cancel');
}
