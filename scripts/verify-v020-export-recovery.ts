// Real Node export orchestration is killed at acknowledged I/O boundaries.
// Reopen uses the production CLI registry boundary, not the recovery helper.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { createDeck } from '../src/lib/slide/ops';
import { samePath } from "./lib/paths.mjs";
const self=fileURLToPath(import.meta.url), require=createRequire(import.meta.url);
const journalRel='.meta/export-source-transaction.json';
const originals=new Map([
 ['paper/notes.qmd','---\ntitle: "Recovery α"\nfilters: [barrier.lua]\n---\n\nSee @fig-1, α β.\n\n{{< include part.qmd >}}\n'],
 ['paper/part.qmd','## Included result\r\n\r\nUnicode μm, <1 ms; see @fig-1.\r\n'],
]);
const stamp=1600000000000; let oldArtifact=Buffer.from('initial fixture placeholder');
if(process.argv[2]==='--writer'){
 setInterval(()=>{},1000); // Keep an acknowledged blocked I/O operation alive until SIGKILL.
 const root=process.argv[3],stage=process.argv[4],journal=path.join(root,journalRel);
 const native=require('node:fs/promises'),oldRename=native.rename,oldOpen=native.open,oldRm=native.rm;
 let journalPublished=false,fired=false;
 const barrier=async(name:string)=>{if(name!==stage||fired)return;fired=true;process.send?.({stage:name});await new Promise(()=>{})};
 native.rename=async(from:string,to:string)=>{
  await oldRename(from,to);
  if(samePath(to,journal))journalPublished=true;
  const relative=path.relative(root,to).split(path.sep).join('/');
  if(originals.has(relative))await barrier((await fs.readFile(to,'utf8'))===originals.get(relative)?'first-restore':'first-rewrite');
 };
 native.open=async(file:string,...args:any[])=>{
  const handle=await oldOpen(file,...args);
  if(samePath(file,path.join(root,'.meta'))){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(journalPublished)await barrier('journal-durable')}}
  return handle;
 };
 native.rm=async(file:string,...args:any[])=>{if(samePath(file,journal)&&journalPublished)await barrier('restoration-complete');return oldRm(file,...args)};
 const cp=require('node:child_process'),spawn=cp.spawn;
 cp.spawn=(...args:any[])=>{const child=spawn(...args);if(child.pid&&args[2]?.detached)process.send?.({ownedGroup:child.pid});return child};
 syncBuiltinESMExports();
 const {compile}=await import('../flux-core/manuscript');
 const result=await compile(root,'docx',{style:'nature'});
 throw Error('Export reached completion before controlled barrier '+stage+': '+JSON.stringify(result));
}else if(process.argv[2]==='--reopen'){
 const root=process.argv[3];
 const {runCliVerb}=await import('../flux-core/registry');
 let code=0,errors='';
 assert.equal(await runCliVerb('list',{pos:[],posRooted:[],flags:{},rootFlags:root,rootPositional:root},{log:()=>{},err:s=>{errors+=s},setExit:c=>{code=c}}),true);
 if(code)throw Error(errors);
}else{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-export-matrix-'));
 const out=process.env.FLUX_OUT||'test-results/v020-export-recovery';await fs.mkdir(out,{recursive:true});
 const evidence:any[]=[];
 // 'journal-durable' hooks the fsync of the .meta DIRECTORY, and fsyncDir is a
 // deliberate no-op on win32 (fsx.ts) because Windows has no directory fsync —
 // so there is no such boundary to kill at there.
 const stages=['journal-durable','first-rewrite','render','first-restore','restoration-complete'].filter(stage=>stage!=='journal-durable'||process.platform!=='win32');
 async function seed(stage:string){
  await fs.rm(root,{recursive:true,force:true});
  const tree=buildScaffoldTree({title:'Recovery α'},createDeck({id:'recovery-talk',title:'Recovery'}));
  for(const [rel,content]of tree.files){await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),content)}
  for(const [rel,content]of originals){await fs.writeFile(path.join(root,rel),content);await fs.utimes(path.join(root,rel),stamp/1000,stamp/1000)}
  const ready=path.join(root,'render-ready'),release=path.join(root,'render-release');
  await fs.writeFile(path.join(root,'paper/barrier.lua'),`function Pandoc(doc)\n local f = assert(io.open([[${ready}]], "w")); f:write("actual pandoc render"); f:close()\n ${stage==='render'?`while not io.open([[${release}]], "r") do os.execute("sleep 0.05") end`:''}\n return doc\nend\n`);
  await fs.writeFile(path.join(root,'paper/notes.docx'),oldArtifact);
 }
 /** SIGKILL a child AND its descendants: a process group off win32, taskkill /T on it. */
 function killTree(pid:number){
  if(process.platform==='win32')spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  else try{process.kill(-pid,'SIGKILL')}catch{try{process.kill(pid,'SIGKILL')}catch{}}
 }
 async function killAt(stage:string){
  const child=fork(self,['--writer',root,stage],{execArgv:['--import','tsx'],detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
  const groups:number[]=[];let errorLog='',reached=false,exit:any=null;child.stderr!.on('data',b=>errorLog+=b);child.stdout!.on('data',b=>errorLog+=b);
  child.on('message',(m:any)=>{if(m.stage===stage)reached=true;if(m.ownedGroup)groups.push(m.ownedGroup)});child.on('exit',(code,signal)=>exit={code,signal});
  try{
   const end=Date.now()+45000;
   while(!reached){if(stage==='render')reached=await fs.access(path.join(root,'render-ready')).then(()=>true,()=>false);if(reached)break;if(exit)throw Error(`Writer exited before ${stage}: ${JSON.stringify(exit)}\n${errorLog}`);if(Date.now()>end)throw Error('Barrier timeout '+stage+'\n'+errorLog);await new Promise(r=>setTimeout(r,20))}
   const text=await fs.readFile(path.join(root,journalRel),'utf8');const record=JSON.parse(text);assert.equal(record.files.length,2,stage+' covers main + included source');
   if(['render','first-restore','restoration-complete'].includes(stage))assert.ok(record.generated?.length,'owned profile journaled');
   await fs.writeFile(path.join(out,stage+'-journal.json'),text);
   // win32 has no process groups, and `child.kill` leaves the quarto/pandoc
   // grandchild alive holding paper/ as its cwd — the next seed then fails to
   // remove the fixture with EBUSY. taskkill /T is the tree kill there.
   const exited=once(child,'exit');killTree(child.pid!);await exited;
  }finally{
   try{killTree(child.pid!)}catch{}
   for(const group of groups)try{killTree(group)}catch{}
  }
 }
 async function reopen(expectFailure?:RegExp){
  const child=fork(self,['--reopen',root],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let log='';child.stderr!.on('data',b=>log+=b);const [code]=await once(child,'exit');
  if(expectFailure){assert.notEqual(code,0);assert.match(log,expectFailure)}else assert.equal(code,0,log);
 }
 try{
  await seed('baseline');
  const {compile}=await import('../flux-core/manuscript');
  const baseline=await compile(root,'docx');assert.equal(baseline.code,0,baseline.log);assert.ok(baseline.output);oldArtifact=await fs.readFile(baseline.output!);
  const {validateDocx}=await import('../src/lib/references/docxArtifact');validateDocx(oldArtifact);await fs.writeFile(path.join(out,'previous-valid.docx'),oldArtifact);
  for(const stage of stages){
   await seed(stage);await killAt(stage);await reopen();await reopen();
   for(const [rel,content]of originals){assert.deepEqual(await fs.readFile(path.join(root,rel)),Buffer.from(content),stage+' exact bytes '+rel);assert.equal((await fs.stat(path.join(root,rel))).mtimeMs,stamp,stage+' original mtime '+rel)}
   assert.deepEqual(await fs.readFile(path.join(root,'paper/notes.docx')),oldArtifact);
   assert.equal(await fs.access(path.join(root,journalRel)).then(()=>true,()=>false),false);
   assert.equal((await fs.readdir(path.join(root,'paper'))).some(n=>n.startsWith('_quarto-flux-')),false);
   evidence.push({stage,signal:'SIGKILL',reopen:'production CLI registry twice',exactSources:2,originalMtimes:true,priorArtifactRetained:true,generatedProfileRemoved:true});
  }
  await seed('first-rewrite');await killAt('first-rewrite');await fs.writeFile(path.join(root,'paper/notes.qmd'),'newer external edit Ω\r\n');await reopen(/changed or missing/);assert.equal(await fs.readFile(path.join(root,'paper/notes.qmd'),'utf8'),'newer external edit Ω\r\n');assert.ok(await fs.stat(path.join(root,journalRel)));
  await fs.writeFile(path.join(root,journalRel),'{corrupt journal');await reopen(/JSON|Unexpected|property name/);assert.equal(await fs.readFile(path.join(root,journalRel),'utf8'),'{corrupt journal');assert.equal(await fs.readFile(path.join(root,'paper/notes.qmd'),'utf8'),'newer external edit Ω\r\n');
  await fs.writeFile(path.join(out,'matrix.json'),JSON.stringify({stages:evidence,externalEditPreserved:true,corruptJournalPreserved:true},null,2));
  console.log(`Export recovery PASS: ${stages.length} real compile SIGKILL phases; actual Pandoc render; production CLI reopen twice; exact Unicode LF/CRLF/mtime/include/profile/prior artifact; external edit and corrupt journal refusal`);
 }finally{await fs.rm(root,{recursive:true,force:true})}
}
