// NR09 acceptance: real20k Library query/render path; no production-result caps
// and no relaxation of the older5k gate. Synthetic seed semantics are explicit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {launch,gotoApp,clickMode,realErrors,OUT} from './lib/driver.mjs';
const N=20000,FAMS=['cortex','sleep','vision','memory','synapse','retina','thalamus','spike'];
const queries=[
 ['sleep',i=>i%8===1],['vision',i=>i%8===2],['memory',i=>i%8===3],
 ['author:author42',i=>i%97===42],['year:2021',i=>i%25===21],['retina',i=>i%8===5],
 ['thalamus',i=>i%8===6],['cortex',i=>i%8===0],['zzzzabsent',()=>false],['',()=>true],
];
const {browser,page}=await launch();const samples=[];let report;
try {
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo',settle:500});await clickMode(page,'Library',{settle:0});
 await page.waitForFunction(()=>!!window.__fluxSeedScaleLibrary,{timeout:15000});
 const started=performance.now();const seeded=await page.evaluate(n=>window.__fluxSeedScaleLibrary(n),N);assert.equal(seeded.entries,N);
 await page.waitForFunction(n=>Number(document.querySelector('.grid')?.dataset.total)===n,{timeout:30000},N);
 const coldMs=performance.now()-started;
 await page.evaluate(()=>{window.__queryLongTasks=[];window.__queryObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())window.__queryLongTasks.push({start:e.startTime,duration:e.duration});});window.__queryObserver.observe({type:'longtask',buffered:false});});
 for(const [query,accept] of queries){
  const expected=[];for(let i=0;i<N;i++)if(accept(i))expected.push(`author${i}${FAMS[i%8]}${2000+i%25}`);
  const sample=await page.evaluate(async(query,expected)=>{
   const wanted=new Set(expected),input=document.querySelector('input.search');if(!input)throw Error('Library search input missing');
   const start=performance.now(),frames=[];let previous=start;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,query);input.dispatchEvent(new Event('input',{bubbles:true}));
   let passes=0;
   while(performance.now()-start<5000){
    await new Promise(resolve=>requestAnimationFrame(now=>{frames.push(now-previous);previous=now;resolve();}));
    const total=Number(document.querySelector('.grid')?.dataset.total??0);
    const keys=[...document.querySelectorAll('.grid .grow:not(.ghead) .gsel input')].map(e=>e.getAttribute('aria-label').replace(/^Select /,''));
    const correct=total===expected.length&&keys.every(k=>wanted.has(k))&&(total===0||keys.length>0);
    // Two frames establish an opportunity to paint the expected result after input.
    if(correct&&++passes>=2)return {query,ms:performance.now()-start,total,visible:keys,frames};
    if(!correct)passes=0;
   }
   throw Error(`query ${query} did not produce expected${expected.length} logical results`);
  },query,expected);
  samples.push(sample);assert.equal(sample.total,expected.length);assert(sample.visible.length<=60,'virtualized DOM remains bounded');
 }
 const longTasks=await page.evaluate(()=>{window.__queryObserver.disconnect();return window.__queryLongTasks;});
 const latencies=samples.map(s=>s.ms).sort((a,b)=>a-b),frames=samples.flatMap(s=>s.frames);
 report={papers:N,corpus:'existing deterministic scientific metadata seed;8 families,97 authors,25 years',coldMs,samples,p50Ms:latencies[Math.floor(latencies.length*.5)],p95Ms:latencies[Math.min(latencies.length-1,Math.floor(latencies.length*.95))],maxFrameGapMs:Math.max(...frames),longTasks,environment:{node:process.version,cpu:os.cpus()[0]?.model,cores:os.cpus().length,ramBytes:os.totalmem(),platform:process.platform,browser:await browser.version(),viewport:page.viewport()}};
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'library-20k.json'),JSON.stringify(report,null,2));await page.screenshot({path:path.join(OUT,'library-20k.png')});
 for(const sample of samples)assert(sample.ms<=100,`${sample.query||'<clear>'} visible response${sample.ms.toFixed(1)}ms exceeds100ms`);
 assert(report.maxFrameGapMs<=100,`query frame stall${report.maxFrameGapMs.toFixed(1)}ms exceeds100ms`);
 assert(longTasks.every(t=>t.duration<=100),'query task exceeds100ms');assert.deepEqual(realErrors(page),[]);
 console.log(`LIBRARY20K: PASS p50=${report.p50Ms.toFixed(1)}ms p95=${report.p95Ms.toFixed(1)}ms maxFrameGap=${report.maxFrameGapMs.toFixed(1)}ms`);
} finally {await browser.close();}
