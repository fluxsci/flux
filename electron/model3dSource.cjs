"use strict";
// Idle source fingerprints. Stream bytes natively; cache only stable stat identities.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fsp = fs.promises;
const under = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
function createModel3dSourceHasher() {
  const cache = new Map();
  let bytesRead = 0;
  async function hash(file, { root, limit, optional = false, readGuard, checkCurrent }) {
    checkCurrent();
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('Invalid 3D source path');
    await readGuard(file);
    let real, before;
    try { real = await fsp.realpath(file); before = await fsp.lstat(real); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    const realRoot = await fsp.realpath(root);
    if (under(path.resolve(root), path.resolve(file)) && !under(realRoot, real)) throw new Error('3D source escapes the project');
    await readGuard(real); checkCurrent();
    if (!before.isFile()) throw new Error('3D source must be a regular file');
    if (before.size > limit) throw new Error(`3D source exceeds ${limit / 1048576} MiB`);
    const key = `${real}\0${identity(before)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error('3D source changed before reading');
      const digest = createHash('sha256'), chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, before.size)));
      let offset = 0;
      while (offset < before.size) {
        checkCurrent();
        const result = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
        if (!result.bytesRead) throw new Error('3D source changed while reading');
        digest.update(chunk.subarray(0, result.bytesRead)); offset += result.bytesRead; bytesRead += result.bytesRead;
      }
      checkCurrent(); await readGuard(file);
      if (identity(await handle.stat()) !== identity(before) || identity(await fsp.lstat(real)) !== identity(before) || await fsp.realpath(file) !== real) throw new Error('3D source changed while reading');
      const value = digest.digest('hex'); cache.set(key, value);
      if (cache.size > 1024) cache.delete(cache.keys().next().value);
      return value;
    } finally { await handle.close(); }
  }
  async function fingerprint(request, options) {
    if (!/\.glb$/i.test(request.sourcePath ?? '')) throw new Error('A GLB source is required');
    for (const key of ['manifestPath', 'storedManifestPath']) if (request[key] != null && !/\.json$/i.test(request[key])) throw new Error('A JSON manifest path is required');
    const opts = { ...options, root: request.root };
    const sourceSha256 = await hash(request.sourcePath, { ...opts, limit: 200 * 1048576 });
    const metadata = file => file ? hash(file, { ...opts, optional: true, limit: 4 * 1048576 }) : null;
    const manifestHash = await metadata(request.manifestPath), storedManifestHash = await metadata(request.storedManifestPath);
    options.checkCurrent(); return { sourceSha256, manifestHash, storedManifestHash };
  }
  return { fingerprint, clear: () => cache.clear(), stats: () => ({ bytesRead, cached: cache.size }) };
}
module.exports = { createModel3dSourceHasher };
