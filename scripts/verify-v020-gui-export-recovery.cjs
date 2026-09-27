'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {unzipSync,strFromU8}=require('fflate');
(async()=>{
 const {TestProcessScope}=await import('./lib/testProcess.mjs'),{harness}=await import('./lib/harness.mjs');
 const h=harness('verify-v020-gui-export-recovery'),scope=new TestProcessScope(),scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-gui-export-kill-'));
 const artifacts=process.env.FLUX_OUT||path.resolve('test-results/gui-export-recovery');await fs.mkdir(artifacts,{recursive:true});
 const envFor=async(caseRoot)=>{const home=path.join(caseRoot,'home'),config=path.join(caseRoot,'config'),temp=path.join(caseRoot,'temp');for(const d of [home,config,temp])await fs.mkdir(d,{recursive:true});const env={...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:config,APPDATA:config,TMPDIR:temp,TMP:temp,TEMP:temp,FLUX_NO_MIGRATE:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;return env;};
 async function prepare(name){const dir=path.join(scratch,name),root=path.join(dir,'project'),env=await envFor(dir);const fixture=scope.spawn(path.resolve('scripts/lib/exportGuiKillFixture.ts'),[root,name],{env,deadlineMs:30000});assert.equal((await scope.waitExit(fixture)).code,0,fixture.stdout+fixture.stderr);return{dir,root,env,originals:JSON.parse(await fs.readFile(path.join(root,'fixture-originals.json'),'utf8'))};}
 async function launch(test,mode,phase,ready){const artifact=path.join(artifacts,`${path.basename(test.dir)}-${phase}-${mode}.json`);const child=scope.spawn(require.resolve('electron/cli.js'),[path.resolve('scripts/lib/exportGuiKillNative.cjs'),...(process.platform==='linux'?['--ozone-platform=x11']:[])],{nodeArgs:[],env:{...test.env,PROBE_PROJECT:test.root,PROBE_MODE:mode,PROBE_PHASE:phase,PROBE_ARTIFACT:artifact},readyLine:ready,deadlineMs:80000});try{await child.ready;}catch(error){await fs.writeFile(artifact+'.log',child.stdout+child.stderr);throw error;}return{child,artifact};}
 async function complete(run){const result=await scope.waitExit(run.child);await fs.writeFile(run.artifact+'.log',run.child.stdout+run.child.stderr);assert.equal(result.code,0,run.child.stdout+run.child.stderr);return JSON.parse(await fs.readFile(run.artifact,'utf8'));}
 const journalOf=t=>path.join(t.root,'.meta/export-source-transaction.json');
 async function exact(t,prior){for(const[rel,text]of Object.entries(t.originals)){assert.equal(await fs.readFile(path.join(t.root,rel),'utf8'),text,rel+' exact bytes');assert.equal((await fs.stat(path.join(t.root,rel))).mtimeMs,1600000000000,rel+' original mtime');}if(prior)assert.deepEqual(await fs.readFile(path.join(t.root,'exports/prior.docx')),prior,'prior validated Word artifact preserved');}
 try{
  const control=await prepare('control');await complete(await launch(control,'export','control','GUI_EXPORT_DONE'));
  const prior=await fs.readFile(path.join(control.root,'exports/prior.docx')),zip=unzipSync(prior),xml=strFromU8(zip['word/document.xml']);
  assert.ok(xml.includes('Primary α CRLF.')&&xml.includes('Included β LF.')&&xml.includes('12.75'),'control actualWord XML contains primary and included scientific text');
  assert.ok(Object.keys(zip).some(p=>/^word\/media\/.*\.png$/i.test(p)),'Word artifact has real raster figure fallback');
  await exact(control);await fs.writeFile(path.join(artifacts,'prior-valid.docx'),prior);h.ok(true,'actual GUI Word export produced inspected primary/include text and raster figure fallback; source bytes and mtimes restored');
  const revision=await prepare('revision');const revisionResult=await complete(await launch(revision,'export','revision','GUI_EXPORT_DONE'));assert.ok(revisionResult.capturedRevision&&revisionResult.typingEvidence.length>0);h.ok(true,'delayed export preserves captured Figure/caption revision while trusted typing remains live and saves after actual Quarto restoration');
  for(const phase of ['journal','rewrite','render','restore','restored']){
   const t=await prepare(phase);await fs.writeFile(path.join(t.root,'exports/prior.docx'),prior);
   const run=await launch(t,'export',phase,'GUI_EXPORT_BARRIER');await scope.reap(run.child);await fs.writeFile(run.artifact+'.log',run.child.stdout+run.child.stderr);
   const barrier=JSON.parse(await fs.readFile(run.artifact,'utf8'));assert.equal(barrier.barrier,phase);
   assert.deepEqual(await fs.readFile(path.join(t.root,'exports/prior.docx')),prior,`${phase}: SIGKILL cannot publish a partial Word file`);
   if(phase!=='restored'){const journal=JSON.parse(await fs.readFile(journalOf(t),'utf8'));assert.equal(journal.files.length,2);for(const f of journal.files){assert.equal(f.original,t.originals[f.path]);assert.notEqual(f.original,f.transformed);}}
   if(phase==='render'||phase==='restore'||phase==='restored')assert.ok(barrier.renderStarted,'actual Quarto render ran before barrier');
   await complete(await launch(t,'recover',phase,'GUI_RECOVERY_DONE'));await exact(t,prior);assert.equal(await fs.stat(journalOf(t)).then(()=>true,()=>false),false);
   h.ok(true,`${phase}: actual GUI export SIGKILL → fresh GUI project open restores exact Unicode/newlines/includes/mtimes and prior artifact`);
  }
  const conflict=await prepare('conflict');await fs.writeFile(path.join(conflict.root,'exports/prior.docx'),prior);
  const blocked=await launch(conflict,'export','render','GUI_EXPORT_BARRIER');await scope.reap(blocked.child);await fs.writeFile(blocked.artifact+'.log',blocked.child.stdout+blocked.child.stderr);
  const newer='External author γ must survive.\r\n';await fs.writeFile(path.join(conflict.root,'paper/included.qmd'),newer);
  await complete(await launch(conflict,'conflict','conflict','GUI_RECOVERY_DONE'));
  assert.equal(await fs.readFile(path.join(conflict.root,'paper/included.qmd'),'utf8'),newer);assert.equal(await fs.readFile(path.join(conflict.root,'paper/notes.qmd'),'utf8'),conflict.originals['paper/notes.qmd']);assert.ok((await fs.readFile(journalOf(conflict),'utf8')).includes('Included β LF.'));assert.deepEqual(await fs.readFile(path.join(conflict.root,'exports/prior.docx')),prior);
  // Once the coauthor's canonical bytes are independently restored, another
  // real GUI open can safely finish this exact retained journal.
  await fs.writeFile(path.join(conflict.root,'paper/included.qmd'),conflict.originals['paper/included.qmd']);await complete(await launch(conflict,'recover','conflict-resolved','GUI_RECOVERY_DONE'));await exact(conflict,prior);
  h.ok(true,'unexpected newer include is retained with journal and visible GUI refusal; resolved reopen recovers idempotently without clobber');
 }catch(error){console.error(error);await fs.cp(scratch,path.join(artifacts,'failed-projects'),{recursive:true});h.fail(String(error.stack||error));}
 finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});}
 await h.done();
})().catch(error=>{console.error(error);process.exitCode=1;});
