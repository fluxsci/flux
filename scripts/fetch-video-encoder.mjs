#!/usr/bin/env node
// Explicit build-time download of the slide video encoder. No installation or network
// request during export.
//
// build/video-encoder.json pins ONE ffmpeg release for every platform-arch: an immutable
// archive (URL, size, SHA-256), the executable's path inside it, and two notices — LICENSE and
// README — each either a `member` of that archive or its own pinned `url`. The staged layout in
// build/video-encoder/<platform>-<arch>/ is what electron-builder ships and what
// verify-packaged-app checks: ffmpeg(.exe), LICENSE, README, NOTICE.md, manifest.json.
//
// Archive formats: `zip` is read in-process (scripts/lib/readZip.mjs, only the pinned members
// inflated); `tar.xz` goes through the host's `tar`, extracting only the pinned members. The
// pinned hash authenticates the whole archive before anything is opened, so a bounded reader
// is not needed for what it contains — only the members named here ever leave it.
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod, rename, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAsset, hashBytes, inventory, recoverPrevious, replacePrepared, verifyInventory, withAssetInstall } from './lib/runtimeAssets.mjs';
import { readZip } from './lib/readZip.mjs';
const exec=promisify(execFile);
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FORMATS=new Set(['zip','tar.xz']);
export async function videoEncoderContract(){return {manifest:JSON.parse(await readFile(path.join(repo,'build/video-encoder.json'),'utf8')),notice:await readFile(path.join(repo,'build/video-encoder-NOTICE.md'))};}
const pinnedFile=v=>v&&typeof v==='object'&&typeof v.url==='string'&&/^https:\/\//.test(v.url)&&Number.isSafeInteger(v.size)&&v.size>0&&/^[a-f0-9]{64}$/.test(v.sha256);
const memberPath=v=>typeof v==='string'&&v.length>0&&!path.posix.isAbsolute(v)&&!v.split('/').some(p=>!p||p==='.'||p==='..');
const noticeSpec=v=>v&&typeof v==='object'&&(('member' in v)?memberPath(v.member)&&!('url' in v):pinnedFile(v));
/** The pinned target for a platform-arch, validated as a whole so a manifest typo fails here, not mid-download. */
export function pinnedTarget(manifest,platform,arch){
  const key=`${platform}-${arch}`,t=manifest?.targets?.[key];
  if(!t||typeof manifest.release!=='string'||!manifest.release)throw new Error(`No complete pinned video encoder for ${key}`);
  if(!pinnedFile(t.archive)||!FORMATS.has(t.archive.format)||!memberPath(t.executable)||typeof t.version!=='string'||!t.version||!t.notices||!noticeSpec(t.notices.LICENSE)||!noticeSpec(t.notices.README)||Object.keys(t.notices).some(n=>n!=='LICENSE'&&n!=='README'))throw new Error(`Malformed pinned video encoder for ${key}`);
  const executable=platform==='win32'?'ffmpeg.exe':'ffmpeg';
  if(path.posix.basename(t.executable)!==executable)throw new Error(`Pinned executable for ${key} must be ${executable}`);
  return {...t,key,executable,archiveExecutable:t.executable};
}
export async function verifyVideoEncoder(target,{platform,arch,manifest,notice}){
  const pinned=pinnedTarget(manifest,platform,arch),{executable}=pinned;
  const current=JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8'));
  if(current.release!==manifest.release||current.platform!==platform||current.arch!==arch||current.version!==pinned.version||current.archiveHash!==pinned.archive.sha256||current.source!==pinned.archive.url)throw new Error('Video encoder identity does not match pinned target');
  if(!current.files||typeof current.files!=='object')throw new Error('Video encoder resource manifest missing');
  // Every staged file is recorded at install time; the ones with an upstream pin must still
  // match that pin, so a manifest edit that swaps a notice cannot ride on a stale stage.
  const expected={ [executable]:current.binaryHash,LICENSE:current.files.LICENSE,README:current.files.README,'NOTICE.md':hashBytes(notice) };
  for(const name of ['LICENSE','README'])if(!('member' in pinned.notices[name])&&current.files[name]!==pinned.notices[name].sha256)throw new Error(`Video encoder ${name} does not match its pin`);
  if(JSON.stringify(Object.keys(current.files).sort())!==JSON.stringify(Object.keys(expected).sort())||Object.entries(expected).some(([name,digest])=>current.files[name]!==digest))throw new Error('Video encoder resource manifest mismatch');
  await verifyInventory(target,{files:current.files,manifestName:'manifest.json',executable,platform,arch,required:['LICENSE','README','NOTICE.md']});return current;
}
/** Pull the named members out of the pinned archive into `dir` under their staged names. */
async function extractMembers(archive,format,members,dir,{scratch}){
  if(format==='zip'){
    const entries=readZip(await readFile(archive),{only:new Set(Object.values(members))});
    for(const [staged,member] of Object.entries(members))await writeFile(path.join(dir,staged),entries.get(member),{flag:'wx'});
    return;
  }
  // tar.xz: the host's tar (GNU or bsdtar; both take member paths and -J). Extract into a
  // scratch tree, then move only the named files — never the archive's directory layout.
  const tree=path.join(scratch,'tree');await mkdir(tree);
  await exec('tar',['-xJf',archive,'-C',tree,...new Set(Object.values(members))],{timeout:300000,maxBuffer:4*1024*1024}).catch(e=>{throw new Error(`tar could not extract the pinned members (${e.message}); a tar with xz support is required to stage a tar.xz encoder`);});
  for(const [staged,member] of Object.entries(members)){const from=path.join(tree,...member.split('/'));if(!(await stat(from)).isFile())throw new Error(`Pinned member is not a file: ${member}`);await rename(from,path.join(dir,staged));}
  await rm(tree,{recursive:true,force:true});
}
export async function fetchVideoEncoder({platform=process.platform,arch=process.arch,root=path.join(repo,'build/video-encoder'),manifest,notice,fetchImpl=fetch,timeoutMs=120000}={}){
  if(!manifest||!notice){const contract=await videoEncoderContract();manifest??=contract.manifest;notice??=contract.notice;}
  const pinned=pinnedTarget(manifest,platform,arch),{key,executable}=pinned;
  return withAssetInstall(root,key,async assertOwned=>{
    const target=path.join(root,key);await recoverPrevious(target);
    try {await verifyVideoEncoder(target,{platform,arch,manifest,notice});await assertOwned();await rm(target+'.previous',{recursive:true,force:true});console.log(`Video encoder ${key}: rehashed ${manifest.release} (${pinned.version})`);return {target,cached:true};}catch{/* Prepare a complete replacement before publication. */}
    const tmp=await mkdtemp(path.join(root,`.fetch-${key}-`)),prepared=path.join(tmp,'prepared');await mkdir(prepared);
    try {
      const archive=path.join(tmp,`archive.${pinned.archive.format}`);
      await downloadAsset(pinned.archive.url,archive,pinned.archive,{fetchImpl,timeoutMs});
      const members={[executable]:pinned.archiveExecutable};
      for(const name of ['LICENSE','README']){const spec=pinned.notices[name];if('member' in spec)members[name]=spec.member;}
      await extractMembers(archive,pinned.archive.format,members,prepared,{scratch:tmp});
      for(const name of ['LICENSE','README']){const spec=pinned.notices[name];if(!('member' in spec))await downloadAsset(spec.url,path.join(prepared,name),spec,{fetchImpl,timeoutMs});}
      await chmod(path.join(prepared,executable),0o755);await writeFile(path.join(prepared,'NOTICE.md'),notice,{flag:'wx'});
      const files=await inventory(prepared);
      await writeFile(path.join(prepared,'manifest.json'),JSON.stringify({release:manifest.release,version:pinned.version,platform,arch,provider:pinned.provider,binaryHash:files[executable],archiveHash:pinned.archive.sha256,source:pinned.archive.url,files},null,2)+'\n');
      await verifyVideoEncoder(prepared,{platform,arch,manifest,notice});await assertOwned();await replacePrepared(prepared,target);
      console.log(`Video encoder ${key}: installed and verified ${manifest.release} (${pinned.version})`);return {target,cached:false};
    }finally{await rm(tmp,{recursive:true,force:true});}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const at=args.indexOf(name);return at<0?'':args[at+1];};
  const platform=arg('--platform')||process.platform,arches=(arg('--arches')||(platform==='darwin'?'arm64,x64':process.arch)).split(',').filter(Boolean);
  for(const arch of arches)await fetchVideoEncoder({platform,arch});
}
