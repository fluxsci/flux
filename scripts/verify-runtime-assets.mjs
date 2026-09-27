#!/usr/bin/env node
// Hermetic packaging boundary regressions. Synthetic binaries exercise header
// validation; native execution is covered separately by packaged smoke tests.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, rename, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import { hashBytes, downloadAsset, inventory, replacePrepared, recoverPrevious, gunzipBounded, verifyExecutable } from './lib/runtimeAssets.mjs';
import { fileLinksSupported, fileLinkSkipNote } from './lib/symlinks.mjs';
import { fetchVideoEncoder, verifyVideoEncoder, videoEncoderContract, pinnedTarget } from './fetch-video-encoder.mjs';
import { fetchCorrectionRuntime, verifyCorrectionRuntime } from './fetch-correction-runtime.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'flux-runtime-assets-'));let checks=0;
const pass=()=>checks++;
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);pass();};
const elf=Buffer.alloc(80);Buffer.from([127,69,76,70,2,1]).copy(elf);elf.writeUInt16LE(62,18);
// A minimal stored-method zip, so the fetcher's real archive path — read the pinned members
// out of an archive, ignore the rest — is what gets exercised, not a stand-in.
function zipOf(entries){
  const locals=[],centrals=[];let offset=0;
  for(const [name,data] of Object.entries(entries)){
    const n=Buffer.from(name),crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,n,data);centrals.push(central,n);offset+=30+n.length+data.length;
  }
  const cd=Buffer.concat(centrals),eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(centrals.length/2,8);eocd.writeUInt16LE(centrals.length/2,10);eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,eocd]);
}
const archive=zipOf({'pkg/bin/ffmpeg':elf,'pkg/LICENSE.txt':Buffer.from('Fixture license\n'),'pkg/bin/ffplay':Buffer.from('not pinned, never staged')});
const readme=Buffer.from('Fixture usage\n');
const bytes={ 'ffmpeg.zip':archive,'README.md':readme };
const pin=b=>({size:b.length,sha256:hashBytes(b)});
const manifest={release:'fixture-1',targets:{'linux-x64':{provider:'fixture',version:'fixture-1-abc',archive:{url:'https://fixture.invalid/runtime/ffmpeg.zip',format:'zip',...pin(archive)},executable:'pkg/bin/ffmpeg',notices:{LICENSE:{member:'pkg/LICENSE.txt'},README:{url:'https://fixture.invalid/runtime/README.md',...pin(readme)}}}}},notice=Buffer.from('Fixture notice\n');
let downloads=0;
const fetchImpl=async url=>{downloads++;const data=bytes[new URL(url).pathname.split('/').at(-1)];assert.ok(data);return new Response(data,{headers:{'content-length':String(data.length)}});};
const opts={platform:'linux',arch:'x64',root:path.join(root,'encoder'),manifest,notice,fetchImpl};
try{
  await mkdir(path.join(opts.root,'.fetch-linux-x64-interrupted'),{recursive:true});await writeFile(path.join(opts.root,'.fetch-linux-x64-interrupted','partial'),'partial');
  const first=await fetchVideoEncoder(opts);assert.equal((await readdir(opts.root)).some(name=>name.startsWith('.fetch-')),false);pass();assert.equal(first.cached,false);assert.deepEqual(await readFile(path.join(first.target,'ffmpeg')),elf);pass();
  assert.deepEqual((await readdir(first.target)).sort(),['LICENSE','NOTICE.md','README','ffmpeg','manifest.json'],'only the pinned members and notices are staged (ffplay stays in the archive)');pass();
  assert.equal(await readFile(path.join(first.target,'LICENSE'),'utf8'),'Fixture license\n');assert.equal(await readFile(path.join(first.target,'README'),'utf8'),'Fixture usage\n');pass();
  assert.equal((await fetchVideoEncoder({...opts,fetchImpl:()=>{throw Error('cache attempted network');}})).cached,true);assert.equal(downloads,2);pass();
  await writeFile(path.join(first.target,'LICENSE'),'corrupt');await reject(()=>verifyVideoEncoder(first.target,opts),/checksum mismatch/);
  const corrupt=await readFile(path.join(first.target,'LICENSE'));await reject(()=>fetchVideoEncoder({...opts,fetchImpl:async()=>{throw Error('offline');}}),/offline/);assert.deepEqual(await readFile(path.join(first.target,'LICENSE')),corrupt);pass();
  assert.equal((await fetchVideoEncoder(opts)).cached,false);pass();
  // chmod cannot clear an exec bit NTFS never had, so this negative case exists
  // only where the host filesystem carries POSIX modes.
  if(process.platform!=='win32'){await chmod(path.join(first.target,'ffmpeg'),0o644);await reject(()=>verifyVideoEncoder(first.target,opts),/not executable/);await chmod(path.join(first.target,'ffmpeg'),0o755);}
  const cached=JSON.parse(await readFile(path.join(first.target,'manifest.json'),'utf8'));cached.arch='arm64';await writeFile(path.join(first.target,'manifest.json'),JSON.stringify(cached));await reject(()=>verifyVideoEncoder(first.target,opts),/identity/);
  await fetchVideoEncoder(opts);await writeFile(path.join(first.target,'unexpected'),'extra');await reject(()=>verifyVideoEncoder(first.target,opts),/missing or unexpected/);await rm(path.join(first.target,'unexpected'));
  // A pin that names a member the archive lacks fails before anything is staged.
  const missing=structuredClone(manifest);missing.targets['linux-x64'].notices.LICENSE={member:'pkg/NOPE.txt'};
  await reject(()=>fetchVideoEncoder({...opts,manifest:missing,root:path.join(root,'encoder-missing')}),/not in archive/);
  // A README pin whose bytes moved is refused even though the archive is intact.
  const swapped=structuredClone(manifest);swapped.targets['linux-x64'].notices.README.sha256=hashBytes(Buffer.from('other'));
  await reject(()=>fetchVideoEncoder({...opts,manifest:swapped,root:path.join(root,'encoder-swapped')}),/checksum\/size/);
  // Malformed pins are rejected as a whole, not discovered mid-download.
  for(const [why,mutate] of Object.entries({format:t=>{t.archive.format='rar';},absolute:t=>{t.executable='/bin/ffmpeg';},traversal:t=>{t.executable='../bin/ffmpeg';},name:t=>{t.executable='pkg/bin/ffprobe';},http:t=>{t.archive.url='http://fixture.invalid/x.zip';},extra:t=>{t.notices.EXTRA={member:'x'};}})){
    const bad=structuredClone(manifest);mutate(bad.targets['linux-x64']);await assert.rejects(()=>fetchVideoEncoder({...opts,manifest:bad,root:path.join(root,`encoder-bad-${why}`)}),/Malformed|must be/);pass();
  }
  // The REAL manifest: one ffmpeg release on every platform, every pin well-formed.
  {
    const {manifest:real}=await videoEncoderContract();const keys=Object.keys(real.targets).sort();
    assert.deepEqual(keys,['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'],'every packaged platform-arch is pinned');pass();
    const archives=new Set();
    for(const key of keys){const [platform,arch]=key.split('-');const t=pinnedTarget(real,platform,arch);
      assert.ok(t.version.includes(real.release),`${key}: pinned build ${t.version} is release ${real.release} (the whole point: one ffmpeg everywhere)`);
      assert.ok(!archives.has(t.archive.sha256),`${key}: its own archive`);archives.add(t.archive.sha256);
    }
    pass();
  }
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
  const concurrent={...opts,root:path.join(root,'concurrent')};const startDownloads=downloads;const pair=await Promise.all([fetchVideoEncoder(concurrent),fetchVideoEncoder(concurrent)]);assert.equal(pair.filter(item=>item.cached).length,1);assert.equal(downloads-startDownloads,2);pass();
  console.log(`Runtime assets: ${checks} checks PASS (bounded download, full cache inventory, architecture, executability, required resources, preserved replacement bytes)`);
}finally{await rm(root,{recursive:true,force:true});}
