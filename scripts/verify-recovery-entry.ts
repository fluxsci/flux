// A saved read must coexist with recent human activity, but an actual recovery
// must still own its leases and re-read the journal before touching any bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { recoverProjectForAuthoring } from '../flux-core/recovery';
import { acquireLock, releaseLock, heldByOther } from '../flux-core/locks';
import { runCliVerb, registerMcpVerbs } from '../flux-core/registry';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { createDeck } from '../src/lib/slide/ops';
import { TEXT_GENERATION_JOURNAL } from '../src/lib/project/textGeneration';
import { EXPORT_RECOVERY_FILE } from '../src/lib/project/exportRecovery';
import { linkDir } from "./lib/symlinks.mjs";

const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-recovery-entry-'));
const root=path.join(scratch,'project'), require=createRequire(import.meta.url);
const native=require('node:fs/promises'), readFile=native.readFile, realpath=native.realpath;
const resources=['export','project','slides','manifest'];
const held=new Set<string>();
let checks=0;
const pass=(message:string)=>{checks++;console.log('PASS '+message)};
const hold=async(name:string)=>{assert.equal(await acquireLock(root,name,'human'),true);held.add(name)};
const release=async(name:string)=>{await releaseLock(root,name,'human');held.delete(name)};
const write=async(rel:string,text:string)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text)};
const generation=(file:string)=>JSON.stringify({version:2,files:[{path:file,before:'before',after:'after'}]});
async function cli(verb:string){let code=0,errors='';assert.equal(await runCliVerb(verb,{pos:[],posRooted:[],flags:{},rootFlags:root,rootPositional:root},{log:()=>{},err:s=>{errors+=s},setExit:c=>{code=c}}),true);return {code,errors};}
try {
  for(const[rel,text]of buildScaffoldTree({title:'Saved recovery entry'},createDeck({id:'saved',title:'Saved'})).files)await write(rel,text);
  for(const resource of resources)await hold(resource);
  const tokens=await Promise.all(resources.map(name=>heldByOther(root,name,'recovery')));
  await recoverProjectForAuthoring(root);
  assert.equal((await cli('list')).code,0);
  let readTool:((args:Record<string,unknown>)=>Promise<any>)|undefined;
  registerMcpVerbs({registerTool:(name,_meta,fn)=>{if(name==='list_project')readTool=fn}},root);
  assert.ok(readTool);assert.notEqual((await readTool({})).isError,true);
  assert.deepEqual(await Promise.all(resources.map(name=>heldByOther(root,name,'recovery'))),tokens);
  pass('CLI and MCP reads coexist with every human lease without releasing or renewing it');
  const manifestBefore=await fs.readFile(path.join(root,'project.json'));
  const mutation=await cli('reindex');assert.notEqual(mutation.code,0);assert.match(mutation.errors,/locked|deferred/);
  assert.deepEqual(await fs.readFile(path.join(root,'project.json')),manifestBefore);
  pass('ordinary mutations still refuse the human lease and preserve saved bytes');
  for(const resource of resources)await release(resource);

  const source='fig/assets/recovery-probe.svg';
  await write(source,'after');await write(TEXT_GENERATION_JOURNAL,generation(source));
  for(const resource of ['project','slides','manifest']){
    await hold(resource);
    await assert.rejects(recoverProjectForAuthoring(root),/locked|deferred/);
    assert.equal(await fs.readFile(path.join(root,source),'utf8'),'after');
    assert.equal(await fs.readFile(path.join(root,TEXT_GENERATION_JOURNAL),'utf8'),generation(source));
    await release(resource);pass('pending generation preserves bytes behind '+resource+' lease');
  }
  await recoverProjectForAuthoring(root);await recoverProjectForAuthoring(root);
  assert.equal(await fs.readFile(path.join(root,source),'utf8'),'before');
  await assert.rejects(fs.access(path.join(root,TEXT_GENERATION_JOURNAL)),{code:'ENOENT'});
  pass('unowned pending generation is restored once and then reads without a lease');

  const paper='paper/notes.qmd', original=await fs.readFile(path.join(root,paper),'utf8');
  const exportJournal=JSON.stringify({version:1,id:'pending',files:[{path:paper,original,transformed:'transformed'}]});
  await write(paper,'transformed');await write(EXPORT_RECOVERY_FILE,exportJournal);await hold('export');
  await assert.rejects(recoverProjectForAuthoring(root),/locked|deferred/);
  assert.equal(await fs.readFile(path.join(root,paper),'utf8'),'transformed');
  assert.equal(await fs.readFile(path.join(root,EXPORT_RECOVERY_FILE),'utf8'),exportJournal);
  await release('export');await recoverProjectForAuthoring(root);
  assert.equal(await fs.readFile(path.join(root,paper),'utf8'),original);
  pass('actual document recovery still requires its export lease and restores exact source');

  const other='fig/assets/new-journal.svg', journalPath=path.join(root,TEXT_GENERATION_JOURNAL);
  await write(source,'after');await write(other,'after');await write(TEXT_GENERATION_JOURNAL,generation(source));
  let reads=0;
  native.readFile=async(file:any,...args:any[])=>{
    const result=await readFile(file,...args);
    if(file===journalPath&&++reads===1)await fs.writeFile(journalPath,generation(other));
    return result;
  };syncBuiltinESMExports();
  await recoverProjectForAuthoring(root);
  native.readFile=readFile;syncBuiltinESMExports();
  assert.ok(reads>=2);assert.equal(await fs.readFile(path.join(root,source),'utf8'),'after');
  assert.equal(await fs.readFile(path.join(root,other),'utf8'),'before');
  pass('presence probe is not authority: recovery re-reads the changed journal under leases');

  native.readFile=async(file:any,...args:any[])=>{if(file===journalPath)throw Object.assign(new Error('denied journal'),{code:'EACCES'});return readFile(file,...args)};syncBuiltinESMExports();
  await assert.rejects(recoverProjectForAuthoring(root),{code:'EACCES'});
  native.readFile=readFile;syncBuiltinESMExports();
  assert.equal(await fs.readFile(path.join(root,source),'utf8'),'after');
  pass('an unreadable journal is not mistaken for an absent transaction');

  for(const binary of [false,true]){
    const target=path.join(root,source),lock=path.join(root,'.meta/locks/project.json');
    const encode=(value:string)=>binary?Buffer.from(value).toString('base64'):value;
    await write(source,'after');await write(TEXT_GENERATION_JOURNAL,JSON.stringify({version:2,files:[{path:source,before:encode('before'),after:encode('after'),...(binary?{encoding:'base64'}:{})}]}));
    let validations=0;
    native.realpath=async(file:any,...args:any[])=>{
      const result=await realpath(file,...args);
      // The third target validation is the publication adapter, after generic
      // recovery has checked its lease. Model revocation during that await.
      if(file===target&&++validations===3){const info=JSON.parse(await readFile(lock,'utf8'));info.token='replacement-owner';await fs.writeFile(lock,JSON.stringify(info))}
      return result;
    };syncBuiltinESMExports();
    await assert.rejects(recoverProjectForAuthoring(root),/lease|ownership|recovery retained/i);
    native.realpath=realpath;syncBuiltinESMExports();
    assert.ok(validations>=3);assert.equal(await fs.readFile(target,'utf8'),'after');
    assert.equal(JSON.parse(await fs.readFile(lock,'utf8')).token,'replacement-owner');
    await fs.access(journalPath);await fs.rm(lock);await recoverProjectForAuthoring(root);
    assert.equal(await fs.readFile(target,'utf8'),'before');
    pass((binary?'binary':'text')+' recovery rechecks ownership after awaited path validation');
  }

  const outside=path.join(scratch,'outside'),linked=path.join(scratch,'linked');
  await fs.mkdir(outside);await fs.mkdir(linked);await fs.writeFile(path.join(linked,'project.json'),'{}');
  await linkDir(outside,path.join(linked,'.meta'));
  await assert.rejects(recoverProjectForAuthoring(linked),/escapes project/);
  assert.deepEqual(await fs.readdir(outside),[]);
  pass('even absent journals behind an escaping metadata symlink are refused');
  console.log(`RECOVERY ENTRY: PASS ${checks}`);
} finally {
  native.readFile=readFile;native.realpath=realpath;syncBuiltinESMExports();
  for(const resource of held)await releaseLock(root,resource,'human');
  await fs.rm(scratch,{recursive:true,force:true});
}
