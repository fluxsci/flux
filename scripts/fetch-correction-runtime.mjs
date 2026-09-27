#!/usr/bin/env node
// Explicit packaging step; application startup never downloads executables.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { downloadAsset, gunzipBounded, inventory, recoverPrevious, replacePrepared, verifyInventory, withAssetInstall } from './lib/runtimeAssets.mjs';

export const CORRECTION_RELEASE = 'b10288';
const RELEASE = CORRECTION_RELEASE;
export const CORRECTION_ASSETS = {
  'darwin-arm64': { name: `llama-${RELEASE}-bin-macos-arm64.tar.gz`, size: 10_977_848, sha256: '2dced716a80ce726be6a7418fefa611f95b632d611a0582ca7cc3880ce0f0bb1', acceleration: 'metal', backendPrefix: 'libggml-metal' },
  'darwin-x64': { name: `llama-${RELEASE}-bin-macos-x64.tar.gz`, size: 11_245_902, sha256: 'b9c2fb2fff9ebb9eab0393bdec25d60990da4ab5a65e50ab70809090b9669171', acceleration: 'cpu' },
  // Vulkan retains a CPU path on hosts without a usable GPU device.
  'linux-x64': { name: `llama-${RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`, size: 32_443_080, sha256: 'eda0a9c25e15bb478b1227edb2464f20cec222b945308401617a558c8a55a48e', acceleration: 'vulkan', backendPrefix: 'libggml-vulkan' },
};
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/correction-runtime');
const sourceUrl = asset => `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}/${asset.name}`;
const exec = promisify(execFile);

export async function verifyCorrectionRuntime(target,{platform,arch,asset=CORRECTION_ASSETS[`${platform}-${arch}`]}) {
  if(!asset)throw new Error(`No pinned correction runtime for ${platform}-${arch}`);
  const current=JSON.parse(await readFile(path.join(target,'runtime-manifest.json'),'utf8'));
  if(current.version!==1||current.release!==RELEASE||current.platform!==platform||current.arch!==arch||current.archive!==asset.name||current.archiveSize!==asset.size||current.archiveSha256!==asset.sha256||current.sourceUrl!==sourceUrl(asset)||current.acceleration!==asset.acceleration||current.license!=='MIT')throw new Error('Correction runtime identity does not match pinned target');
  const files=await verifyInventory(target,{files:current.files,manifestName:'runtime-manifest.json',executable:'llama-server',platform,arch,backendPrefix:asset.backendPrefix});
  if(current.serverSha256!==files['llama-server'])throw new Error('Correction server manifest checksum mismatch');
  for(const prefix of ['libllama.','libggml-base.']){const name=Object.keys(files).find(name=>name.startsWith(prefix)&&(name.endsWith('.dylib')||name.includes('.so')));if(!name||(await stat(path.join(target,name))).size===0)throw new Error(`Required correction library missing: ${prefix}`);}
  if(asset.backendPrefix&&(!current.backend?.file?.startsWith(asset.backendPrefix)||current.backend.sha256!==files[current.backend.file]))throw new Error('Correction runtime backend manifest mismatch');
  return current;
}
async function extractRuntime(archive,extracted) {
  // Limit expanded archive bytes before tar sees them. Pinned hashes authenticate
  // the archive; traversal validation is an additional packaging boundary.
  const expanded=archive+'.tar';await gunzipBounded(archive,expanded);
  const {stdout}=await exec('tar',['-tf',expanded],{timeout:60000,maxBuffer:2*1024*1024});
  const names=stdout.split('\n').filter(Boolean);
  if(names.length>10000||names.some(name=>path.posix.isAbsolute(name)||name.split('/').some(part=>part==='..')))throw new Error('Correction archive contains unsafe paths');
  await exec('tar',['-xf',expanded,'--strip-components=1','-C',extracted],{timeout:60000,maxBuffer:2*1024*1024});
}
export async function fetchCorrectionRuntime({platform=process.platform,arch=process.arch,root=rootDefault,asset=CORRECTION_ASSETS[`${platform}-${arch}`],fetchImpl=fetch,extract=extractRuntime,timeoutMs=120000}={}) {
  const key=`${platform}-${arch}`;if(!asset)throw new Error(`No pinned correction runtime for ${key}`);
  return withAssetInstall(root,key,async assertOwned=>{
    const target=path.join(root,key);await recoverPrevious(target);
    try { await verifyCorrectionRuntime(target,{platform,arch,asset});await assertOwned();await rm(target+'.previous',{recursive:true,force:true});console.log(`correction runtime ${key}: rehashed ${RELEASE}`);return {target,cached:true}; }
    catch { /* Keep the current bundle until a complete replacement is verified. */ }
    const scratch=await mkdtemp(path.join(root,`.fetch-${key}-`));
    try {
      const archive=path.join(scratch,'download.gz'),extracted=path.join(scratch,'extracted');await mkdir(extracted);
      await downloadAsset(sourceUrl(asset),archive,asset,{fetchImpl,timeoutMs});await extract(archive,extracted);
      for(const entry of await readdir(extracted))if(entry!=='llama-server'&&entry!=='LICENSE'&&!entry.includes('.')&&(await stat(path.join(extracted,entry))).isFile())await rm(path.join(extracted,entry));
      await chmod(path.join(extracted,'llama-server'),0o755);
      const files=await inventory(extracted),backendFile=asset.backendPrefix?Object.keys(files).find(name=>name.startsWith(asset.backendPrefix)):null;
      const manifest={version:1,release:RELEASE,upstreamRevision:'360e1349f0009c5ad99d21e3c4546b707addc68a',platform,arch,archive:asset.name,archiveSize:asset.size,archiveSha256:asset.sha256,serverSha256:files['llama-server'],sourceUrl:sourceUrl(asset),license:'MIT',acceleration:asset.acceleration,backend:backendFile?{file:backendFile,sha256:files[backendFile]}:null,files};
      await writeFile(path.join(extracted,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
      await verifyCorrectionRuntime(extracted,{platform,arch,asset});await assertOwned();
      await replacePrepared(extracted,target);console.log(`correction runtime ${key}: installed and verified ${RELEASE}`);return {target,cached:false};
    } finally {await rm(scratch,{recursive:true,force:true});}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=name=>{const at=args.indexOf(name);return at<0?'':args[at+1];};
  const platform=value('--platform')||process.platform,arches=(value('--arches')||(platform==='darwin'?'arm64,x64':process.arch)).split(',').filter(Boolean);
  for(const arch of arches)await fetchCorrectionRuntime({platform,arch});
}
