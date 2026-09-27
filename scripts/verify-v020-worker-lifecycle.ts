import assert from 'node:assert/strict';
class FakeWorker {
 static all:FakeWorker[]=[];static rejectNext=false;onmessage:((e:any)=>void)|null=null;onerror:((e:any)=>void)|null=null;sent:any[]=[];terminated=false;
 constructor(){if(FakeWorker.rejectNext){FakeWorker.rejectNext=false;throw Error('controlled worker constructor failure')}FakeWorker.all.push(this)}
 postMessage(m:any){this.sent.push(m)}terminate(){this.terminated=true}
 reply(m:any){this.onmessage?.({data:m})}fail(){this.onerror?.({message:'controlled import/worker failure'})}
}
(globalThis as any).Worker=FakeWorker;
const math=await import('../src/shell/modes/paper/science/mathRenderService');
const last=()=>FakeWorker.all.at(-1)!;
const answer=(w:FakeWorker,html:string)=>w.reply({id:w.sent.at(-1).id,html});
const a=math.renderMath('old expression',true),old=last();old.fail();assert.match(await a,/old expression/);assert.ok(old.terminated);
const b=math.renderMath('new expression',true),current=last();assert.notEqual(current,old);current.reply({ready:true});old.reply({id:current.sent.at(-1).id,html:'STALE'});old.fail();assert.equal(current.terminated,false);answer(current,'NEW');assert.equal(await b,'NEW');
const dup1=math.renderMath('coalesced',false),dup2=math.renderMath('coalesced',false);assert.equal(dup1,dup2);answer(current,'COALESCED');await dup1;
// Count pressure: old keys evict one at a time, recent keys remain hits.
for(let i=0;i<501;i++){const p=math.renderMath('count-'+i,false);answer(current,'value-'+i);await p}
const before=current.sent.length;await math.renderMath('count-500',false);assert.equal(current.sent.length,before);
const evicted=math.renderMath('count-0',false);assert.equal(current.sent.length,before+1);answer(current,'fresh');await evicted;
// Byte pressure independently evicts below the entry-count limit.
for(let i=0;i<6;i++){const p=math.renderMath('bytes-'+i,false);answer(current,'x'.repeat(1024*1024));await p}
const bytesBefore=current.sent.length;const byteEvicted=math.renderMath('bytes-0',false);assert.equal(current.sent.length,bytesBefore+1);answer(current,'fresh');await byteEvicted;
const queued=Array.from({length:140},(_,i)=>math.renderMath('bounded-'+i,true));let messages=0;const answered=new Set<number>();
while(current.sent.at(-1)?.tex?.startsWith('bounded-')&&!answered.has(current.sent.at(-1).id)){answered.add(current.sent.at(-1).id);answer(current,'bounded');messages++;}
const results=await Promise.all(queued);assert.ok(messages<=129&&results.some(x=>x.includes('queue is full')));
// A failed worker must not poison the next lazy initialization.
const failure=math.renderMath('fail-active',false);current.fail();assert.match(await failure,/failed/);
FakeWorker.rejectNext=true;const constructor=math.renderMath('constructor failure',false);assert.match(await constructor,/constructor failure/);
const healthy=math.renderMath('healthy again',false);last().reply({ready:true});answer(last(),'HEALTHY');assert.equal(await healthy,'HEALTHY');
const {localCorrectionService:s}=await import('../src/shell/modes/paper/editing/localCorrectionService');
// `repair` keeps these requests on the LIVE lane that warm() just created —
// `lintOnly` is annotation-only work and rides its own lane (2026-09-22), which
// would leave `original` serving nothing. The lifecycle contract is unchanged:
// a failed worker rejects ITS OWN pending work, and the failed worker cannot
// then kill the replacement that succeeds it.
s.warm('fixture');const original=last(),pending=s.lint('old','' as any,'repair','old');original.fail();await assert.rejects(pending,/failure/);
const repaired=s.lint('new',undefined,'repair','new'),replacement=last();original.fail();assert.equal(replacement.terminated,false);replacement.reply({type:'ready'});replacement.reply({type:'lints',id:replacement.sent.at(-1).id,lints:[],elapsedMs:0});assert.deepEqual(await repaired,[]);
// The background lane is independent: it is created lazily by annotation-only
// work and a live-lane failure must not take it, or its pending work, down.
const annotation=s.lint('backlog',undefined,'lintOnly','scan'),background=last();assert.notEqual(background,replacement);
background.reply({type:'ready'});background.reply({type:'lints',id:background.sent.at(-1).id,lints:[],elapsedMs:0});assert.deepEqual(await annotation,[]);
// Actual bibliography loader ownership: a delayed old project read cannot
// replace the newer accepted source captured by an export job.
let releaseBib!: (text:string)=>void;
(globalThis as any).window={fig:{exists:async()=>true,readText:async(p:string)=>p.startsWith('/old/')?new Promise<string>(r=>releaseBib=r):'% newer exact bytes\r\n'}};
const {loadBib}=await import('../src/shell/modes/paper/scholar/bibLoad');
const {bibSource}=await import('../src/shell/modes/paper/scholar/bib');
const {get}=await import('svelte/store');
const oldBib=loadBib('/old');await Promise.resolve();await loadBib('/new');
releaseBib('% stale bytes\n');await oldBib;
assert.deepEqual(get(bibSource),{root:'/new',text:'% newer exact bytes\r\n'});
console.log(JSON.stringify({mathFailureRestart:true,staleMessagesIgnored:true,constructorRetry:true,entryCacheBound:500,byteCacheBound:8388608,queuedJobs:140,executedJobs:messages,correctionOldWorkerCannotKillReplacement:true,bibliographyLatestOwner:true,passed:true}));
