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
import { joinPath, type FileBridge, type RunnerCapability, type RunnerEvent, type RunnerPayload, type RunnerStart } from "./types";
import type { Model3dImportRequest, Model3dImportResult, Model3dImportOwnership } from '../model3d/importData';

const sha256 = async (bytes:Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,"0")).join("");
const enc = new TextEncoder();
const dec = new TextDecoder();

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
  _files: Map<string, Uint8Array>;
  _dirs: Set<string>;
  _emitFsChange: (info: { subsystem: string; path: string }) => void;
} {
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
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  const fsListeners = new Set<(info: { subsystem: string; path: string }) => void>();
  let watchedRoot: string | null | undefined, watchGeneration = 0;
  const modelImports = new Map<string, { root: string; generation: number; state: 'pending' | 'canceled'; result: Model3dImportResult; paths: string[] }>();

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
    if (request.target?.kind !== 'figure') throw new Error('3D import requires a Figure target');
    const documentBytes = files.get(`${root}/project.json`);
    if (!documentBytes) throw new Error('Save the project before importing a 3D model');
    const document = JSON.parse(dec.decode(documentBytes));
    const prefix = typeof document.schemaVersion === 'string' ? 'fig' : document.version === 2 && Array.isArray(document.figures) ? '' : null;
    if (prefix === null) throw new Error('Unrecognized Figure project format');
    const sourcePath = norm(request.sourcePath);
    if (!/\.glb$/i.test(dropped?.name ?? sourcePath)) throw new Error('Choose a binary .glb model file');
    if (dropped && dropped.size > 200 * 1024 * 1024) throw new Error('GLB exceeds 200 MiB');
    const bytes = dropped ? new Uint8Array(await dropped.arrayBuffer()) : files.get(sourcePath);
    if (!bytes) throw new Error(`Missing GLB source ${sourcePath}`);
    const manifestPath = sourcePath.replace(/\.glb$/i, '.fluxplot.json');
    const recipePath = sourcePath.replace(/\.glb$/i, '.recipe.json');
    const manifestText = !dropped && files.has(manifestPath) ? dec.decode(files.get(manifestPath)) : undefined;
    const recipeText = !dropped && files.has(recipePath) ? dec.decode(files.get(recipePath)) : undefined;
    const { prepareModel3dImport } = await import('../model3d/importData');
    const prepared = await prepareModel3dImport({ bytes, assetId: `model-${crypto.randomUUID()}`, name: dropped?.name ?? baseOf(sourcePath), manifestText, recipeText });
    assertOwner();
    const result: Model3dImportResult = { ...prepared.data, receipt: crypto.randomUUID(), assetPrefix: prefix,
      source: { glbPath: sourcePath, ...(manifestText !== undefined ? { manifestPath } : {}), ...(recipeText !== undefined ? { recipePath } : {}), ...(dropped ? { frozen: true } : {}) } };
    const directory = joinPath(root, prefix, 'assets'), paths: string[] = [];
    const entries: [string, Uint8Array][] = [[`${directory}/${result.asset.id}.glb`, prepared.bytes]];
    if (result.raw?.manifest !== undefined) entries.push([`${directory}/${result.asset.id}.fluxplot.json`, enc.encode(result.raw.manifest)]);
    if (result.raw?.recipe !== undefined) entries.push([`${directory}/${result.asset.id}.recipe.json`, enc.encode(result.raw.recipe)]);
    for (const [file] of entries) if (files.has(file)) throw new Error('Model import destination already exists');
    for (const [file, content] of entries) { ensureParent(file); files.set(file, content); paths.push(file); }
    modelImports.set(result.receipt, { root, generation, state: 'pending', result, paths });
    return result;
  }
  function ownedModel(request: Model3dImportOwnership) {
    const item = modelImports.get(request.receipt);
    if (!item || item.root !== norm(request.root) || request.target?.kind !== 'figure' || item.result.asset.id !== request.assetId) throw new Error('Unknown or already adopted model import receipt');
    return item;
  }

  return {
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
      const docPath = joinPath(item.root, item.result.assetPrefix, item.result.assetPrefix ? 'index.json' : 'project.json');
      const savedBytes = files.get(docPath);
      if (savedBytes && JSON.parse(dec.decode(savedBytes)).assets?.some((a: { id: string }) => a.id === request.assetId)) throw new Error('This model is already saved in the project');
      for (const file of item.paths) files.delete(file);
      modelImports.delete(request.receipt);
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
    _files: files,
    _dirs: dirs,
    // Dev-only: lets the headless harness simulate an external (agent) fs change.
    _emitFsChange: (info) => {
      for (const l of fsListeners) l(info);
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
    watchRoot(root) {
      const next = root === null ? null : norm(root);
      if (next !== watchedRoot) { watchedRoot = next; watchGeneration++; }
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
      const b = files.get(norm(p));
      if (!b) throw new Error(`ENOENT: ${p}`);
      return dec.decode(b);
    },
    async readFile(p) {
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
      return null; // no OS file picker in the demo fixture
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
    async proxyStatus() {
      return { configured: false, signedIn: false }; // no library proxy in the demo
    },
    async proxyLogin() {
      return { error: "Library proxy is unavailable in the demo fixture (use the desktop app)." };
    },
    async fetchViaProxy() {
      return { error: "Library proxy is unavailable in the demo fixture (use the desktop app)." };
    },
    async proxyCancel() {
      return { ok: true }; // nothing to cancel in the demo (Part B is inert here)
    },
    async proxySetCredentials() {
      return { error: "Credential storage is unavailable in the demo fixture (use the desktop app)." };
    },
    async proxyHasCredentials() {
      return { username: "", hasPassword: false, available: false };
    },
    async proxyClearCredentials() {
      return { ok: true };
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
