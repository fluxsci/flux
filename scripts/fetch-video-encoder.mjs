#!/usr/bin/env node
// Explicit build-time download. No installation or network request during export.
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAsset, gunzipBounded, hashBytes, inventory, recoverPrevious, replacePrepared, verifyInventory, withAssetInstall } from './lib/runtimeAssets.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function videoEncoderContract(){return {manifest:JSON.parse(await readFile(path.join(repo,'build/video-encoder.json'),'utf8')),notice:await readFile(path.join(repo,'build/video-encoder-NOTICE.md'))};}
function resources(manifest,platform,arch){const key=`${platform}-${arch}`,files=manifest.targets?.[key];if(!files?.[`ffmpeg-${key}.gz`]||!files[`${key}.LICENSE`]||!files[`${key}.README`])throw new Error(`No complete pinned video encoder for ${key}`);return files;}
export async function verifyVideoEncoder(target,{platform,arch,manifest,notice}){
  const key=`${platform}-${arch}`,pinned=resources(manifest,platform,arch),executable=platform==='win32'?'ffmpeg.exe':'ffmpeg';
  const current=JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8'));
  if(current.release!==manifest.release||current.platform!==platform||current.arch!==arch||current.archiveHash!==pinned[`ffmpeg-${key}.gz`].sha256||current.source!==manifest.baseUrl)throw new Error('Video encoder identity does not match pinned target');
  // Older bundles had a binary-only manifest. Ancillary files still have pinned
  // upstream hashes, so they can be verified without silently rewriting them.
  const expected={ [executable]:current.binaryHash,LICENSE:pinned[`${key}.LICENSE`].sha256,README:pinned[`${key}.README`].sha256,'NOTICE.md':hashBytes(notice) };
  if(current.files&&(JSON.stringify(Object.keys(current.files).sort())!==JSON.stringify(Object.keys(expected).sort())||Object.entries(expected).some(([name,digest])=>current.files[name]!==digest)))throw new Error('Video encoder resource manifest mismatch');
  await verifyInventory(target,{files:current.files??expected,manifestName:'manifest.json',executable,platform,arch,required:['LICENSE','README','NOTICE.md']});return current;
}
export async function fetchVideoEncoder({platform=process.platform,arch=process.arch,root=path.join(repo,'build/video-encoder'),manifest,notice,fetchImpl=fetch,timeoutMs=120000}={}){
  if(!manifest||!notice){const contract=await videoEncoderContract();manifest??=contract.manifest;notice??=contract.notice;}
  const key=`${platform}-${arch}`,pinned=resources(manifest,platform,arch),executable=platform==='win32'?'ffmpeg.exe':'ffmpeg';
  return withAssetInstall(root,key,async assertOwned=>{
    const target=path.join(root,key);await recoverPrevious(target);
    try {await verifyVideoEncoder(target,{platform,arch,manifest,notice});await assertOwned();await rm(target+'.previous',{recursive:true,force:true});console.log(`Video encoder ${key}: rehashed ${manifest.release}`);return {target,cached:true};}catch{/* Prepare a complete replacement before publication. */}
    const tmp=await mkdtemp(path.join(root,`.fetch-${key}-`)),prepared=path.join(tmp,'prepared');await mkdir(prepared);
    try {
      for(const [name,expected] of Object.entries(pinned)){
        if(name!==`ffmpeg-${key}.gz`&&name!==`${key}.LICENSE`&&name!==`${key}.README`)throw new Error(`Unexpected pinned encoder resource: ${name}`);
        const archive=path.join(tmp,name);await downloadAsset(`${manifest.baseUrl}/${name}`,archive,expected,{fetchImpl,timeoutMs});
        if(name.endsWith('.gz'))await gunzipBounded(archive,path.join(prepared,executable));else await writeFile(path.join(prepared,name.split('.').at(-1)),await readFile(archive),{flag:'wx'});
      }
      await chmod(path.join(prepared,executable),0o755);await writeFile(path.join(prepared,'NOTICE.md'),notice);
      const files=await inventory(prepared);
      await writeFile(path.join(prepared,'manifest.json'),JSON.stringify({release:manifest.release,platform,arch,binaryHash:files[executable],archiveHash:pinned[`ffmpeg-${key}.gz`].sha256,source:manifest.baseUrl,files},null,2)+'\n');
      await verifyVideoEncoder(prepared,{platform,arch,manifest,notice});await assertOwned();await replacePrepared(prepared,target);
      console.log(`Video encoder ${key}: installed and verified ${manifest.release}`);return {target,cached:false};
    }finally{await rm(tmp,{recursive:true,force:true});}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const at=args.indexOf(name);return at<0?'':args[at+1];};
  const platform=arg('--platform')||process.platform,arches=(arg('--arches')||(platform==='darwin'?'arm64,x64':process.arch)).split(',').filter(Boolean);
  for(const arch of arches)await fetchVideoEncoder({platform,arch});
}
