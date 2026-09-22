import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createOwnedPdfTask } from '../src/lib/pdf/taskOwner';
import { createReaderSourceOwner } from '../src/shell/modes/reader/readerSession';
import { createReaderContextPublisher } from '../src/shell/modes/reader/readerContextPublisher';
import { createReaderSnipController, type ReaderSnipRequest } from '../src/shell/modes/reader/readerSnips';
import { readPngDpi, readPngText } from '../src/lib/figure/pngDpi';
import { SNIP_TEXT_KEYWORD } from '../src/lib/references/snips';
import { readReaderContext, ensureItemDir } from '../flux-core/items';
import { harness } from './lib/harness.mjs';
const require=createRequire(import.meta.url),{createFileCore}=require('../electron/ipc/files.cjs'),{createReaderContext}=require('../electron/ipc/readerContext.cjs');
const h=harness('verify-reader-session');
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
// Version-specific structural guard. PDF.js6 removed the old no-eval switch;
// these paired builds have no PDF-data source compiler. Native inert-PDF behavior
// is covered by verify-pdf-inert-electron, not inferred from this source check.
for(const entry of ['pdf.mjs','pdf.worker.mjs']) {
 const source=fs.readFileSync(require.resolve('pdfjs-dist/legacy/build/'+entry),'utf8');
 // Bundled core-js has one fixed global-object fallback, unreachable where
 // globalThis exists. It compiles a literal, never PDF data. No other compiler
 // site is permitted by this deliberately version-specific guard.
 const withoutGlobalFallback=source.replace("Function('return this')()",'STATIC_GLOBAL_OBJECT_FALLBACK');
 h.ok(!/\b(?:eval|Function)\s*\(/.test(withoutGlobalFallback),`installed legacy ${entry} has no PDF-data compiler beyond the fixed global-object fallback (structural)`);
}
for(const failure of ['worker-setup','task-setup','invalid-load','destroy-reject','worker-destroy-reject','valid']) {
 let ports=0,workers=0,tasks=0,options:any;
 const input=new Uint8Array([1,2,3]);
 const owned=createOwnedPdfTask(input,'file:///isolated/pdfjs/',{
  createPort:()=>({terminate(){ports++;}}),
  createWorker:()=>{if(failure==='worker-setup')throw Error(failure);return {destroy(){workers++;if(failure==='worker-destroy-reject')throw Error(failure);}};},
  getDocument:o=>{options=o;if(failure==='task-setup')throw Error(failure);return {promise:failure==='invalid-load'?Promise.reject(Error('Invalid PDF')):Promise.resolve({numPages:1}),destroy:async()=>{tasks++;if(failure==='destroy-reject')throw Error(failure);}} as any;},
 });
 if(['worker-setup','task-setup','invalid-load'].includes(failure))await assert.rejects(()=>owned.promise);else await owned.promise;
 await owned.dispose();await owned.dispose();
 h.ok(ports===1&&workers===(failure==='worker-setup'?0:1)&&tasks===(['worker-setup','task-setup'].includes(failure)?0:1),`PDF ${failure}: created resources terminate exactly once including cleanup rejection`);
 if(options){h.ok(options.isEvalSupported===false&&options.wasmUrl.endsWith('/wasm/')&&options.iccUrl.endsWith('/iccs/'),'PDF task requests legacy no-eval compatibility and local auxiliary assets');options.data[0]=9;h.eq([...input],[1,2,3],'PDF transfer owns independent bytes');}
}
{
 let root='A',selected='main',errors=0;const owner=createReaderSourceOwner(async()=>root);const a=deferred<string>(),b=deferred<string>();
 const first=owner.run(()=>a.promise,value=>{selected=value;});await tick();const second=owner.run(()=>b.promise,value=>{selected=value;});await tick();b.resolve('supplement B');await second;a.resolve('supplement A');await first;
 h.eq(selected,'supplement B','slow A cannot replace newer B source');
 const c=deferred<string>();const pending=owner.run(()=>c.promise,value=>{selected=value;});await tick();owner.invalidate();selected='main';c.resolve('supplement C');await pending;h.eq(selected,'main','main selection invalidates a pending supplement');
 const d=deferred<string>();const moved=owner.run(()=>d.promise,value=>{selected=value;});await tick();root='B';d.resolve('old library PDF');await moved;h.eq(selected,'main','root changes refuse delayed old-library publication');
 await owner.run(async()=>{throw Error('EACCES');},()=>{},()=>{errors++;});h.eq(errors,1,'owned load failure becomes actionable error rather than unhandled rejection');
 const e=deferred<string>();const close=owner.run(()=>e.promise,value=>{selected=value;});await tick();owner.dispose();e.resolve('closed view');await close;h.eq(selected,'main','disposed view cannot adopt late source bytes');
}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-reader-owner-'));
try {
 for(const mode of ['success','source-switch','project-switch','disposed','lease-loss']) {
  const project=path.join(scratch,'snip-'+mode);fs.mkdirSync(project);
  let currentProject=project,currentEpoch=1,alive=true,leaseHeld=true;
  const render=deferred<string|null>(),started=deferred<void>();
  const request:ReaderSnipRequest={citekey:'supplement-paper',page:2,rect:[0,0,20,10],name:'region',citation:'Exact scientific citation',projectRoot:project,sourceEpoch:1,sourcePdf:{supplement:'methods.pdf'},view:{pageBox:async()=>[0,0,100,100],renderRegion:async()=>{started.resolve();return render.promise;}}};
  const controller=createReaderSnipController({current:r=>alive&&r.projectRoot===currentProject&&r.sourceEpoch===currentEpoch,bridge:()=>({mkdir:async p=>{fs.mkdirSync(p,{recursive:true});},exists:async p=>fs.existsSync(p),writeText:async(p,text,options)=>{fs.writeFileSync(p,text,{flag:options?.createOnly?'wx':'w'});},writeFile:async(p,bytes)=>{fs.writeFileSync(p,bytes);}}),withLease:async(root,publish)=>{assert.equal(root,project);if(mode==='lease-loss')leaseHeld=false;await publish(async()=>{if(!leaseHeld)throw Error('Lost lease');});}});
  const saving=controller.save(request,'chosen region');await started.promise;
  if(mode==='source-switch')currentEpoch++;if(mode==='project-switch')currentProject=path.join(scratch,'other-project');if(mode==='disposed')alive=false;
  // Mutation after render starts must not alter captured embedded provenance.
  request.citekey='wrong-late-key';request.sourcePdf={supplement:'wrong-late.pdf'};
  render.resolve('data:image/png;base64,'+fs.readFileSync('scripts/fixtures/slide-video-clips/poster.png').toString('base64'));
  if(mode==='success') {
   const saved=await saving,base=path.join(project,'plots/paper_snips',saved.name),png=fs.readFileSync(base+'.png'),side=JSON.parse(fs.readFileSync(base+'.snip.json','utf8'));
   h.eq(JSON.parse(readPngText(png,SNIP_TEXT_KEYWORD)!),side,'actual saved PNG provenance equals the matching sidecar');
   h.ok(side.citekey==='supplement-paper'&&side.sourcePdf.supplement==='methods.pdf'&&side.citation==='Exact scientific citation','delayed snip records immutable captured supplement and citation');
   h.eq(Math.round(readPngDpi(png)!),288,'extracted Reader snip controller preserves physical DPI');
  } else {
   await assert.rejects(()=>saving,mode==='lease-loss'?/Lost lease/:/source changed/);
   const out=path.join(project,'plots/paper_snips');h.ok(!fs.existsSync(out)||fs.readdirSync(out).length===0,`snip ${mode} during delayed render/commit publishes no PNG or provenance into either project`);
   h.ok(!fs.existsSync(path.join(scratch,'other-project')),'canceled snip never creates the replacement project');
  }
 }
 const A=path.join(scratch,'A'),B=path.join(scratch,'B');for(const root of [A,B])fs.mkdirSync(path.join(root,'.fluxlib'),{recursive:true});
 let activeRoot=A,focus=1;const senders=[1,2].map(id=>Object.assign(new EventEmitter(),{id,isDestroyed:()=>false}));
 const windows=senders.map(sender=>Object.assign(new EventEmitter(),{isFocused:()=>focus===sender.id}));
 const core=createFileCore({app:{getPath:()=>scratch},roots:()=>[A,B]});
 let beforeCommit:(()=>void)|undefined;
 let writeGate:{entered:ReturnType<typeof deferred<void>>;release:ReturnType<typeof deferred<void>>}|undefined;
 const native=createReaderContext({rootFor:()=>activeRoot,windowFor:(s:any)=>windows[s.id-1],guard:(e:any,p:string)=>core.fsGuard(p,e.sender.id),atomicWrite:async(p:string,b:any,c:any,m:any,s:any,check:()=>void)=>{const gate=writeGate;if(gate){gate.entered.resolve();await gate.release.promise;}return core.atomicWriteMain(p,b,c,m,s,()=>{beforeCommit?.();check();});}});
 const context=(key:string)=>({citekey:key,updatedAt:new Date().toISOString(),selection:`exact ${key} scientific selection`});
 const one=await native.claim(senders[0],{root:A,owner:'pane-A'});await native.publish(senders[0],{token:one.token,generation:1,context:context('paper-A')});
 const pA=path.join(A,'.fluxlib','reader-context.json'),prior=fs.readFileSync(pA);
 h.eq((await readReaderContext(A))?.citekey,'paper-A','Node context reads current native source and resolves its item paths');
 const item=await ensureItemDir('paper-A',A),externalPdf=path.join(scratch,'deferred-external.pdf');
 fs.writeFileSync(path.join(item,'paper.link.json'),JSON.stringify({path:externalPdf,linkedAt:new Date().toISOString()}));
 h.eq((await readReaderContext(A))?.pdfPath,externalPdf,'main reading context resolves the actual linked source without opening a deferred PDF');
 h.ok(!fs.existsSync(externalPdf),'context lookup never materializes a missing external PDF');
 fs.writeFileSync(path.join(item,'paper.pdf'),'exact stored source');
 // The resolver joins a POSIX item path onto the root, so on Windows its
 // answer mixes separators while path.join would not — compare in one form.
 h.eq((await readReaderContext(A))?.pdfPath?.split(path.sep).join('/'),path.join(item,'paper.pdf').split(path.sep).join('/'),'stored PDF remains authoritative over a fallback linked pointer');
 h.eq(await native.release(senders[1],one.token),false,'foreign renderer cannot clear another sender claim');
 let two:any;
 beforeCommit=()=>{beforeCommit=undefined;focus=2;two=native.claim(senders[1],{root:A,owner:'pane-B'});};
 h.eq(await native.publish(senders[0],{token:one.token,generation:2,context:context('late-A')}),false,'focus/owner switch at actual pre-rename boundary rejects old context');
 h.eq(fs.readFileSync(pA),prior,'rejected old context preserves exact previous saved bytes');
 two=await two;
 await native.publish(senders[1],{token:two.token,generation:1,context:context('paper-B')});
 h.eq(await native.release(senders[0],one.token),false,'stale clear cannot erase a newer focused owner');
 h.eq(JSON.parse(fs.readFileSync(pA,'utf8')).citekey,'paper-B','newest focused document remains stored after stale clear');
 await native.publish(senders[1],{token:two.token,generation:2,context:{...context('paper-B'),sourcePdf:{supplement:'methods.pdf'}}});
 const supplementContext=await readReaderContext(A);h.ok(supplementContext?.pdfPath?.split(path.sep).join('/').endsWith('/supplements/methods.pdf')&&!supplementContext.fulltextPath,'supplement context names actual PDF and cannot expose main-paper fulltext');
 await assert.rejects(()=>native.publish(senders[1],{token:two.token,generation:3,context:{...context('paper-B'),sourcePdf:{supplement:'../foreign.pdf'}}}),/source/);h.ok(true,'context source rejects traversal identity');
 const current=fs.readFileSync(pA);beforeCommit=()=>{beforeCommit=undefined;activeRoot=B;};
 h.eq(await native.publish(senders[1],{token:two.token,generation:4,context:context('wrong-root')}),false,'library move during staged native write is refused at commit');
 h.eq(fs.readFileSync(pA),current,'library-root change preserves exact old context bytes');
 h.ok(!fs.existsSync(path.join(B,'.fluxlib','reader-context.json')),'old source never materializes as context under new library root');
 activeRoot=A;focus=2;const live=await native.claim(senders[1],{root:A,owner:'live'});
 const transport={renew:async(token:string,generation:number)=>native.renew(senders[1],{token,generation}),claim:async(root:string,owner:string)=>native.claim(senders[1],{root,owner}),publish:async(token:string,generation:number,ctx:any)=>native.publish(senders[1],{token,generation,context:ctx}),release:async(token:string)=>native.release(senders[1],token)};
 const publisher=createReaderContextPublisher(transport,'heartbeat',{heartbeatMs:5});publisher.update(A,context('long-read'),true);await publisher.flush();
 // The 5ms heartbeat needs a tick to land, and a fixed sleep assumes the
 // runner grants one — it did not, under load (CI, 2026-09-22). Poll for the
 // renewal instead: this still fails a heartbeat that never renews.
 const firstTime=JSON.parse(fs.readFileSync(pA,'utf8')).expiresAt;
 let renewed=firstTime;
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,20));await publisher.flush();renewed=JSON.parse(fs.readFileSync(pA,'utf8')).expiresAt;if(renewed>firstTime)break;}
 h.ok(renewed>firstTime,'focused long read renews context without user interaction');
 focus=0;publisher.update(A,context('must-not-publish-background-change'),true,false);await publisher.flush();
 const external=await readReaderContext(A);h.ok(external?.citekey==='long-read'&&external.foreground===false,'external-agent OS focus retains the exact last reader context without publishing new background text');
 const contentAt=external?.updatedAt;await new Promise(r=>setTimeout(r,12));await publisher.flush();
 h.ok((await readReaderContext(A))?.updatedAt===contentAt,'background heartbeat renews liveness without falsely restamping content time');
 focus=2;
 await publisher.dispose();h.eq(await readReaderContext(A),null,'view disposal releases its exact native context owner');
 const old={...context('crashed'),owner:live.token,expiresAt:new Date(Date.now()-1).toISOString()};fs.writeFileSync(pA,JSON.stringify(old));
 h.eq(await readReaderContext(A),null,'expired crashed-process context cannot be returned as current reading');
 const dead=await native.claim(senders[1],{root:A,owner:'destroyed'});await native.publish(senders[1],{token:dead.token,generation:1,context:context('destroyed')});senders[1].emit('destroyed');
 // The destroy handler fires release() WITHOUT awaiting it, so a single read a
 // fixed 10ms later is racing an un-awaited write — it lost on a loaded CI
 // runner (2026-09-22). Poll to a deadline: the clear must still happen
 // promptly and long before the 30s expiry fallback this check is about.
 let cleared=null;for(let i=0;i<200;i++){cleared=await readReaderContext(A);if(cleared===null)break;await new Promise(r=>setTimeout(r,10));}
 h.eq(cleared,null,'native sender destruction clears context before the expiry fallback');
 activeRoot=A;focus=2;
 const pause1=await native.suspend(),pause2=await native.suspend();
 h.eq(await native.claim(senders[1],{root:A,owner:'paused'}),null,'configuration move refuses new native context claims');
 pause1();pause1();h.eq(await native.claim(senders[1],{root:A,owner:'still-paused'}),null,'overlapping configuration suspensions cannot resume each other');
 pause2();h.ok((await native.claim(senders[1],{root:A,owner:'resumed'}))?.token,'move failure or success resume admits only a fresh context claim');
 const drainOwner=await native.claim(senders[1],{root:A,owner:'drain'}),drainBefore=fs.readFileSync(pA);
 writeGate={entered:deferred<void>(),release:deferred<void>()};
 const writing=native.publish(senders[1],{token:drainOwner.token,generation:1,context:context('must-not-recreate-old-root')});await writeGate.entered.promise;
 let drained=false;const pausePromise=native.suspend().then((resume:()=>void)=>{drained=true;return resume;});await tick();
 h.ok(!drained,'configuration move awaits in-flight context publication settlement');
 writeGate.release.resolve();writeGate=undefined;h.eq(await writing,false,'suspension invalidates queued context before actual atomic rename');
 const resumeMove=await pausePromise;h.eq(fs.readFileSync(pA),drainBefore,'drained context transaction retains exact original saved bytes');
 const moved=path.join(scratch,'moved-library');fs.renameSync(A,moved);activeRoot=moved;resumeMove();await tick();
 h.ok(!fs.existsSync(A),'drained native owner cannot recreate the old library after a real directory move');
 fs.renameSync(moved,A);activeRoot=A;
 const escape=path.join(B,'foreign-context.json');fs.writeFileSync(escape,'exact foreign bytes');fs.unlinkSync(pA);fs.symlinkSync(escape,pA);
 await assert.rejects(()=>native.claim(senders[1],{root:A,owner:'escape'}),/escapes/);
 h.eq(fs.readFileSync(escape,'utf8'),'exact foreign bytes','native context refuses a cross-library stored-path symlink without changing foreign bytes');
 native.dispose();
 const delayed=deferred<{token:string;root:string}>(),released:string[]=[];let publications=0;
 const pending=createReaderContextPublisher({claim:()=>delayed.promise,publish:async()=>{publications++;return true;},release:async token=>{released.push(token);}},'late');
 pending.update(A,context('old-pane'),true);await tick();pending.update(A,null,false);delayed.resolve({token:'late-token',root:A});await pending.flush();
 h.ok(publications===0&&released.includes('late-token'),'focus lost during claim releases late token without publishing old selection');await pending.dispose();
} finally {fs.rmSync(scratch,{recursive:true,force:true});}
h.done();
