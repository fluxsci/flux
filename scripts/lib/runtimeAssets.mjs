// Build-time asset boundary, shared by correction and encoder fetchers.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, lstat, readdir, realpath, rename, rm, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import leases from '../../electron/operationLease.cjs';
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(file) {
  const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');
}
const contained = (root, value) => value === root || value.startsWith(root + path.sep);
export async function inventory(directory, exclude = new Set()) {
  const root=await realpath(directory),files={};let total=0;
  const walk=async(rel='')=>{
    for(const entry of await readdir(path.join(root,rel),{withFileTypes:true})) {
      const name=rel?`${rel}/${entry.name}`:entry.name;if(exclude.has(name))continue;
      const file=path.join(root,name),actual=await realpath(file);
      if(!contained(root,actual))throw new Error(`Runtime link escapes its bundle: ${name}`);
      const info=await stat(file);
      if(info.isDirectory()){if(entry.isSymbolicLink())throw new Error(`Runtime directory link is not allowed: ${name}`);await walk(name);}
      else if(info.isFile()) { total+=info.size;if(total>1024*1024*1024||Object.keys(files).length>=10000)throw new Error('Runtime inventory exceeds build-time resource bound');files[name]=await hashFile(file); }
      else throw new Error(`Runtime has unsupported file type: ${name}`);
    }
  };await walk();return files;
}
/** Header validation works when cross-building; execution is a separate platform smoke. */
export async function verifyExecutable(file, platform, arch) {
  const info=await stat(file);if(!info.isFile()||!info.size)throw new Error(`Missing executable: ${file}`);
  if(platform!=='win32'&&(info.mode&0o111)===0)throw new Error(`Runtime is not executable: ${file}`);
  const fd=await open(file,'r');const bytes=Buffer.alloc(4096);let size;
  try {size=(await fd.read(bytes,0,bytes.length,0)).bytesRead;}finally{await fd.close();}
  let valid=false;
  if(platform==='linux')valid=size>=20&&bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))&&bytes[4]===2&&bytes[5]===1&&bytes.readUInt16LE(18)===(arch==='x64'?62:arch==='arm64'?183:-1);
  if(platform==='darwin'&&size>=8){
    const cpu=arch==='x64'?0x01000007:arch==='arm64'?0x0100000c:-1;
    if(bytes.readUInt32LE(0)===0xfeedfacf)valid=bytes.readUInt32LE(4)===cpu;
    else if(bytes.readUInt32BE(0)===0xcafebabe){const n=bytes.readUInt32BE(4);if(n>0&&n<=32&&size>=8+n*20)for(let i=0;i<n;i++)valid ||= bytes.readUInt32BE(8+i*20)===cpu;}
  }
  if(platform==='win32'&&size>=64&&bytes.toString('ascii',0,2)==='MZ'){
    const at=bytes.readUInt32LE(60);valid=at+6<=size&&bytes.toString('ascii',at,at+4)==='PE\0\0'&&bytes.readUInt16LE(at+4)===(arch==='x64'?0x8664:arch==='arm64'?0xaa64:-1);
  }
  if(!valid)throw new Error(`Runtime executable architecture does not match ${platform}-${arch}: ${file}`);
}
export async function verifyInventory(directory,{files,manifestName,executable,platform,arch,required=['LICENSE'],backendPrefix}) {
  if(!files||typeof files!=='object'||Array.isArray(files)||!Object.keys(files).length)throw new Error('Runtime file inventory missing');
  for(const [name,digest] of Object.entries(files))if(!name||path.isAbsolute(name)||name.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||!/^[a-f0-9]{64}$/.test(digest))throw new Error('Invalid runtime file inventory');
  const actual=await inventory(directory,new Set([manifestName]));
  if(JSON.stringify(Object.keys(actual).sort())!==JSON.stringify(Object.keys(files).sort()))throw new Error('Runtime inventory files are missing or unexpected');
  for(const [name,digest] of Object.entries(files))if(actual[name]!==digest)throw new Error(`Runtime checksum mismatch: ${name}`);
  for(const name of [executable,...required])if(!files[name]||(await stat(path.join(directory,name))).size===0)throw new Error(`Required runtime resource missing: ${name}`);
  if(backendPrefix&&!Object.keys(files).some(name=>name.startsWith(backendPrefix)))throw new Error(`Required runtime backend missing: ${backendPrefix}`);
  await verifyExecutable(path.join(directory,executable),platform,arch);
  return actual;
}
/** Exact byte budget and deadline apply during streaming, before allocation. */
export async function downloadAsset(url,destination,expected,{fetchImpl=fetch,timeoutMs=120000,signal}={}) {
  if(!Number.isSafeInteger(expected.size)||expected.size<1||expected.size>512*1024*1024||!/^[a-f0-9]{64}$/.test(expected.sha256))throw new Error('Invalid pinned download contract');
  const deadline=AbortSignal.timeout(timeoutMs),stop=signal?AbortSignal.any([deadline,signal]):deadline;
  let fetchAbort;const fetchAborted=new Promise((_,reject)=>{fetchAbort=()=>reject(stop.reason??new Error('Runtime download cancelled'));stop.addEventListener('abort',fetchAbort,{once:true});if(stop.aborted)fetchAbort();});
  let response;try {response=await Promise.race([fetchImpl(url,{redirect:'follow',signal:stop}),fetchAborted]);}finally{stop.removeEventListener('abort',fetchAbort);}
  if(!response.ok)throw new Error(`Runtime download HTTP ${response.status}`);
  if(!response.body)throw new Error('Runtime download has no body');
  const advertised=response.headers.get('content-length');if(advertised&&Number(advertised)!==expected.size){void response.body.cancel().catch(()=>{});throw new Error('Runtime download size header mismatch');}
  const fd=await open(destination,'wx'),reader=response.body.getReader(),digest=createHash('sha256');let total=0;
  let abort;const aborted=new Promise((_,reject)=>{abort=()=>reject(stop.reason??new Error('Runtime download cancelled'));stop.addEventListener('abort',abort,{once:true});if(stop.aborted)abort();});
  try {
    while(true){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;total+=value.byteLength;if(total>expected.size)throw new Error('Runtime download exceeds pinned byte limit');digest.update(value);let offset=0;while(offset<value.byteLength)offset+=(await fd.write(value,offset,value.byteLength-offset)).bytesWritten;}
    if(total!==expected.size||digest.digest('hex')!==expected.sha256)throw new Error('Runtime download checksum/size mismatch');
    await fd.sync();
  } catch(error){void reader.cancel().catch(()=>{});await fd.close();await rm(destination,{force:true});throw error;}
  finally{stop.removeEventListener('abort',abort);}
  await fd.close();
}
export async function gunzipBounded(archive,destination,maxBytes=512*1024*1024){let total=0;await pipeline(createReadStream(archive),createGunzip(),new Transform({transform(chunk,_encoding,done){total+=chunk.length;done(total>maxBytes?new Error('Expanded runtime exceeds byte limit'):null,chunk);}}),createWriteStream(destination,{flags:'wx'}));}
/** Keep the old bundle until the prepared bundle is complete and verified.
 * A fixed previous slot is recoverable after a crash between the two renames. */
