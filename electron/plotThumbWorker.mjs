// Plot thumbnail worker — a long-lived Node child (spawned by electron/ipc/plotThumbs.cjs with
// ELECTRON_RUN_AS_NODE, the same process model as flux-core's resvg raster child and the slide
// video worker). All raster work for the Plots rail happens here: never in the Electron main
// process (a resvg panic must not take the app down) and never on the renderer's main thread
// (a 20 MB matplotlib SVG decoded in an <img> stalls the editor).
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   → { id, op: "list",   base, reserved: [names], accept: "svg,png,glb", indexRoot, dirs? }
//   → { id, op: "probe",  paths: [abs], indexRoot }
//   → { id, op: "thumb",  path, bucket, roots: [abs], indexRoot, priority }
//   → { id, op: "cancel", ids: [id] }           (queued thumbs only; a running render finishes)
//   → { id, op: "quarantine", path, indexRoot, reason }
//   → { id, op: "sweep" }
//   ← { id, ok: true, result } | { id, ok: false, error }
//   ← { started: id }   just before resvg runs, so the parent can name (and time) the culprit.
// Env: FLUX_RESVG_FROM (file URL resvg resolves from), FLUX_THUMB_CACHE (cache dir),
//      FLUX_FONTFILES_MODULE (file URL of src/lib/text/fontFiles.mjs), FLUX_FONT_INDEX.
// stdin closing ends the worker after the per-root indexes are flushed.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { createThumbEngine } from "./plotThumbEngine.mjs";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let resolveFontFile = null;
try {
  if (process.env.FLUX_FONTFILES_MODULE) ({ resolveFontFile } = await import(process.env.FLUX_FONTFILES_MODULE));
} catch { /* without the resolver, text renders in resvg's built-in fallback */ }
const fontIndex = process.env.FLUX_FONT_INDEX || undefined;

const engine = createThumbEngine({
  cacheDir: process.env.FLUX_THUMB_CACHE,
  resvgFrom: process.env.FLUX_RESVG_FROM || pathToFileURL(path.join(process.cwd(), "package.json")).href,
  resolveFont: resolveFontFile ? (req) => resolveFontFile(req, { cacheFile: fontIndex }) : undefined,
});

// One render at a time (resvg's render is synchronous); lower priority number first, FIFO within.
const queue = [];
let running = false;
let seq = 0;

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = queue.shift();
      // `started` is sent right before resvg runs (the synchronous part that can hang or panic),
      // not before the file reads and font lookups — a slow disk must not get an innocent plot
      // killed and quarantined.
      let named = false;
      const onRender = () => { if (!named) { named = true; send({ started: job.id }); } };
      try {
        const result = await engine.thumb(job.path, job.bucket, { roots: job.roots ?? [], indexRoot: job.indexRoot ?? null, onRender });
        send({ id: job.id, ok: true, result });
      } catch (e) {
        send({ id: job.id, ok: false, error: String(e?.message ?? e) });
      }
      // Let list/probe requests that arrived meanwhile interleave between renders.
      await new Promise((r) => setImmediate(r));
    }
  } finally { running = false; }
}

function acceptFn(spec) {
  const exts = String(spec || "svg,png").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const re = new RegExp(`\\.(${exts.map((e) => e.replace(/[^a-z0-9]/g, "")).join("|")})$`, "i");
  return (name) => re.test(name);
}

async function handle(msg) {
  const { id, op } = msg;
  try {
    if (op === "thumb") {
      queue.push({ id, path: msg.path, bucket: msg.bucket, roots: msg.roots, indexRoot: msg.indexRoot, priority: Number(msg.priority) || 0, seq: seq++ });
      void pump();
      return;
    }
    if (op === "cancel") {
      const ids = new Set(msg.ids ?? []);
      for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) { send({ id: queue[i].id, ok: false, error: "cancelled", cancelled: true }); queue.splice(i, 1); }
      send({ id, ok: true, result: null });
      return;
    }
    if (op === "list") {
      const reserved = new Set(msg.reserved ?? []);
      const result = await engine.list(msg.base, {
        skipDir: (name) => reserved.has(name),
        accept: acceptFn(msg.accept),
        indexRoot: msg.indexRoot ?? msg.base,
        dirs: Array.isArray(msg.dirs) ? msg.dirs : null,
      });
      send({ id, ok: true, result });
      return;
    }
    if (op === "probe") {
      send({ id, ok: true, result: await engine.probe(msg.paths ?? [], msg.indexRoot ?? null) });
      return;
    }
    if (op === "quarantine") {
      await engine.quarantine(msg.path, msg.indexRoot, msg.reason);
      send({ id, ok: true, result: null });
      return;
    }
    if (op === "sweep") {
      send({ id, ok: true, result: await engine.sweep() });
      return;
    }
    send({ id, ok: false, error: `unknown op ${op}` });
  } catch (e) {
    send({ id, ok: false, error: String(e?.message ?? e) });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  void handle(msg);
});
rl.on("close", async () => {
  try { await engine.flushAll(); } catch { /* best effort */ }
  process.exit(0);
});
// The cache is swept once per worker start, after the first requests have had their turn.
setTimeout(() => { void engine.sweep().catch(() => {}); }, 15000).unref();
