"use strict";
// tiff:* — a TIFF becomes an image bundle in the requesting window's project (fluximg stage 2, plan D11).
//
// The work runs in a supervised child (electron/tiffConvert.cjs → electron/generated/tiffWorker.bundle.mjs): only a
// probe, small PNG previews and progress cross IPC. This family adds what fluximg:import adds to a bundle copy:
//   * the request's root must be the window's open project, and the project must not change (switch, reopen: the
//     watch generation) while a probe or a conversion runs;
//   * a path named by the renderer needs the window's read capability (fsReadGuard: a dialog's approval or a path
//     inside the project); a DROP is its own capability (tiff:probeDropped is reached only through the preload,
//     which takes the path from the dropped File);
//   * a probed file becomes a TOKEN of this window: previews and conversions name the token, never a path again;
//   * the child writes into a hidden staging folder under fig/assets; this family publishes it by ONE rename to
//     fig/assets/<id>.fluximg after checking the project is still the one asked for. A cancel, a crash of the
//     child, a closed window or a project switch removes the staging folder: no half bundle ever survives;
//   * one conversion at a time per window: a second one queues (its progress says so);
//   * progress reaches the window at most ten times a second.
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const fluximgFiles = require("../fluximgFiles.cjs");
const { createTiffConverter, tiffWorkerPath, removeStaging, cancelledError } = require("../tiffConvert.cjs");

const PROGRESS_MS = 100;
const MAX_TOKENS = 64;

