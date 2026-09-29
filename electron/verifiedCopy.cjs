"use strict";
// Native, bounded-memory copy with exclusive atomic publication. The source is retained.
function createVerifiedCopy({ fs=require("node:fs"), fsp=fs.promises, path=require("node:path"), retry=require("./fsRetry.cjs").shareRetry }={}) {
  const crypto=require("node:crypto");
  const digest=async file=>{ const hash=crypto.createHash("sha256"); for await(const bytes of fs.createReadStream(file)) hash.update(bytes); return hash.digest("hex"); };
  async function regular(file) { const stat=await fsp.lstat(file); if(!stat.isFile()||stat.isSymbolicLink()) throw new Error("Copy requires a regular file"); return stat; }
  async function identical(destination,sha) { await regular(destination); if(await digest(destination)!==sha) throw new Error("Copy destination contains different bytes"); }
  return async function copyVerified(source,destination,expectedSha256,beforePublish=()=>{}) {
    if(expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid expected source hash");
    const before=await regular(source), sha=await digest(source);
    if(expectedSha256&&sha!==expectedSha256) throw new Error("Copy source hash changed");
    try { await identical(destination,sha); return sha; } catch(error) { if(error.code!=="ENOENT") throw error; }
    const dir=path.dirname(destination), tmp=path.join(dir,`.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomInt(1e9)}`);
    try {
      await fsp.mkdir(dir,{recursive:true});
      await fsp.copyFile(source,tmp,fs.constants.COPYFILE_EXCL);
      const handle=await fsp.open(tmp,"r+"); try { await handle.sync(); } finally { await handle.close(); }
      const after=await regular(source);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||await digest(tmp)!==sha||await digest(source)!==sha) throw new Error("Copy source changed or copy verification failed");
      try { await retry(async()=>{ await beforePublish(); await fsp.link(tmp,destination); }); } catch(error) { if(error.code!=="EEXIST") throw error; await identical(destination,sha); }
      if(process.platform!=="win32") { const handle=await fsp.open(dir,"r"); try { await handle.sync(); } finally { await handle.close(); } }
      return sha;
    } finally { await retry(()=>fsp.rm(tmp,{force:true})); }
  };
}
module.exports={createVerifiedCopy};
