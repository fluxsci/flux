import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, readFile, rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {createRequire} from "node:module";
import {createFulltextRefreshState, markFulltextDirty, loadFreshFulltextIndex} from "../flux-core/fulltextIndex";
import {searchFulltext} from "../flux-core/fulltextSearch";
import {harness} from "./lib/harness.mjs";
const require=createRequire(import.meta.url);
const {createFulltextService}=require("../electron/fulltextService.cjs");
const {createReadJobs}=require("../electron/ipc/readJobs.cjs");
const {createGlobalLibraryWatcher}=require("../electron/globalLibraryWatcher.cjs");
const h=harness("verify-fulltext-refresh"), root=await mkdtemp(path.join(tmpdir(),"flux-ft-refresh-"));
const key=(i:number)=>`paper${String(i).padStart(3,"0")}`;
const textPath=(k:string)=>path.join(root,"items",k,"fulltext.txt");
try {
  for(let i=0;i<300;i++){await mkdir(path.dirname(textPath(key(i))),{recursive:true});await writeFile(textPath(key(i)),`Scientific common baseline ${i}`);}
  const refresh=createFulltextRefreshState(3), progress:any[]=[];
  const cold=await searchFulltext("common",{libPath:root,limit:500,refresh,onProgress:p=>progress.push(p)});
  h.ok(cold.hits.length===300&&refresh.lastChecked===300&&progress.some(p=>p.phase==="indexing"),"cold build retains all300 papers and reports nonterminal index progress");
  await searchFulltext("baseline",{libPath:root,limit:500,refresh});
  h.eq(refresh.lastChecked,3,"warm query checks the bounded integrity slice instead of all300 items");
  await writeFile(textPath(key(299)),"new scientific watchedtoken");
  markFulltextDirty(refresh,`items/${key(299)}/fulltext.txt`);
  const watched=await searchFulltext("watchedtoken",{libPath:root,refresh});
  h.ok(watched.hits[0]?.key===key(299)&&refresh.lastChecked<=4,"dirty candidate outside integrity slice is fresh on the next query");
  await writeFile(textPath(key(150)),"missedwatchtoken scientific text");
  let repaired=false, passes=0;
  for(;passes<100;passes++){
    await loadFreshFulltextIndex(root,{refresh});
    assert(refresh.lastChecked<=3);
    if((await searchFulltext("missedwatchtoken",{libPath:root,refresh})).hits.length){repaired=true;break;}
  }
  h.ok(repaired&&passes<100,"missed event is repaired by a bounded complete integrity rotation");
  const added="paperNew";await mkdir(path.dirname(textPath(added)));await writeFile(textPath(added),"addedtoken exact scientific text");
  markFulltextDirty(refresh,`items/${added}/fulltext.txt`);
  h.eq((await searchFulltext("addedtoken",{libPath:root,refresh})).hits.map(x=>x.key),[added],"new directory discovery retains exact key and text");
  await rm(path.dirname(textPath(key(299))),{recursive:true});markFulltextDirty(refresh,`items/${key(299)}`);
  h.eq((await searchFulltext("watchedtoken",{libPath:root,refresh})).hits.length,0,"deleted item is purged after a directory event");
  await writeFile(path.join(root,".fluxlib","fulltext-index.json"),"{broken");
  const rebuilt=await searchFulltext("addedtoken",{libPath:root,refresh});
  h.ok(rebuilt.hits[0]?.key===added&&refresh.lastChecked===300,"corrupt persisted cache forces complete rebuild with exact hits");
  markFulltextDirty(refresh,null);
  let marked=false;
  await loadFreshFulltextIndex(root,{refresh,onProgress:()=>{if(!marked){marked=true;markFulltextDirty(refresh,`items/${key(200)}/fulltext.txt`);}}});
  h.ok(refresh.dirty.has(key(200)),"watcher event during an awaited scan remains pending for its next owner");
  await writeFile(textPath(key(200)),"constructor tostring hasownproperty scientific words");
  markFulltextDirty(refresh,`items/${key(200)}/fulltext.txt`);
  const inherited=await searchFulltext("constructor",{libPath:root,refresh});
  h.eq(inherited.hits.map(x=>x.key),[key(200)],"ordinary inherited-property word is indexed as data");
  const indexPath=path.join(root,".fluxlib","fulltext-index.json");
  const incomplete=JSON.parse(await readFile(indexPath,"utf8"));incomplete.postings={};
  await writeFile(indexPath,JSON.stringify(incomplete));
  h.eq((await searchFulltext("constructor",{libPath:root,refresh})).hits.map(x=>x.key),[key(200)],"missing postings with unchanged source stamps rebuild from text instead of silently omitting hits");
  const malformed=JSON.parse(await readFile(indexPath,"utf8"));malformed.postings.constructor={[key(200)]:["not-a-page"]};
  const {schemaVersion,builtAt,docs,postings}=malformed;
  malformed.integrity=createHash("sha256").update(JSON.stringify({schemaVersion,builtAt,docs,postings})).digest("hex");
  await writeFile(indexPath,JSON.stringify(malformed));
  h.eq((await searchFulltext("constructor",{libPath:root,refresh})).hits.map(x=>x.key),[key(200)],"structurally invalid posting is rejected even with a matching cache digest");
  const staleDir=path.join(root,"items","stale");await mkdir(staleDir);
  await writeFile(path.join(staleDir,"paper.pdf"),"%PDF scientific source");
  await writeFile(path.join(staleDir,"fulltext.txt"),"obsolete scientific text");
  await writeFile(path.join(staleDir,"source.pending.json"),"{}");markFulltextDirty(refresh,"items/stale/source.pending.json");
  for(const options of [{},{forceScan:true}]) for(const query of ["scientific",'"scientific text"',"s"]){
    const result=await searchFulltext(query,{libPath:root,refresh,limit:500,...options});
    assert(!result.hits.some(x=>x.key==="stale"));assert(result.missingText.includes("stale"));
  }
  h.ok(true,"indexed, phrase, short-query and exact scan agree on stale PDF exclusion and rebuild status");
  h.ok((await searchFulltext('"scientific common"',{libPath:root,refresh,limit:1})).missingText.includes("stale"),"early limited phrase result retains already known extraction needs");

  // A progress packet must never consume the active request, even if the
  // requesting view throws/disposes while observing it.
  let current:any;
  class FakeWorker extends EventEmitter {constructor(){super();current=this;} postMessage(message:any){this.last=message;} last:any;terminate(){return Promise.resolve(0);}}
  const service=createFulltextService({workerFile:"unused",root,WorkerImpl:FakeWorker});
  let settled=false, progressCalls=0;
  const request=service.search("pane-a","query",{},()=>{progressCalls++;throw Error("view disposed");}).then((r:any)=>{settled=true;return r;});
  const id=current.last.id;
  current.emit("message",{kind:"progress",id:id+1,progress:{phase:"checking",completed:0,total:300}});
  current.emit("message",{kind:"progress",id,progress:{phase:"checking",completed:1,total:300}});
  await Promise.resolve();
  h.ok(!settled&&progressCalls===1&&service.status().active,"only owning progress is delivered and it cannot settle/fail search");
  service.markDirty("items/paper000/fulltext.txt");h.eq(current.last.kind,"dirty","native dirty event forwards independently of active query");
  current.emit("message",{kind:"result",id,result:{hits:[]}});await request;service.dispose();

  const handlers=new Map<string,Function>(), pending:any[]=[], cancelled:string[]=[];
  const fakeService={search(owner:string,q:string,_opts:any,onProgress:Function){return new Promise(resolve=>pending.push({owner,q,onProgress,resolve}));},cancelOwner(owner:string){cancelled.push(owner);},markDirty(){},dispose(){}};
  const jobs=createReadJobs({app:{isPackaged:false},appRoot:root,fluxLibDir:()=>root,createService:()=>fakeService});
  jobs.registerHandlers({handle:(name:string,fn:Function)=>handlers.set(name,fn)});
  const sender:any=new EventEmitter();sender.id=42;sender.isDestroyed=()=>false;const sent:any[]=[];sender.send=(channel:string,p:any)=>sent.push({channel,p});
  const search=handlers.get("fulltext:search")!, cancel=handlers.get("fulltext:cancel")!;
  const a=search({sender},{query:"first",opts:{ownerId:"a",requestId:"a1"}});await Promise.resolve();
  const b=search({sender},{query:"second",opts:{ownerId:"b",requestId:"b1"}});await Promise.resolve();
  pending[0].onProgress({phase:"indexing",completed:1,total:300});
  h.ok(pending[0].owner!==pending[1].owner&&sent[0].p.requestId==="a1","two panes retain distinct worker owners and request-qualified progress");
  h.ok(cancel({sender},{ownerId:"a",requestId:"stale"})===false&&cancelled.length===0,"stale cancellation cannot stop a current pane");
  h.ok(cancel({sender},{ownerId:"a",requestId:"a1"})===true&&cancelled[0]===pending[0].owner,"explicit cancellation targets only the owning pane/request");
  pending[0].onProgress({phase:"indexing",completed:2,total:300});
  h.eq(sent.length,1,"cancelled query cannot publish late progress");
  pending[0].resolve({hits:[]});pending[1].resolve({hits:[]});await Promise.all([a,b]);jobs.dispose();

  let releaseTermination!:()=>void, stopped=false;
  const stopBarrier=new Promise<void>(resolve=>releaseTermination=resolve);
  const moving=createReadJobs({app:{isPackaged:false},appRoot:root,fluxLibDir:()=>root,createService:()=>({search:async()=>({hits:[]}),cancelOwner(){},markDirty(){},dispose:async()=>{await stopBarrier;stopped=true;}})});
  const moveHandlers=new Map<string,Function>();moving.registerHandlers({handle:(n:string,f:Function)=>moveHandlers.set(n,f)});
  await moveHandlers.get("fulltext:search")!({sender},{query:"before move"});
  let resumed=false;
  const suspension=moving.suspend().then((resume:Function)=>{resumed=true;return resume;});
  await Promise.resolve();
  h.ok(!resumed&&!stopped&&(await moveHandlers.get("fulltext:search")!({sender},{query:"during move"})).cancelled,"root move waits for worker termination and refuses overlapping searches");
  releaseTermination();const resume=await suspension;
  h.ok(stopped&&(await moveHandlers.get("fulltext:search")!({sender},{query:"still moving"})).cancelled,"drained worker stays suspended until move or failure has settled");
  resume();resume();
  h.ok(!(await moveHandlers.get("fulltext:search")!({sender},{query:"after move"})).error,"owned idempotent resume permits a new worker after success or failure");
  moving.dispose();

  const watcher:any=new EventEmitter();watcher.close=async()=>{};const changes:any[]=[];
  const global=createGlobalLibraryWatcher({loadChokidar:async()=>({watch:()=>watcher}),fluxLibDir:()=>root,captureDir:()=>null,readPrefs:()=>({}),liveWindows:()=>[],writeOrigin:()=>42,notifyRenderer:()=>{},TMP_WRITE_RE:/\.tmp$/,onLibraryChange:(r:string,p:string|null)=>changes.push([r,p])});
  await global.rebuild();changes.length=0;
  watcher.emit("all","change",textPath(key(1)));watcher.emit("all","change",textPath(key(2)));
  h.eq(changes.map(x=>x[1]),[textPath(key(1)),textPath(key(2))],"coalesced own-window writes both reach index before renderer notification");
  watcher.emit("error",Error("watch lost"));h.eq(changes.at(-1)[1],null,"watcher failure invalidates full discovery");
  await global.dispose();
} finally {await rm(root,{recursive:true,force:true});}
h.done();
