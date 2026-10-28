"use strict";
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readFrames, writeFrame } = require('../sceneRasterProtocol.cjs');
const { validateSceneRequest } = require('../sceneRasterRules.cjs');

/** One dedicated worker per requesting window, one active and only the latest
 * queued capture. Cancellation kills a running decode, not merely its reply.
 * No scene, PNG or cache file is written to the project or user configuration. */
function createSceneRasterFamily({ app, appRoot, rootFor, generationFor = () => 0, fontIndexFile = () => undefined, timeoutMs = 15000, spawnProcess = spawn }) {
  const owners = new Map();
  let closed = false;
  function settle(job, result) { if (!job || job.done) return; job.done = true; job.resolve(result); }
  function stopWorker(owner) {
    if (owner.timer) clearTimeout(owner.timer); owner.timer = null;
    const proc = owner.proc; owner.proc = null;
    if (proc) { proc.stdin.destroy(); try { proc.kill('SIGKILL'); } catch {} }
  }
  function cancelOwner(senderId) {
    const owner = owners.get(senderId); if (!owner) return;
    owners.delete(senderId); stopWorker(owner);
    settle(owner.active, { cancelled: true }); settle(owner.pending, { cancelled: true });
    owner.sender.removeListener('destroyed', owner.onDestroyed);
    owner.active = owner.pending = null;
  }
  function valid(owner, job) { return !closed && owners.get(owner.sender.id) === owner && !owner.sender.isDestroyed() && rootFor(job.event) === job.root && generationFor(job.event) === job.generation; }
  function failed(owner, message) {
    stopWorker(owner);
    settle(owner.active, { error: message }); owner.active = null;
    // A bad source is not retried forever: three worker deaths suppress this
    // owner's capture service until its project/session changes.
    const now = Date.now(); owner.deaths = owner.deaths.filter(t => now - t < 60000); owner.deaths.push(now);
    if (owner.deaths.length >= 3) { owner.unavailable = true; settle(owner.pending, { error: 'Scene raster worker unavailable' }); owner.pending = null; }
    else pump(owner);
  }
  function worker(owner) {
    if (owner.proc) return owner.proc;
    const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : appRoot;
    const proc = spawnProcess(process.execPath, ['--max-old-space-size=768', path.join(root, 'electron/sceneRasterWorker.mjs')], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: '2', FLUX_SCENE_FONT_INDEX: fontIndexFile() || '' },
    });
    owner.proc = proc;
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    proc.stdin.on('error', () => {});
    readFrames(proc.stdout, (header, body) => {
      if (owner.proc !== proc || !owner.active) return;
      if (header.rid !== owner.active.request.rid) return; // stale/duplicate response from this worker
      const job = owner.active; owner.active = null;
      if (owner.timer) clearTimeout(owner.timer); owner.timer = null;
      if (!valid(owner, job)) settle(job, { cancelled: true });
      else if (header.error) settle(job, { error: String(header.error) });
      else {
        try {
          if (!Array.isArray(header.rasters) || header.rasters.length !== job.request.regions.length) throw Error('Invalid scene raster reply');
          let offset = 0;
          const rasters = header.rasters.map((r, i) => {
            const target = job.request.regions[i];
            if (r.width !== target.width || r.height !== target.height || !Number.isInteger(r.byteLength) || r.byteLength < 8 || offset + r.byteLength > body.length) throw Error('Invalid scene raster dimensions');
            const bytes = body.subarray(offset, offset + r.byteLength); offset += r.byteLength;
            if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Invalid scene raster PNG');
            return { bytes, width: r.width, height: r.height };
          });
          if (offset !== body.length) throw Error('Invalid scene raster payload');
          settle(job, { rasters });
        } catch (error) { settle(job, { error: error.message }); stopWorker(owner); }
      }
      pump(owner);
    }, error => { if (owner.proc === proc) failed(owner, `Scene raster protocol failed: ${error.message}`); }, 20 * 1024 * 1024);
    proc.on('error', error => { if (owner.proc === proc) failed(owner, `Scene raster worker failed: ${error.message}`); });
    proc.on('exit', (code, signal) => { if (owner.proc === proc) failed(owner, `Scene raster worker exited (${code ?? signal})${stderr ? ': ' + stderr.trim().split('\n').at(-1) : ''}`); });
    return proc;
  }
  function pump(owner) {
    if (closed || owner.active || !owner.pending || owners.get(owner.sender.id) !== owner) return;
    const job = owner.pending; owner.pending = null;
    if (!valid(owner, job)) { settle(job, { cancelled: true }); return; }
    if (owner.unavailable) { settle(job, { error: 'Scene raster worker unavailable' }); return; }
    owner.active = job;
    try {
      const proc = worker(owner);
      owner.timer = setTimeout(() => { if (owner.active === job) failed(owner, 'Scene raster worker timed out'); }, timeoutMs);
      writeFrame(proc.stdin, { rid: job.request.rid, regions: job.request.regions }, job.request.svg);
    } catch (error) { failed(owner, `Scene raster worker failed: ${error.message}`); }
  }
  function ownerFor(event) {
    let owner = owners.get(event.sender.id);
    if (!owner) {
      owner = { sender: event.sender, proc: null, active: null, pending: null, timer: null, deaths: [], unavailable: false, onDestroyed: () => cancelOwner(event.sender.id) };
      owners.set(event.sender.id, owner); event.sender.once('destroyed', owner.onDestroyed);
    }
    return owner;
  }
  function rasterize(event, request) {
    if (closed || event.sender.isDestroyed()) return Promise.resolve({ cancelled: true });
    let checked;
    try { checked = validateSceneRequest(request); } catch (error) { return Promise.resolve({ error: error.message }); }
    const owner = ownerFor(event);
    return new Promise(resolve => {
      settle(owner.pending, { cancelled: true });
      owner.pending = { request: checked, resolve, event, root: rootFor(event), generation: generationFor(event), done: false };
      pump(owner);
    });
  }
  function cancel(event, rid) {
    if (typeof rid !== 'string') return;
    const owner = owners.get(event.sender.id); if (!owner) return;
    if (owner.pending?.request.rid === rid) { settle(owner.pending, { cancelled: true }); owner.pending = null; }
    if (owner.active?.request.rid === rid) { const job = owner.active; owner.active = null; stopWorker(owner); settle(job, { cancelled: true }); pump(owner); }
  }
  return {
    registerHandlers(ipc) { ipc.handle('scene:rasterize', rasterize); ipc.handle('scene:cancelRaster', (event, rid) => cancel(event, rid)); },
    cancelOwner,
    shutdown() { closed = true; for (const id of [...owners.keys()]) cancelOwner(id); },
  };
}
module.exports = { createSceneRasterFamily };