const contained = (dir, file) => { const rel = path.relative(dir, file); return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

function createTiffFamily({ app, appRoot, rootFor, generationFor = () => 0, fsReadGuard, globalRulesFile = () => null, makeConverter, progressMs = PROGRESS_MS }) {
  const owners = new Map();
  let rulesMod = null;
  const R = () => (rulesMod ??= fluximgFiles.loadRules());
  const newConverter = makeConverter ?? (() => { const w = tiffWorkerPath({ app, appRoot }); return createTiffConverter({ workerFile: w.file, cwd: w.root }); });

  function ownerFor(e) {
    let o = owners.get(e.sender.id);
    if (!o) {
      o = { sender: e.sender, converter: null, tokens: new Map(), queue: [], running: null, onDestroyed: () => dropOwner(e.sender.id) };
      owners.set(e.sender.id, o);
      e.sender.once?.("destroyed", o.onDestroyed);
    }
    return o;
  }
  const converterOf = (o) => (o.converter ??= newConverter());

  /** The window's project now, and a check that it is still the one the request named (throws in the shared words). */
  async function bind(e, request) {
    const rules = await R();
    const root = rootFor(e), generation = generationFor(e);
    const checkCurrent = () => {
      if (!root || request?.root !== root || e.sender.isDestroyed() || rootFor(e) !== root || generationFor(e) !== generation) throw new Error(rules.fluximgErrors.projectChanged());
    };
    checkCurrent();
    return { rules, root, generation, checkCurrent };
  }

  /** Resolve and check a TIFF path the way importBundle resolves a bundle folder. */
  async function resolveSource(rules, root, sourcePath, readGuard) {
    rules.tiffSourcePath(sourcePath);
    const realRoot = await fs.promises.realpath(root).catch(() => { throw new Error(rules.fluximgErrors.root()); });
    const relative = !path.isAbsolute(sourcePath);
    const source = path.resolve(root, sourcePath);
    const inside = source === root || contained(root, source);
    if (relative && !inside) throw new Error(rules.tiffErrors.sourceEscapes());
    await readGuard(source);
    const real = await fs.promises.realpath(source).catch((error) => { throw error.code === "ENOENT" ? new Error(rules.tiffErrors.missing(sourcePath)) : error; });
    if (inside && !contained(realRoot, real)) throw new Error(rules.tiffErrors.sourceSymlinkEscapes());
    await readGuard(real);
    const st = await fs.promises.stat(real);
    if (!st.isFile()) throw new Error(rules.tiffErrors.notFile(path.basename(source)));
    // What the placed element records: project-relative inside the project, else the path as given.
    const record = inside ? path.relative(root, source).split(path.sep).join("/") : source;
    return { real, label: path.basename(source), record, inside };
  }

  function cleanRules(rules, list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, rules.TIFF_MAX_RULES).filter((r) => r && typeof r === "object" && r.rule === 1 && typeof r.fingerprint === "string" && r.answer && typeof r.answer === "object")
      .map((r) => ({ rule: 1, fingerprint: r.fingerprint, answer: r.answer }));
  }

  async function probe(e, request, readGuard) {
    const { rules, root, checkCurrent } = await bind(e, request);
    const src = await resolveSource(rules, root, request?.sourcePath, readGuard);
    const o = ownerFor(e);
    const max = Number.isFinite(request?.max) ? Math.max(16, Math.min(512, request.max)) : 256;
    const result = await converterOf(o).request("probe", { path: src.real, rules: cleanRules(rules, request?.rules), max }).promise;
    checkCurrent();
    const token = randomUUID().replace(/-/g, "");
    o.tokens.set(token, { path: src.real, root, label: src.label, record: src.record, inside: src.inside });
    while (o.tokens.size > MAX_TOKENS) o.tokens.delete(o.tokens.keys().next().value);
    return { token, name: src.label, sourcePath: src.record, external: !src.inside, ...result };
  }

  function tokenOf(o, rules, root, token) {
    const t = typeof token === "string" ? o?.tokens.get(token) : undefined;
    if (!t || t.root !== root) throw new Error(rules.tiffErrors.token());
    return t;
  }
  function checkAnswer(rules, answer) {
    if (!answer || typeof answer !== "object" || !Array.isArray(answer.dims)) throw new Error(rules.tiffErrors.answer());
    return answer;
  }

  async function preview(e, request) {
    const { rules, root, checkCurrent } = await bind(e, request);
    const o = owners.get(e.sender.id);
    const t = tokenOf(o, rules, root, request?.token);
    const max = Number.isFinite(request?.max) ? Math.max(16, Math.min(512, request.max)) : 256;
    const result = await converterOf(o).request("preview", { path: t.path, answer: checkAnswer(rules, request?.answer), max }).promise;
    checkCurrent();
    return result;
  }

  function push(o, msg) { if (!o.sender.isDestroyed()) o.sender.send("tiff:progress", msg); }

  async function convert(e, request) {
    const { rules, root, checkCurrent } = await bind(e, request);
    const o = ownerFor(e);
    const t = tokenOf(o, rules, root, request?.token);
    const answer = checkAnswer(rules, request?.answer);
    const id = rules.fluximgAssetId(request?.assetId);
    const jobId = rules.tiffJobId(request?.jobId);
    if (o.running?.jobId === jobId || o.queue.some((j) => j.jobId === jobId)) throw new Error(rules.tiffErrors.job());
    const job = { jobId, cancelled: false, run: null, staging: null, cancel: null };
    // One conversion at a time per window: wait for the one before (cancelled while waiting = never started).
    if (o.running) {
      push(o, { jobId, queued: o.queue.length + 1 });
      await new Promise((resolve, reject) => { job.run = resolve; job.cancel = reject; o.queue.push(job); });
    }
    o.running = job;
    try {
      if (job.cancelled) throw cancelledError();
      checkCurrent();
      const { realAssets } = await fluximgFiles.assetsLocation(root, rules, { create: true });
      const destination = path.join(realAssets, `${id}${rules.FLUXIMG_EXT}`);
      if (fs.existsSync(destination)) throw new Error(rules.fluximgErrors.exists(id));
      job.staging = path.join(realAssets, `.${id}${rules.FLUXIMG_EXT}.tiff-${randomUUID()}`);
      let last = 0, held = null, timer = null;
      const relay = (p) => {
        try { checkCurrent(); } catch { cancelJob(o, job); return; }
        const now = Date.now();
        if (now - last >= progressMs) { last = now; held = null; push(o, { jobId, ...p }); }
        else { held = p; if (!timer) timer = setTimeout(() => { timer = null; if (held && o.running === job) { last = Date.now(); push(o, { jobId, ...held }); held = null; } }, progressMs - (now - last)); }
      };
      const name = t.label.replace(/\.(ome\.)?tiff?$/i, "");
      const req = converterOf(o).request("convert", { path: t.path, answer, out: job.staging, name, sourcePath: t.inside ? t.record : t.label }, { onProgress: relay });
      job.requestId = req.id;
      if (job.cancelled) converterOf(o).cancel(req.id);
      let result;
      try { result = await req.promise; } finally { clearTimeout(timer); }
      if (job.cancelled) throw cancelledError();
      checkCurrent();
      if (fs.existsSync(destination)) throw new Error(rules.fluximgErrors.exists(id));
      await fs.promises.rename(job.staging, destination);
      job.staging = null;
      await fluximgFiles.syncDirectory(realAssets);
      return { path: rules.fluximgAssetPath(id), sha256: result.sha256, bytes: result.bytes, files: result.files, manifest: result.manifest, method: "convert", notes: result.notes, ms: result.ms, bytesRead: result.bytesRead };
    } catch (error) {
      if (job.staging) await removeStaging(job.staging);
      if (error?.code === "stopped") throw new Error(rules.tiffErrors.stopped(error.message));
      throw error?.name === "AbortError" ? cancelledError() : error;
    } finally {
      if (o.running === job) o.running = null;
      const next = o.queue.shift();
      if (next) next.run();
    }
  }

  function cancelJob(o, job) {
    if (job.cancelled) return;
    job.cancelled = true;
    const queued = o.queue.indexOf(job);
    if (queued >= 0) { o.queue.splice(queued, 1); job.cancel(cancelledError()); return; }
    if (job.requestId && o.converter) o.converter.cancel(job.requestId);
  }
  function cancel(e, jobId) {
    const o = owners.get(e.sender.id);
    if (!o || typeof jobId !== "string") return false;
    const job = o.running?.jobId === jobId ? o.running : o.queue.find((j) => j.jobId === jobId);
    if (!job) return false;
    cancelJob(o, job);
    return true;
  }

  /** A window closed or left its project: every job is cancelled (staging removed), every token forgotten. */
  function cancelOwner(id) {
    const o = owners.get(id);
    if (!o) return;
    o.tokens.clear();
    for (const job of [...o.queue]) cancelJob(o, job);
    if (o.running) cancelJob(o, o.running);
  }
  function dropOwner(id) {
    const o = owners.get(id);
    if (!o) return;
    cancelOwner(id);
    owners.delete(id);
    // The child ends once the cancelled conversion has cleaned up (stdin's end aborts what is left, then it exits).
    setTimeout(() => o.converter?.close(), 50);
  }

  // --- remembered answers for every project (FluxConfig) -------------------------------------------------------
  // A dumb list store, like the text-style library: what a rule is (and every check of one) is the renderer's pure
  // src/lib/tiff/remember.ts, which sanitizes what it reads and what it writes; here only the file and a size bound.
  async function readGlobalRules() {
    const file = globalRulesFile();
    if (!file) return [];
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return [];
      const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
      return Array.isArray(parsed?.rules) ? parsed.rules : [];
    } catch { return []; }
  }
  async function writeGlobalRules(rules) {
    const file = globalRulesFile();
    if (!file) throw new Error("There is no FluxConfig folder to remember answers in");
    const text = JSON.stringify({ schemaVersion: "0.1.0", rules: Array.isArray(rules) ? rules.slice(0, 200) : [] }, null, 2) + "\n";
    if (text.length > 4 * 1024 * 1024) throw new Error("Too many remembered answers to store");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
    return true;
  }

  function registerHandlers(ipcMain) {
    ipcMain.handle("tiff:probe", (e, request) => probe(e, request, (file) => fsReadGuard(file, e.sender.id)));
    // Reached only through importDroppedTiff(File) in the isolated preload, which takes the path from the dropped File
    // (webUtils), never from the page: the user's drop is the read capability, as for fluximg:importDropped.
    ipcMain.handle("tiff:probeDropped", (e, request) => probe(e, request, () => {}));
    ipcMain.handle("tiff:preview", (e, request) => preview(e, request));
    ipcMain.handle("tiff:convert", (e, request) => convert(e, request));
    ipcMain.handle("tiff:cancel", (e, jobId) => cancel(e, jobId));
    ipcMain.handle("tiff:release", (e, token) => { owners.get(e.sender.id)?.tokens.delete(token); });
    ipcMain.handle("tiff:rules", () => readGlobalRules());
    ipcMain.handle("tiff:setRules", (_e, rules) => writeGlobalRules(rules));
  }
  return {
    registerHandlers, cancelOwner,
    shutdown() { for (const id of [...owners.keys()]) dropOwner(id); },
    // For the gates: the child of a window, and the jobs it holds.
    _owner: (id) => owners.get(id),
  };
}

module.exports = { createTiffFamily };
