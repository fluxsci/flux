// Real 190mm / 1200dpi output: no reduced-DPI shortcut and no UI-thread TIFF encode.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {launch,gotoApp,realErrors} from './lib/driver.mjs';
const {browser,page}=await launch();
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});
 const result=await page.evaluate(async()=>{
  const {renderFigureBytes}=await import('/src/lib/io.ts');
  const f={id:'scale',canvasId:'c',name:'Scale export',x:0,y:0,width:640,height:480,background:'#ffffff',elements:[{id:'r',type:'rect',x:40,y:40,width:560,height:400,rotation:0,fill:'#4385be',stroke:'#222222',strokeWidth:1,cornerRadius:8}]};
  const longTasks=[];const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({entryTypes:['longtask']});
  const start=performance.now(),bytes=await renderFigureBytes(f,{format:'tiff',mm:190,dpi:1200});
  const elapsed=performance.now()-start;await new Promise(r=>setTimeout(r,80));observer.disconnect();
  const v=new DataView(bytes.buffer),offset=v.getUint32(4,true),tags={};for(let i=0;i<v.getUint16(offset,true);i++){const p=offset+2+i*12;tags[v.getUint16(p,true)]=v.getUint32(p+8,true)}
  // Cancel an active worker, then export again: no orphan result or leaked worker.
  const controller=new AbortController();const pending=renderFigureBytes(f,{format:'png',mm:90,dpi:600,signal:controller.signal});setTimeout(()=>controller.abort(),5);
  let cancelled=false;try{await pending}catch(e){cancelled=e.name==='AbortError'}
  const retry=await renderFigureBytes(f,{format:'png',mm:25.4,dpi:96});
  return{elapsed,longTasks,width:tags[256],height:tags[257],bytes:bytes.length,dpi:v.getUint32(tags[282],true)/v.getUint32(tags[282]+4,true),cancelled,retry:retry.length};
 });
 writeFileSync('test-results/figure-polish-export-scale.json',JSON.stringify(result,null,2));console.log(result);
 assert.equal(result.width,Math.round(190/25.4*1200));assert.equal(result.height,Math.round(result.width*480/640));assert.equal(result.dpi,1200);
 assert.ok(Math.max(0,...result.longTasks)<=100,'export must not block direct interaction for over 100ms');assert.ok(result.cancelled&&result.retry>100,'cancelled export releases resources for retry');
 assert.deepEqual(realErrors(page),[]);console.log('FIGURE EXPORT SCALE: PASS');
}finally{await browser.close()}
