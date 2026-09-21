import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {launch,gotoApp,clickMode,waitFor,APP_URL,OUT,realErrors} from './lib/driver.mjs';
const evidence=[];
for(const cached of [false,true])for(let trial=0;trial<3;trial++){
 const {browser,page}=await launch();let bypassed=false;
 try{
  if(!cached){await page.setRequestInterception(true);page.on('request',async req=>{
   if(new URL(req.url()).pathname==='/src/lib/slide/outline.ts'){
    const response=await fetch(req.url());let source=await response.text();const a=source.indexOf('function pointAt(p, s) {'),b=source.indexOf('function pointAtUncached',a);
    assert.ok(a>=0&&b>a&&source.slice(a,b).includes('points.get'),'controlled no-memo baseline found exact immutable point cache');
    source=source.slice(0,a)+'function pointAt(p, s) { return pointAtUncached(p, s); }\n'+source.slice(b);bypassed=true;
    await req.respond({status:200,contentType:'application/javascript',body:source});
   }else await req.continue();
  });}
  await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:100});await clickMode(page,'Slide',{settle:100});await waitFor(page,()=>!!window.__flux?.slide.currentDeck(),null,{label:'real Slide editor'});
  await page.evaluate(()=>{
   const f=window.__flux,d=structuredClone(f.slide.currentDeck()),first=d.slides[0];first.elements=[];first.beats=[{id:'base',tracks:[]}];d.slides=[first];d.defaults.transition='none';
   for(let s=1;s<12;s++)f.slideOps.addSlide(d,{id:'dense'+s,layout:'blank'});
   const beat=f.slideOps.addBeat(d,first.id,{id:'morph'});
   for(let i=0;i<3;i++){
    const el={id:'shape'+i,type:i<2?'path':'rect',x:100+i*280,y:140,width:220,height:130,rotation:0,fill:'#4385be',stroke:'#fff',strokeWidth:2,...(i<2?{d:'',closed:true,nodes:Array.from({length:200},(_,j)=>({x:110+100*Math.cos(j*Math.PI/100),y:65+55*Math.sin(j*Math.PI/100),type:'smooth',hIn:{dx:-.9,dy:-.4},hOut:{dx:.9,dy:.4}}))}:{cornerRadius:18})};
    f.slideOps.addElement(d,first.id,el);f.slideOps.addElement(d,first.id,{id:'target'+i,type:'ellipse',x:120+i*280,y:160,width:220,height:130,rotation:0,fill:'#da702c',stroke:'#fff',strokeWidth:2});
    f.slideOps.becomeTransform(d,first.id,beat.id,el.id,'target'+i,{duration:1200,easing:'linear'});
   }
   f.slide.loadDeckModel(d);window.__morphSaved=JSON.stringify(f.slide.currentDeck());
  });
  await page.evaluate(()=>[...document.querySelectorAll('.deckbar button')].find(b=>b.textContent.includes('Animate')).click());await waitFor(page,()=>!!document.querySelector('.animator .bar .play'),null,{label:'play control'});
  const timing=await page.evaluate(async()=>{
   const start=performance.now();document.querySelector('.animator .bar .play').click();
   await new Promise((resolve,reject)=>{let count=0;const frame=()=>{if(document.querySelector('.preview-host [data-el-id="shape0"]'))return resolve();if(++count>120)return reject(Error('preview never mounted'));requestAnimationFrame(frame)};requestAnimationFrame(frame)});
   const previewMs=performance.now()-start;const ruler=document.querySelector('.animator .ruler'),r=ruler.getBoundingClientRect(),t=performance.now();ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:r.x+r.width*.5,clientY:r.y+5}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));await new Promise(resolve=>requestAnimationFrame(resolve));
   const seekMs=performance.now()-t,geometry=[...document.querySelectorAll('.preview-host [data-el-id^="shape"] path')].map(e=>e.getAttribute('d'));
   return {previewMs,seekMs,geometry,saved:JSON.stringify(window.__flux.slide.currentDeck())===window.__morphSaved};
  });
  assert.ok(cached||bypassed);assert.ok(timing.saved);assert.ok(timing.geometry.length>=3);assert.equal(realErrors(page).length,0);evidence.push({cached,trial,...timing});
  if(cached){assert.ok(timing.previewMs<=100,`cold first preview ${timing.previewMs}ms <=100`);assert.ok(timing.seekMs<=100,`first seek ${timing.seekMs}ms <=100`);}
  await page.screenshot({path:`${OUT}/v020-morph-${cached?'cached':'baseline'}-${trial}.png`});
 }finally{await browser.close();}
}
for(const value of evidence)assert.deepEqual(value.geometry,evidence[0].geometry,"cached and pre-memo first-seek paths are numerically identical");
const median=a=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)];
const oldMs=median(evidence.filter(x=>!x.cached).map(x=>x.previewMs)),newMs=median(evidence.filter(x=>x.cached).map(x=>x.previewMs));assert.ok(newMs<oldMs,`actual cold-preview median improves ${oldMs}→${newMs}`);
await fs.writeFile(`${OUT}/v020-morph-startup.json`,JSON.stringify({evidence,baselineMedianMs:oldMs,cachedMedianMs:newMs,speedup:oldMs/newMs},null,2));console.log(JSON.stringify({baselineMedianMs:oldMs,cachedMedianMs:newMs,speedup:oldMs/newMs,passed:true}));
