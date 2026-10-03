import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { atomicWrite, fsyncDir } from "./fsx";
import { publishModelFile } from "./model3dFile";
import { GLB_LIMITS } from "../src/lib/model3d/glbCore.mjs";
import type { ModelBounds, RenderSpec } from "../src/lib/model3d/types";

const KEY = /^m3d-[a-f0-9]{14}$/;
/** One worker page embeds every model of its batch as base64 inside one script
 * string. V8 caps a string near 512 MiB (2^29 - 24 chars), so the raw model
 * bytes of a batch stay at or below 256 MiB (about 342 MiB of base64) and the
 * planner splits larger work into sequential worker jobs. */
export const POSTER_BATCH_LIMITS = Object.freeze({ maxRequests: 64, maxModelBytes: 256 * 1024 * 1024 });
export interface PosterBatchPlan<T> { batches: T[][]; oversized: T[] }
/** Pure greedy planner: request order is preserved, each distinct model counts
 * once per batch, and a request whose own models exceed the byte cap is
 * returned in `oversized` instead of producing an unrenderable page. */
export function planPosterBatches<T>(requests: readonly T[], modelsOf: (request: T) => readonly string[], sizeOf: (modelId: string) => number,
  limits: { maxRequests: number; maxModelBytes: number } = POSTER_BATCH_LIMITS): PosterBatchPlan<T> {
  const batches: T[][] = [], oversized: T[] = [];
  let batch: T[] = [], models = new Set<string>(), bytes = 0;
  for (const request of requests) {
    const own = [...new Set(modelsOf(request))], ownBytes = own.reduce((sum, id) => sum + sizeOf(id), 0);
    if (!Number.isFinite(ownBytes) || ownBytes > limits.maxModelBytes) { oversized.push(request); continue; }
    const extra = own.filter(id => !models.has(id)).reduce((sum, id) => sum + sizeOf(id), 0);
    if (batch.length && (batch.length >= limits.maxRequests || bytes + extra > limits.maxModelBytes)) {
      batches.push(batch); batch = []; models = new Set(); bytes = 0;
    }
    batch.push(request);
    for (const id of own) if (!models.has(id)) { models.add(id); bytes += sizeOf(id); }
  }
  if (batch.length) batches.push(batch);
  return { batches, oversized };
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export interface PosterRequest { key: string; spec: RenderSpec }
export interface PosterProgress { phase: "preparing" | "rendering"; done: number; total: number }
export interface PosterBatchResult {
  renderer: string;
  readyMs: number;
  spawnMs: number;
  totalMs: number;
  results: Array<{ key: string; path: string; w: number; h: number; bytes: number; renderMs: number; encodeMs: number }>;
}
export interface PosterBatchOptions {
  outDir: string;
  /** Project-cache publication must retain this root confinement across awaits. */
  publicationRoot?: string;
  modelBytes: (assetId: string, signal?: AbortSignal) => Promise<Uint8Array> | Uint8Array;
  /** Stored asset.model.bounds per asset id; they govern framing (renderCore.load). */
  modelBounds?: (assetId: string) => ModelBounds | undefined;
  signal?: AbortSignal;
  onProgress?: (progress: PosterProgress) => void;
  deadlineMs?: number;
  /** Linux display qualification only; ordinary headless rendering needs no display. */
  ozonePlatform?: "headless" | "x11";
}

const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

/** A self-contained page with an exact script CSP and no model/resource fetching. */
export function modelPosterHtml(runtime: string, requests: readonly PosterRequest[], models: Record<string, string>, bounds: Record<string, ModelBounds> = {}): string {
  if (/<\/script/i.test(runtime)) throw new Error("Unsafe model runtime script terminator");
  const boot = `"use strict";
window.fluxModel3dPosterReady = (async () => {
  const start = performance.now(), payload = ${scriptJson({ requests, models, bounds })};
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const core = FluxModel3dRuntime.createRenderCore(canvas);
  for (const [id, encoded] of Object.entries(payload.models)) {
    const raw = atob(encoded), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    await core.load(id, bytes.buffer, payload.bounds[id]);
  }
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL2 is unavailable for 3D posters");
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  window.fluxModel3dPoster = {
    render(index) {
      if (!Number.isInteger(index) || !payload.requests[index]) throw new Error("Invalid poster request index");
      const t0 = performance.now();
      core.render(payload.requests[index].spec);
      if (gl.isContextLost()) throw new Error("3D poster context was lost");
      const t1 = performance.now();
      const png = canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
      if (gl.isContextLost()) throw new Error("3D poster context was lost during readback");
      return { png, metrics: { renderMs: t1 - t0, encodeMs: performance.now() - t1 } };
    },
    dispose() { core.dispose(); }
  };
  return { renderer, readyMs: performance.now() - start };
})();`;
  const hashes = [runtime, boot].map(script => `'sha256-${createHash("sha256").update(script).digest("base64")}'`).join(" ");
  const csp = `default-src 'none'; script-src ${hashes}; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>3D poster worker</title><body><script>${runtime}</script><script>${boot}</script></body>`;
}

const abortError = (signal?: AbortSignal) => signal?.reason instanceof Error ? signal.reason : new Error("3D poster rendering cancelled");
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}
/** Explicit rendering only. Callers choose project cache for mutations or machine cache for read-only image requests. */
export async function renderModelPosterBatch(requests: readonly PosterRequest[], options: PosterBatchOptions): Promise<PosterBatchResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("3D poster rendering cancelled"));
  const timeout = options.deadlineMs ?? 120000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid 3D poster deadline");
  const timer = setTimeout(() => controller.abort(new Error("3D poster worker timed out")), timeout);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try { return await runModelPosterBatch(requests, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
}
async function runModelPosterBatch(requests: readonly PosterRequest[], options: PosterBatchOptions): Promise<PosterBatchResult> {
  const t0 = performance.now();
  if (!requests.length) return { renderer: "", readyMs: 0, spawnMs: 0, totalMs: 0, results: [] };
  if (requests.length > POSTER_BATCH_LIMITS.maxRequests) throw new Error(`A 3D poster batch may contain at most ${POSTER_BATCH_LIMITS.maxRequests} requests`);
  const keys = new Set<string>(), assetIds = new Set<string>();
  for (const { key, spec } of requests) {
    if (!KEY.test(key) || keys.has(key)) throw new Error("Invalid or duplicate 3D poster key");
    keys.add(key);
    if (![spec.w, spec.h].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error("Invalid poster dimensions");
    assetIds.add(spec.assetId);
    if (spec.morph) assetIds.add(spec.morph.to);
  }
  const cancelled = () => { if (options.signal?.aborted) throw abortError(options.signal); };
  cancelled();
  if (process.env.FLUX_MODEL3D_DISABLE === "1") throw new Error("3D poster rendering is disabled");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = process.env.FLUX_MODEL3D_APP_ROOT || path.resolve(here, "..");
  const runtimeFile = path.join(appRoot, "dist/flux-model3d-runtime.js");
  const runtime = await abortable(fs.readFile(runtimeFile, "utf8").catch(() => { throw new Error("3D renderer is missing. Build Flux's model3d runtime before rendering posters."); }), options.signal);
  const require = createRequire(import.meta.url);
  const electron = process.env.FLUX_MODEL3D_ELECTRON || (process.versions.electron ? process.execPath : require("electron")) as string;
  if (typeof electron !== "string") throw new Error("3D poster rendering requires an Electron executable");
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flux-model3d-")));
  try {
    options.onProgress?.({ phase: "preparing", done: 0, total: requests.length });
    const models: Record<string, string> = Object.create(null);
    let totalBytes = 0;
    for (const id of assetIds) {
      cancelled();
      const bytes = await abortable(Promise.resolve().then(() => { cancelled(); return options.modelBytes(id, options.signal); }), options.signal);
      // Callers plan batches with planPosterBatches; this is the backstop that
      // keeps one page's base64 payload below the V8 string limit.
      if (!bytes.length || bytes.length > GLB_LIMITS.maxBytes || (totalBytes += bytes.length) > POSTER_BATCH_LIMITS.maxModelBytes)
        throw new Error("3D poster batch exceeds the model byte limit");
      models[id] = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    }
    cancelled();
    const html = path.join(scratch, "poster.html"), jobFile = path.join(scratch, "job.json");
    const bounds: Record<string, ModelBounds> = Object.create(null);
    for (const id of assetIds) { const stored = options.modelBounds?.(id); if (stored) bounds[id] = stored; }
    await fs.writeFile(html, modelPosterHtml(runtime, requests, models, bounds));
    await fs.writeFile(jobFile, JSON.stringify({ version: 1, html, requests: requests.map(({ key, spec }) => ({ key, w: spec.w, h: spec.h })) }));
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_MODEL3D_POSTER_WORKER: "1", FLUX_MODEL3D_POSTER_JOB: jobFile, FLUX_NO_MIGRATE: "1" };
    delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.FLUX_SLIDE_VIDEO_WORKER;
    if (process.platform === "linux") {
      delete env.WAYLAND_DISPLAY;
      if ((options.ozonePlatform ?? "headless") === "headless") delete env.DISPLAY;
    }
    const spawnStart = performance.now();
    let spawnMs = 0;
    const result = await new Promise<Omit<PosterBatchResult, "spawnMs" | "totalMs">>((resolve, reject) => {
      const args = [path.join(appRoot, "electron/entry.cjs"),
        ...(process.platform === "linux" ? [`--ozone-platform=${options.ozonePlatform ?? "headless"}`,
          ...((options.ozonePlatform ?? "headless") === "headless" || process.env.SOFTGPU === "1" ? ["--use-gl=angle", "--use-angle=swiftshader"] : [])] : []), "--enable-unsafe-swiftshader"];
      const child = spawn(electron, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      let buffer = "", stderr = "", failure = "", finished: Omit<PosterBatchResult, "spawnMs" | "totalMs"> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => child.kill());
        } else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      };
      const cancel = () => { child.stdin.write("cancel\n"); killTimer ??= setTimeout(kill, 3000); };
      // All event handlers exist before cancellation can run.
      child.stdin.on("error", () => {});
      child.once("error", error => { failure ||= error.message; });
      child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-12000); });
      child.stdout.on("data", bytes => {
        buffer += bytes;
        if (buffer.length > 1024 * 1024) { failure ||= "3D poster worker response exceeded its limit"; kill(); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.startsWith("FLUX_MODEL3D ")) continue;
          try {
            const message = JSON.parse(line.slice(13));
            if (message.error) failure ||= message.error;
            else if (message.result) finished = message.result;
            else if (message.phase === "ready") spawnMs = performance.now() - spawnStart;
            else if (message.phase) options.onProgress?.(message);
          } catch { failure ||= "Invalid 3D poster worker response"; kill(); }
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(killTimer); options.signal?.removeEventListener("abort", cancel);
        if (options.signal?.aborted) reject(abortError(options.signal));
        else if (code === 0 && finished && !failure) resolve(finished);
        else {
          // Callers keep only the first line, so a crash names its signal and Electron's last words there.
          const last = stderr.trim().split("\n").pop()?.trim();
          const exit = `3D poster worker ${code === null ? `killed by ${signal}` : `exited ${code}`}${last ? ` (${last.slice(0, 300)})` : ""}`;
          reject(new Error([failure || exit, stderr.trim()].filter(Boolean).join("\n")));
        }
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    cancelled();
    if (!Array.isArray(result.results) || result.results.length !== requests.length) throw new Error("Incomplete 3D poster worker result");
    const results: PosterBatchResult["results"] = [];
    // Validate the whole batch before publishing any cache entry.
    const images = await Promise.all(requests.map(async ({ key, spec }, index) => {
      const entry = result.results[index];
      if (!entry || entry.key !== key) throw new Error("3D poster worker returned an unexpected key");
      const bytes = await fs.readFile(path.join(scratch, "posters", `${key}.png`));
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(16) !== spec.w || bytes.readUInt32BE(20) !== spec.h)
        throw new Error("3D poster output failed validation");
      return bytes;
    }));
    if (!options.publicationRoot) await fs.mkdir(options.outDir, { recursive: true });
    for (let i = 0; i < requests.length; i++) {
      cancelled();
      const destination = path.join(options.outDir, `${requests[i].key}.png`);
      if (options.publicationRoot) await publishModelFile(options.publicationRoot, destination, images[i]);
      else await atomicWrite(destination, images[i]);
      results.push({ ...result.results[i], path: destination });
    }
    if (!options.publicationRoot) await fsyncDir(options.outDir);
    return { ...result, results, spawnMs, totalMs: performance.now() - t0 };
  } finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
