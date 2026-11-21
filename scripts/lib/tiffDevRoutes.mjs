// The dev server's route to Node for TIFF conversion (vite.config.ts mounts it with `apply: "serve"`; the pure gate
// verify-tiff-app mounts the same handler on its own loopback server). The in-memory bridge (project/memBridge.ts)
// has no zstd ENCODER and no file system, so for the dev fixture and the GUI gates its TIFF twin hands the bytes
// here and gets back what the desktop app's child makes: the SAME supervised child (electron/tiffConvert.cjs →
// electron/generated/tiffWorker.bundle.mjs), the same probe, previews, progress and bundle, so the content id
// agrees with Electron's. No new dependency: Node's own http, fs and zlib.
//
//   POST /__flux-dev/tiff/stage      raw bytes, header x-flux-name     → {handle}
//   POST /__flux-dev/tiff/probe      {handle, rules?, max?}            → the child's probe
//   POST /__flux-dev/tiff/preview    {handle, answer, max?}            → the child's preview
//   POST /__flux-dev/tiff/convert    {handle, answer, name?, sourcePath?} → NDJSON: {progress}… then {ok, result: {…, contents: {rel: base64}}}
//                                    (closing the request cancels the conversion)
//   POST /__flux-dev/tiff/release    {handle}                          → {}
// Staged files and outputs live in one mkdtemp folder of this process, removed at exit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createTiffConverter, removeStaging } = require("../../electron/tiffConvert.cjs");
const MAX_STAGE = 8 * 1024 ** 3;

export function createTiffDevRoutes({ workerFile = path.join(repo, "electron/generated/tiffWorker.bundle.mjs") } = {}) {
  let scratch = null, converter = null;
  const handles = new Map();
  const dir = () => (scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "flux-dev-tiff-")));
  const conv = () => (converter ??= createTiffConverter({ workerFile, cwd: repo }));
  const json = (res, status, body) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
  const readJson = (req) => new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { text += c; if (text.length > 16 * 1024 * 1024) reject(new Error("request too large")); });
    req.on("end", () => { try { resolve(JSON.parse(text || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
  const fileOf = (handle) => { const h = handles.get(handle); if (!h) throw new Error("This TIFF is no longer open here: drop or choose it again"); return h; };

  async function stage(req, res) {
    const name = path.basename(String(req.headers["x-flux-name"] || "image.tif")).replace(/[^\w.\-]+/g, "_") || "image.tif";
    const handle = randomUUID();
    const folder = path.join(dir(), handle);
    fs.mkdirSync(folder);
    const file = path.join(folder, name);
    const out = fs.createWriteStream(file);
    let bytes = 0;
    await new Promise((resolve, reject) => {
      req.on("data", (c) => { bytes += c.length; if (bytes > MAX_STAGE) { req.destroy(); reject(new Error("file too large for the dev server")); } });
      req.pipe(out);
      out.on("finish", resolve); out.on("error", reject); req.on("error", reject);
    });
    // The converter records the source's mtime in the bundle's provenance: the bridge's, so the content id is the file's.
    const mtime = Number(req.headers["x-flux-mtime"]);
    if (Number.isFinite(mtime) && mtime > 0) fs.utimesSync(file, mtime / 1000, mtime / 1000);
    handles.set(handle, { file, folder });
    json(res, 200, { handle });
  }

  async function convert(req, res) {
    const body = await readJson(req);
    const h = fileOf(body.handle);
    const out = path.join(h.folder, `out-${randomUUID()}.fluximg`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson");
    const line = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + "\n"); };
    const job = conv().request("convert", { path: h.file, answer: body.answer, out, name: body.name, sourcePath: body.sourcePath }, { onProgress: (p) => line({ progress: p }) });
    // The page aborted its fetch (Cancel, a closed tab): the conversion stops and leaves nothing.
    let done = false;
    res.on("close", () => { if (!done) conv().cancel(job.id); });
    try {
      const result = await job.promise;
      const contents = {};
      for (const ent of fs.readdirSync(out, { withFileTypes: true, recursive: true })) {
        if (!ent.isFile()) continue;
        const abs = path.join(ent.parentPath, ent.name);
        contents[path.relative(out, abs).split(path.sep).join("/")] = fs.readFileSync(abs).toString("base64");
      }
      done = true;
      line({ ok: true, result: { ...result, path: undefined, contents } });
    } catch (error) {
      done = true;
      line({ ok: false, error: String(error?.message ?? error), ...(error?.name === "AbortError" ? { cancelled: true } : {}), ...(error?.code ? { code: error.code } : {}) });
    } finally {
      await removeStaging(out);
      res.end();
    }
  }

  async function handler(req, res, next) {
    const url = req.url || "";
    if (!url.startsWith("/__flux-dev/tiff/")) return next?.();
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const op = url.slice("/__flux-dev/tiff/".length).split("?")[0];
    try {
      if (op === "stage") return await stage(req, res);
      if (op === "convert") return await convert(req, res);
      const body = await readJson(req);
      if (op === "probe") return json(res, 200, { ok: true, result: await conv().request("probe", { path: fileOf(body.handle).file, rules: body.rules, max: body.max }).promise });
      if (op === "preview") return json(res, 200, { ok: true, result: await conv().request("preview", { path: fileOf(body.handle).file, answer: body.answer, max: body.max }).promise });
      if (op === "release") { const h = handles.get(body.handle); handles.delete(body.handle); if (h) fs.rmSync(h.folder, { recursive: true, force: true }); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: "unknown operation" });
    } catch (error) {
      return json(res, 200, { ok: false, error: String(error?.message ?? error), ...(error?.code ? { code: error.code } : {}) });
    }
  }
  function close() {
    converter?.close(); converter = null;
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
  return { handler, close, get converter() { return converter; } };
}

/** The Vite plugin (dev server only). */
export function tiffDevPlugin() {
  return {
    name: "flux-dev-tiff",
    apply: "serve",
    configureServer(server) {
      const routes = createTiffDevRoutes();
      server.middlewares.use((req, res, next) => { void routes.handler(req, res, next); });
      server.httpServer?.once("close", () => routes.close());
      process.once("exit", () => routes.close());
    },
  };
}
