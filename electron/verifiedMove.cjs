"use strict";
// Exclusive verified publication shared by capture and assignment.
function createVerifiedMove({fs=require("node:fs"),fsp=fs.promises,path=require("node:path")}={}) {
  const crypto=require("node:crypto");
  const digest = async file => {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  };
  async function moveExclusive(src, dst, expectedSha256) {
    const source = await fsp.lstat(src);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error("Capture source is not a regular file");
    const receipt = path.join(path.dirname(dst), `.capture-${crypto.createHash("sha256").update(src).digest("hex")}.json`);
    // If removal failed after publication, the receipt identifies the exact
    // completed destination. Retry finishes that operation rather than suffixing
    // and filing a duplicate. Receipt paths never authorize another directory.
    let prior;
    try { prior = JSON.parse(await fsp.readFile(receipt, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (prior) {
      if (expectedSha256 && prior.sha256 !== expectedSha256) throw new Error("Source changed since interrupted move; both files preserved");
      if (prior.source !== src || path.dirname(prior.destination) !== path.dirname(dst)) throw new Error("Invalid capture recovery receipt");
      if (fs.existsSync(prior.destination)) {
        const st = await fsp.lstat(prior.destination); if (!st.isFile() || st.isSymbolicLink()) throw new Error("Invalid recovery destination");
        if (await digest(prior.destination) !== prior.sha256 || await digest(src) !== prior.sha256) throw new Error("Capture changed during interrupted intake; preserved for recovery");
        await fsp.rm(src); await fsp.rm(receipt); return prior.destination;
      }
      await fsp.rm(receipt);
    }
    const sha256 = await digest(src);
    if (expectedSha256 && expectedSha256 !== sha256) throw new Error("Source changed before move; bytes preserved");
    const fdReceipt = await fsp.open(receipt, "wx", 0o600);
    try { await fdReceipt.writeFile(JSON.stringify({source: src,destination: dst,sha256})); await fdReceipt.sync(); } finally { await fdReceipt.close(); }
    let published = false;
    try {
      try { await fsp.link(src, dst); published = true; }
      catch (error) {
        if (error.code !== "EXDEV") throw error;
        const tmp = `${dst}.pending-${crypto.randomUUID()}`;
        try {
          await fsp.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
          // "r+", not "r": Windows refuses FlushFileBuffers on a read-only handle
          // (EPERM), and intake swallows the throw as "retry next pass" — so every
          // cross-device capture failed to publish there, forever and silently.
          const fd = await fsp.open(tmp, "r+"); try { await fd.sync(); } finally { await fd.close(); }
          if (await digest(tmp) !== sha256 || await digest(src) !== sha256) throw new Error("Capture copy verification failed; original retained");
          await fsp.link(tmp, dst); published = true;
        } finally { await fsp.rm(tmp, {force:true}).catch(() => {}); }
      }
      const after = await fsp.lstat(src);
      if (after.size !== source.size || after.mtimeMs !== source.mtimeMs) throw new Error("Capture changed during intake; preserved for recovery");
      await fsp.rm(src); await fsp.rm(receipt); return dst;
    } catch (error) {
      if (!published) await fsp.rm(receipt, {force:true}).catch(() => {});
      throw error;
    }
  }
  return moveExclusive;
}
module.exports={createVerifiedMove};
