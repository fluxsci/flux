/** Exercise the actual portable HTML and video-capture bootstraps without network. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {launch,errors} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
import {createDeck,addSlide,addBeat,setTransform} from '../src/lib/slide/ops';
import {makeModel3dElement} from '../src/lib/model3d/make';
import {inspectGlb} from '../src/lib/model3d/glbCore.mjs';
import {exportDeckHtml,exportSlideVideoHtml} from '../src/lib/slide/export/exportDeck';
import type {Model3dAsset} from '../src/lib/model3d/types';
const h=harness('verify-model3d-slide-browser'),out=path.resolve('test-results/model3d/slides-export');await fs.mkdir(out,{recursive:true});
const bytes=await fs.readFile('scripts/fixtures/model3d/fluxplot/states.glb');
const manifest=JSON.parse(await fs.readFile('scripts/fixtures/model3d/fluxplot/states.fluxplot.json','utf8'));
const asset:Model3dAsset={id:'states',kind:'glb',name:'Shape',path:'assets/states.glb',naturalWidth:320,naturalHeight:280,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,model:inspectGlb(bytes)};
const deck=createDeck({withTitleSlide:false,theme:'flux-light'});deck.stage={width:640,height:360};deck.assets=[asset];
const slide=addSlide(deck),element=makeModel3dElement(asset,{id:'mesh',box:{x:100,y:20,width:400,height:320}});slide.elements.push(element);
const beat=addBeat(deck,slide.id)!;setTransform(deck,slide.id,beat.id,element.id,{state:{orbitAzimuth:element.orbitAzimuth+180,modelStates:{bent:1}},duration:1000,easing:'linear'});
const payload={deck,models:{states:bytes.toString('base64')},modelManifests:{states:manifest}};
const {browser,page}=await launch({width:1280,height:720});
try {
  await page.setOfflineMode(true);
  await page.evaluate(()=>{const real=requestAnimationFrame;(window as any).modelRafCalls=0;window.requestAnimationFrame=cb=>{(window as any).modelRafCalls++;return real(cb);};});
  const html=(await exportDeckHtml(payload)).html;await fs.writeFile(path.join(out,'offline.html'),html);
  await page.setContent(html,{waitUntil:'load'});
  await page.waitForFunction(()=>{const c=document.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d]');return c&&c.width>0&&c.style.display==='block';});
  const before=await page.$eval('canvas[data-slide-model3d]',(c:any)=>c.toDataURL());
  await page.screenshot({path:path.join(out,'offline-start.png')});
  const idle=await page.evaluate(async()=>{const start=(window as any).modelRafCalls;await new Promise(r=>setTimeout(r,180));return (window as any).modelRafCalls-start;});
  h.eq(idle,0,'actual offline presentation schedules no animation frames at rest');
  await page.keyboard.press('ArrowRight');await new Promise(r=>setTimeout(r,320));
  const moving=await page.$eval('canvas[data-slide-model3d]',(c:any)=>c.toDataURL());
  h.ok(before!==moving,'offline exported HTML changes real mesh pixels during the authored beat');
  await page.screenshot({path:path.join(out,'offline-motion.png')});
  // A new document releases the presenter, then boots the exact capture runtime.
  const capture=await exportSlideVideoHtml(payload,{height:720,fps:60,startHoldMs:0,endHoldMs:0,stepDelayMs:0});
  await page.goto('about:blank');await page.setContent(capture,{waitUntil:'load'});
  const info=await page.evaluate(()=> (window as any).fluxVideoReady);
  h.eq([info.width,info.height,info.frames,info.fps],[1280,720,60,60],'capture runtime has exact authored 60fps dimensions/timeline');
  h.ok(!info.issues.some((i:any)=>/still|missing|WebGL/i.test(i.reason)),'capture readiness completes with a real live model');
  const hashes:Record<number,string>={};
  for(const frame of [0,30,59,15,30,0]) {
    const png=await page.evaluate(async(frame)=>{await (window as any).fluxVideo.frame(frame);return document.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d]')!.toDataURL();},frame);
    if(hashes[frame])h.eq(png,hashes[frame],`capture seek ${frame} is pixel-identical after arbitrary seeks`);
    hashes[frame]=png;
  }
  h.ok(hashes[0]!==hashes[30]&&hashes[30]!==hashes[59],'capture frames contain different real orbit and shape samples');
  await page.evaluate(()=> (window as any).fluxVideo.frame(30));await page.screenshot({path:path.join(out,'capture-midpoint.png')});
  h.eq(errors(page),[],'portable playback/capture emits no browser errors');
} finally {await browser.close();}
await h.done();
