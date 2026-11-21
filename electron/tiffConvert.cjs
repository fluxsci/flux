"use strict";
// The supervisor of one TIFF conversion child (electron/tiffWorker.mjs, bundled): spawn on Electron's own Node,
// requests by id over JSON lines, progress, cancel, crash and idle. No Electron here: the IPC family
// (electron/ipc/tiff.cjs), the dev server's route (scripts/lib/tiffDevRoutes.mjs) and the gates all use it.
//
// Cancel is a message first (the converter stops between planes and removes its own staging folder), then, if the
// job has not ended after `graceMs`, the child is killed. A killed or crashed child settles every request it held
// with an error; the next request starts a new child. Staging folders a killed child leaves behind are removed by
// the caller (`removeStaging`), which knows where it asked the child to write.
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const GRACE_MS = 3000;
const IDLE_MS = 60000;

/** The bundle's path: on real disk beside app.asar when packaged (a Node-mode child cannot read asar). */
function tiffWorkerPath({ app, appRoot }) {
  const root = app?.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : appRoot;
  return { root, file: path.join(root, "electron", "generated", "tiffWorker.bundle.mjs") };
}

function createTiffConverter({ workerFile, cwd, execPath = process.execPath, spawnProcess = spawn, graceMs = GRACE_MS, idleMs = IDLE_MS, maxOldSpaceMb = 2048, threads = 8, env = {} }) {
  let child = null, nextId = 1, idleTimer = null, closed = false;
  const pending = new Map(); // id → { resolve, reject, onProgress, killTimer, cancelled }

  function settleAll(proc, message) {
    for (const [id, job] of pending) {
      if (job.proc !== proc) continue;
      pending.delete(id); clearTimeout(job.killTimer);
      job.reject(job.cancelled ? cancelledError() : Object.assign(new Error(message), { code: "stopped" }));
    }
  }
  function start() {
    if (child) return child;
    const proc = spawnProcess(execPath, [`--max-old-space-size=${maxOldSpaceMb}`, workerFile], {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      // Compression runs on the libuv pool: its size is read once, when the process starts.
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: String(threads) },
    });
    child = proc;
    let buf = "", errTail = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      for (let nl; (nl = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const job = pending.get(msg.id);
        if (!job || job.proc !== proc) continue;
        if (msg.progress) { try { job.onProgress?.(msg.progress); } catch { /* a listener's failure is not the job's */ } continue; }
        pending.delete(msg.id); clearTimeout(job.killTimer);
        if (msg.ok) job.resolve(msg.result);
        else job.reject(msg.cancelled || job.cancelled ? cancelledError() : Object.assign(new Error(msg.error || "conversion failed"), msg.code ? { code: msg.code } : {}));
        armIdle();
      }
    });
    proc.stderr.on("data", (chunk) => { errTail = (errTail + chunk).slice(-2000); });
    proc.stdin.on("error", () => {});
    const gone = (why) => {
      if (child === proc) child = null;
      settleAll(proc, `${why}${errTail.trim() ? `: ${errTail.trim().split("\n").at(-1)}` : ""}`);
    };
    proc.on("error", (error) => gone(error.message));
    proc.on("exit", (code, signal) => gone(signal ? `killed by ${signal}` : `exit code ${code}`));
    return proc;
  }
  function armIdle() {
    clearTimeout(idleTimer); idleTimer = null;
    if (!child || pending.size || !(idleMs > 0)) return;
    idleTimer = setTimeout(() => { if (!pending.size && child) { const p = child; child = null; p.stdin.end(); } }, idleMs);
    idleTimer.unref?.();
  }
  /** Send `op` with `payload`; resolves with the child's result. Returns the request id beside the promise. */
  function request(op, payload, { onProgress } = {}) {
    if (closed) return { id: 0, promise: Promise.reject(new Error("The image converter is closed")) };
    clearTimeout(idleTimer); idleTimer = null;
    const id = nextId++;
    let proc;
    const promise = new Promise((resolve, reject) => {
      try { proc = start(); } catch (error) { reject(error); return; }
      pending.set(id, { resolve, reject, onProgress, killTimer: null, cancelled: false, proc });
      proc.stdin.write(JSON.stringify({ id, op, ...payload }) + "\n");
    });
    return { id, promise };
  }
  /** Ask the job to stop; kill the child if it has not stopped after the grace period. */
  function cancel(id) {
    const job = pending.get(id);
    if (!job) return false;
    job.cancelled = true;
    try { job.proc.stdin.write(JSON.stringify({ op: "cancel", target: id }) + "\n"); } catch { /* the kill below covers it */ }
    job.killTimer = setTimeout(() => { if (pending.get(id) === job) kill(job.proc); }, graceMs);
    return true;
  }
  function kill(proc = child) {
    if (!proc) return;
    if (child === proc) child = null;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
  return {
    request, cancel, kill: () => kill(),
    get pid() { return child?.pid ?? null; },
    get busy() { return pending.size > 0; },
    close() { closed = true; clearTimeout(idleTimer); for (const job of pending.values()) job.cancelled = true; const p = child; child = null; if (p) { try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, graceMs).unref?.(); } },
  };
}

const cancelledError = () => Object.assign(new Error("The TIFF conversion was cancelled"), { name: "AbortError", code: "cancelled" });

/**
 * Remove what a conversion into `out` may have left: `out` itself and the converter's own staging siblings
 * (`.<basename(out)>.tmp-<uuid>`). Only names that start with that unique prefix are touched.
 */
async function removeStaging(out) {
  const dir = path.dirname(out), base = path.basename(out);
  const names = await fs.promises.readdir(dir).catch(() => []);
  for (const n of names) if (n === base || n.startsWith(`.${base}.tmp-`)) await fs.promises.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {});
}

module.exports = { createTiffConverter, tiffWorkerPath, removeStaging, cancelledError, GRACE_MS };
