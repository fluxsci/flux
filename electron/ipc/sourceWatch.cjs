"use strict";
// Per-window exact-file source watches/read capabilities. No directory grant,
// write capability, recipe execution, or cross-window authorization is added.
const path = require("node:path");
const MAX_SOURCES = 20000;
function normalizeSourceWatchRequest(request) {
  if (!request || typeof request !== "object" || typeof request.root !== "string" || !path.isAbsolute(request.root) || request.root.includes("\0")) throw new Error("Invalid linked source project root");
  if (typeof request.scope !== "string" || !/^(?:fig|slides\/[A-Za-z0-9_-]+)$/.test(request.scope)) throw new Error("Invalid linked source scope");
  if (!Array.isArray(request.sources) || request.sources.length > MAX_SOURCES) throw new Error("Invalid linked source list");
  const files = new Set();
  const checked = (p, ext) => {
    if (typeof p !== "string" || p.length > 32768 || !path.isAbsolute(p) || p.includes("\0") || !p.toLowerCase().endsWith(ext)) throw new Error(`Invalid linked source ${ext} path`);
    return path.resolve(p);
  };
  for (const source of request.sources) {
    if (!source || typeof source !== "object") throw new Error("Invalid linked source");
    const svg = checked(source.svgPath, ".svg");
    files.add(svg);
    files.add(svg.replace(/\.svg$/i, ".fluxplot.json"));
    files.add(svg.replace(/\.svg$/i, ".recipe.json"));
    if (source.manifestPath != null) files.add(checked(source.manifestPath, ".json"));
    if (source.recipePath != null) files.add(checked(source.recipePath, ".json"));
  }
  return { root: path.resolve(request.root), scope: request.scope, files: [...files] };
}
function createSourceWatchCore({ sessionFor, pendingRootFor, fileCore, loadChokidar, notify }) {
  const states = new Map();
  const sameRoot = (a, b) => a && b && (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  async function clear(senderId) {
    const state = states.get(senderId);
    states.delete(senderId);
    fileCore.clearSourceReadFiles(senderId);
    if (state?.timer) clearTimeout(state.timer);
    if (state?.watcher) await state.watcher.close().catch(() => {});
  }
  async function setRoot(senderId, root) {
    const state = states.get(senderId);
    if (!root || !state || !sameRoot(state.root, root)) { await clear(senderId); return; }
    // watch:setRoot clears dialog approvals while promoting pendingRoot.
    // Reapply exact read grants already registered during that same open.
    for (const [scope, files] of state.scopes) fileCore.setSourceReadFiles(senderId, scope, files);
  }
  async function setFiles(e, request) {
    const normalized = normalizeSourceWatchRequest(request);
    const session = sessionFor(e), senderId = e.sender.id;
    if (!session || ![session.root, pendingRootFor(senderId)].some((root) => sameRoot(root, normalized.root))) throw new Error("Linked source project does not belong to this window");
    let state = states.get(senderId);
    if (state && !sameRoot(state.root, normalized.root)) { await clear(senderId); state = null; }
    if (!state) {
      state = { root: normalized.root, scopes: new Map(), files: new Set(), watcher: null, timer: null, chain: Promise.resolve() };
      states.set(senderId, state);
    }
    const current = state;
    // Serialize additions/removals for figure and deck callers sharing a window.
    const work = state.chain.catch(() => {}).then(async () => {
      if (states.get(senderId) !== current) return { watched: 0 };
      const s = sessionFor(e);
      if (!s || ![s.root, pendingRootFor(senderId)].some((root) => sameRoot(root, normalized.root))) throw new Error("Linked source project changed during registration");
      current.scopes.set(normalized.scope, normalized.files);
      fileCore.setSourceReadFiles(senderId, normalized.scope, normalized.files);
      const files = new Set([...current.scopes.values()].flat());
      const prior = current.files;
      current.files = files;
      let created = false;
      if (!current.watcher && files.size) {
        const ck = await loadChokidar();
        if (!ck) throw new Error("Live linked-source watching is unavailable");
        if (states.get(senderId) !== current) return { watched: 0 };
        current.watcher = ck.watch([], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 } });
        created = true;
        current.watcher.on("all", (_event, file) => {
          const absolute = path.resolve(file);
          if (states.get(senderId) !== current || !current.files.has(absolute) || fileCore.isSelfWrite(absolute)) return;
          current.changed = absolute;
          if (!current.timer) current.timer = setTimeout(() => {
            current.timer = null;
            if (states.get(senderId) === current && !s.win.isDestroyed()) s.win.webContents.send("fs:changed", { subsystem: "plots", path: current.changed });
          }, 200);
        });
        current.watcher.on("error", (err) => notify("error", "Linked source file-watch stopped", String(err?.message ?? err)));
      }
      if (current.watcher) {
        await current.watcher.unwatch([...prior].filter((p) => !files.has(p)));
        current.watcher.add([...files].filter((p) => created || !prior.has(p)));
      }
      return { watched: files.size };
    });
    state.chain = work;
    return work;
  }
  return { setFiles, setRoot, clear, clearAll: () => Promise.all([...states.keys()].map(clear)), registerHandlers(ipc) { ipc.handle("watch:setSourceFiles", setFiles); } };
}
module.exports = { createSourceWatchCore, normalizeSourceWatchRequest };
