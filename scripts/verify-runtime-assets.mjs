#!/usr/bin/env node
// Hermetic packaging boundary regressions. Synthetic binaries exercise header
// validation; native execution is covered separately by packaged smoke tests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, rename, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { hashBytes, downloadAsset, inventory, replacePrepared, recoverPrevious, gunzipBounded, verifyExecutable } from './lib/runtimeAssets.mjs';
import { fileLinksSupported, fileLinkSkipNote } from './lib/symlinks.mjs';
import { fetchVideoEncoder, verifyVideoEncoder } from './fetch-video-encoder.mjs';
import { fetchCorrectionRuntime, verifyCorrectionRuntime } from './fetch-correction-runtime.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'flux-runtime-assets-'));let checks=0;
const pass=()=>checks++;
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);pass();};
const elf=Buffer.alloc(80);Buffer.from([127,69,76,70,2,1]).copy(elf);elf.writeUInt16LE(62,18);
const bytes={ 'ffmpeg-linux-x64.gz':gzipSync(elf),'linux-x64.LICENSE':Buffer.from('Fixture license\n'),'linux-x64.README':Buffer.from('Fixture usage\n') };
const pinned=Object.fromEntries(Object.entries(bytes).map(([k,b])=>[k,{size:b.length,sha256:hashBytes(b)}]));
const manifest={release:'fixture-1',baseUrl:'https://fixture.invalid/runtime',targets:{'linux-x64':pinned}},notice=Buffer.from('Fixture notice\n');
let downloads=0;
const fetchImpl=async url=>{downloads++;const data=bytes[new URL(url).pathname.split('/').at(-1)];assert.ok(data);return new Response(data,{headers:{'content-length':String(data.length)}});};
const opts={platform:'linux',arch:'x64',root:path.join(root,'encoder'),manifest,notice,fetchImpl};
try{
  await mkdir(path.join(opts.root,'.fetch-linux-x64-interrupted'),{recursive:true});await writeFile(path.join(opts.root,'.fetch-linux-x64-interrupted','partial'),'partial');
  const first=await fetchVideoEncoder(opts);assert.equal((await readdir(opts.root)).some(name=>name.startsWith('.fetch-')),false);pass();assert.equal(first.cached,false);assert.deepEqual(await readFile(path.join(first.target,'ffmpeg')),elf);pass();
  assert.equal((await fetchVideoEncoder({...opts,fetchImpl:()=>{throw Error('cache attempted network');}})).cached,true);assert.equal(downloads,3);pass();
  await writeFile(path.join(first.target,'LICENSE'),'corrupt');await reject(()=>verifyVideoEncoder(first.target,opts),/checksum mismatch/);
  const corrupt=await readFile(path.join(first.target,'LICENSE'));await reject(()=>fetchVideoEncoder({...opts,fetchImpl:async()=>{throw Error('offline');}}),/offline/);assert.deepEqual(await readFile(path.join(first.target,'LICENSE')),corrupt);pass();
  assert.equal((await fetchVideoEncoder(opts)).cached,false);pass();
  // chmod cannot clear an exec bit NTFS never had, so this negative case exists
  // only where the host filesystem carries POSIX modes.
  if(process.platform!=='win32'){await chmod(path.join(first.target,'ffmpeg'),0o644);await reject(()=>verifyVideoEncoder(first.target,opts),/not executable/);await chmod(path.join(first.target,'ffmpeg'),0o755);}
  const cached=JSON.parse(await readFile(path.join(first.target,'manifest.json'),'utf8'));cached.arch='arm64';await writeFile(path.join(first.target,'manifest.json'),JSON.stringify(cached));await reject(()=>verifyVideoEncoder(first.target,opts),/identity/);
  await fetchVideoEncoder(opts);await writeFile(path.join(first.target,'unexpected'),'extra');await reject(()=>verifyVideoEncoder(first.target,opts),/missing or unexpected/);await rm(path.join(first.target,'unexpected'));
  const badArch=path.join(root,'bad-arch');const arm=Buffer.from(elf);arm.writeUInt16LE(183,18);await writeFile(badArch,arm,{mode:0o755});await reject(()=>verifyExecutable(badArch,'linux','x64'),/architecture/);
  const checkPath=path.join(root,'download');const expected={size:4,sha256:hashBytes(Buffer.from('four'))};
  await reject(()=>downloadAsset('x',checkPath,expected,{fetchImpl:async()=>new Response('five!',{headers:{'content-length':'5'}})}),/size header/);
  await reject(()=>downloadAsset('x',checkPath,expected,{fetchImpl:async()=>new Response('five!')}),/byte limit/);
  await reject(()=>downloadAsset('x',checkPath,expected,{fetchImpl:async()=>new Response('fou')}),/checksum\/size/);
  await reject(()=>downloadAsset('x',checkPath,expected,{fetchImpl:async()=>new Response('FOUR')}),/checksum\/size/);
  assert.equal((await readdir(root)).includes('download'),false);pass();
  const timer=setInterval(()=>{},20);try{await reject(()=>downloadAsset('x',checkPath,expected,{fetchImpl:async()=>new Response(new ReadableStream({start(){},cancel(){}})),timeoutMs:30}),/timeout|aborted/i);await reject(()=>downloadAsset('x',checkPath,expected,{fetchImpl:()=>new Promise(()=>{}),timeoutMs:30}),/timeout|aborted/i);}finally{clearInterval(timer);}
  const bomb=path.join(root,'bomb.gz'),expanded=path.join(root,'expanded');await writeFile(bomb,gzipSync(Buffer.alloc(4096)));await reject(()=>gunzipBounded(bomb,expanded,1024),/byte limit/);
  const target=path.join(root,'replace'),prepared=path.join(root,'prepared');await mkdir(target);await writeFile(path.join(target,'bytes'),'LAST GOOD');await mkdir(prepared);await writeFile(path.join(prepared,'bytes'),'replacement');
  await reject(()=>replacePrepared(prepared,target,{renameImpl:async(from,to)=>{if(from===prepared)throw Error('injected rename failure');return rename(from,to);}}),/injected rename/);assert.equal(await readFile(path.join(target,'bytes'),'utf8'),'LAST GOOD');pass();
  await rename(target,target+'.previous');await recoverPrevious(target);assert.equal(await readFile(path.join(target,'bytes'),'utf8'),'LAST GOOD');pass();
  await replacePrepared(prepared,target);assert.equal(await readFile(path.join(target,'bytes'),'utf8'),'replacement');pass();
  if(fileLinksSupported()){await symlink(badArch,path.join(target,'escape'));await reject(()=>inventory(target),/escapes/);}
  else console.log(fileLinkSkipNote('runtime inventory refuses a link escaping its bundle'));
  // Correction bundle cache must rehash every library, not just the server.
  const archive=Buffer.from('pinned correction archive fixture');const asset={name:'fixture.tar.gz',size:archive.length,sha256:hashBytes(archive),acceleration:'vulkan',backendPrefix:'libggml-vulkan'};
  const extract=async(_archive,dir)=>{await writeFile(path.join(dir,'llama-server'),elf);for(const name of ['LICENSE','libllama.so','libggml-base.so','libggml-vulkan.so'])await writeFile(path.join(dir,name),'correct resource');};
  const correction={platform:'linux',arch:'x64',root:path.join(root,'correction'),asset,extract,fetchImpl:async()=>new Response(archive)};
  const installed=await fetchCorrectionRuntime(correction);await verifyCorrectionRuntime(installed.target,correction);pass();
  assert.equal((await fetchCorrectionRuntime({...correction,fetchImpl:()=>{throw Error('cache used network');}})).cached,true);pass();
  await writeFile(path.join(installed.target,'libggml-base.so'),'corrupted library');await reject(()=>verifyCorrectionRuntime(installed.target,correction),/checksum mismatch/);
  await reject(()=>fetchCorrectionRuntime({...correction,extract:async(_a,dir)=>{await extract(_a,dir);await rm(path.join(dir,'LICENSE'));}}),/resource missing/);assert.equal(await readFile(path.join(installed.target,'libggml-base.so'),'utf8'),'corrupted library');pass();
  await fetchCorrectionRuntime(correction);await rm(path.join(installed.target,'libggml-vulkan.so'));await reject(()=>verifyCorrectionRuntime(installed.target,correction),/missing or unexpected/);
  assert.equal((await readdir(correction.root)).filter(n=>n.startsWith('.fetch-')).length,0);pass();
  const concurrent={...opts,root:path.join(root,'concurrent')};const startDownloads=downloads;const pair=await Promise.all([fetchVideoEncoder(concurrent),fetchVideoEncoder(concurrent)]);assert.equal(pair.filter(item=>item.cached).length,1);assert.equal(downloads-startDownloads,3);pass();
  console.log(`Runtime assets: ${checks} checks PASS (bounded download, full cache inventory, architecture, executability, required resources, preserved replacement bytes)`);
}finally{await rm(root,{recursive:true,force:true});}
