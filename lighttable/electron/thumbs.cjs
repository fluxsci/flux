"use strict";
// Thumbnail cache — the heart of "fast". No Electron APIs at module scope: the
// cache dir is injected via initThumbs() so verify-node.mjs can run this
// against a temp dir without a display.
//
// Generation backends: in-process (plain Node — tests, CLI) or an Electron
// utilityProcess worker (the app). The worker exists because @napi-rs/canvas
// SEGFAULTS the Electron main process under burst load (found 2026-07-15
// flinging a 1500-image set); a utilityProcess is crash-isolated — if it dies
// it is respawned (bounded), outstanding jobs fall back to serving originals,
// and the app never goes down with it.
const fsp = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");
const { thumbKey, bucketFor, wantsThumb } = require("./lib/pure.cjs");
const { generateThumb } = require("./lib/thumbGen.cjs");

let cacheDir = null;

function initThumbs(dir) {
  cacheDir = dir;
  fss.mkdirSync(dir, { recursive: true });
}

function cacheRoot() {
  return cacheDir;
}

// ---- worker backend (Electron only) ------------------------------------------
const JOB_TIMEOUT_MS = 30000;
const MAX_RESPAWNS = 3;
let workerPath = null;
let worker = null;
let workerDead = false;
let respawns = 0;
let jobSeq = 0;
const jobs = new Map(); // id -> { resolve, reject, timer }

function useWorkerBackend(modulePath) {
  workerPath = modulePath;
  spawnWorker();
}

function spawnWorker() {
  const { utilityProcess } = require("electron");
  worker = utilityProcess.fork(workerPath, [], { serviceName: "lighttable-thumbs" });
  worker.on("message", (m) => {
    const j = jobs.get(m.id);
    if (!j) return;
    jobs.delete(m.id);
    clearTimeout(j.timer);
    if (m.ok) j.resolve(m.path);
    else j.reject(new Error(m.error));
  });
  worker.on("exit", () => {
    for (const j of jobs.values()) {
      clearTimeout(j.timer);
      j.reject(new Error("thumb worker exited"));
    }
    jobs.clear();
    worker = null;
    if (respawns < MAX_RESPAWNS) {
      respawns++;
      console.warn(`lighttable: thumb worker exited; respawning (${respawns}/${MAX_RESPAWNS})`);
      spawnWorker();
    } else {
      workerDead = true;
      console.warn("lighttable: thumb worker kept dying; serving originals from here on");
    }
  });
}

function generate(src, px, out) {
  if (!workerPath) return generateThumb(src, px, out); // in-process (plain Node)
  if (!worker || workerDead) return Promise.reject(new Error("thumb worker unavailable"));
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error("thumb job timed out"));
    }, JOB_TIMEOUT_MS);
    jobs.set(id, { resolve, reject, timer });
    worker.postMessage({ id, src, px, out });
  });
}

// ---- ensureThumb --------------------------------------------------------------
const inflight = new Map(); // cache path -> Promise<abs path>
const warnedOnce = new Set(); // one log line per failing source, not a flood

// Ensure a thumbnail for `srcAbs` at bucket >= pxWanted exists; returns the
// absolute path to serve (the cached webp, or the ORIGINAL on any fallback:
// svg/gif by design, undecodable bytes, worker trouble, fs races).
// Robustness over purity — a broken image must never break the grid.
async function ensureThumb(srcAbs, pxWanted) {
  if (!cacheDir) throw new Error("thumbs: initThumbs() not called");
  if (!wantsThumb(srcAbs)) return srcAbs;
  let st;
  try {
    st = await fsp.stat(srcAbs);
  } catch {
    return srcAbs;
  }
  const px = bucketFor(pxWanted);
  const out = path.join(cacheDir, thumbKey(srcAbs, st.mtimeMs, st.size, px) + ".webp");
  try {
    await fsp.access(out);
    fsp.utimes(out, new Date(), new Date()).catch(() => {}); // LRU touch, best-effort
    return out;
  } catch {}
  let p = inflight.get(out);
  if (!p) {
    p = generate(srcAbs, px, out)
      .catch((e) => {
        if (!warnedOnce.has(srcAbs)) {
          warnedOnce.add(srcAbs);
          console.warn(`lighttable: thumbnail failed for ${srcAbs} (${e.message}); serving original`);
        }
        return srcAbs;
      })
      .finally(() => inflight.delete(out));
    inflight.set(out, p);
  }
  return p;
}

// Best-effort startup sweep: if the cache exceeds maxBytes, delete
// least-recently-used files down to targetBytes. Never throws.
async function sweepCache(maxBytes = 512 * 1024 * 1024, targetBytes = 256 * 1024 * 1024) {
  if (!cacheDir) return;
  try {
    const names = await fsp.readdir(cacheDir);
    let total = 0;
    const files = [];
    for (const name of names) {
      try {
        const p = path.join(cacheDir, name);
        const st = await fsp.stat(p);
        if (st.isFile()) {
          total += st.size;
          files.push({ p, size: st.size, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
    if (total <= maxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= targetBytes) break;
      try {
        await fsp.unlink(f.p);
        total -= f.size;
      } catch {}
    }
  } catch {}
}

module.exports = { initThumbs, cacheRoot, ensureThumb, sweepCache, useWorkerBackend };
