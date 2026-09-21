"use strict";
const { Worker } = require("node:worker_threads");
// One sequential resident worker per canonical library. Replacing a request
// kills a running old scan (including synchronous index work), then restarts.
// Completed queries retain their worker/index cache for subsequent queries.
function createFulltextService({ workerFile, root, timeoutMs = 120000, WorkerImpl = Worker }) {
  let worker = null, active = null, seq = 0, closed = false;
  const queue = [];
  const finish = (request, result) => { clearTimeout(request.timer); request.resolve(result); };
  let termination = Promise.resolve();
  function stopWorker() {
    const old = worker; worker = null;
    if (old) termination = Promise.all([termination, old.terminate().catch(() => {})]).then(() => {});
    return termination;
  }
  function pump() {
    if (closed || active || !queue.length) return;
    if (!worker) {
      let created;
      try { created = new WorkerImpl(workerFile, { workerData: { root }, execArgv: [] }); }
      catch(error) {
        finish(queue.shift(), {error: `Fulltext worker failed: ${String(error)}`});
        queueMicrotask(pump);
        return;
      }
      worker = created;
      created.on("message", message => {
        if (worker !== created || !active || message.id !== active.id) return;
        if (message.kind === "progress") {
          try { active.onProgress?.(message.progress); } catch { /* a disposed view cannot fail its worker */ }
          return;
        }
        const request = active; active = null;
        finish(request, message.error ? { error: message.error } : message.result); pump();
      });
      const failure = error => {
        if (worker !== created) return;
        stopWorker();
        if (active) { const request = active; active = null; finish(request, { error: `Fulltext worker failed: ${String(error)}` }); }
        pump();
      };
      created.on("error", failure);
      created.on("exit", code => { if (worker === created) failure(`exit ${code}`); });
    }
    active = queue.shift();
    try { worker.postMessage({ kind: "search", id: active.id, query: active.query, opts: active.opts }); }
    catch(error) {
      const request=active;active=null;stopWorker();
      finish(request,{error:`Fulltext worker failed: ${String(error)}`});
      queueMicrotask(pump);
    }
  }
  function cancelOwner(owner, reason = "Search superseded") {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].owner === owner) finish(queue.splice(i, 1)[0], { error: reason, cancelled: true });
    if (active?.owner === owner) { const request = active; active = null; stopWorker(); finish(request, { error: reason, cancelled: true }); }
    pump();
  }
  function search(owner, query, opts = {}, onProgress) {
    if (closed) return Promise.resolve({ error: "Fulltext service is closed" });
    if (typeof query !== "string" || query.length > 10000 || (opts.keys !== undefined && (!Array.isArray(opts.keys) || opts.keys.length > 20000 || opts.keys.some(k => typeof k !== "string")))) return Promise.resolve({ error: "Invalid fulltext search request" });
    cancelOwner(owner);
    if (queue.length >= 16) return Promise.resolve({ error: "Fulltext search queue is busy; retry shortly" });
    return new Promise(resolve => {
      const request = { id: ++seq, owner, query, opts: { ...opts, limit: Math.max(1, Math.min(5000, Number(opts.limit) || 50)) }, onProgress, resolve, timer: null };
      request.timer = setTimeout(() => cancelOwner(owner, "Fulltext search deadline exceeded"), timeoutMs); request.timer.unref?.();
      queue.push(request); pump();
    });
  }
  // Events are independent of renderer notification coalescing. A replacement
  // worker starts with a complete scan, so no dirty event can be lost on restart.
  function markDirty(relativePath = null) {
    if (!worker || closed) return;
    try { worker.postMessage({ kind: "dirty", path: relativePath }); }
    catch { if (active) cancelOwner(active.owner, "Fulltext worker disconnected"); else stopWorker(); }
  }
  function dispose() {
    closed = true; const stopped = stopWorker();
    if (active) { finish(active, { error: "Library changed", cancelled: true }); active = null; }
    while (queue.length) finish(queue.shift(), { error: "Library changed", cancelled: true });
    return stopped;
  }
  return { search, cancelOwner, markDirty, dispose, status: () => ({ resident: !!worker, active: !!active, queued: queue.length }) };
}
module.exports = { createFulltextService };
