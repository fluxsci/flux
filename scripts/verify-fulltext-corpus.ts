// Reproducible derived-search characterization. No external library/user data.
// The existing scale gate retains its fixed warm budget; these diverse generated
// scientific corpora record representation and worker responsiveness, not real-world prevalence.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,stat,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { searchFulltext } from '../flux-core/fulltextSearch';
const {createFulltextService}=createRequire(import.meta.url)('../electron/fulltextService.cjs');
const root=await mkdtemp(path.join(os.tmpdir(),'flux-ft-corpus-'));
const words='cortex hippocampus synapse dendrite neuron receptor calcium membrane vesicle protein transcript axon inhibitory excitatory network oscillation spindle ripple sleep wake memory learning plasticity behavior population amplitude frequency variance confidence distribution model regression correlation causal association trial stimulation recording imaging fluorescence electrode tissue experimental control response methods results figure supplement reference analysis estimate uncertainty assay sensitivity specificity baseline condition animal human'.split(' ');
const records:any[]=[];
let service:any;
try {
 const workerFile=path.join(root,'worker.cjs');
 await build({entryPoints:['flux-core/fulltextWorker.ts'],outfile:workerFile,bundle:true,platform:'node',format:'cjs',logLevel:'silent',external:['pdfjs-dist','@napi-rs/canvas']});
 for(const count of [300,1000,5000]) {
  const lib=path.join(root,String(count));let sourceBytes=0;
  for(let i=0;i<count;i++){
   const pages=Array.from({length:12},(_,page)=>Array.from({length:160},(_,j)=>j%7===0?`transcript${(i*733+page*97+j*31)%50000}`:words[(i*17+page*11+j*13)%words.length]).join(' '));
   pages[0]+=`\nCafé analysis. Scientific locus unique${i}.`;
   const text=pages.join('\f');sourceBytes+=Buffer.byteLength(text);
   const dir=path.join(lib,'items',`paper${i}`);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'fulltext.txt'),text);
  }
  let starts=0;class Counted extends Worker {constructor(file:string,opts:any){super(file,opts);starts++;}}
  service=createFulltextService({workerFile,root:lib,WorkerImpl:Counted,timeoutMs:120000});
  let maxMainTickMs=0;
  const measuredSearch=async(query:string,onProgress?:Function)=>{let lastTick=performance.now();const timer=setInterval(()=>{const now=performance.now();maxMainTickMs=Math.max(maxMainTickMs,now-lastTick);lastTick=now;},10);try{return await service.search(1,query,{limit:5000,diagnostics:true},onProgress);}finally{clearInterval(timer);}};
  const coldProgress:any[]=[];
  const t0=performance.now();const cold=await measuredSearch('unique17',(p:any)=>coldProgress.push({...p,atMs:performance.now()-t0}));const coldMs=performance.now()-t0;
  assert.equal(cold.hits[0]?.key,'paper17',JSON.stringify(cold));
  assert(coldProgress.length>0&&coldProgress[0].atMs<1000,'cold worker reports progress before the one-second feedback budget');
  assert(coldProgress.some(p=>p.phase==='indexing'),'actual cold tokenization reports index progress');
  const samples:number[]=[];let memory;
  for(const query of ['cafe','transcript1024','hippocamp','cortex calcium','"scientific locus"','unique29']){
   const t=performance.now();const indexed=await measuredSearch(query);samples.push(performance.now()-t);memory=indexed.diagnostics;
   assert(indexed.refresh.checked<=128,'unchanged warm query uses bounded freshness work');
   const oracle=await searchFulltext(query,{libPath:lib,forceScan:true,limit:5000});
   const norm=(r:any)=>JSON.stringify(r.hits.slice().sort((a:any,b:any)=>a.key.localeCompare(b.key)));
   assert.equal(norm(indexed),norm(oracle),`${count} ${query}: exact scan parity`);
  }
  samples.sort((a,b)=>a-b);
  const indexPath=path.join(lib,'.fluxlib/fulltext-index.json');const index=JSON.parse(await readFile(indexPath,'utf8'));
  records.push({papers:count,pagesPerPaper:12,sourceBytes,vocabulary:Object.keys(index.postings).length,postings:Object.values(index.postings).reduce((n:number,docs:any)=>n+Object.values(docs).reduce((sum:number,pages:any)=>sum+pages.length,0),0),indexBytes:(await stat(indexPath)).size,coldMs,coldProgress,warmP50Ms:samples[Math.floor(samples.length*.5)],warmP95Ms:samples.at(-1),maxMainTickMs,processStarts:starts,workerMemory:memory,mainMemory:process.memoryUsage()});
  assert.equal(starts,1,'all completed native-service requests reuse worker');service.dispose();service=null;
  console.log(JSON.stringify(records.at(-1)));
 }
 const out=process.env.FLUX_OUT||path.join(process.cwd(),'test-results','fulltext-corpus');await mkdir(out,{recursive:true});
 await writeFile(path.join(out,'fulltext-corpus.json'),JSON.stringify({corpus:'deterministic scientific vocabulary + 50k transcript identifiers, 12 pages x160 tokens',node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,cores:os.cpus().length,totalMemory:os.totalmem(),records},null,2));
 console.log('FULLTEXT CORPUS: PASS — all exact oracles and process reuse; timings retained as measurements');
} finally {service?.dispose();await rm(root,{recursive:true,force:true});}
