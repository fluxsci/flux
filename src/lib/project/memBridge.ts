// Dev-only in-memory FileBridge fixture (§1.4 of the Improvement Plan).
//
// Backs `window.fig` with a JS object pre-seeded from a sample project (a
// manuscript with @fig/@cite, a figure with panels + caption, and a library.bib),
// so Surface A (the dev server, no Electron) can exercise figures-in-paper,
// citations, export-render, and F1–F7 — the single biggest accelerator for visual
// iteration. Gate via the `?fixture=demo` query param. Surface B (full Electron)
// remains the final gate for real-FS behavior.
//
// Loaded only behind import.meta.env.DEV via dynamic import (see main.ts), so it
// never ships in a production build.

import { scaffoldProject } from "./scaffold";
import { joinPath, type FileBridge, type RunnerCapability, type RunnerEvent, type RunnerPayload, type RunnerStart, type SetupProgress, type SetupStatus, type SetupTaskResult } from "./types";
import type { Model3dImportRequest, Model3dImportResult, Model3dImportOwnership } from '../model3d/importData';
import { GLB_LIMITS } from '../model3d/glbCore.mjs';
import { RESERVED_PLOT_DIRNAMES } from "./plotsFolders";
import { supportsDeckSchema } from "../slide/schemaStamp";
import { DISSECT_REL, dissectionRootRelFor, classifyDissectionFile, dissectionNoteRel, DISSECT_NOTE_MAX_BYTES } from "../dissect/rules";
import { probeImageSize, acceptsFluximg, fileAcceptExts, fluximgBundleOf, fluximgIndexEntry, FLUXIMG_MANIFEST_NAME, FLUXIMG_PREVIEW_NAME } from "../plotsRail/rules";
import type { PlotIndexEntry } from "./types";
import * as fxr from "../../../electron/fluximgRules.js";
import { createMemTiff } from "./memTiff";
import type { FluximgImportRequest, FluximgImportResult, FluximgReadRequest } from "../fluximg/bridge";

const sha256 = async (bytes:Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,"0")).join("");
const enc = new TextEncoder();
const dec = new TextDecoder();

/** The browser fixture's "Set up Flux…" machine: nothing installed, not a first run unless a
 *  gate says so. Installs complete in a few progress steps unless `hold` keeps them running
 *  (so a gate can observe progress and Cancel); `fail` makes the next install fail. */