export async function recoverPrevious(target,{renameImpl=rename}={}){
  const backup=target+'.previous';const present=await lstat(target).catch(()=>null),old=await lstat(backup).catch(()=>null);
  if(!present&&old)await renameImpl(backup,target);
}
export async function replacePrepared(prepared,target,{renameImpl=rename}={}){
  const backup=target+'.previous';await recoverPrevious(target,{renameImpl});
  if(await lstat(backup).catch(()=>null))throw new Error(`Previous runtime needs review before replacement: ${backup}`);
  let moved=false;
  if(await lstat(target).catch(()=>null)){await renameImpl(target,backup);moved=true;}
  try{await renameImpl(prepared,target);}catch(error){if(moved){try{await renameImpl(backup,target);}catch(restore){throw new Error(`Runtime replacement and restoration failed; last good bundle is preserved at ${backup}. ${error}; ${restore}`);}}throw error;}
  if(moved)await rm(backup,{recursive:true,force:true});
}

/** One operation owner serializes both cache checking and publication. */
export async function withAssetInstall(root,key,work){
  if(!/^[a-z0-9]+-[a-z0-9]+$/.test(key))throw new Error('Invalid runtime target');
  const dir=path.join(root,'.locks');await mkdir(dir,{recursive:true});
  return leases.queued(dir,key,async canonical=>{
    const deadline=Date.now()+300000;let acquired;
    do { acquired=await leases.acquire(canonical,key,'runtime-fetch');if(acquired.ok)break;if(Date.now()>deadline)throw new Error(`Runtime installation busy: ${key}`);await new Promise(resolve=>setTimeout(resolve,100)); } while(true);
    let renewalError;const timer=setInterval(()=>{leases.renew(acquired.lease).then(ok=>{if(!ok)renewalError=new Error('Runtime installation lease was lost');}).catch(error=>{renewalError=error;});},5000);timer.unref();
    const assertOwned=async()=>{if(renewalError)throw renewalError;await leases.assertOwned(acquired.lease);};
    try{
      // Under the exclusive target lease, every old staging directory is from
      // an interrupted prior owner. Cleanup failure still releases this lease.
      for(const name of await readdir(root))if(name.startsWith(`.fetch-${key}-`))await rm(path.join(root,name),{recursive:true,force:true});
      return await work(assertOwned);
    }finally{clearInterval(timer);await leases.release(acquired.lease);}
  });
}
