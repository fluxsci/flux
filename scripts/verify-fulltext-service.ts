import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { searchFulltext } from "../flux-core/fulltextSearch";
import { harness } from "./lib/harness.mjs";
const { createFulltextService } = createRequire(import.meta.url)("../electron/fulltextService.cjs");
const h = harness("verify-fulltext-service");
const root = await mkdtemp(path.join(tmpdir(),"flux-fulltext-service-"));
let service: any;
try {
  const workerFile = path.join(root,"worker.cjs");
  await build({ entryPoints:["flux-core/fulltextWorker.ts"],outfile:workerFile,bundle:true,platform:"node",format:"cjs",logLevel:"silent",external:["pdfjs-dist","@napi-rs/canvas"] });
  for (let i=0;i<20;i++) { const dir = path.join(root,"items",`paper${i}`); await mkdir(dir,{recursive:true}); await writeFile(path.join(dir,"fulltext.txt"),`Café memory scientific context ${i%2?"neuron":"synapse"}`); }
  let starts=0;
  class CountedWorker extends Worker { constructor(file:string,opts:any){super(file,opts);starts++;} }
  service=createFulltextService({workerFile,root,WorkerImpl:CountedWorker});
  const first=await service.search(1,"cafe",{limit:100});
  const second=await service.search(1,"neuron",{limit:100});
  const scan=await searchFulltext("neuron",{libPath:root,forceScan:true,limit:100});
  h.eq(first.hits.length,20,"real worker builds missing derived index and returns all exact hits");
  h.eq(second.hits.map((x:any)=>x.key),scan.hits.map(x=>x.key),"resident indexed result equals unchanged exact scan oracle");
  h.eq(starts,1,"completed repeated searches reuse one process and resident index");
  await writeFile(path.join(root,"items","paper0","fulltext.txt"),"changed unique newword");
  const changed=await service.search(1,"newword");
  h.eq(changed.hits.map((x:any)=>x.key),["paper0"],"worker integrity refresh observes changed child fulltext");
  await writeFile(path.join(root,".fluxlib","fulltext-index.json"),"{broken derived cache");
  let cancelledDuringBuild=false;
  const coldCancelled=await service.search(1,"cafe",{},(progress:any)=>{
    if(!cancelledDuringBuild&&progress.phase==="checking"&&progress.completed===0){cancelledDuringBuild=true;service.cancelOwner(1);}
  });
  h.ok(cancelledDuringBuild&&coldCancelled.cancelled,"actual cold rebuild can be cancelled from its nonterminal progress response");
  h.eq((await service.search(1,"newword")).hits.map((x:any)=>x.key),["paper0"],"cancelled cold rebuild restarts with exact source text and no partial-hit result");
  await service.dispose();
  h.ok((await service.search(1,"cafe")).error,"disposed library owner cannot enqueue work");
  service=createFulltextService({workerFile,root,WorkerImpl:CountedWorker});
  const stale=service.search(1,"cafe"); const latest=service.search(1,"synapse");
  h.ok((await stale).cancelled,"superseded query is cancelled before it can replace current results");
  h.eq((await latest).hits.length,9,"replacement query runs in fresh owned worker");
  assert(service.status().resident && !service.status().active);
  service.dispose();
  let spawnOnce=true;
  class SpawnFailureWorker extends Worker {constructor(file:string,opts:any){if(spawnOnce){spawnOnce=false;throw Error('controlled worker setup failure');}super(file,opts);}}
  service=createFulltextService({workerFile,root,WorkerImpl:SpawnFailureWorker});
  h.ok((await service.search(1,"cafe")).error.includes("setup failure"),"synchronous worker setup failure settles its owned request");
  h.eq((await service.search(1,"synapse")).hits.length,9,"worker setup failure releases queue for a successful retry");
  service.dispose();
  const brokenWorker=path.join(root,"broken-worker.cjs");await writeFile(brokenWorker,'throw Error("controlled runtime failure")');let crashOnce=true;
  class CrashOnceWorker extends Worker {constructor(file:string,opts:any){super(crashOnce?brokenWorker:file,opts);crashOnce=false;}}
  service=createFulltextService({workerFile,root,WorkerImpl:CrashOnceWorker});
  h.ok((await service.search(1,"cafe")).error.includes("runtime failure"),"real worker runtime crash settles current request");
  h.eq((await service.search(1,"synapse")).hits.length,9,"next search restarts after a real worker crash");
  service.dispose();
  const busyWorker=path.join(root,"busy-worker.cjs");await writeFile(busyWorker,'require("node:worker_threads").parentPort.on("message",()=>{while(true){}})');
  service=createFulltextService({workerFile:busyWorker,root,timeoutMs:100});
  const timed=await service.search(1,"cafe");h.ok(timed.cancelled&&timed.error.includes("deadline")&&!service.status().resident,"deadline terminates a synchronous busy worker and settles its request");
} finally { await service?.dispose(); await rm(root,{recursive:true,force:true}); }
h.done();
