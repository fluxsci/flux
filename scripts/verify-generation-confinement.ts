// Actual native filesystem handlers with the legitimate union of two project
// grants: a stored recovery journal must still belong to exactly one project.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generationBridgeIO } from '../src/lib/project/generationBridgeIO';
import { recoverTextGeneration, commitTextGeneration, bytesToBase64 } from '../src/lib/project/textGeneration';
import { recoverProjectForAuthoring } from '../flux-core/recovery';
import { exportRecoveryIO } from '../flux-core/recovery';
import { recoverExportSources, EXPORT_RECOVERY_FILE } from '../src/lib/project/exportRecovery';
import { loadProject } from '../src/lib/project/load';
import type { FileBridge } from '../src/lib/project/types';
import { harness } from './lib/harness.mjs';
import { linkDir } from "./lib/symlinks.mjs";
const { createFileCore } = createRequire(import.meta.url)('../electron/ipc/files.cjs');
const h = harness('verify-generation-confinement');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-generation-confinement-'));
const journal = '.meta/figure-source-generation.json';
async function fixture(name: string) {
  const base = path.join(sandbox, name), A = path.join(base, 'A'), B = path.join(base, 'B');
  await fs.mkdir(path.join(A,'.meta'),{recursive:true}); await fs.mkdir(path.join(A,'fig')); await fs.mkdir(B);
  await fs.writeFile(path.join(A,'project.json'),'{}');
  const handlers = new Map<string,Function>(), event = {sender:{id:1}};
  createFileCore({app:{getPath:()=>base},roots:()=>[A,B],projectRootFor:()=>[A],setPendingRoot(){}}).registerHandlers({handle:(channel:string,fn:Function)=>handlers.set(channel,fn)});
  const call = (channel:string,...args:unknown[]) => handlers.get(channel)!(event,...args);
  const bridge = Object.fromEntries(['exists','readText','writeText','readFile','writeFile','mkdir','remove','fsyncDir','projectAssetPath'].map(name=>[name,(...args:unknown[])=>call('fs:'+name,...args)])) as unknown as FileBridge;
  return {A,B,bridge};
}
try {
  for(const engine of ['GUI','Node']) for(const binary of [false,true]) for(const missing of [false,true]) {
    const {A,B,bridge}=await fixture(`${engine}-${binary}-${missing}`);
    await linkDir(B,path.join(A,'fig','escape'));
    const target=path.join(B,binary?'scientific.png':'owned.json'),good=path.join(A,'fig','good.json');
    const original=Buffer.from([0,255,42,19]),after=Buffer.from([31,0,66,250]);
    if(!missing)await fs.writeFile(target,binary?after:'other project current bytes');
    await fs.writeFile(good,'good current bytes');
    // Reverse recovery would restore the good sibling first without all-path preflight.
    const content=JSON.stringify({version:2,files:[{path:`fig/escape/${path.basename(target)}`,before:binary?bytesToBase64(original):'other predecessor',after:missing?null:binary?bytesToBase64(after):'other project current bytes',...(binary?{encoding:'base64'}:{})},{path:'fig/good.json',before:'good predecessor',after:'good current bytes'}]});
    await fs.writeFile(path.join(A,journal),content);
    await assert.rejects(engine==='GUI'?()=>recoverTextGeneration(generationBridgeIO(A,bridge)):()=>recoverProjectForAuthoring(A),/escapes|outside/i);
    assert.equal(await fs.readFile(good,'utf8'),'good current bytes');
    assert.equal(await fs.readFile(path.join(A,journal),'utf8'),content);
    if(missing)await assert.rejects(fs.access(target),{code:'ENOENT'});else assert.deepEqual(await fs.readFile(target),binary?after:Buffer.from('other project current bytes'));
    h.ok(true,`${engine} preflights all ${binary?'binary':'text'} recovery paths including ${missing?'absent':'existing'} target: other project, valid sibling, exact journal unchanged`);
  }
  {
    const {A,B,bridge}=await fixture('new-publication');await linkDir(B,path.join(A,'fig','escape'));
    await assert.rejects(()=>commitTextGeneration(generationBridgeIO(A,bridge),new Map([['fig/escape/new.png',{base64:bytesToBase64(new Uint8Array([1,2,3]))}]])),/escapes/);
    await assert.rejects(fs.access(path.join(B,'new.png')),{code:'ENOENT'});await assert.rejects(fs.access(path.join(A,journal)),{code:'ENOENT'});
    h.ok(true,'fresh publication refuses absent cross-project binary target before creating its journal or bytes');
  }
  {
    const {A,B,bridge}=await fixture('journal-path');await fs.rm(path.join(A,'.meta'),{recursive:true});await linkDir(B,path.join(A,'.meta'));
    const content='{"version":2,"files":[]}';await fs.writeFile(path.join(B,'figure-source-generation.json'),content);
    await assert.rejects(()=>recoverTextGeneration(generationBridgeIO(A,bridge)),/escapes/);assert.equal(await fs.readFile(path.join(B,'figure-source-generation.json'),'utf8'),content);
    h.ok(true,'journal path itself cannot follow a symlink into another granted project');
  }
  {
    const {A,bridge}=await fixture('allowed-alias'),alias=path.join(path.dirname(A),'alias');await linkDir(A,alias);await fs.mkdir(path.join(A,'owned'));await linkDir(path.join(A,'owned'),path.join(A,'fig','inside'));
    await commitTextGeneration(generationBridgeIO(alias,bridge),new Map([['fig/inside/new/data.json','exact owned bytes']]));
    assert.equal(await fs.readFile(path.join(A,'owned','new','data.json'),'utf8'),'exact owned bytes');await assert.rejects(fs.access(path.join(A,journal)),{code:'ENOENT'});
    h.ok(true,'canonical project aliases and internal directory symlinks preserve legitimate new nested publication');
  }
  {
    const {A,B}=await fixture('export-generated');await fs.mkdir(path.join(A,'paper'));await linkDir(B,path.join(A,'paper','escape'));
    const source=path.join(A,'paper','notes.qmd'),foreign=path.join(B,'profile.yml');await fs.writeFile(source,'transformed scientific text');await fs.writeFile(foreign,'foreign exact generated content');
    const content=JSON.stringify({version:1,id:'interrupted',files:[{path:'paper/notes.qmd',original:'original scientific text',transformed:'transformed scientific text'}],generated:[{path:'paper/escape/profile.yml',content:'foreign exact generated content'}]});
    await fs.writeFile(path.join(A,EXPORT_RECOVERY_FILE),content);
    await assert.rejects(()=>recoverExportSources(exportRecoveryIO(A),A),/escapes/);
    assert.equal(await fs.readFile(source,'utf8'),'transformed scientific text');assert.equal(await fs.readFile(foreign,'utf8'),'foreign exact generated content');assert.equal(await fs.readFile(path.join(A,EXPORT_RECOVERY_FILE),'utf8'),content);
    h.ok(true,'export recovery preflights generated resources before restoring any valid source sibling');
  }
  {
    const {A,B,bridge}=await fixture('GUI-startup'),previousWindow=(globalThis as any).window,locks:string[]=[];
    (bridge as any).lockAcquire=async(_scope:string,name:string,expectedRoot:string)=>{assert.equal(expectedRoot,A);locks.push(name);return{ok:true,noop:true}};
    (globalThis as any).window={fig:bridge};
    try {
      const before={schemaVersion:'0.1.0',id:'p',title:'Fixture',manuscript:{path:'paper/notes.qmd'},references:{library:'references/library.bib'},figures:[],slides:[]};
      const after={...before,slides:[{id:'pending',path:'slides/pending/deck.json',title:'Incomplete publication',order:1}]};
      const original=JSON.stringify(before),changed=JSON.stringify(after);await fs.writeFile(path.join(A,'project.json'),changed);
      await fs.mkdir(path.join(A,'slides','pending'),{recursive:true});await fs.writeFile(path.join(A,'slides/pending/deck.json'),'pending deck bytes');
      await fs.writeFile(path.join(A,journal),JSON.stringify({version:2,files:[{path:'slides/pending/deck.json',before:null,after:'pending deck bytes'},{path:'project.json',before:original,after:changed}]}));
      const loaded=await loadProject(A);assert.deepEqual(loaded.manifest.slides,[]);assert.equal(await fs.readFile(path.join(A,'project.json'),'utf8'),original);await assert.rejects(fs.access(path.join(A,'slides/pending/deck.json')),{code:'ENOENT'});await assert.rejects(fs.access(path.join(A,journal)),{code:'ENOENT'});assert.deepEqual(locks,['export','project','slides','manifest']);
      h.ok(true,'actual GUI loadProject recovers exact manifest/deck generation before adoption under export then project/slides/manifest leases');
      await linkDir(B,path.join(A,'fig','escape'));await fs.writeFile(path.join(B,'owned.json'),'foreign authored bytes');await fs.writeFile(path.join(A,'project.json'),changed);
      const hostile=JSON.stringify({version:2,files:[{path:'fig/escape/owned.json',before:'foreign predecessor',after:'foreign authored bytes'},{path:'project.json',before:original,after:changed}]});await fs.writeFile(path.join(A,journal),hostile);
      await assert.rejects(()=>loadProject(A),/escapes/);assert.equal(await fs.readFile(path.join(B,'owned.json'),'utf8'),'foreign authored bytes');assert.equal(await fs.readFile(path.join(A,'project.json'),'utf8'),changed);assert.equal(await fs.readFile(path.join(A,journal),'utf8'),hostile);
      h.ok(true,'actual GUI startup refuses external journal target before manifest adoption or any source restoration');
    } finally {(globalThis as any).window=previousWindow;}
  }
} finally {await fs.rm(sandbox,{recursive:true,force:true});}
await h.done();
