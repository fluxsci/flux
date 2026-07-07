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
  // File identity (mtime+size) for cache keying — null when absent.
  stat: (p) => ipcRenderer.invoke("fs:stat", p),
  readdir: (p) => ipcRenderer.invoke("fs:readdir", p),
  remove: (p) => ipcRenderer.invoke("fs:remove", p),
  exportPdf: (svg, outPath, w, h) => ipcRenderer.invoke("export:pdf", { svg, outPath, w, h }),
  // Render a full HTML document (multi-page, CSS @page-driven) to a PDF.
  printPdf: (html, outPath, opts) => ipcRenderer.invoke("print:pdf", { html, outPath, opts }),

  // Citation metadata fetch (CrossRef) — runs in main to avoid CORS.
  fetchDoi: (doi) => ipcRenderer.invoke("cite:fetchDoi", doi),
  // DOI → BibTeX via doi.org content negotiation (registrar-agnostic: rescues
  // DataCite DOIs — arXiv 10.48550/*, Zenodo — that Crossref 404s).
  fetchDoiBibtex: (doi) => ipcRenderer.invoke("cite:fetchDoiBibtex", doi),
  // Resolve a paper URL (or DOI) to a DOI by fetching + scraping the page in main.
  resolveUrl: (url) => ipcRenderer.invoke("cite:resolveUrl", url),
  // Fetch an OpenAlex API URL (built by src/lib/references/openalex.ts) in main —
  // powers library hydration + whole-world lookups (no CORS; api_key attached if set).
  fetchOpenAlex: (url) => ipcRenderer.invoke("cite:openalex", url),
  // Fetch a Semantic Scholar API URL in main (recommendations / citation contexts);
  // the x-api-key header is attached when an S2 key is configured.
  fetchS2: (url) => ipcRenderer.invoke("cite:s2", url),
  // PDF-acquisition fetch (FluxFinder): host-unrestricted http(s) GET in main, used by
  // the renderer's resolver waterfall. mode ∈ "json" | "text" | "bytes".
  netGet: (url, mode) => ipcRenderer.invoke("pdf:netGet", url, mode),
  // Library proxy (EZProxy) — user-initiated paywalled access (OA is tried first).
  proxyLogin: () => ipcRenderer.invoke("proxy:login"),
  proxyStatus: () => ipcRenderer.invoke("proxy:status"),
  // `token` is an opaque per-call id the renderer generates so it can cancel this exact
  // fetch (or all in-flight via proxyCancel("*")) while a background bulk run is going.
  fetchViaProxy: (target, token) => ipcRenderer.invoke("pdf:fetchViaProxy", target, token),
  proxyCancel: (token) => ipcRenderer.invoke("proxy:cancel", token),
  // Proxy credentials, stored ENCRYPTED in the OS keychain (safeStorage) for auto-login.
  proxySetCredentials: (username, password) => ipcRenderer.invoke("proxy:setCredentials", { username, password }),
  proxyHasCredentials: () => ipcRenderer.invoke("proxy:hasCredentials"),
  proxyClearCredentials: () => ipcRenderer.invoke("proxy:clearCredentials"),
  // Machine-global API-key store (~/FluxLib/keys.json), shared across projects.
  keysGet: () => ipcRenderer.invoke("keys:get"),
  keysSet: (patch) => ipcRenderer.invoke("keys:set", patch),
  // Open a URL (e.g. a DOI link) in the OS browser.
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  // Optional external tools.
  quartoAvailable: () => ipcRenderer.invoke("quarto:available"),
  quartoRender: (root, to, docPath) => ipcRenderer.invoke("quarto:render", { root, to, docPath }),
  // Reveal an exported file in the OS file manager (Finder/Files).
  revealPath: (p) => ipcRenderer.invoke("shell:showItemInFolder", p),

  // Host platform ("darwin" | "linux" | "win32") — lets the renderer adapt its chrome
  // (e.g. defer to the native macOS traffic lights instead of custom window buttons).
  platform: process.platform,

  // App / user paths.
  paths: () => ipcRenderer.invoke("app:paths"),

  // Global preferences (<userData>/preferences.json — holds the FluxLib path).
  prefsGet: () => ipcRenderer.invoke("prefs:get"),
  prefsSet: (patch) => ipcRenderer.invoke("prefs:set", patch),

  // File-watch live reload (F1): register the open project root, and subscribe to
  // external (agent/script) changes mapped to a subsystem ("fig"|"plots"|
  // "manuscript"|"references"). Returns an unsubscribe fn.
  watchRoot: (root) => ipcRenderer.invoke("watch:setRoot", root),
  // F2: re-run a plot's recipe; returns { code, svgText, manifestText, recipeText }.
  runRecipe: (recipePath, params) => ipcRenderer.invoke("recipe:run", { recipePath, params }),
  // Slide export: emit a self-contained offline .html for a deck. Node-only
  // (esbuild + fs run in main, via the flux-cli verb). Returns { ok, path } |
  // { ok:false, error }. The renderer gates its Export button on this existing.
  exportDeck: (root, deckId) => ipcRenderer.invoke("slides:exportDeck", { root, deckId }),
  onFsChanged: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("fs:changed", handler);
    return () => ipcRenderer.removeListener("fs:changed", handler);
  },

  // Web capture: the main process delivers a flux://add?doi=…|url=… payload here
  // (from the bookmarklet / OS protocol handler) for the shell to add to FluxLib.
  onCapture: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("capture:add", handler);
    return () => ipcRenderer.removeListener("capture:add", handler);
  },

  // App-level notices: main-process failures (watcher death, spawn errors) surface
  // as shell toasts instead of dying in the main console. { level, msg, detail? }.
  onAppError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("app:error", handler);
    return () => ipcRenderer.removeListener("app:error", handler);
  },

  // W6: quit/close flush handshake. Main sends `app:flush` with a token before it
  // destroys the window; the renderer flushes every dirty mode and replies with
  // flushDone(token). Main destroys on ack or after a 2.5s timeout.
  onFlushRequest: (cb) => {
    const handler = (_e, token) => cb(token);
    ipcRenderer.on("app:flush", handler);
    return () => ipcRenderer.removeListener("app:flush", handler);
  },
  flushDone: (token) => ipcRenderer.send("app:flush:done", token),

  // WS6: provenance journal + advisory locks. Main appends/writes under .meta/
  // (suppressing the self-write echo); both no-op until a project is open.
  journalAppend: (entry) => ipcRenderer.invoke("journal:append", entry),
  lockSet: (name, held, scope) => ipcRenderer.invoke("lock:set", { name, held, scope }),
  // W3: short renderer-held locks around FluxLib/project read-modify-writes.
  lockAcquire: (scope, name) => ipcRenderer.invoke("lock:acquire", { scope, name }),
  lockRelease: (scope, name) => ipcRenderer.invoke("lock:release", { scope, name }),

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
    // SHL-12: mirror the app's dirty state to the OS window (macOS close-button dot).
    setDocumentEdited: (edited) => ipcRenderer.send("win:setDocumentEdited", !!edited),
  },

  // R3 (FluxReader "Ask Claude"): how to launch the flux MCP server for the open
  // project — embedded by the agent drawer in `claude --mcp-config` so the spawned
  // session can see the paper (get_reading_context / get_paper_text / annotations).
  agentMcpSpec: () => ipcRenderer.invoke("agent:mcpSpec"),

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
