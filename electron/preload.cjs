const { contextBridge, ipcRenderer } = require("electron");

// Exposed to the renderer as `window.fig`. The renderer never touches Node
// directly; all filesystem / dialog / export work happens in the main process.
contextBridge.exposeInMainWorld("fig", {
  openFiles: (filters) => ipcRenderer.invoke("dlg:open", { multiple: true, filters }),
  openDirectory: (title) => ipcRenderer.invoke("dlg:open", { directory: true, title }),
  save: (defaultPath, filters) => ipcRenderer.invoke("dlg:save", { defaultPath, filters }),
  readFile: (p) => ipcRenderer.invoke("fs:readFile", p),
  writeFile: (p, data) => ipcRenderer.invoke("fs:writeFile", p, data),
  readText: (p) => ipcRenderer.invoke("fs:readText", p),
  writeText: (p, text) => ipcRenderer.invoke("fs:writeText", p, text),
  mkdir: (p) => ipcRenderer.invoke("fs:mkdir", p),
  exists: (p) => ipcRenderer.invoke("fs:exists", p),
  readdir: (p) => ipcRenderer.invoke("fs:readdir", p),
  exportPdf: (svg, outPath, w, h) => ipcRenderer.invoke("export:pdf", { svg, outPath, w, h }),
  // Render a full HTML document (multi-page, CSS @page-driven) to a PDF.
  printPdf: (html, outPath, opts) => ipcRenderer.invoke("print:pdf", { html, outPath, opts }),

  // Citation metadata fetch (CrossRef) — runs in main to avoid CORS.
  fetchDoi: (doi) => ipcRenderer.invoke("cite:fetchDoi", doi),
  // Open a URL (e.g. a DOI link) in the OS browser.
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  // Optional external tools.
  quartoAvailable: () => ipcRenderer.invoke("quarto:available"),
  quartoRender: (root, to) => ipcRenderer.invoke("quarto:render", { root, to }),

  // Host platform ("darwin" | "linux" | "win32") — lets the renderer adapt its chrome
  // (e.g. defer to the native macOS traffic lights instead of custom window buttons).
  platform: process.platform,

  // App / user paths.
  paths: () => ipcRenderer.invoke("app:paths"),

  // File-watch live reload (F1): register the open project root, and subscribe to
  // external (agent/script) changes mapped to a subsystem ("fig"|"plots"|
  // "manuscript"|"references"). Returns an unsubscribe fn.
  watchRoot: (root) => ipcRenderer.invoke("watch:setRoot", root),
  // F2: re-run a plot's recipe; returns { code, svgText, manifestText, recipeText }.
  runRecipe: (recipePath, params) => ipcRenderer.invoke("recipe:run", { recipePath, params }),
  onFsChanged: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("fs:changed", handler);
    return () => ipcRenderer.removeListener("fs:changed", handler);
  },

  // WS6: provenance journal + advisory locks. Main appends/writes under .meta/
  // (suppressing the self-write echo); both no-op until a project is open.
  journalAppend: (entry) => ipcRenderer.invoke("journal:append", entry),
  lockSet: (name, held) => ipcRenderer.invoke("lock:set", { name, held }),

  // Frameless window controls (used by the custom title bar).
  win: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    maximizeToggle: () => ipcRenderer.invoke("win:maximizeToggle"),
    close: () => ipcRenderer.invoke("win:close"),
    isMaximized: () => ipcRenderer.invoke("win:isMaximized"),
    onMaximizeChange: (cb) => {
      const handler = (_e, v) => cb(v);
      ipcRenderer.on("win:maximized", handler);
      return () => ipcRenderer.removeListener("win:maximized", handler);
    },
  },

  // Integrated terminal: drive a native shell (PTY) living in the main process.
  // write/resize are fire-and-forget; onData/onExit return an unsubscribe fn and
  // carry the session id so the renderer can filter. Mirrors onFsChanged's shape.
  term: {
    create: (opts) => ipcRenderer.invoke("pty:create", opts),
    write: (id, data) => ipcRenderer.send("pty:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.send("pty:resize", id, cols, rows),
    kill: (id) => ipcRenderer.invoke("pty:kill", id),
    onData: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on("pty:data", handler);
      return () => ipcRenderer.removeListener("pty:data", handler);
    },
    onExit: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on("pty:exit", handler);
      return () => ipcRenderer.removeListener("pty:exit", handler);
    },
  },

  // WS4: live agent context bridge. The renderer pushes its UI context up
  // (pushContext) and answers dispatch requests from an external agent
  // (onDispatch → reply). Main relays these to/from the loopback control server.
  bridge: {
    pushContext: (ctx) => ipcRenderer.send("bridge:context", ctx),
    onDispatch: (cb) => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on("bridge:dispatch", handler);
      return () => ipcRenderer.removeListener("bridge:dispatch", handler);
    },
    reply: (id, result, error) => ipcRenderer.send("bridge:dispatch:reply", { id, result, error }),
  },
});
