import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fsyncDir } from '../flux-core/fsx';
import { commitTextGeneration, recoverTextGeneration } from '../src/lib/project/textGeneration';
import { recoverExportSources, exportJournalPath } from '../src/lib/project/exportRecovery';
const require=createRequire(import.meta.url), {createFileCore}=require('../electron/ipc/files.cjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-durability-'));
try{
 const handlers=new Map(),core=createFileCore({app:{getPath:()=>root},roots:()=>[root]});core.registerHandlers({handle:(name:string,fn:Function)=>handlers.set(name,fn)});
 const event={sender:{id:41}},native=(file:string)=>handlers.get('fs:fsyncDir')(event,file);
 if(process.platform!=='win32'){
  await fsyncDir(root);await native(root);
  for(const sync of [fsyncDir,native])await assert.rejects(sync(path.join(root,'missing')),e=>(e as NodeJS.ErrnoException).code==='ENOENT');
  const originalOpen=fs.open;
  for(const code of ['EIO','ENOSPC','EACCES','EINVAL','ENOTSUP']){
   let closed=0;(fs as any).open=async()=>({sync:async()=>{throw Object.assign(Error(code),{code})},close:async()=>{closed++}});
   try{for(const sync of [fsyncDir,native])if(['EINVAL','ENOTSUP'].includes(code))await sync(root);else await assert.rejects(sync(root),e=>(e as NodeJS.ErrnoException).code===code);assert.equal(closed,2)}finally{(fs as any).open=originalOpen}
  }
 }
 const journal='.meta/figure-source-generation.json',files=new Map([['project.json','old project'],['fig/index.json','old index']]);
 let owned=true;const writes:string[]=[],syncs:string[]=[];
 const owner=async()=>{if(!owned)throw Error('operation lease revoked')};
 const io={read:async(rel:string)=>files.get(rel)??null,write:async(rel:string,text:string)=>{writes.push(rel);files.set(rel,text);if(rel==='fig/index.json')owned=false},remove:async(rel:string)=>{writes.push('remove:'+rel);files.delete(rel)},fsyncDir:async(rel:string)=>{syncs.push(rel);assert.ok(['.meta','fig','.'].includes(rel),'actual parent directory '+rel)}};
 await assert.rejects(commitTextGeneration(io,new Map([['fig/index.json','new index'],['project.json','new project']]),owner),/recovery retained/);
 assert.equal(files.get('fig/index.json'),'new index');assert.equal(files.get('project.json'),'old project');assert.equal(writes.filter(x=>x==='fig/index.json').length,1,'lost writer cannot roll its own publication back');assert.ok(files.has(journal));
 const beforeRecovery=[...files];await assert.rejects(recoverTextGeneration(io,owner),/revoked/);assert.deepEqual([...files],beforeRecovery);
 owned=true;const recoveryIO={...io,write:async(rel:string,text:string)=>{files.set(rel,text)}};await recoverTextGeneration(recoveryIO,owner);assert.equal(files.get('fig/index.json'),'old index');assert.ok(!files.has(journal));
 await commitTextGeneration(recoveryIO,new Map([['project.json','new project']]),owner);assert.ok(syncs.includes('.'),'root manifest publication syncs root directory');
 // Export restoration includes timestamp writes and generated-resource cleanup:
 // all must stop when the lease is revoked, retaining a recoverable journal.
 const source=path.join(root,'a.qmd'),resource=path.join(root,'profile.yml'),exportJournal=exportJournalPath(root);
 // exportRecovery joins its paths POSIX, so this in-memory disk is keyed on the
 // RESOLVED path: keyed on path.join output it answered 'changed or missing' for
 // every file on Windows, and the gate read as a missing revocation.
 const key=(p:string)=>path.resolve(p);
 const exported=new Map([[key(source),'temporary'],[key(resource),'owned profile'],[key(exportJournal),JSON.stringify({version:1,id:'owner',files:[{path:'a.qmd',original:'α\r\n',transformed:'temporary',times:{atimeMs:1,mtimeMs:2}}],generated:[{path:'profile.yml',content:'owned profile'}]})]]);
 const effects:string[]=[];owned=false;
 const exportIO={readText:async(p:string)=>exported.get(key(p))??null,writeText:async(p:string,t:string)=>{effects.push(key(p));exported.set(key(p),t)},removeFile:async(p:string)=>{effects.push('remove:'+key(p));exported.delete(key(p))},setTimes:async(p:string)=>{effects.push('times:'+key(p))},assertOwned:owner};
 await assert.rejects(recoverExportSources(exportIO,root),/revoked/);assert.deepEqual(effects,[]);assert.equal(exported.get(key(source)),'temporary');assert.ok(exported.has(key(exportJournal))&&exported.has(key(resource)));
 owned=true;await recoverExportSources(exportIO,root);assert.equal(exported.get(key(source)),'α\r\n');assert.ok(!exported.has(key(exportJournal))&&!exported.has(key(resource)));assert.ok(effects.includes('times:'+key(source)));
 console.log('Durability PASS: both engines propagate directory I/O faults; only unsupported fsync is tolerated; root manifest parent correct; lost leases cannot publish or restore bytes/timestamps/resources; new owner recovers journal.');
}finally{await fs.rm(root,{recursive:true,force:true})}
