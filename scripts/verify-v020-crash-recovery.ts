import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {atomicWrite,fsyncDir} from '../flux-core/fsx';
import {withLock,assertLockOwned} from '../flux-core/locks';
import {recoverProjectForAuthoring} from '../flux-core/recovery';
import {commitTextGeneration,bytesToBase64,type TextGenerationIO,type GenerationWrite} from '../src/lib/project/textGeneration';
const require=createRequire(import.meta.url),leases=require('../electron/operationLease.cjs');
const self=fileURLToPath(import.meta.url),journal='.meta/figure-source-generation.json';
const before=new Map<string,Buffer>([['fig/assets/a.png',Buffer.from([0,255,128,39])],['fig/assets/a.fluxplot.json',Buffer.from('{"scientificVersion":"old"}')],['fig/canvases/c.json',Buffer.from('{"old":"canvas"}')],['fig/captions/f.md',Buffer.from('original caption\n')],['fig/index.json',Buffer.from('{"old":"index"}')],['project.json',Buffer.from('{"old":"registration"}')]]);
const writes=new Map<string,GenerationWrite>([...before].map(([rel])=>[rel,rel.endsWith('.png')?{base64:bytesToBase64(new Uint8Array([47,19,0,255]))}:'new '+rel]));
const timeout=(ms:number)=>new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('Controlled barrier timed out')),ms);t.unref()});
function child(args:string[]){return fork(self,args,{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']})}
async function message(proc:ReturnType<typeof fork>){return Promise.race([once(proc,'message').then(x=>x[0]),once(proc,'exit').then(([code,signal])=>{throw Error(`Child exited before barrier: ${code}/${signal}`)}),timeout(10000)])}
if(process.argv[2]==='--writer'){
 const root=process.argv[3],stop=process.argv[4];
 const barrier=async(rel:string)=>{if(rel===stop){process.send?.({stage:rel});await new Promise(()=>{})}};
 const io:TextGenerationIO={read:async rel=>{try{return await fs.readFile(path.join(root,rel),'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}},write:async(rel,text)=>{await atomicWrite(path.join(root,rel),text);await barrier(rel)},remove:async rel=>{await fs.rm(path.join(root,rel),{force:true});if(rel===journal)await barrier('committed')},readBytes:async rel=>{try{return await fs.readFile(path.join(root,rel))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}},writeBytes:async(rel,bytes)=>{await atomicWrite(path.join(root,rel),bytes);await barrier(rel)},fsyncDir:rel=>fsyncDir(path.join(root,rel))};
 await withLock(root,'project','crash-fixture',lease=>withLock(root,'slides','crash-fixture',()=>withLock(root,'manifest','crash-fixture',()=>commitTextGeneration(io,writes,()=>assertLockOwned(lease)))));
 process.exit(0);
}else if(process.argv[2]==='--lease'){
 const root=process.argv[3];process.send?.({ready:true});await once(process,'message');
 const result=await leases.acquire(root,'simultaneous','crash-fixture');process.send?.(result);
 if(result.ok){await once(process,'message');await leases.release(result.lease)}process.exit(0);
}else{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-generation-crash-')),evidence:any[]=[];
 try{
 for(const stage of [journal,...before.keys(),'committed']){
  await fs.rm(root,{recursive:true,force:true});for(const [rel,bytes]of before){await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),bytes)}
  const proc=child(['--writer',root,stage]);const reached=await message(proc);assert.equal(reached.stage,stage);const exited=once(proc,'exit');proc.kill('SIGKILL');await exited;
  await recoverProjectForAuthoring(root);await recoverProjectForAuthoring(root);
  for(const [rel,original]of before){const next=writes.get(rel)!;const expected=stage==='committed'?(typeof next==='string'?Buffer.from(next):Buffer.from((next as {base64:string}).base64,'base64')):original;assert.deepEqual(await fs.readFile(path.join(root,rel)),expected,stage+' '+rel)}
  assert.equal(await fs.access(path.join(root,journal)).then(()=>true,()=>false),false);evidence.push({stage,recovered:stage==='committed'?'new':'original',exactFiles:before.size});
 }
 // Two real stale contenders cannot overlap; the loser cannot release winner.
 const a=child(['--lease',root]),b=child(['--lease',root]);await Promise.all([message(a),message(b)]);const am=message(a),bm=message(b);a.send('go');b.send('go');const [ar,br]=await Promise.all([am,bm]);assert.equal(Number(ar.ok)+Number(br.ok),1);const winner=ar.ok?a:b,winning=ar.ok?ar:br;assert.equal((await leases.inspect(root,'simultaneous')).token,winning.lease.token);const winnerExited=once(winner,'exit');winner.send('release');await winnerExited;assert.equal(await leases.inspect(root,'simultaneous'),null);
 // An external edit during an interrupted generation is never overwritten.
 await fs.rm(root,{recursive:true,force:true});for(const [rel,bytes]of before){await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),bytes)}
 const proc=child(['--writer',root,'fig/canvases/c.json']);await message(proc);const exited=once(proc,'exit');proc.kill('SIGKILL');await exited;await fs.writeFile(path.join(root,'fig/assets/a.png'),'external edit');await assert.rejects(recoverProjectForAuthoring(root),/changed outside transaction/);assert.equal(await fs.readFile(path.join(root,'fig/assets/a.png'),'utf8'),'external edit');assert.ok(await fs.stat(path.join(root,journal)));
 const out=process.env.FLUX_OUT??'test-results/v020-crash';await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'generations.json'),JSON.stringify(evidence,null,2));console.log('V020 CRASH PASS: 8 SIGKILL publication barriers; exact old/new bytes; real competing processes; external-edit preservation');
 }finally{await fs.rm(root,{recursive:true,force:true})}
}
