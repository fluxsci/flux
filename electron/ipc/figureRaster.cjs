'use strict';
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { readFrames, writeFrame } = require('../sceneRasterProtocol.cjs');
const { validateFigureRequest } = require('../figureRasterRules.cjs');

// 2026-10-29: cold atlas fill needs every figure (13 on the measured project).
// Unlike sceneRaster's latest viewport only, each window owns a FIFO pool:
// replace only the same queued figure, keeping its place; never discard a neighbour.
function createFigureRasterFamily({ app, appRoot, rootFor, generationFor = () => 0, fontIndexFile = () => undefined,
  workers = Number(process.env.FLUX_FIGURE_RASTER_WORKERS) || Math.min(4, Math.max(1, Math.floor(os.cpus().length / 8))),
  timeoutMs = 15000, idleMs = 60000, spawnProcess = spawn }) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw Error('Invalid figure raster worker count');
  const owners = new Map(); let closed = false;
  const settle = (job, result) => { if (job && !job.done) { job.done = true; job.resolve(result); } };
  const valid = (owner, job) => !closed && owners.get(owner.sender.id) === owner && !owner.sender.isDestroyed() && rootFor(job.event) === job.request.root && generationFor(job.event) === job.generation;
  // A worker holds 0.4–0.8 GB (measured 2026-10-29 on the owner's project); four per window
  // must not outlive the burst that needed them. An idle slot is reaped after idleMs and
  // respawns lazily on the next job. stop() nulls slot.proc first, so the exit is not a death.
  function armIdle(owner, slot) {
    clearTimeout(slot.idle); slot.idle = null;
    if (!slot.proc || slot.job || slot.stopping || !(idleMs > 0)) return;
    slot.idle = setTimeout(() => { slot.idle = null; if (!slot.job && slot.proc && !owner.queue.length) stop(slot); }, idleMs);
  }
  function stop(slot) {
    clearTimeout(slot.timer); slot.timer = null;
    clearTimeout(slot.idle); slot.idle = null;
    const proc = slot.proc; slot.proc = null;
    if (proc) { proc.stdin.destroy(); try { proc.kill('SIGKILL'); } catch {} }
    // A killed process retains its slot until exit: cancellation cannot briefly
    // exceed the pool bound while the OS is still reaping the old worker.
    slot.stopping = !!proc;
  }
  function cancelOwner(id) {
    const owner = owners.get(id); if (!owner) return;
    owners.delete(id); owner.sender.removeListener('destroyed', owner.onDestroyed);
    for (const job of owner.queue) settle(job, { cancelled: true }); owner.queue = [];
    for (const slot of owner.slots) { settle(slot.job, { cancelled: true }); slot.job = null; stop(slot); }
  }
  function failed(owner, slot, message) {
    stop(slot); settle(slot.job, { error: message }); slot.job = null;
    const now = Date.now(); owner.deaths = owner.deaths.filter(t => now - t < 60000); owner.deaths.push(now);
    if (owner.deaths.length >= 3) {
      owner.unavailable = true;
      for (const job of owner.queue) settle(job, { error: 'Figure raster worker unavailable' }); owner.queue = [];
      for (const other of owner.slots) { settle(other.job, { error: 'Figure raster worker unavailable' }); other.job = null; if (other.proc) stop(other); }
    }
    pump(owner);
  }
  function worker(owner, slot) {
    if (slot.proc) return slot.proc;
    const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : appRoot;
    const proc = spawnProcess(process.execPath, ['--max-old-space-size=768', path.join(root, 'electron/generated/figureRasterWorker.bundle.mjs')], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: '2', FLUX_MODEL3D_APP_ROOT: root, FLUX_SCENE_FONT_INDEX: fontIndexFile() || '' },
    });
    slot.proc = proc; let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    proc.stdin.on('error', () => {});
    proc.on('error', error => { if (slot.proc === proc) failed(owner, slot, `Figure raster worker failed: ${error.message}`); });
    proc.on('close', (code, signal) => {
      if (slot.proc === proc) failed(owner, slot, `Figure raster worker exited (${code ?? signal})${stderr ? ': ' + stderr.trim().split('\n').at(-1) : ''}`);
      slot.stopping = false; pump(owner);
    });
    readFrames(proc.stdout, (header, png) => {
      if (slot.proc !== proc || !slot.job || header.rid !== slot.job.request.rid) return;
      const job = slot.job; slot.job = null; clearTimeout(slot.timer); slot.timer = null;
      if (!valid(owner, job)) settle(job, { cancelled: true });
      else if (header.error) settle(job, { error: String(header.error) });
      else if (header.width !== job.request.width || header.height !== job.request.height || png.length < 24 ||
        !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.readUInt32BE(16) !== header.width || png.readUInt32BE(20) !== header.height) {
        slot.job = job; failed(owner, slot, 'Invalid figure raster PNG'); return;
      } else settle(job, { png, width: header.width, height: header.height, ms: header.ms });
      pump(owner);
      armIdle(owner, slot);
    }, error => { if (slot.proc === proc) failed(owner, slot, `Figure raster protocol failed: ${error.message}`); }, 20 * 1024 * 1024);
    return proc;
  }
  function pump(owner) {
    if (closed || owners.get(owner.sender.id) !== owner || owner.unavailable) return;
    for (const slot of owner.slots) {
      if (slot.job || slot.stopping) continue;
      let job;
      while ((job = owner.queue.shift())) {
        if (valid(owner, job)) break;
        settle(job, { cancelled: true }); job = null;
      }
      if (!job) break;
      clearTimeout(slot.idle); slot.idle = null;
      slot.job = job;
      try {
        const proc = worker(owner, slot);
        slot.timer = setTimeout(() => { if (slot.job === job) failed(owner, slot, 'Figure raster worker timed out'); }, timeoutMs);
        // The model/inline assets exceed the protocol's small metadata bound.
        writeFrame(proc.stdin, { rid: job.request.rid }, JSON.stringify(job.request));
      } catch (error) { failed(owner, slot, `Figure raster worker failed: ${error.message}`); }
    }
  }
  function ownerFor(event) {
    let owner = owners.get(event.sender.id);
    if (!owner) {
      owner = { sender: event.sender, queue: [], slots: Array.from({ length: workers }, () => ({ proc: null, job: null, timer: null, idle: null, stopping: false })), deaths: [], unavailable: false, onDestroyed: () => cancelOwner(event.sender.id) };
      owners.set(event.sender.id, owner); event.sender.once('destroyed', owner.onDestroyed);
    }
    return owner;
  }
  function rasterize(event, request) {
    if (closed || event.sender.isDestroyed()) return Promise.resolve({ cancelled: true });
    let checked;
    try { checked = validateFigureRequest(request, rootFor(event)); } catch (error) { return Promise.resolve({ error: error.message }); }
    const owner = ownerFor(event);
    if (owner.unavailable) return Promise.resolve({ error: 'Figure raster worker unavailable' });
    return new Promise(resolve => {
      // rid is an owner-scoped cancellation token; accepting duplicates would
      // make an explicit cancel ambiguous, including across distinct figures.
      if (owner.queue.some(j => j.request.rid === checked.rid) || owner.slots.some(s => s.job?.request.rid === checked.rid)) { resolve({ error: 'Duplicate figure raster identity' }); return; }
      const job = { request: checked, event, generation: generationFor(event), resolve, done: false };
      const at = owner.queue.findIndex(j => j.request.figure.id === checked.figure.id);
      if (at < 0) owner.queue.push(job);
      else { settle(owner.queue[at], { cancelled: true }); owner.queue[at] = job; }
      pump(owner);
    });
  }
  function cancel(event, rid) {
    const owner = owners.get(event.sender.id); if (!owner || typeof rid !== 'string') return;
    owner.queue = owner.queue.filter(job => { if (job.request.rid !== rid) return true; settle(job, { cancelled: true }); return false; });
    for (const slot of owner.slots) if (slot.job?.request.rid === rid) {
      settle(slot.job, { cancelled: true }); slot.job = null; stop(slot);
    }
    pump(owner);
  }
  return {
    registerHandlers(ipc) { ipc.handle('figure:rasterize', rasterize); ipc.handle('figure:cancelRaster', (event, rid) => cancel(event, rid)); },
    cancelOwner,
    shutdown() { closed = true; for (const id of [...owners.keys()]) cancelOwner(id); },
  };
}
module.exports = { createFigureRasterFamily };
