"use strict";
// Dedicated process: no editor config, launcher, migration, project grants or locks.
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const KEY = /^m3d-[a-f0-9]{14}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function deadline(promise, label, signal, ms = 60000) {
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(new Error("3D poster rendering cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      if (signal.aborted) abort();
    })]);
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
}

function validateJob(job, directory) {
  if (!job || job.version !== 1 || !Array.isArray(job.requests) || !job.requests.length || job.requests.length > 64)
    throw new Error("Invalid 3D poster job");
  if (job.html !== path.join(directory, "poster.html")) throw new Error("Invalid poster HTML path");
  const keys = new Set();
  for (const request of job.requests) {
    if (!request || !KEY.test(request.key) || keys.has(request.key)) throw new Error("Invalid or duplicate poster key");
    keys.add(request.key);
    if (![request.w, request.h].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error("Invalid poster dimensions");
  }
}

async function renderPosters(job, directory, { BrowserWindow, session }, signal, progress = () => {}) {
  validateJob(job, directory);
  // Resolve before opening: even a caller-created symlink cannot expand the allowlist.
  if (await fs.realpath(job.html) !== job.html) throw new Error("Poster HTML must be a regular scratch file");
  const ses = session.fromPartition(`model3d-poster-${process.pid}`);
  const url = pathToFileURL(job.html).href;
  const denied = [];
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allow = details.url === url || /^(data|blob):/.test(details.url);
    if (!allow) denied.push(details.url);
    callback({ cancel: !allow });
  });
  let win;
  const pageCall = async (expression, label) => {
    const response = await deadline(win.webContents.executeJavaScript(`Promise.resolve().then(() => ${expression}).then(value => ({value}), error => ({error: String(error?.stack || error)}))`), label, signal);
    if (response?.error) throw new Error(`${label}: ${response.error}`);
    return response?.value;
  };
  const abort = () => { if (win && !win.isDestroyed()) win.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("3D poster rendering cancelled");
    win = new BrowserWindow({ show: false, width: 64, height: 64,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
        offscreen: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, next) => { if (next !== url) event.preventDefault(); });
    await deadline(win.loadFile(job.html), "Loading 3D poster runtime", signal);
    const ready = await pageCall("window.fluxModel3dPosterReady", "Preparing 3D models");
    if (!ready?.renderer) throw new Error("3D poster runtime did not report WebGL2 readiness");
    progress({ phase: "ready", renderer: ready.renderer, readyMs: ready.readyMs });
    const output = path.join(directory, "posters");
    await fs.mkdir(output, { recursive: true });
    const results = [];
    for (let index = 0; index < job.requests.length; index++) {
      const request = job.requests[index];
      const result = await pageCall(`window.fluxModel3dPoster.render(${index})`, `Rendering ${request.key}`);
      if (signal.aborted) throw new Error("3D poster rendering cancelled");
      if (!result || typeof result.png !== "string" || result.png.length > 360 * 1024 * 1024)
        throw new Error("Invalid poster PNG response");
      const bytes = Buffer.from(result.png, "base64");
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(16) !== request.w || bytes.readUInt32BE(20) !== request.h)
        throw new Error("Poster PNG dimensions or signature disagree with request");
      const file = await fs.open(path.join(output, `${request.key}.png`), "wx");
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      results.push({ key: request.key, w: request.w, h: request.h, bytes: bytes.length, ...result.metrics });
      progress({ phase: "rendering", done: index + 1, total: job.requests.length });
    }
    if (denied.length) throw new Error(`Poster runtime attempted a forbidden resource (${denied.length})`);
    return { renderer: ready.renderer, readyMs: ready.readyMs, results };
  } finally {
    signal.removeEventListener("abort", abort); abort();
    ses.webRequest.onBeforeRequest(null);
  }
}
module.exports = { renderPosters, validateJob };

if (process.env.FLUX_MODEL3D_POSTER_WORKER === "1") {
  const { app, BrowserWindow, session } = require("electron");
  const controller = new AbortController();
  process.stdin.on("data", () => controller.abort());
  process.stdin.on("end", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  const emit = message => process.stdout.write(`FLUX_MODEL3D ${JSON.stringify(message)}\n`);
  // A worker decides when it exits. Electron's default quits when the last window closes, so a
  // capture renderer that died (render-process-gone → window destroyed) ended the process with code 0
  // before the worker could report why (packaged video export under load, 2026-10-04).
  app.on("window-all-closed", () => {});
  // app.exit() does not wait for a piped stdout to drain: the final result/error line could be lost and
  // the parent saw a bare non-zero exit (packaged video export on CI, 2026-10-04). Exit once it is
  // written; an error also goes to stderr, which the parent includes in its message.
  const finish = (message, code) => {
    if (message.error) process.stderr.write(`[flux worker] ${message.error}\n`);
    const exit = () => app.exit(code), fallback = setTimeout(exit, 2000);
    process.stdout.write(`FLUX_MODEL3D ${JSON.stringify(message)}\n`, () => { clearTimeout(fallback); exit(); });
  };
  (async () => {
    const jobPath = await fs.realpath(process.env.FLUX_MODEL3D_POSTER_JOB);
    const directory = path.dirname(jobPath);
    const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
    validateJob(job, directory);
    app.setPath("userData", path.join(directory, "profile"));
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
    app.commandLine.appendSwitch("force-color-profile", "srgb");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    await deadline(app.whenReady(), "Starting 3D poster worker", controller.signal, 20000);
    app.dock?.hide();
    finish({ result: await renderPosters(job, directory, { BrowserWindow, session }, controller.signal, emit) }, 0);
  })().catch(error => finish({ error: String(error.message || error), cancelled: controller.signal.aborted }, 1));
}
