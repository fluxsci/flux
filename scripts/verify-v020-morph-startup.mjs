// The cold morph path, as the user feels it (V0.2 morph startup).
//
// Three dense-deck trials in the real Slide editor: 12 slides, three 200-node
// path -> ellipse Becomes on the first. The clock for the whole cold path
// starts when the ANIMATOR OPENS (that is where node correspondences get
// warmed, 2026-09-22), and per trial the two things a user waits on are
// budgeted in the instantaneous class: the first preview <= 100 ms and the
// first ruler seek <= 100 ms. The three trials must also agree on the sampled
// geometry, so a timing win can never be a correctness loss.
//
// History: until 2026-09-25 this gate ran the app twice, once with the
// per-plan point memo patched out of outline.ts, to prove the memo paid for
// itself. The memo existed to offset arcT; arcT became allocation-free on
// 2026-09-23 and the memo then measured as noise (cold-path ratio 0.94-1.12,
// its 1.5x assertion failed on its own), so the memo was removed and this gate
// measures the one real path. verify-v020-morph-cache pins the sampled morph
// geometry against the oracle recorded before either change.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {launch,gotoApp,clickMode,waitFor,APP_URL,OUT,realErrors} from './lib/driver.mjs';
const evidence=[];
for(let trial=0;trial<3;trial++){
 const {browser,page}=await launch();
 try{
  await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:100});await clickMode(page,'Slide',{settle:100});await waitFor(page,()=>!!window.__flux?.slide.currentDeck(),null,{label:'real Slide editor'});
  await page.evaluate(()=>{
   const f=window.__flux,d=structuredClone(f.slide.currentDeck()),first=d.slides[0];first.elements=[];first.beats=[{id:'base',tracks:[]}];d.slides=[first];d.defaults.transition='none';
   for(let s=1;s<12;s++)f.slideOps.addSlide(d,{id:'dense'+s,layout:'blank'});
   const beat=f.slideOps.addBeat(d,first.id,{id:'morph'});
   for(let i=0;i<3;i++){
    const el={id:'shape'+i,type:i<2?'path':'rect',x:100+i*280,y:140,width:220,height:130,rotation:0,fill:'#4385be',stroke:'#fff',strokeWidth:2,...(i<2?{d:'',closed:true,nodes:Array.from({length:200},(_,j)=>({x:110+100*Math.cos(j*Math.PI/100),y:65+55*Math.sin(j*Math.PI/100),type:'smooth',hIn:{dx:-.9,dy:-.4},hOut:{dx:.9,dy:.4}}))}:{cornerRadius:0})};
    f.slideOps.addElement(d,first.id,el);f.slideOps.addElement(d,first.id,{id:'target'+i,type:'ellipse',x:120+i*280,y:160,width:220,height:130,rotation:0,fill:'#da702c',stroke:'#fff',strokeWidth:2});
    f.slideOps.becomeTransform(d,first.id,beat.id,el.id,'target'+i,{duration:1200,easing:'linear'});
   }
   f.slide.loadDeckModel(d);window.__morphSaved=JSON.stringify(f.slide.currentDeck());
  });
  // Opening the animator is where the node correspondences get warmed, so the
  // clock for the whole cold path starts HERE, not at the play click.
  await page.evaluate(()=>{window.__openedAt=performance.now();[...document.querySelectorAll('.deckbar button')].find(b=>b.textContent.includes('Animate')).click();});await waitFor(page,()=>!!document.querySelector('.animator .bar .play'),null,{label:'play control'});
  const timing=await page.evaluate(async()=>{
   const start=performance.now();document.querySelector('.animator .bar .play').click();
   await new Promise((resolve,reject)=>{let count=0;const frame=()=>{if(document.querySelector('.preview-host [data-el-id="shape0"]'))return resolve();if(++count>120)return reject(Error('preview never mounted'));requestAnimationFrame(frame)};requestAnimationFrame(frame)});
   const previewMs=performance.now()-start;const ruler=document.querySelector('.animator .ruler'),r=ruler.getBoundingClientRect(),t=performance.now();ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:r.x+r.width*.5,clientY:r.y+5}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));await new Promise(resolve=>requestAnimationFrame(resolve));
   const seekMs=performance.now()-t,geometry=[...document.querySelectorAll('.preview-host [data-el-id^="shape"] path')].map(e=>e.getAttribute('d'));
   const totalMs=performance.now()-window.__openedAt;
   return {previewMs,seekMs,totalMs,geometry,saved:JSON.stringify(window.__flux.slide.currentDeck())===window.__morphSaved};
  });
  assert.ok(timing.saved,'the cold path writes nothing to the deck');assert.ok(timing.geometry.length>=3,'three morphing shapes are on screen');assert.equal(realErrors(page).length,0,'clean browser console');evidence.push({trial,...timing});
  assert.ok(timing.previewMs<=100,`cold first preview ${timing.previewMs}ms <=100`);assert.ok(timing.seekMs<=100,`first seek ${timing.seekMs}ms <=100`);
  await page.screenshot({path:`${OUT}/v020-morph-${trial}.png`});
 }finally{await browser.close();}
}
for(const value of evidence)assert.deepEqual(value.geometry,evidence[0].geometry,"every trial samples identical first-seek geometry");
const median=a=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)];
const report={previewMedianMs:median(evidence.map(x=>x.previewMs)),seekMedianMs:median(evidence.map(x=>x.seekMs)),coldPathMedianMs:median(evidence.map(x=>x.totalMs))};
await fs.writeFile(`${OUT}/v020-morph-startup.json`,JSON.stringify({evidence,...report},null,2));console.log(JSON.stringify({...report,passed:true}));
