// Startup recovery is an authoring-entry boundary, not a recursively called
// loadManifest hook. Lock order: export -> project -> slides -> references -> manifest.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withLock, assertLockOwned } from './locks';
import { atomicWrite, fsyncDir } from './fsx';
import { recoverExportSources, exportJournalPath, type ExportRecoveryIO } from '../src/lib/project/exportRecovery';
import { recoverTextGeneration, TEXT_GENERATION_JOURNAL } from '../src/lib/project/textGeneration';
export async function confinedRecoveryPath(root: string, candidate: string): Promise<void> {
  const base=await fs.realpath(root), absolute=path.resolve(candidate);
  const lexical=path.relative(path.resolve(root),absolute);
  if(lexical==='..'||lexical.startsWith('..'+path.sep)||path.isAbsolute(lexical))throw Error('Recovery path escapes project');
  let probe=absolute;
  while(true){
    try {const real=await fs.realpath(probe), relative=path.relative(base,real);
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error(`Recovery symlink escapes project: ${candidate}`);return;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(probe);if(parent===probe)throw error;probe=parent;}
  }
}
export function exportRecoveryIO(root: string, assertOwned?: () => Promise<void>): ExportRecoveryIO {
  return {
    assertOwned,
    readText: async p=>{await confinedRecoveryPath(root,p);try{return await fs.readFile(p,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},
    writeText: async(p,text)=>{await confinedRecoveryPath(root,p);await assertOwned?.();await atomicWrite(p,text);await fsyncDir(path.dirname(p))},
    removeFile: async p=>{await confinedRecoveryPath(root,p);await assertOwned?.();await fs.rm(p,{force:true});await fsyncDir(path.dirname(p))},
    validatePath:p=>confinedRecoveryPath(root,p),
    fsyncDir,
    stat: async p => { await confinedRecoveryPath(root,p); return fs.stat(p); },
    setTimes: async (p,times) => { await confinedRecoveryPath(root,p); await assertOwned?.(); await fs.utimes(p,times.atimeMs/1000,times.mtimeMs/1000); const file=await fs.open(p,"r+"); /* r+: Windows refuses fsync on a read-only handle (EPERM) */ try{await file.sync()}finally{await file.close()} },
  };
}
export async function recoverProjectForAuthoring(root: string): Promise<void> {
  try{await fs.access(path.join(root,'project.json'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  const probe=exportRecoveryIO(root);
  // Read-only commands (including the GUI's already-saved video export) must
  // not acquire authoring leases when there is no interrupted transaction.
  // A presence probe never authorizes restoration: each recovery below reads
  // and validates the current journal again while owning its normal leases.
  if(await probe.readText(exportJournalPath(root))!==null)
    await withLock(root,'export','recovery',async lease=>{await recoverExportSources(exportRecoveryIO(root,()=>assertLockOwned(lease)),root)});
  if(await probe.readText(path.join(root,TEXT_GENERATION_JOURNAL))===null)return;
  await withLock(root,'project','recovery',projectLease=>withLock(root,'slides','recovery',slidesLease=>withLock(root,'manifest','recovery',async manifestLease=>{
    const assertOwned = async()=>{await assertLockOwned(projectLease);await assertLockOwned(slidesLease);await assertLockOwned(manifestLease)};
    const io=exportRecoveryIO(root,assertOwned);
    await recoverTextGeneration({validatePath:rel=>io.validatePath!(path.join(root,rel)),read:rel=>io.readText(path.join(root,rel)),write:(rel,text)=>io.writeText(path.join(root,rel),text),remove:rel=>io.removeFile(path.join(root,rel)),fsyncDir:rel=>fsyncDir(path.join(root,rel)),readBytes:async rel=>{const file=path.join(root,rel);await confinedRecoveryPath(root,file);try{return await fs.readFile(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}},writeBytes:async(rel,bytes)=>{const file=path.join(root,rel);await confinedRecoveryPath(root,file);await assertOwned();await atomicWrite(file,bytes)}},assertOwned);
  })));
}
