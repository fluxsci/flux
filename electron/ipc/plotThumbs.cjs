"use strict";
// The Plots rail's main-process family: plot listing, header probes, thumbnails and dissection
// counts. The raster work and the tree walk run in a long-lived Node child
// (electron/plotThumbWorker.mjs, ELECTRON_RUN_AS_NODE — the slide-video / flux-core resvg process
// model); this file only supervises it, contains every path to the requesting window's project
// plots/ or the global plot library, and serves warm thumbnails straight from the disk cache
// (a cache hit is two small reads — no worker round trip, no raster work in main).
//
// Supervision: a render that crashes the worker or runs past THUMB_TIMEOUT_MS gets its file
// QUARANTINED (by size + mtime, in the worker's per-root index — retried only once the file
// changes) and the worker respawns; queued requests are re-sent. More than MAX_RESPAWNS deaths
// inside RESPAWN_WINDOW_MS switch the family to fallback: thumbnails answer
// { unavailable: true } and the renderer draws tiles itself.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const THUMB_TIMEOUT_MS = 20000;
const MAX_RESPAWNS = 3;
const RESPAWN_WINDOW_MS = 10 * 60 * 1000;
const BUCKETS = new Set([256, 512, 1024]);
const ACCEPT_RE = /^[a-z0-9]{2,5}(,[a-z0-9]{2,5}){0,7}$/;

