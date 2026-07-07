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
import { joinPath, type FileBridge } from "./types";

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
  _files: Map<string, Uint8Array>;
  _dirs: Set<string>;
  _emitFsChange: (info: { subsystem: string; path: string }) => void;
  _emitCapture: (p: { doi?: string; url?: string }) => void;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  const fsListeners = new Set<(info: { subsystem: string; path: string }) => void>();
  const captureListeners = new Set<(p: { doi?: string; url?: string }) => void>();

  const addDir = (p: string) => {
    let cur = norm(p);
    while (cur && !dirs.has(cur)) {
      dirs.add(cur);
      if (cur === "/") break;
      cur = parentOf(cur);
    }
  };
  const ensureParent = (p: string) => addDir(parentOf(p));

  return {
    _files: files,
    _dirs: dirs,
    // Dev-only: lets the headless harness simulate an external (agent) fs change.
    _emitFsChange: (info) => {
      for (const l of fsListeners) l(info);
    },
    // Dev-only: lets the headless harness simulate a flux:// web capture.
    _emitCapture: (p) => {
      for (const l of captureListeners) l(p);
    },
    watchRoot() {
      return true;
    },
    onFsChanged(cb) {
      fsListeners.add(cb);
      return () => fsListeners.delete(cb);
    },
    onCapture(cb) {
      captureListeners.add(cb);
      return () => captureListeners.delete(cb);
    },
    async resolveUrl() {
      return { error: "URL resolution is unavailable in the demo fixture (use Surface B)." };
    },
    async mkdir(p) {
      addDir(p);
    },
    async writeText(p, text) {
      ensureParent(p);
      files.set(norm(p), enc.encode(text));
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
    },
    async paths() {
      return { home: "/home/demo", userData: "/home/demo/.config/Flux", documents: "/home/demo/Documents" };
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
      const p = norm("/home/demo/FluxLib/keys.json");
      try {
        return files.has(p) ? JSON.parse(new TextDecoder().decode(files.get(p)!)) : {};
      } catch {
        return {};
      }
    },
    async keysSet(patch) {
      const p = norm("/home/demo/FluxLib/keys.json");
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
    async checkForUpdate() {
      return null; // never self-checks in the dev fixture (packaged-only feature)
    },
    async quartoAvailable() {
      return { installed: false };
    },
    async quartoRender() {
      return { ok: false, log: "Quarto is unavailable in the demo fixture (use Surface B)." };
    },
    async prefsGet() {
      const p = norm("/home/demo/.config/Flux/preferences.json");
      const resolved = { fluxLibResolved: "/home/demo/FluxLib" };
      try {
        return files.has(p)
          ? { ...resolved, ...JSON.parse(new TextDecoder().decode(files.get(p)!)) }
          : resolved;
      } catch {
        return resolved;
      }
    },
    async prefsSet(patch) {
      const p = norm("/home/demo/.config/Flux/preferences.json");
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
  autoWidth: true,
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
  (window as unknown as { __fluxEmitCapture?: unknown }).__fluxEmitCapture = bridge._emitCapture;

  // Scaffold the real tree (project.json, _quarto.yml, AGENTS.md, dirs, …),
  // then enrich it with sample content so the two-module workflow is exercised.
  await scaffoldProject(ROOT, { title: "Mycelial growth under nutrient stress", author: "Kort Driessen" });

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