const setupFixture = (() => {
  const state = {
    platform: "darwin",
    // A gate previews the first-launch window by setting this key before the page loads.
    firstRun: typeof localStorage !== "undefined" && localStorage.getItem("flux.fixture.setupFirstRun") === "1",
    launcher: { installed: false, onPath: false, launcher: "/home/demo/.local/bin/flux", profile: "/home/demo/.zshrc" },
    quarto: { installed: false, origin: null, command: null, version: "" } as SetupStatus["quarto"],
    quartoManageable: true,
    quartoPinned: "1.7.32",
    tex: { installed: false, kind: null, path: null } as SetupStatus["tex"],
    agents: { claude: false, codex: false },
    hold: false,
    fail: "",
  };
  const listeners = new Set<(p: SetupProgress) => void>();
  const pending = new Map<string, (r: SetupTaskResult) => void>();
  const emit = (p: SetupProgress) => listeners.forEach((cb) => cb(p));
  const fixture = {
    state, listeners,
    status: (): SetupStatus => ({ ...structuredClone({ ...state, hold: undefined, fail: undefined }), busy: [...pending.keys()] } as SetupStatus),
    run(task: "quarto" | "tinytex"): Promise<SetupTaskResult> {
      return new Promise((resolve) => {
        pending.set(task, resolve);
        const finish = (r: SetupTaskResult) => { if (pending.get(task) === resolve) { pending.delete(task); resolve(r); } };
        if (task === "quarto") emit({ task, phase: "download", done: 50, total: 100 });
        else emit({ task, phase: "log", line: "Installing TinyTeX…" });
        if (state.hold) return;
        setTimeout(() => {
          if (state.fail) { const error = state.fail; state.fail = ""; finish({ ok: false, error }); return; }
          if (task === "quarto") { state.quarto = { installed: true, origin: "managed", command: "/home/demo/FluxConfig/tools/quarto/1.7.32/bin/quarto", version: "1.7.32" }; emit({ task, phase: "done", done: 100, total: 100 }); }
          else state.tex = { installed: true, kind: "tinytex", path: "/home/demo/Library/TinyTeX/bin/universal-darwin/lualatex" };
          finish({ ok: true });
        }, 120);
      });
    },
    cancel(task: string) {
      const resolve = pending.get(task);
      if (!resolve) return false;
      pending.delete(task);
      resolve({ ok: false, cancelled: true, error: "Cancelled" });
      return true;
    },
  };
  if (typeof window !== "undefined") (window as unknown as { __fluxSetupFixture?: typeof fixture }).__fluxSetupFixture = fixture;
  return fixture;
})();

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
}
function parentOf(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}
function baseOf(p: string): string {
  const n = norm(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

/** A minimal in-memory file system implementing the FileBridge contract. */
export function createMemBridge(): FileBridge & {
  _runnerCalls: { method: string; options: unknown }[];
  _emitRunnerEvent: (runId: string, event: RunnerPayload) => void;
  /** Gates pin "no installed CLI" (or a subset) before the first probe. */
  _setRunnerCapabilities: (caps: RunnerCapability[]) => void;
  reads: string[];
  _files: Map<string, Uint8Array>;
  _dirs: Set<string>;
  _emitFsChange: (info: { subsystem: string; path: string }) => void;
  /** Dev/test: write a bundle (bundle-relative path → bytes or base64) at a project-relative
   *  `plots/…/<name>.fluximg` or `fig/assets/<id>.fluximg`, replacing what was there. Returns its path. */
  _seedFluximg: (root: string, bundle: string, files: Record<string, string | Uint8Array>) => string;
  /** Gates: where the dev server's TIFF route is (the page's own origin by default). */
  _setTiffEndpoint: (url: string) => void;
} {
  const reads: string[] = [];
  const runnerCalls: { method: string; options: unknown }[] = [];
  let runnerCaps: RunnerCapability[] = [
    { driver: "claude", detected: true, available: true, version: "fixture", model: true, effort: true },
    { driver: "codex", detected: true, available: true, version: "fixture", model: true, effort: true },
  ];
  const runnerEvents = new Set<(event: RunnerEvent) => void>();
  const runs = new Map<string, { seq: number; options: RunnerStart }>();
  const emitRunner = (runId: string, event: RunnerPayload) => {
    const run = runs.get(runId); if (!run) return;
    const normalized = { ...event, runId, seq: ++run.seq };
    for (const cb of runnerEvents) cb(normalized);
  };
  // File times for the Plots rail's version stamps (size:mtime): every write moves the clock.
  const mtimes = new Map<string, number>();
  let clock = Date.now();
  class StampedFiles extends Map<string, Uint8Array> {
    set(key: string, value: Uint8Array) { mtimes.set(key, ++clock); return super.set(key, value); }
    delete(key: string) { mtimes.delete(key); return super.delete(key); }
  }
  const files = new StampedFiles();
  const batchListeners = new Set<(info: { subsystem: string; paths: string[]; rescan?: boolean }) => void>();
  const dirs = new Set<string>(["/"]);
  const fsListeners = new Set<(info: { subsystem: string; path: string }) => void>();
  let watchedRoot: string | null | undefined, watchGeneration = 0;
  const modelImports = new Map<string, { root: string; generation: number; state: 'pending' | 'canceled'; target: Model3dImportRequest['target']; document: string; result: Model3dImportResult; paths: string[] }>();

  const addDir = (p: string) => {
    let cur = norm(p);
    while (cur && !dirs.has(cur)) {
      dirs.add(cur);
      if (cur === "/") break;
      cur = parentOf(cur);
    }
  };
  const ensureParent = (p: string) => addDir(parentOf(p));

  async function importMemModel(request: Model3dImportRequest, dropped?: File): Promise<Model3dImportResult> {
    const root = norm(request.root), generation = watchGeneration;
    const assertOwner = () => {
      if (!root || (watchedRoot !== undefined && watchedRoot !== root) || generation !== watchGeneration) throw new Error('The project changed while importing the model');
    };
    assertOwner();
    if (!['figure', 'slide'].includes(request.target?.kind) || Object.keys(request.target).some(k => k !== 'kind' && !(request.target.kind === 'slide' && k === 'deckId'))) throw new Error('3D import requires a Figure or slide target');
    const documentBytes = files.get(`${root}/project.json`);
    if (!documentBytes) throw new Error('Save the project before importing a 3D model');
    const document = JSON.parse(dec.decode(documentBytes));
    let prefix = typeof document.schemaVersion === 'string' ? 'fig' : document.version === 2 && Array.isArray(document.figures) ? '' : null;
    if (prefix === null) throw new Error('Unrecognized Figure project format');
    let documentPath = joinPath(root, prefix ? 'fig/index.json' : 'project.json');
    const assertDestination = () => {
      if (request.target.kind !== 'slide') return;
      const id = request.target.deckId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,180}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Unsafe model deck id');
      const relative = `slides/${id}/deck.json`;
      const currentBytes = files.get(`${root}/project.json`), currentDocument = currentBytes ? JSON.parse(dec.decode(currentBytes)) : undefined;
      if (typeof currentDocument?.schemaVersion !== 'string' || !currentDocument.slides?.some((d: {id:string;path:string}) => d.id === id && d.path === relative)) throw new Error('The model destination deck is not registered in this project');
      documentPath = joinPath(root, relative);
      const saved = files.get(documentPath), deck = saved ? JSON.parse(dec.decode(saved)) : undefined;
      if (deck?.id !== id || !supportsDeckSchema(deck.schemaVersion) || !Array.isArray(deck.slides)) throw new Error('The model destination deck cannot be edited by this Flux version');
      prefix = `slides/${id}`;
    }
    assertDestination();
    const sourcePath = norm(request.sourcePath);
    if (!/\.glb$/i.test(dropped?.name ?? sourcePath)) throw new Error('Choose a binary .glb model file');
    if (dropped && dropped.size > GLB_LIMITS.maxBytes) throw new Error(`GLB exceeds ${GLB_LIMITS.maxBytes / 1024 / 1024} MiB`);
    const bytes = dropped ? new Uint8Array(await dropped.arrayBuffer()) : files.get(sourcePath);
    if (!bytes) throw new Error(`Missing GLB source ${sourcePath}`);
    const manifestPath = request.manifestPath ?? sourcePath.replace(/\.glb$/i, '.fluxplot.json');
    const recipePath = request.recipePath ?? sourcePath.replace(/\.glb$/i, '.recipe.json');
    const manifestText = !dropped && files.has(manifestPath) ? dec.decode(files.get(manifestPath)) : undefined;
    const recipeText = !dropped && files.has(recipePath) ? dec.decode(files.get(recipePath)) : undefined;
    const { prepareModel3dImport } = await import('../model3d/importData');
    const prepared = await prepareModel3dImport({ bytes, assetId: `model-${crypto.randomUUID()}`, name: dropped?.name ?? baseOf(sourcePath), manifestText, recipeText });
    assertOwner(); assertDestination();
    const result: Model3dImportResult = { ...prepared.data, receipt: crypto.randomUUID(), assetPrefix: prefix,
      source: { glbPath: sourcePath, ...(manifestText !== undefined ? { manifestPath } : {}), ...(recipeText !== undefined ? { recipePath } : {}), ...(dropped ? { frozen: true } : {}) } };
    const directory = joinPath(root, prefix, 'assets'), paths: string[] = [];
    const entries: [string, Uint8Array][] = [[`${directory}/${result.asset.id}.glb`, prepared.bytes]];
    if (result.raw?.manifest !== undefined) entries.push([`${directory}/${result.asset.id}.fluxplot.json`, enc.encode(result.raw.manifest)]);
    if (result.raw?.recipe !== undefined) entries.push([`${directory}/${result.asset.id}.recipe.json`, enc.encode(result.raw.recipe)]);
    for (const [file] of entries) if (files.has(file)) throw new Error('Model import destination already exists');
    for (const [file, content] of entries) { ensureParent(file); files.set(file, content); paths.push(file); }
    modelImports.set(result.receipt, { root, generation, state: 'pending', target: structuredClone(request.target), document: documentPath, result, paths });
    return result;
  }
  // --- fluximg: the same requests, rules and messages as electron/fluximgFiles.cjs ------------
  // (validation and wording are shared through electron/fluximgRules.js). This fixture has no links,
  // special files or other windows, so those refusals exist only on the native side.
  const memIsDir = (p: string) => dirs.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`));
  /** Resolve `.`/`..` in an absolute POSIX path; null when it climbs above "/". */
  const memResolve = (p: string): string | null => {
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (!out.length) return null; out.pop(); } else out.push(part);
    }
    return `/${out.join("/")}`;
  };
  /** The request's project root: the open one (else "the project changed"), absolute. */
  const fluximgRoot = (root: unknown): string => {
    if (typeof root === "string" && watchedRoot !== undefined && watchedRoot !== norm(root)) throw new Error(fxr.fluximgErrors.projectChanged());
    if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) throw new Error(fxr.fluximgErrors.root());
    return memResolve(root) ?? "/";
  };
  const fluximgSha = async (text: string) => sha256(enc.encode(text));

  async function importMemFluximg(request: FluximgImportRequest): Promise<FluximgImportResult> {
    if (typeof request?.root === "string" && watchedRoot !== undefined && watchedRoot !== norm(request.root)) throw new Error(fxr.fluximgErrors.projectChanged());
    const id = fxr.fluximgAssetId(request?.assetId);
    const root = fluximgRoot(request.root), sourcePath = request.sourcePath;
    if (typeof sourcePath !== "string" || !sourcePath || sourcePath.length > 32768 || sourcePath.includes("\0")) throw new Error(fxr.fluximgErrors.sourcePath());
    if (!files.has(`${root}/project.json`)) throw new Error(fxr.fluximgErrors.root());
    const name = `${id}${fxr.FLUXIMG_EXT}`, destination = `${root}/${fxr.FLUXIMG_ASSETS_REL}/${name}`;
    if (files.has(destination) || memIsDir(destination)) throw new Error(fxr.fluximgErrors.exists(id));
    const relative = !sourcePath.replace(/\\/g, "/").startsWith("/");
    const source = memResolve(relative ? `${root}/${sourcePath.replace(/\\/g, "/")}` : norm(sourcePath));
    const inside = source !== null && (source === root || source.startsWith(`${root}/`));
    if (relative && !inside) throw new Error(fxr.fluximgErrors.sourceEscapes());
    if (source === null || (!files.has(source) && !memIsDir(source))) throw new Error(`ENOENT: ${sourcePath} does not exist`);
    const label = baseOf(source);
    if (files.has(source)) throw new Error(fxr.fluximgErrors.notDirectory(label));
    if (`${root}/${fxr.FLUXIMG_ASSETS_REL}`.startsWith(`${source}/`) || source === `${root}/${fxr.FLUXIMG_ASSETS_REL}`) throw new Error(fxr.fluximgErrors.destinationInsideSource());
    const manifestBytes = files.get(`${source}/fluximg.json`);
    if (!manifestBytes) throw new Error(fxr.fluximgErrors.notBundle(label));
    if (manifestBytes.byteLength > fxr.FLUXIMG_MANIFEST_MAX_BYTES) throw new Error(fxr.fluximgErrors.manifestTooLarge());
    const manifest = fxr.parseFluximgManifest(dec.decode(manifestBytes));
    // The walk: every file under the source, OS litter skipped, the native limits applied.
    const found: { rel: string; bytes: Uint8Array }[] = [];
    const folders = new Set<string>();
    for (const [key, bytes] of files) {
      if (!key.startsWith(`${source}/`)) continue;
      const rel = key.slice(source.length + 1), parts = rel.split("/");
      if (parts.some((part) => fxr.isFluximgJunkName(part))) continue;
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
      found.push({ rel, bytes });
    }
    for (const dir of dirs) if (dir.startsWith(`${source}/`) && !dir.slice(source.length + 1).split("/").some((part) => fxr.isFluximgJunkName(part))) folders.add(dir.slice(source.length + 1));
    const deepest = Math.max(0, ...[...folders].map((f) => f.split("/").length));
    if (deepest > fxr.FLUXIMG_IMPORT_MAX_DEPTH) throw new Error(fxr.fluximgErrors.tooDeep(fxr.FLUXIMG_IMPORT_MAX_DEPTH));
    if (folders.size > fxr.FLUXIMG_IMPORT_MAX_DIRS) throw new Error(fxr.fluximgErrors.tooManyDirs(fxr.FLUXIMG_IMPORT_MAX_DIRS));
    if (found.length > fxr.FLUXIMG_IMPORT_MAX_FILES) throw new Error(fxr.fluximgErrors.tooManyFiles(fxr.FLUXIMG_IMPORT_MAX_FILES));
    const total = found.reduce((sum, f) => sum + f.bytes.byteLength, 0);
    if (total > fxr.FLUXIMG_IMPORT_MAX_BYTES) throw new Error(fxr.fluximgErrors.tooLarge(total, fxr.FLUXIMG_IMPORT_MAX_BYTES));
    const entries = await Promise.all(found.map(async (f) => ({ path: f.rel, sha256: await sha256(f.bytes) })));
    const contentId = await fluximgSha(fxr.fluximgContentIdText(entries));
    // Published all at once, after every check (the native side stages and renames).
    if (files.has(destination) || memIsDir(destination)) throw new Error(fxr.fluximgErrors.exists(id));
    addDir(destination);
    for (const folder of folders) addDir(`${destination}/${folder}`);
    for (const f of found) { const key = `${destination}/${f.rel}`; ensureParent(key); files.set(key, new Uint8Array(f.bytes)); }
    return { path: fxr.fluximgAssetPath(id), sha256: contentId, bytes: total, files: found.length, manifest, method: "copy" };
  }

  // TIFF → image bundle: the twin of electron/ipc/tiff.cjs (memTiff.ts), converting through the dev server's route.
  const memTiff = createMemTiff({
    files, isDir: memIsDir, addDir, ensureParent, norm, resolve: memResolve, sha256, mtime: (p) => mtimes.get(norm(p)) ?? 0,
    watched: () => ({ root: watchedRoot, generation: watchGeneration }),
  });

  function ownedModel(request: Model3dImportOwnership) {
    const item = modelImports.get(request.receipt);
    if (!item || item.root !== norm(request.root) || request.target?.kind !== item.target.kind || (request.target.kind === 'slide' && item.target.kind === 'slide' && request.target.deckId !== item.target.deckId) || item.result.asset.id !== request.assetId) throw new Error('Unknown or already adopted model import receipt');
    return item;
  }

  return {
    ...memTiff,
    importFluximg: (request) => importMemFluximg(request),
    // A "dropped" bundle in the fixture is named by its project-relative path (there is no file manager here).
    importDroppedFluximg: (file, request) => importMemFluximg({ ...request, sourcePath: file.name }).then((result) => ({ ...result, sourcePath: file.name })),
    async readFluximg(request: FluximgReadRequest) {
      if (typeof request?.root === "string" && watchedRoot !== undefined && watchedRoot !== norm(request.root)) throw new Error(fxr.fluximgErrors.projectChanged());
      const root = fluximgRoot(request?.root);
      const where = fxr.fluximgBundleRel(request.bundle), parts = fxr.fluximgInnerPath(request.path);
      fxr.fluximgCheckRange(request.offset, request.length);
      const bundle = `${root}/${where.rel}`;
      if (!memIsDir(`${root}/${where.area}`) || !memIsDir(bundle)) throw new Error(fxr.fluximgErrors.bundleMissing(where.rel));
      const rel = parts.join("/"), key = `${bundle}/${rel}`, bytes = files.get(key);
      if (!bytes) throw new Error(memIsDir(key) ? fxr.fluximgErrors.notFile(rel) : fxr.fluximgErrors.missing(where.rel, rel));
      const range = fxr.fluximgRange(rel, bytes.byteLength, request.offset, request.length);
      // A fresh buffer sized exactly to the bytes read, like the IPC result.
      return bytes.slice(range.start, range.start + range.length).buffer;
    },
    async discardFluximg(request) {
      if (typeof request?.root === "string" && watchedRoot !== undefined && watchedRoot !== norm(request.root)) throw new Error(fxr.fluximgErrors.projectChanged());
      const id = fxr.fluximgAssetId(request?.assetId);
      const root = fluximgRoot(request.root);
      if (!files.has(`${root}/project.json`)) throw new Error(fxr.fluximgErrors.root());
      const target = `${root}/${fxr.FLUXIMG_ASSETS_REL}/${id}${fxr.FLUXIMG_EXT}`;
      if (files.has(target)) throw new Error(fxr.fluximgErrors.discardNotDirectory(id));
      if (!memIsDir(target)) return;
      const index = files.get(`${root}/fig/index.json`);
      let saved: { assets?: unknown } | undefined;
      if (index) { try { saved = JSON.parse(dec.decode(index)); } catch { throw new Error(fxr.fluximgErrors.savedUnreadable()); } }
      if (Array.isArray(saved?.assets) && saved.assets.some((a: { id?: unknown } | null) => a?.id === id)) throw new Error(fxr.fluximgErrors.saved(id));
      for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key);
      for (const dir of [...dirs]) if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
    },
    _seedFluximg(root, bundle, content) {
      const where = fxr.fluximgBundleRel(bundle), base = `${norm(root)}/${where.rel}`;
      const entries = Object.entries(content).map(([rel, data]) => {
        const parts = fxr.fluximgInnerPath(rel);
        const bytes = typeof data === "string" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new Uint8Array(data);
        return [`${base}/${parts.join("/")}`, bytes] as const;
      });
      for (const key of [...files.keys()]) if (key.startsWith(`${base}/`)) files.delete(key);
      for (const dir of [...dirs]) if (dir.startsWith(`${base}/`)) dirs.delete(dir);
      addDir(base);
      for (const [key, bytes] of entries) { ensureParent(key); files.set(key, bytes); }
      if (where.area === "plots") for (const l of batchListeners) l({ subsystem: "plots", paths: [base] });
      return base;
    },
    importModel3d: request => importMemModel(request),
    importDroppedModel3d: (file, request) => importMemModel({ ...request, sourcePath: file.name }, file),
    async adoptModel3d(request) {
      const item = ownedModel(request);
      if (item.state !== 'pending') throw new Error('This model import was canceled and cannot be adopted');
      modelImports.delete(request.receipt);
      if ((watchedRoot !== undefined && watchedRoot !== item.root) || watchGeneration !== item.generation) throw new Error('The project changed before adopting the model; its files were retained');
    },
    async discardModel3d(request) {
      const item = ownedModel(request);
      item.state = 'canceled';
      const docPath = item.document;
      const savedBytes = files.get(docPath);
      if (savedBytes && JSON.parse(dec.decode(savedBytes)).assets?.some((a: { id: string }) => a.id === request.assetId)) throw new Error('This model is already saved in the project');
      for (const file of item.paths) files.delete(file);
      modelImports.delete(request.receipt);
    },
    async model3dSourceFingerprint(request) {
      if (watchedRoot !== undefined && norm(request.root) !== watchedRoot) throw new Error('The source project changed');
      const source = files.get(norm(request.sourcePath));
      if (!source) throw new Error(`ENOENT: ${request.sourcePath}`);
      if (source.length > 200 * 1048576) throw new Error('3D source exceeds 200 MiB');
      const hash = async (path?: string) => { const bytes = path ? files.get(norm(path)) : undefined; if (bytes && bytes.length > 4 * 1048576) throw new Error('3D manifest exceeds 4 MiB'); return bytes ? sha256(bytes) : null; };
      return { sourceSha256: await sha256(source), manifestHash: await hash(request.manifestPath), storedManifestHash: await hash(request.storedManifestPath) };
    },
    async model3dAvailability() { return { disabled: false }; },
    _runnerCalls: runnerCalls,
    _emitRunnerEvent: emitRunner,
    _setRunnerCapabilities: (caps) => { runnerCaps = caps; },
    async runnerCapabilities() { return runnerCaps.map(c => ({ ...c })); },
    async runnerStart(options) {
      const runId = crypto.randomUUID(), driver = options.driver ?? "claude";
      runnerCalls.push({ method: "start", options: { ...options, runId } });
      runs.set(runId, { seq: 0, options });
      queueMicrotask(() => emitRunner(runId, { type: "session", sessionId: "fixture-session" }));
      return { runId, driver };
    },
    async runnerSend(options) {
      if (!runs.has(options.runId)) throw new Error("Unknown fixture run");
      runnerCalls.push({ method: "send", options });
      emitRunner(options.runId, { type: "status", state: "running" });
    },
    async runnerRespond(options) {
      runnerCalls.push({ method: "respond", options });
      emitRunner(options.runId, { type: "permission.closed", permissionId: options.permissionId });
    },
    async runnerCancel(options) {
      runnerCalls.push({ method: "cancel", options });
      emitRunner(options.runId, { type: "status", state: "cancelled" }); runs.delete(options.runId);
    },
    onRunnerEvent(cb) { runnerEvents.add(cb); return () => runnerEvents.delete(cb); },
    reads,
    _files: files,
    _dirs: dirs,
    // Dev-only: lets the headless harness simulate an external (agent) fs change.
    _emitFsChange: (info) => {
      for (const l of fsListeners) l(info);
      // The real watcher also sends every changed path under plots/ in one batch.
      if (info.subsystem === "plots" || info.subsystem === "dissections")
        for (const l of batchListeners) l({ subsystem: info.subsystem, paths: [info.path] });
    },
    // --- the Plots rail (electron/ipc/plotThumbs.cjs in the app) --------------------------
    async stat(p) {
      const b = files.get(norm(p));
      if (!b) return null;
      return { mtimeMs: mtimes.get(norm(p)) ?? 0, size: b.byteLength };
    },
    async plotsList(request) {
      const base0 = request.scope === "global" ? "/home/demo/FluxConfig/plot_library" : watchedRoot ? `${watchedRoot}/plots` : "";
      const collection = request.collection && RESERVED_PLOT_DIRNAMES.includes(request.collection) ? request.collection : "";
      const base = collection ? `${base0}/${collection}` : base0;
      if (!base0) return { base: "", entries: [], truncated: false };
      const exts = new Set(fileAcceptExts(request.accept ?? "svg,png"));
      const listBundles = acceptsFluximg(request.accept);
      const only = request.dirs ? new Set(request.dirs.map(norm)) : null;
      const entries: PlotIndexEntry[] = [];
      const seenDirs = new Set<string>();
      // Image bundles: one entry per `*.fluximg` directory, never its inner files (the engine's rule, shared:
      // plotThumbRules.fluximgIndexEntry). Found from the files under them and from empty bundle folders.
      const bundles = new Map<string, string>(); // abs → rel
      const noteBundle = (key: string): boolean => {
        const at = fluximgBundleOf(key.slice(base.length + 1));
        if (at === null) return false;
        const abs = `${base}/${at}`;
        if (key === abs && !memIsDir(abs)) return false; // a FILE named x.fluximg is not a bundle
        const parts = at.split("/");
        if (!collection && parts.slice(0, -1).some((d) => RESERVED_PLOT_DIRNAMES.includes(d))) return true;
        if (!listBundles || (only && !only.has(parentOf(abs)))) return true;
        bundles.set(abs, at);
        return true;
      };
      for (const dir of dirs) if (dir.startsWith(base + "/")) noteBundle(dir);
      for (const [key, bytes] of files) {
        if (!key.startsWith(base + "/")) continue;
        const rel = key.slice(base.length + 1);
        const parts = rel.split("/");
        const name = parts[parts.length - 1];
        const parent = parentOf(key);
        if (!collection && parts.slice(0, -1).some((d) => RESERVED_PLOT_DIRNAMES.includes(d))) continue;
        if (noteBundle(key)) { seenDirs.add(parentOf(`${base}/${fluximgBundleOf(rel)}`)); continue; }
        seenDirs.add(parent);
        if (only && !only.has(parent)) continue;
        const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
        if (!exts.has(ext) || /\.(fluxplot|recipe|snip)\.json$/i.test(name)) continue;
        entries.push({ rel, abs: key, size: bytes.byteLength, mtimeMs: mtimes.get(key) ?? 0,
          semantic: /\.(svg|glb)$/i.test(name) && files.has(key.replace(/\.(svg|glb)$/i, ".fluxplot.json")),
          snip: /\.png$/i.test(name) && files.has(key.replace(/\.png$/i, ".snip.json")) });
      }
      const statOf = (key: string) => { const b = files.get(key); return b ? { size: b.byteLength, mtimeMs: mtimes.get(key) ?? 0 } : null; };
      for (const [abs, rel] of bundles)
        entries.push(fluximgIndexEntry({ rel, abs, manifest: statOf(`${abs}/${FLUXIMG_MANIFEST_NAME}`), preview: statOf(`${abs}/${FLUXIMG_PREVIEW_NAME}`) }));
      const missing = only ? [...only].filter((d) => !seenDirs.has(d) && !dirs.has(d)) : [];
      return { base, entries, truncated: false, missing };
    },
    async plotsProbe(paths) {
      return paths.map((abs) => {
        const b = files.get(norm(abs));
        if (!b) return { abs, error: "missing" };
        const size = probeImageSize(abs, /\.svg$/i.test(abs) ? dec.decode(b.subarray(0, 16384)) : b);
        const stamp = { size: b.byteLength, mtimeMs: mtimes.get(norm(abs)) ?? 0 };
        return size ? { abs, w: size.width, h: size.height, physMm: size.physMm, ...stamp } : { abs, error: "unknown", ...stamp };
      });
    },
    async plotThumb(request) {
      // A gate can switch the "worker" off to walk the renderer's fallback path.
      if (localStorage.getItem("flux.fixture.thumbsUnavailable") === "1") return { error: "unavailable", unavailable: true };
      const abs = norm(request.path);
      const b = files.get(abs);
      if (!b) return { error: "missing" };
      if (/\.webp$/i.test(abs)) return { error: "unsupported image format", unsupported: true };
      // A gate's stand-in for a file that crashes or hangs the app's worker (it is quarantined).
      if (abs.includes("__kills_worker__")) return { error: "the preview timed out", quarantined: true };
      try {
        const { renderThumbInBrowser } = await import("../plotsRail/browserThumb");
        const t = await renderThumbInBrowser(b, abs, request.bucket);
        let paper: string | null = null;
        const sidecar = files.get(abs.replace(/\.svg$/i, ".fluxplot.json"));
        if (/\.svg$/i.test(abs) && sidecar) {
          try { const tok = JSON.parse(dec.decode(sidecar))?.style?.tokens; const v = tok?.paper ?? tok?.plot; if (typeof v === "string") paper = v; } catch { /* no paper */ }
        }
        // Pre-warm (the rail's idle generation): the app's worker fills its disk cache and returns
        // no bytes; here the render is the work, and gates read the count.
        if (request.warm) {
          const w = window as unknown as { __fluxPrewarmed?: string[] };
          (w.__fluxPrewarmed ??= []).push(abs);
          return { warmed: true, stats: t.stats, paper };
        }
        return { bytes: t.png, width: t.width, height: t.height, stats: t.stats, paper, naturalWidth: t.naturalWidth, naturalHeight: t.naturalHeight };
      } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    },
    async plotThumbCancel() {},
    async dissectCounts(keys) {
      const out: Record<string, number> = {};
      const root = watchedRoot ?? "";
      for (const key of keys) {
        const dir = `${root}/plots/${dissectionRootRelFor(key)}`;
        if (!dir.startsWith(`${root}/${DISSECT_REL}/`)) continue;
        let n = 0, any = dirs.has(dir);
        for (const f of files.keys()) {
          if (!f.startsWith(dir + "/")) continue;
          const rest = f.slice(dir.length + 1).split("/");
          if (rest.length > 2) continue;
          any = true;
          if (classifyDissectionFile(rest[rest.length - 1]) !== "sidecar") n++;
        }
        if (any) out[key] = n;
      }
      return out;
    },
    async saveDissectionNote(request) {
      if (request.root !== watchedRoot) throw new Error("The plot's project is no longer open");
      const target = joinPath(request.root, dissectionNoteRel(request.key, request.group, request.name));
      if (enc.encode(request.text).byteLength > DISSECT_NOTE_MAX_BYTES) throw new Error("Plot notes are limited to 1 MiB");
      const current = files.get(target);
      const text = current === undefined ? null : typeof current === "string" ? current : dec.decode(current);
      if (text !== request.expected) throw new Error("This note changed outside Flux. Your draft is kept; reopen the note to compare before saving.");
      ensureParent(target);
      files.set(norm(target), enc.encode(request.text));
      mtimes.set(norm(target), Date.now());
      return { path: target };
    },
    onFsChangedBatch(cb) {
      batchListeners.add(cb);
      return () => batchListeners.delete(cb);
    },
    // Dev-only stand-in for Electron's win:capture (Snapshot & annotate): a PNG the size of
    // the window, so the overlay's ASYNC capture path — the one every real build takes — runs
    // in the browser harness too. Without it the ui gate only ever saw the synchronous
    // no-capture branch, and the overlay could fail to open in Electron with the gate green
    // (2026-09-26). The blue corner marks the image as a capture, not the live DOM.
    async captureWindow(rect) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round((rect?.width ?? window.innerWidth) * dpr));
      const h = Math.max(1, Math.round((rect?.height ?? window.innerHeight) * dpr));
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fffcf0";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#205ea6";
      ctx.fillRect(0, 0, Math.min(w, 64 * dpr), Math.min(h, 64 * dpr));
      const blob = await c.convertToBlob({ type: "image/png" });
      return { png: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
    },
    // The figure atlas's cold route is a main-process worker (electron/ipc/figureRaster.cjs). The browser
    // harness has no main process, so it answers "unavailable": the atlas then rasterizes figures from their
    // live DOM only (route L), which is exactly the path the ui gates drive. A harness bridge must carry every
    // method the real bridge has (guide §9): a missing optional method silently selects an untested branch.
    async rasterizeFigure() {
      return { error: "unavailable" };
    },
    async cancelFigureRaster() {},
    watchRoot(root) {
      const next = root === null ? null : norm(root);
      if (next !== watchedRoot) { watchedRoot = next; watchGeneration++; memTiff._forgetTiffs(); }
      return true;
    },
    onFsChanged(cb) {
      fsListeners.add(cb);
      return () => fsListeners.delete(cb);
    },
    async resolveUrl() {
      return { error: "URL resolution is unavailable in the demo fixture (use Surface B)." };
    },
    async mkdir(p) {
      addDir(p);
    },
    async writeText(p, text, options) {
      if (options?.createOnly && (files.has(norm(p)) || dirs.has(norm(p)))) throw new Error(`EEXIST: ${p}`);
      ensureParent(p);
      files.set(norm(p), enc.encode(text));
    },
    async feedbackAppend(p, line) {
      ensureParent(p);
      const key = norm(p);
      const cur = files.get(key);
      const add = enc.encode(line);
      if (!cur) files.set(key, add);
      else {
        const merged = new Uint8Array(cur.length + add.length);
        merged.set(cur);
        merged.set(add, cur.length);
        files.set(key, merged);
      }
      return true;
    },
    async readTextBounded(p, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('Invalid bounded text limit');
      const bytes = files.get(norm(p));
      if (!bytes) throw new Error(`ENOENT: ${p}`);
      const truncated = bytes.length > maxBytes;
      return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: truncated }), truncated, totalBytes: bytes.length };
    },
    async readText(p) {
      reads.push(norm(p));
      const b = files.get(norm(p));
      if (!b) throw new Error(`ENOENT: ${p}`);
      return dec.decode(b);
    },
    async readModelFile(p, root) {
      const base = norm(root), key = norm(p);
      if (!base || watchedRoot !== undefined && watchedRoot !== base) throw new Error('The project changed while reading the model');
      if (!key.startsWith(`${base}/`) || key.split('/').some(part => part === '..')) throw new Error('Model file escapes the project');
      const bytes = files.get(key); if (!bytes) throw new Error(`ENOENT: ${p}`);
      if (bytes.byteLength > GLB_LIMITS.maxBytes) throw new Error('GLB exceeds 200 MiB');
      return new Uint8Array(bytes).buffer;
    },
    async readFile(p) {
      reads.push(norm(p));
      const b = files.get(norm(p));
      if (!b) throw new Error(`ENOENT: ${p}`);
      const ab = new ArrayBuffer(b.byteLength);
      new Uint8Array(ab).set(b);
      return ab;
    },
    async copyFileVerified(source, destination, expected) {
      const bytes=files.get(norm(source)); if(!bytes) throw new Error(`ENOENT: ${source}`);
      const hash=await sha256(bytes); if(expected!==undefined&&hash!==expected) throw new Error("Copy source hash changed");
      const previous=files.get(norm(destination)); if(previous&&await sha256(previous)!==hash) throw new Error("Copy destination contains different bytes");
      ensureParent(destination); files.set(norm(destination),new Uint8Array(bytes)); return hash;
    },
    async writeFile(p, data) {
      ensureParent(p);
      files.set(norm(p), new Uint8Array(data));
    },
    async exists(p) {
      const n = norm(p);
      return files.has(n) || dirs.has(n);
    },
    async readdir(p) {
      const base = norm(p);
      const out = new Map<string, boolean>();
      for (const f of files.keys()) if (parentOf(f) === base) out.set(baseOf(f), false);
      for (const d of dirs) if (d !== base && parentOf(d) === base) out.set(baseOf(d), true);
      return [...out].map(([name, dir]) => ({ name, dir }));
    },
    async remove(p) {
      files.delete(norm(p));
      dirs.delete(norm(p));
    },
    async trash(p) {
      // The fixture has no OS trash: a plain remove, reported as such.
      const existed = files.delete(norm(p));
      return { trashed: false, existed };
    },
    async paths() {
      return { home: "/home/demo", userData: "/home/demo/.config/flux", documents: "/home/demo/Documents" };
    },
    // Machine-global text-style library — localStorage-backed in the fixture so
    // verify scripts can exercise the copy-on-apply flow without Electron.
    async readGlobalTextStyles() {
      try {
        const raw = localStorage.getItem("flux.textstyles");
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    async writeGlobalTextStyles(styles) {
      try {
        localStorage.setItem("flux.textstyles", JSON.stringify(styles ?? []));
      } catch {
        /* quota/serialization failure — the library is best-effort in the fixture */
      }
    },
    // Design presets — localStorage-backed in the fixture (entries shaped like
    // the Electron store: { rel, preset }) so the picker + save flow verify
    // headless.
    async readDesignPresets() {
      try {
        const parsed = JSON.parse(localStorage.getItem("flux.presets.designs") || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    async writeDesignPreset(rel, preset) {
      try {
        const raw = JSON.parse(localStorage.getItem("flux.presets.designs") || "[]");
        const cur = (Array.isArray(raw) ? raw : []) as { rel: string }[];
        const next = [...cur.filter((p) => p.rel !== rel), { rel, preset }];
        localStorage.setItem("flux.presets.designs", JSON.stringify(next));
        return true;
      } catch {
        return false;
      }
    },
    async deleteDesignPreset(rel) {
      try {
        const raw = JSON.parse(localStorage.getItem("flux.presets.designs") || "[]");
        const cur = (Array.isArray(raw) ? raw : []) as { rel: string }[];
        localStorage.setItem("flux.presets.designs", JSON.stringify(cur.filter((p) => p.rel !== rel)));
        return true;
      } catch {
        return false;
      }
    },
    // Animation presets/templates — same localStorage twin pattern as the
    // design presets ({ rel, payload } entries; kind picks the key).
    async readAnimLibrary(kind) {
      try {
        const parsed = JSON.parse(localStorage.getItem(kind === "template" ? "flux.presets.animTemplates" : "flux.presets.animations") || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    async writeAnimLibrary(kind, rel, payload) {
      try {
        const key = kind === "template" ? "flux.presets.animTemplates" : "flux.presets.animations";
        const raw = JSON.parse(localStorage.getItem(key) || "[]");
        const cur = (Array.isArray(raw) ? raw : []) as { rel: string }[];
        localStorage.setItem(key, JSON.stringify([...cur.filter((p) => p.rel !== rel), { rel, payload }]));
        return true;
      } catch {
        return false;
      }
    },
    async deleteAnimLibrary(kind, rel) {
      try {
        const key = kind === "template" ? "flux.presets.animTemplates" : "flux.presets.animations";
        const raw = JSON.parse(localStorage.getItem(key) || "[]");
        const cur = (Array.isArray(raw) ? raw : []) as { rel: string }[];
        localStorage.setItem(key, JSON.stringify(cur.filter((p) => p.rel !== rel)));
        return true;
      } catch {
        return false;
      }
    },
    // Slide presets — same localStorage twin pattern ({ rel, payload } entries).
    async readSlideLibrary() {
      try {
        const parsed = JSON.parse(localStorage.getItem("flux.presets.slides") || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    async writeSlideLibrary(rel, payload) {
      try {
        const raw = JSON.parse(localStorage.getItem("flux.presets.slides") || "[]");
        const cur = (Array.isArray(raw) ? raw : []) as { rel: string }[];
        localStorage.setItem("flux.presets.slides", JSON.stringify([...cur.filter((p) => p.rel !== rel), { rel, payload }]));
        return true;
      } catch {
        return false;
      }
    },
    async deleteSlideLibrary(rel) {
      try {
        const raw = JSON.parse(localStorage.getItem("flux.presets.slides") || "[]");
        const cur = (Array.isArray(raw) ? raw : []) as { rel: string }[];
        localStorage.setItem("flux.presets.slides", JSON.stringify(cur.filter((p) => p.rel !== rel)));
        return true;
      } catch {
        return false;
      }
    },
    async openDirectory() {
      return "/demo/myc-growth-paper";
    },
    async openFiles() {
      // No OS file picker in the demo fixture; a browser gate may stage the
      // "picked" paths (the real bridge's dlg:open returns absolute paths too).
      const staged = (globalThis as { __fluxDemoOpenFiles?: string[] }).__fluxDemoOpenFiles;
      return staged?.length ? [...staged] : null;
    },
    async save(defaultPath) {
      return joinPath("/demo", defaultPath || "untitled");
    },
    async printPdf(html, outPath) {
      // No real rasterizer on Surface A; record the HTML so the export flow can be
      // exercised end-to-end (Surface B does the true PDF render).
      files.set(norm(outPath), enc.encode(html));
      return true;
    },
    async fetchDoi() {
      return { error: "DOI fetch is unavailable in the demo fixture (use Surface B)." };
    },
    async fetchOpenAlex(url) {
      // OpenAlex sends permissive CORS, so the browser demo can fetch it directly.
      try {
        const r = await fetch(String(url));
        if (!r.ok) return { error: `HTTP ${r.status}` };
        return await r.json();
      } catch (e) {
        return { error: String((e && (e as Error).message) || e) };
      }
    },
    async fetchS2(url) {
      try {
        const r = await fetch(String(url));
        if (!r.ok) return { error: `HTTP ${r.status}` };
        return await r.json();
      } catch (e) {
        return { error: String((e && (e as Error).message) || e) };
      }
    },
    async netGet(url, mode) {
      try {
        const r = await fetch(String(url), { redirect: "follow" });
        if (!r.ok) return { error: `HTTP ${r.status}`, status: r.status };
        if (mode === "json") return { json: await r.json() };
        if (mode === "text") return { text: await r.text() };
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return { bytesB64: btoa(bin), contentType: r.headers.get("content-type") || "", finalUrl: r.url || String(url) };
      } catch (e) {
        return { error: String((e && (e as Error).message) || e) };
      }
    },
    async keysGet() {
      const p = norm("/home/demo/FluxConfig/FluxLib/keys.json");
      try {
        return files.has(p) ? JSON.parse(new TextDecoder().decode(files.get(p)!)) : {};
      } catch {
        return {};
      }
    },
    async keysSet(patch) {
      const p = norm("/home/demo/FluxConfig/FluxLib/keys.json");
      let cur: Record<string, unknown> = {};
      try {
        if (files.has(p)) cur = JSON.parse(new TextDecoder().decode(files.get(p)!));
      } catch {
        /* fresh */
      }
      const next = { ...cur, ...patch };
      ensureParent(p);
      files.set(p, enc.encode(JSON.stringify(next)));
      return next;
    },
    async openExternal() {
      /* no-op in the fixture */
    },
    async launchLighttable() {
      return { ok: false, error: "Lighttable is unavailable in the browser fixture." };
    },
    async checkForUpdate() {
      return null; // never self-checks in the dev fixture (packaged-only feature)
    },
    async updateInstall() {
      return { ok: false, error: "Updating is available in the installed app." };
    },
    // "Set up Flux…": a controllable fake machine (window.__fluxSetupFixture) so the ui gate
    // can drive every row's detection state and action without touching the real one.
    async setupStatus() {
      return setupFixture.status();
    },
    async setupAddToTerminal() {
      setupFixture.state.launcher = { ...setupFixture.state.launcher, installed: true, onPath: true };
      return { ...setupFixture.state.launcher, profileChanged: true };
    },
    async setupInstallQuarto() {
      return setupFixture.run("quarto");
    },
    async setupInstallTinytex() {
      return setupFixture.run("tinytex");
    },
    async setupCancel(task: "quarto" | "tinytex") {
      return setupFixture.cancel(task);
    },
    onSetupProgress(cb: (p: SetupProgress) => void) {
      setupFixture.listeners.add(cb);
      return () => setupFixture.listeners.delete(cb);
    },
    async quartoAvailable() {
      return { installed: false };
    },
    async quartoRender() {
      return { ok: false, log: "Quarto is unavailable in the demo fixture (use Surface B)." };
    },
    async quartoCancel() {
      return false; // nothing ever renders in the fixture, so nothing to cancel
    },
    onQuartoLog() {
      return () => {}; // no render, no log stream — a no-op unsubscribe
    },
    async prefsGet() {
      const p = norm("/home/demo/.config/flux/preferences.json");
      const resolved = {
        fluxLibResolved: "/home/demo/FluxConfig/FluxLib",
        fluxConfigResolved: "/home/demo/FluxConfig",
        plotLibraryResolved: "/home/demo/FluxConfig/plot_library",
      };
      try {
        return files.has(p)
          ? { ...resolved, ...JSON.parse(new TextDecoder().decode(files.get(p)!)) }
          : resolved;
      } catch {
        return resolved;
      }
    },
    async prefsSet(patch) {
      const p = norm("/home/demo/.config/flux/preferences.json");
      let cur: Record<string, unknown> = {};
      try {
        if (files.has(p)) cur = JSON.parse(new TextDecoder().decode(files.get(p)!));
      } catch {
        /* fresh prefs */
      }
      const next = { ...cur, ...patch };
      files.set(p, enc.encode(JSON.stringify(next)));
      return next;
    },
    async configMove() {
      return { error: "Moving FluxConfig needs the desktop app." };
    },
  };
}

const ROOT = "/demo/myc-growth-paper";

const MAIN_QMD = `---
title: "Mycelial growth under nutrient stress"
author:
  - Kort Driessen
bibliography: ../references/library.bib
---

# Results

Mycelial extension increased under nutrient stress (@fig-growth). The control
series plateaued by 18 h, whereas the treatment series continued to rise
(@fig-growth-a), consistent with earlier reports [@smith2021].

Panel @fig-growth-b shows the dose response.
`;

const LIBRARY_BIB = `% Bibliography for this project (BibLaTeX). Canonical source of truth.
@article{smith2021,
  title = {Nutrient stress responses in filamentous fungi},
  author = {Smith, Jane and Doe, John},
  journal = {Journal of Mycology},
  year = {2021},
  volume = {12},
  number = {3},
  pages = {45--67},
  doi = {10.1234/jmyc.2021.0045},
}
`;

const FIG_INDEX = {
  schemaVersion: "0.1.0",
  canvases: [{ id: "canvas-1", name: "Canvas 1", order: 1 }],
  figures: [
    {
      id: "growth",
      name: "Growth curves",
      label: "fig-growth",
      order: 1,
      kind: "main",
      canvas: "canvas-1",
      caption: "", // F7: the caption's source is fig/captions/growth.md, not the index
    },
  ],
  assets: [],
  palette: [],
  colorGroups: [],
};

const mkLabel = (id: string, text: string, x: number) => ({
  type: "text",
  id,
  name: `panel ${text}`,
  x,
  y: 6,
  width: 16,
  height: 22,
  rotation: 0,
  text,
  fontFamily: "Arial",
  fontSize: 18,
  fontWeight: 700,
  fontStyle: "normal",
  align: "left",
  color: "#111111",
  sizing: "auto",
  panelLabel: true,
});
const mkRect = (id: string, x: number, fill: string) => ({
  type: "rect",
  id,
  x,
  y: 32,
  width: 260,
  height: 240,
  rotation: 0,
  fill,
  stroke: "#222222",
  strokeWidth: 1,
  cornerRadius: 4,
});

const FIG_CANVAS = {
  schemaVersion: "0.1.0",
  id: "canvas-1",
  name: "Canvas 1",
  figures: [
    {
      id: "growth",
      name: "Growth curves",
      canvasId: "canvas-1",
      x: 0,
      y: 0,
      width: 600,
      height: 300,
      background: "#ffffff",
      elements: [
        mkRect("el-a-rect", 20, "#d95f02"),
        mkLabel("el-a", "a", 20),
        mkRect("el-b-rect", 320, "#1b9e77"),
        mkLabel("el-b", "b", 320),
      ],
      captions: {
        __figure__: "Mycelial growth under nutrient stress over 24 h.",
        "el-a": "Control vs treatment extension.",
        "el-b": "Dose response.",
      },
    },
  ],
};

/**
 * Install the in-memory bridge and seed the demo project. Returns the project
 * root, which the caller (main.ts) opens via shellStore.openProjectAt.
 */
export async function installDemoFixture(): Promise<string> {
  const bridge = createMemBridge();
  (window as unknown as { fig?: FileBridge }).fig = bridge;
  // Dev-only: let the headless harness simulate an external (agent/script) write.
  (window as unknown as { __fluxEmitFsChange?: unknown }).__fluxEmitFsChange = bridge._emitFsChange;
  // Dev-only: put a .fluximg bundle (written in Node by the reference writer, files as base64) into the
  // demo project, e.g. __fluxSeedFluximg("plots/cells.fluximg", { "fluximg.json": "…", … }).
  (window as unknown as { __fluxSeedFluximg?: unknown }).__fluxSeedFluximg = (bundle: string, content: Record<string, string>) =>
    bridge._seedFluximg(ROOT, bundle, content);
  // Dev-only: let the headless harness simulate a flux:// web capture.

  // Scaffold the real tree (project.json, _quarto.yml, AGENTS.md, dirs, …),
  // then enrich it with sample content so the two-module workflow is exercised.
  await scaffoldProject(ROOT, { title: "Mycelial growth under nutrient stress", author: "Kort Driessen" });

  const legacyManifest = JSON.parse(await bridge.readText(joinPath(ROOT, "project.json")));
  delete legacyManifest.documentRoot;
  legacyManifest.manuscript = { path: "manuscript/main.qmd", config: "manuscript/_quarto.yml", format: "quarto" };
  await bridge.writeText(joinPath(ROOT, "project.json"), JSON.stringify(legacyManifest, null, 2) + "\n");
  await bridge.remove?.(joinPath(ROOT, "paper/notes.qmd"));
  await bridge.remove?.(joinPath(ROOT, "paper/_quarto.yml"));
  await bridge.remove?.(joinPath(ROOT, "paper"));
  await bridge.writeText(joinPath(ROOT, "manuscript/main.qmd"), MAIN_QMD);
  await bridge.writeText(
    joinPath(ROOT, "manuscript/supp.qmd"),
    '---\ntitle: "Supplementary Material"\n---\n\n# Supplementary\n\nExtended methods and additional analyses.\n'
  );
  await bridge.writeText(joinPath(ROOT, "references/library.bib"), LIBRARY_BIB);
  await bridge.writeText(joinPath(ROOT, "fig/index.json"), JSON.stringify(FIG_INDEX, null, 2) + "\n");
  await bridge.writeText(
    joinPath(ROOT, "fig/canvases/canvas-1.json"),
    JSON.stringify(FIG_CANVAS, null, 2) + "\n"
  );
  await bridge.writeText(
    joinPath(ROOT, "fig/captions/growth.md"),
    "Mycelial growth under nutrient stress over 24 h. (a) Control vs treatment extension. (b) Dose response.\n"
  );

  // Keep project.json's figures rollup consistent with fig/index.json.
  try {
    const manifest = JSON.parse(await bridge.readText(joinPath(ROOT, "project.json")));
    manifest.figures = FIG_INDEX.figures.map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      order: f.order,
      kind: f.kind,
      canvas: f.canvas,
      caption: `fig/captions/${f.id}.md`,
    }));
    manifest.supplementary = [{ path: "manuscript/supp.qmd" }];
    await bridge.writeText(joinPath(ROOT, "project.json"), JSON.stringify(manifest, null, 2) + "\n");
  } catch {
    /* leave the scaffolded manifest as-is */
  }

  return ROOT;
}