function createPlotThumbsFamily({ app, appRoot, rootFor, libraryRoot, cacheDir, fontIndexFile, fsReadGuard, log = () => {} }) {
  const here = path.join(appRoot, "electron");
  let engineMod = null, foldersMod = null, dissectMod = null;
  const loadEngine = () => (engineMod ??= import(pathToFileURL(path.join(here, "plotThumbEngine.mjs")).href));
  const loadFolders = () => (foldersMod ??= import(pathToFileURL(path.join(here, "plotsFolders.js")).href));
  const loadDissect = () => (dissectMod ??= import(pathToFileURL(path.join(here, "dissectRules.js")).href));

  // ------------------------------------------------------------------ the worker
  let child = null;
  let nextId = 1;
  let unavailable = false;
  let deaths = [];
  let started = null; // id of the render in progress (the culprit if the worker dies)
  let startedTimer = null;
  const pending = new Map(); // id → { msg, resolve, sender, rid }

  function workerRoot() { return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : appRoot; }

  function spawnWorker() {
    const root = workerRoot();
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      FLUX_THUMB_CACHE: cacheDir(),
      // Electron-as-Node cannot read asar: resvg and the font resolver resolve beside the
      // unpacked worker (electron-builder asarUnpack keeps @resvg and fontFiles.mjs on disk).
      FLUX_RESVG_FROM: pathToFileURL(path.join(root, "package.json")).href,
      FLUX_FONTFILES_MODULE: pathToFileURL(path.join(root, "src", "lib", "text", "fontFiles.mjs")).href,
      FLUX_FONT_INDEX: fontIndexFile(),
    };
    const proc = spawn(process.execPath, [path.join(root, "electron", "plotThumbWorker.mjs")], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let errTail = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.started != null) { markStarted(msg.started); continue; }
        const job = pending.get(msg.id);
        if (!job) continue;
        if (started === msg.id) markStarted(null);
        pending.delete(msg.id);
        job.resolve(msg.ok ? { result: msg.result } : { error: msg.error, cancelled: !!msg.cancelled });
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { errTail = (errTail + chunk).slice(-4000); });
    proc.stdin.on("error", () => {}); // a dead child is reported by "exit"
    proc.on("error", (err) => log("plot thumbnail worker failed to start", String(err?.message ?? err)));
    proc.on("exit", (code, signal) => {
      if (child !== proc) return; // a deliberate shutdown
      child = null;
      const culprit = started;
      markStarted(null);
      log("plot thumbnail worker exited", `${code ?? signal}${errTail ? `: ${errTail.trim().split("\n").pop()}` : ""}`);
      onDeath(culprit, signal === "SIGKILL" ? "preview timed out" : "preview crashed the renderer");
    });
    return proc;
  }

  function markStarted(id) {
    started = id;
    if (startedTimer) { clearTimeout(startedTimer); startedTimer = null; }
    if (id != null) startedTimer = setTimeout(() => { if (started === id && child) child.kill("SIGKILL"); }, THUMB_TIMEOUT_MS);
  }

  function onDeath(culprit, reason) {
    const now = Date.now();
    deaths = deaths.filter((t) => now - t < RESPAWN_WINDOW_MS);
    deaths.push(now);
    const culpritJob = culprit != null ? pending.get(culprit) : null;
    if (culpritJob) {
      pending.delete(culprit);
      culpritJob.resolve({ error: reason, quarantined: true });
    }
    if (deaths.length > MAX_RESPAWNS) {
      unavailable = true;
      log("plot thumbnails switched to the fallback renderer", `${deaths.length} worker deaths in ${RESPAWN_WINDOW_MS / 60000} min`);
      for (const [id, job] of pending) { pending.delete(id); job.resolve({ error: "unavailable", unavailable: true }); }
      return;
    }
    // Respawn, quarantine the culprit first, then re-send everything still outstanding.
    const proc = ensureWorker();
    if (!proc) return;
    if (culpritJob?.msg?.op === "thumb") {
      const id = nextId++;
      pending.set(id, { msg: { op: "quarantine", path: culpritJob.msg.path, indexRoot: culpritJob.msg.indexRoot, reason }, resolve: () => {} });
      write(proc, { id, op: "quarantine", path: culpritJob.msg.path, indexRoot: culpritJob.msg.indexRoot, reason });
    }
    for (const [id, job] of pending) if (job.msg.op !== "quarantine") write(proc, { id, ...job.msg });
  }

  function ensureWorker() {
    if (unavailable) return null;
    if (!child) {
      try { child = spawnWorker(); } catch (e) { log("plot thumbnail worker failed to start", String(e?.message ?? e)); unavailable = true; return null; }
    }
    return child;
  }

  function write(proc, msg) {
    try { proc.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* exit handler re-sends */ }
  }

  /** Send one request; resolves { result } | { error, … } — never rejects. */
  function call(msg, extra = {}, id = nextId++) {
    return new Promise((resolve) => {
      const proc = ensureWorker();
      if (!proc) { resolve({ error: "unavailable", unavailable: true }); return; }
      pending.set(id, { msg, resolve, ...extra });
      write(proc, { id, ...msg });
    });
  }

  function shutdown() {
    const proc = child;
    child = null;
    markStarted(null);
    if (proc) { try { proc.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 3000).unref(); }
    for (const [id, job] of pending) { pending.delete(id); job.resolve({ error: "shutting down", cancelled: true }); }
  }

  // ------------------------------------------------------------------ containment
  /** The base a path belongs to (project plots/ or the library), or null. */
  function baseFor(e, abs) {
    if (typeof abs !== "string" || !path.isAbsolute(abs) || abs.includes("\0") || path.resolve(abs) !== path.normalize(abs)) return null;
    const root = rootFor(e);
    const bases = [root ? path.join(root, "plots") : "", libraryRoot() || ""].filter(Boolean);
    for (const base of bases) if (abs === base || abs.startsWith(base + path.sep)) return base;
    return null;
  }
  function guard(e, abs) {
    const base = baseFor(e, abs);
    if (!base) throw new Error("Thumbnails are limited to this project's plots folder and the global plot library");
    fsReadGuard(abs, e.sender.id);
    return base;
  }

  // ------------------------------------------------------------------ handlers
  const senderJobs = new Map(); // senderId → Map(rid → workerId)

  function registerHandlers(ipcMain) {
    ipcMain.handle("plots:list", async (e, request) => {
      const scope = request?.scope === "global" ? "global" : "project";
      const root = rootFor(e);
      const scopeBase = scope === "global" ? libraryRoot() : root ? path.join(root, "plots") : "";
      if (!scopeBase) return { base: "", entries: [], truncated: false };
      const { RESERVED_PLOT_DIRNAMES } = await loadFolders();
      // A reserved collection (typing "_" in the rail): list INSIDE it, nothing pruned there.
      const collection = typeof request?.collection === "string" && RESERVED_PLOT_DIRNAMES.includes(request.collection) ? request.collection : "";
      const base = collection ? path.join(scopeBase, collection) : scopeBase;
      const accept = typeof request?.accept === "string" && ACCEPT_RE.test(request.accept) ? request.accept : "svg,png";
      try { await fs.promises.access(base); } catch { return { base, entries: [], truncated: false }; }
      fsReadGuard(base, e.sender.id);
      const dirs = Array.isArray(request?.dirs) ? request.dirs.filter((d) => typeof d === "string" && path.isAbsolute(d) && (d === base || d.startsWith(base + path.sep))).slice(0, 2000) : null;
      const reply = await call({ op: "list", base, reserved: collection ? [] : RESERVED_PLOT_DIRNAMES, accept, indexRoot: scopeBase, dirs });
      if (reply.error) return { base, entries: [], truncated: false, error: reply.error, unavailable: !!reply.unavailable };
      // The project may have changed while the walk ran.
      if (scope === "project" && rootFor(e) !== root) return { base, entries: [], truncated: false, stale: true };
      return { base, entries: reply.result.entries, truncated: reply.result.truncated, missing: reply.result.missing ?? [] };
    });

    ipcMain.handle("plots:probe", async (e, paths) => {
      if (!Array.isArray(paths) || paths.length > 5000) throw new Error("Invalid probe request");
      const byBase = new Map();
      for (const p of paths) {
        let base;
        try { base = guard(e, p); } catch { continue; }
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(p);
      }
      const out = [];
      for (const [base, list] of byBase) {
        const reply = await call({ op: "probe", paths: list, indexRoot: base });
        if (!reply.error) out.push(...reply.result);
      }
      return out;
    });

    ipcMain.handle("thumbs:get", async (e, request) => {
      const abs = request?.path;
      const bucket = BUCKETS.has(request?.bucket) ? request.bucket : 512;
      const base = guard(e, abs);
      const rid = typeof request?.rid === "string" && request.rid.length < 64 ? request.rid : null;
      // Warm: straight from the disk cache.
      try {
        const { cachedThumb } = await loadEngine();
        const hit = await cachedThumb(cacheDir(), abs, bucket);
        if (hit) return { ...hit, bytes: await fs.promises.readFile(hit.path) };
      } catch { /* fall through to the worker */ }
      if (unavailable) return { error: "unavailable", unavailable: true };
      const senderId = e.sender.id;
      const priority = Number.isFinite(request?.priority) ? request.priority : 0;
      let jobs = senderJobs.get(senderId);
      if (!jobs) {
        senderJobs.set(senderId, (jobs = new Map()));
        e.sender.once("destroyed", () => {
          const ids = [...(senderJobs.get(senderId)?.values() ?? [])];
          senderJobs.delete(senderId);
          if (ids.length && child) void call({ op: "cancel", ids });
        });
      }
      const id = nextId++;
      if (rid) jobs.set(rid, id);
      const reply = await call({ op: "thumb", path: abs, bucket, roots: [base], indexRoot: base, priority }, { sender: senderId, rid }, id);
      if (rid) jobs.delete(rid);
      if (reply.error) return { error: reply.error, cancelled: !!reply.cancelled, quarantined: !!reply.quarantined, unavailable: !!reply.unavailable };
      const r = reply.result;
      if (!r || r.error) return { error: r?.error ?? "no preview", quarantined: !!r?.quarantined, tooLarge: !!r?.tooLarge, unsupported: !!r?.unsupported };
      try { return { ...r, bytes: await fs.promises.readFile(r.path) }; }
      catch { return { error: "preview vanished" }; }
    });

    ipcMain.handle("thumbs:cancel", async (e, rids) => {
      if (!Array.isArray(rids)) return;
      const jobs = senderJobs.get(e.sender.id);
      if (!jobs || !child) return;
      const ids = rids.map((r) => jobs.get(r)).filter((id) => id != null);
      if (ids.length) await call({ op: "cancel", ids });
    });

    ipcMain.handle("dissect:counts", async (e, keys) => {
      const root = rootFor(e);
      if (!root || !Array.isArray(keys) || keys.length > 5000) return {};
      const { DISSECT_REL, dissectionRootRelFor, classifyDissectionFile } = await loadDissect();
      const plotsBase = path.join(root, "plots");
      const out = {};
      await Promise.all(keys.map(async (key) => {
        if (typeof key !== "string" || !key || key.length > 1024 || key.split("/").some((s) => !s || s === "." || s === "..")) return;
        const dir = path.join(plotsBase, dissectionRootRelFor(key));
        // DISSECT_REL is plots/_dissections — the folder never leaves the project's plots/.
        if (!dir.startsWith(path.join(root, DISSECT_REL) + path.sep)) return;
        let top;
        try { top = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        let n = top.filter((d) => d.isFile() && classifyDissectionFile(d.name) !== "sidecar").length;
        for (const d of top.filter((x) => x.isDirectory())) {
          try { n += (await fs.promises.readdir(path.join(dir, d.name), { withFileTypes: true })).filter((f) => f.isFile() && classifyDissectionFile(f.name) !== "sidecar").length; }
          catch { /* unreadable group */ }
        }
        out[key] = n;
      }));
      return out;
    });
  }

  return { registerHandlers, shutdown, _state: () => ({ unavailable, deaths: deaths.length, pending: pending.size, running: !!child }) };
}

module.exports = { createPlotThumbsFamily };
