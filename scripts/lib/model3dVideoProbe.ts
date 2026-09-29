/** Native MP4 pixels versus independently sought capture-runtime frames. */
import './cssStub.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import * as core from '../../flux-core/index';
import {mutateDeck,gatherDeckPayload} from '../../flux-core/slides';
import {becomeTransform} from '../../src/lib/slide/ops';
import {exportSlideVideo} from '../../flux-core/slideVideo';
import {exportSlideVideoHtml} from '../../src/lib/slide/export/exportDeck';
import {launch} from './driver.mjs';
const require=createRequire(import.meta.url);require('./nestedVideoTestLaunch.cjs').installNestedVideoTestLaunch();
const scratch=process.env.PROBE_SCRATCH!;assert.ok(scratch&&process.env.HOME?.startsWith(scratch));
const root=path.join(scratch,'project'),out=path.resolve('test-results/model3d/video');await fs.mkdir(out,{recursive:true});await core.scaffold(root,{title:'3D video gate'});
const {deckId}=await core.createDeck(root,{id:'model-video',theme:'flux-light'});
await mutateDeck(root,deckId,'fixture',d=>{d.stage={width:640,height:360};d.slides=[];});
async function fixture(name:string,stems:string[]) {
 const {slideId}=await core.addSlide(root,deckId,{name,layout:'blank'});const {beatId}=await core.addBeat(root,deckId,slideId);const ids:string[]=[];
 for(const stem of stems){for(const ext of ['glb','fluxplot.json'])await fs.copyFile(`scripts/fixtures/model3d/fluxplot/${stem}.${ext}`,path.join(root,'plots',`${stem}.${ext}`));
 ids.push((await core.addSlideModel(root,deckId,slideId,`plots/${stem}.glb`,{x:120,y:30,width:400,height:300,noPoster:true})).elementId);}
 return {slideId,beatId,ids};
}
const turn=await fixture('Turntable',['named-parts']);await core.addSlideTurntable(root,deckId,turn.slideId,turn.beatId,turn.ids[0],{durationMs:1000,turns:1});
const morph=await fixture('Morph',['morph-a','morph-b']);await mutateDeck(root,deckId,'fixture_morph',d=>{becomeTransform(d,morph.slideId,morph.beatId,morph.ids[0],morph.ids[1],{mode:'handoff',duration:1000,curve:'linear'});});
const encoder=path.resolve('build/video-encoder',`${process.platform}-${process.arch}`,process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const options={height:1080 as const,fps:60 as const,startHoldMs:0,endHoldMs:100,stepDelayMs:0};
const receipts=[];
for(const [name,item]of [['turntable',turn],['morph',morph]] as const){
 const file=path.join(out,`${name}.mp4`),result=await exportSlideVideo(root,deckId,item.slideId,{...options,out:file,refreshSources:false});
 const decoded=spawnSync(encoder,['-hide_banner','-i',file,'-vf','scale=320:180','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxBuffer:30*1024*1024,timeout:30000});assert.equal(decoded.status,0,decoded.stderr.toString());
 assert.match(decoded.stderr.toString(),/1920x1080/);assert.match(decoded.stderr.toString(),/60 fps/);
 const stride=320*180*3;assert.equal(decoded.stdout.length/stride,66);assert.equal(result.frames,66);
 const {payload}=await gatherDeckPayload(root,deckId,item.slideId,{refreshSources:false});const html=await exportSlideVideoHtml(payload,options);
 const {browser,page}=await launch({width:1920,height:1080});const measured=[];
 try{await page.setContent(html,{waitUntil:'load'});await page.evaluate('window.__name=(value)=>value');const info=await page.evaluate(()=>(window as any).fluxVideoReady);assert.ok(!info.issues.some((i:any)=>/still|missing|unsupported|WebGL|failed|error/i.test(i.reason)),JSON.stringify(info.issues));
  if(name==='turntable')await page.evaluate(async payload=>{
    const runtime=(window as any).FluxModel3dRuntime;
    const host=runtime.createInlineHost({sourceKey:'explicit-linear-reference',modelBytes:(id:string)=>Uint8Array.from(atob(payload.models![id]),c=>c.charCodeAt(0))});
    const element=payload.deck.slides[0].elements.find(e=>e.type==='model3d')!;
    await host.ready([(element as any).assetId]);
    (window as any).linearReference={host,view:host.view(document.querySelector('canvas[data-slide-model3d]')),element,manifest:payload.modelManifests![(element as any).assetId]};
  },payload);

  for(let frame=0;frame<66;frame++){
   await page.evaluate(async frame=>{await (window as any).fluxVideo.frame(frame);},frame);
   if(name==='turntable')await page.evaluate(frame=>{
    const r=(window as any).linearReference,c=document.querySelector<HTMLCanvasElement>('canvas[data-slide-model3d]')!;
    r.view.render({...r.element,x:0,y:0,orbitAzimuth:r.element.orbitAzimuth-360*Math.min(1,frame/60)},c.width,c.height,{manifest:r.manifest});
   },frame);
   const png=await page.screenshot();
   // Match the production codec/color conversion before pixel comparison:
   // its ordinary RGB->YUV420->RGB roundtrip maps white255 to253 on this encoder.
   // This control preserves the declared tolerance and isolates rendering/timing.
   const referenceEncoded=spawnSync(encoder,['-hide_banner','-loglevel','error','-f','image2pipe','-vcodec','png','-framerate','60','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','2','-f','matroska','pipe:1'],{input:png,maxBuffer:8*1024*1024,timeout:10000});assert.equal(referenceEncoded.status,0,referenceEncoded.stderr.toString());
   const expected=spawnSync(encoder,['-hide_banner','-loglevel','error','-i','pipe:0','-vf','scale=320:180','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{input:referenceEncoded.stdout,maxBuffer:2*1024*1024,timeout:10000});assert.equal(expected.status,0,expected.stderr.toString());assert.equal(expected.stdout.length,stride);
   const actual=decoded.stdout.subarray(frame*stride,(frame+1)*stride);let sum=0,bad=0;for(let i=0;i<stride;i++){const d=Math.abs(actual[i]-expected.stdout[i]);sum+=d;if(d>20)bad++;}
   const mae=sum/stride,fraction=bad/stride;if(mae>2||fraction>.01){await fs.writeFile(path.join(out,`${name}-mismatch-${frame}-expected.png`),png);await fs.writeFile(path.join(out,`${name}-mismatch-${frame}-actual.rgb`),actual);console.log('MISMATCH',JSON.stringify({name,frame,mae,fraction,actualCorner:[...actual.subarray(0,3)],expectedCorner:[...expected.stdout.subarray(0,3)]}));}assert.ok(mae<=2&&fraction<=.01,`${name} frame${frame}: encoded seek mismatch MAE${mae} fraction${fraction}`);measured.push({frame,mae,fraction});
   if(frame===30)await fs.writeFile(path.join(out,`${name}-midpoint.png`),png);
  }
 }finally{await browser.close();}
 // Handover must have no extra pixel discontinuity beyond neighbouring motion.
 const delta=(a:number,b:number)=>{let sum=0;for(let i=0;i<stride;i++)sum+=Math.abs(decoded.stdout[a*stride+i]-decoded.stdout[b*stride+i]);return sum/stride;};
 const colored=(frame:number)=>{const pixels=decoded.stdout.subarray(frame*stride,(frame+1)*stride);let count=0;for(let i=0;i<stride;i+=3){const rgb=[pixels[i],pixels[i+1],pixels[i+2]];if(Math.max(...rgb)-Math.min(...rgb)>30&&Math.min(...rgb)<220)count++;}return count;};
 const coverage=[colored(0),colored(30)];assert.ok(coverage.every(n=>n>1000),`${name} has no substantial colored mesh: ${coverage}`);
 const midpointChange=delta(0,30);assert.ok(midpointChange>1,`${name} has no meaningful mesh motion: ${midpointChange}`);
 const handover=delta(59,60),nearby=Math.max(...[55,56,57,58].map(i=>delta(i,i+1)));
 if(name==='morph')assert.ok(handover<=nearby*1.5+.15,`morph handover pop ${handover} versus nearby ${nearby}`);
 receipts.push({name,frames:66,width:1920,height:1080,fps:60,measured,coverage,midpointChange,handover,nearby,warnings:result.warnings});
 console.log(`PROBE ${name}: all66 native H264 frames match seek samples, maxMAE ${Math.max(...measured.map(m=>m.mae)).toFixed(4)}`);
}
await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify({referenceCodec:"production libx264 fast CRF18 yuv420p roundtrip",codecTolerance:{meanAbsoluteChannelDifference:2,fractionChannelsAbove20:.01},receipts},null,2));
