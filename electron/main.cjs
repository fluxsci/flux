const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { resolveToDoi } = require("./resolveDoi.cjs");
const { parseFluxUrl, fluxUrlFromArgv } = require("./fluxUrl.cjs");

// chokidar is ESM-only (v5); this file is CommonJS, so it must be loaded via a
// dynamic import() — a require() throws ERR_REQUIRE_ESM, which (when swallowed)
// silently disables F1 file-watch live-reload entirely. Cached after first load.
let chokidarMod; // module namespace (has .watch); null if genuinely unavailable
let chokidarLoad;
function loadChokidar() {
  if (chokidarMod !== undefined) return Promise.resolve(chokidarMod);
  if (!chokidarLoad)
    chokidarLoad = import("chokidar")
      .then((m) => (chokidarMod = m))
      .catch((e) => {
        console.error("file-watch disabled: chokidar failed to load —", e && e.message);
        return (chokidarMod = null);
      });
  return chokidarLoad;
}

// Integrated-terminal backend (native shell in a PTY). A native module, so the
// app must still run if it failed to load/unpack — the renderer shows a notice.
let nodePty;
try {
  nodePty = require("@lydell/node-pty");
} catch (err) {
  nodePty = null;
  console.warn("[flux] @lydell/node-pty unavailable; integrated terminal disabled:", err && err.message);
}

// File-watch (F1): the open window + project watcher, plus a short-lived set of
// paths the app itself just wrote — so we never echo our own saves back to the
// renderer as "external" changes.
let mainWindow = null;
let projectWatcher = null;
const recentWrites = new Map(); // absPath -> expiry (ms)
function noteWrite(p) {
  recentWrites.set(path.resolve(p), Date.now() + 1500);
}
function isSelfWrite(p) {
  const ab = path.resolve(p);
  const exp = recentWrites.get(ab);
  if (exp && exp > Date.now()) return true;
  if (exp) recentWrites.delete(ab);
  return false;
}

// M9: path-validation for the fs:* handlers (defense-in-depth — matters more now
// that F1's agent/watch surface widens the attack area, and guards against a
// malicious project.json with a traversal path). When a project is open we only
// touch paths under (a) the project root, (b) the app's own dirs, or (c) a
// directory the user explicitly reached through a file dialog (imports/exports).
let currentRoot = null;
const approvedDirs = new Set();
function approveDir(p) {
  if (p) approvedDirs.add(path.resolve(path.dirname(p)));
}
function underDir(ab, dir) {
  return ab === dir || ab.startsWith(dir + path.sep);
}
function fsGuard(p) {
  if (!currentRoot) return; // nothing to protect before a project is open
  const ab = path.resolve(p);
  const roots = [
    currentRoot,
    app.getPath("userData"),
    app.getPath("temp"),
    app.getPath("home"),
    getFluxLibRoot(), // the machine-global FluxLib (covers a relocated path outside $HOME)
    ...approvedDirs,
  ].filter(Boolean);
  if (roots.some((r) => underDir(ab, path.resolve(r)))) return;
  throw new Error(`refused path outside project/app roots: ${p}`);
}

// ---------------------------------------------------------------------------
// Global preferences: <userData>/preferences.json — the first file-based config
// the GUI and the CLI/agents share (holds the FluxLib path). flux-core computes
// the same userData dir, so both sides agree on where the library lives.
// ---------------------------------------------------------------------------
const prefsFile = () => path.join(app.getPath("userData"), "preferences.json");
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8"));
  } catch {
    return { schemaVersion: "0.1.0" };
  }
}
let fluxLibRoot; // undefined = not yet resolved from prefs; null = use default (~/FluxLib, under $HOME)
function getFluxLibRoot() {
  if (fluxLibRoot !== undefined) return fluxLibRoot;
  const c = readPrefs().fluxLibPath;
  fluxLibRoot = typeof c === "string" && c.trim() ? path.resolve(c) : null;
  return fluxLibRoot;
}

// API keys (machine-global ~/FluxLib/keys.json), shared across every project.
// Read in main so credentials are attached here, never baked into renderer URLs.
const fluxLibDir = () => getFluxLibRoot() || path.join(os.homedir(), "FluxLib");
const fluxKeysPath = () => path.join(fluxLibDir(), "keys.json");
function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(fluxKeysPath(), "utf8"));
  } catch {
    return {};
  }
}
const KEY_ENV = { mailto: "FLUX_MAILTO", openAlexKey: "OPENALEX_API_KEY", s2Key: "S2_API_KEY" };
function getKey(name) {
  const e = process.env[KEY_ENV[name]];
  if (e && e.trim()) return e.trim();
  const v = readKeys()[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// WS4: live agent context bridge. The renderer pushes its UI context up (cached
// here) and answers dispatch requests; an external agent (the Flux MCP server)
// talks to a loopback control server started per open project. See bridgeServer.cjs.
// ---------------------------------------------------------------------------
const { startBridge } = require("./bridgeServer.cjs");
let bridge = null;
let latestContext = null;
let dispatchSeq = 0;
const dispatchPending = new Map(); // id -> { resolve, reject, timer }

function stopBridge() {
  if (bridge) {
    try {
      bridge.stop();
    } catch {
      /* ignore */
    }
    bridge = null;
  }
  for (const { reject, timer } of dispatchPending.values()) {
    clearTimeout(timer);
    reject(new Error("bridge stopped"));
  }
  dispatchPending.clear();
  latestContext = null;
}

function startBridgeFor(root) {
  stopBridge();
  if (!root) return;
  bridge = startBridge({
    root,
    getContext: () => latestContext,
    dispatch: (command) =>
      new Promise((resolve, reject) => {
        if (!mainWindow || mainWindow.webContents.isDestroyed()) return reject(new Error("no renderer"));
        const id = ++dispatchSeq;
        const timer = setTimeout(() => {
          dispatchPending.delete(id);
          reject(new Error("dispatch timed out"));
        }, 12000);
        dispatchPending.set(id, { resolve, reject, timer });
        appendJournalLine(root, {
          action: `dispatch:${command && command.type}`,
          client: "agent",
          target: (command && (command.figureId || command.partId)) || undefined,
        });
        mainWindow.webContents.send("bridge:dispatch", { id, command });
      }),
    noteWrite,
  });
}

ipcMain.on("bridge:context", (_e, ctx) => {
  latestContext = ctx;
  if (bridge) bridge.pushContext(ctx);
});
ipcMain.on("bridge:dispatch:reply", (_e, { id, result, error }) => {
  const p = dispatchPending.get(id);
  if (!p) return;
  dispatchPending.delete(id);
  clearTimeout(p.timer);
  if (error) p.reject(new Error(error));
  else p.resolve(result);
});

// ---------------------------------------------------------------------------
// WS6: provenance journal + advisory locks. The renderer (human) and the bridge
// (agent) append journal lines and hold/release a lock under .meta/; flux-core
// (CLI/MCP) reads the same files, so a concurrent file write defers instead of
// clobbering an in-flight human edit.
// ---------------------------------------------------------------------------
function appendJournalLine(root, entry) {
  if (!root) return;
  try {
    const p = path.join(root, ".meta", "journal.ndjson");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    noteWrite(p);
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), client: "human", ...entry }) + "\n");
  } catch (e) {
    console.warn("[flux] journal append failed:", e && e.message);
  }
}
ipcMain.handle("journal:append", (_e, entry) => {
  appendJournalLine(currentRoot, entry || {});
  return true;
});
ipcMain.handle("lock:set", (_e, { name, held }) => {
  if (!currentRoot) return false;
  const p = path.join(currentRoot, ".meta", "locks", `${name}.json`);
  try {
    noteWrite(p);
    if (held) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ client: "human", pid: process.pid, ts: new Date().toISOString() }));
    } else {
      fs.rmSync(p, { force: true });
    }
    return true;
  } catch (e) {
    console.warn("[flux] lock set failed:", e && e.message);
    return false;
  }
});

// ---------------------------------------------------------------------------
// Crank the GPU knobs: prefer hardware rasterization/compositing everywhere.
// (Chromium handles large canvases on NVIDIA far better than WebKitGTK.)
// ---------------------------------------------------------------------------
// GPU config. On NVIDIA the default XWayland path can segfault the GPU process;
// native Wayland (what the Figma desktop app uses on this machine) is stable.
// `ozone-platform-hint=auto` picks Wayland when available, else X11 elsewhere.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");

// Escape hatches if a machine still has GPU trouble:
//   OZONE=x11      force XWayland
//   NOSANDBOX=1    disable the GPU sandbox (can fix some NVIDIA segfaults)
//   SOFTGPU=1      fall back to software rendering (always works, slower)
if (process.env.OZONE === "x11") {
  app.commandLine.appendSwitch("ozone-platform-hint", "x11");
}
if (process.env.NOSANDBOX === "1") {
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}
if (process.env.SOFTGPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#100f0f",
    title: "Flux",
    // Linux/Windows: fully frameless — we draw our own title bar (TitleBar.svelte).
    // macOS: keep the native traffic lights but hide the title-bar chrome
    // (titleBarStyle:"hidden"), nudged to sit centered in our 38px bar.
    frame: isMac ? true : false,
    titleBarStyle: isMac ? "hidden" : "default",
    ...(isMac ? { trafficLightPosition: { x: 14, y: 11 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  mainWindow = win;

  // Keep the renderer's custom maximize/restore button in sync.
  win.on("maximize", () => win.webContents.send("win:maximized", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized", false));

  // Reap any integrated-terminal PTYs owned by this window's renderer on close,
  // and tear down the live agent bridge (removes .meta/live/bridge.json).
  win.on("closed", () => {
    reapPtys((s) => s.wc.isDestroyed());
    stopBridge();
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Flush any flux:// web capture that arrived before the renderer was ready.
  win.webContents.once("did-finish-load", () => {
    if (pendingCapture) {
      win.webContents.send("capture:add", pendingCapture);
      pendingCapture = null;
    }
  });
}

// ---------------------------------------------------------------------------
// flux:// web capture. A single instance owns the protocol; a second launch (or
// the macOS open-url event) forwards its flux://add?doi=…|url=… to the renderer,
// which adds it to FluxLib. URL grammar lives in electron/fluxUrl.cjs.
// ---------------------------------------------------------------------------
let pendingCapture = null; // capture payload seen before the renderer is ready

function deliverCapture(payload) {
  if (!payload) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const wc = mainWindow.webContents;
    if (wc.isLoading()) wc.once("did-finish-load", () => wc.send("capture:add", payload));
    else wc.send("capture:add", payload);
  } else {
    pendingCapture = payload; // flushed when the next window finishes loading
  }
}
function handleFluxUrl(raw) {
  deliverCapture(parseFluxUrl(raw));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const url = fluxUrlFromArgv(argv);
    if (url) handleFluxUrl(url);
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  // macOS delivers flux:// here (not via argv).
  app.on("open-url", (e, url) => {
    e.preventDefault();
    handleFluxUrl(url);
  });
  // Register as the OS handler for flux:// (dev: pass execPath + script path).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("flux", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("flux");
  }
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  createWindow();
  // Cold start via protocol (Windows/Linux carry the URL in argv).
  const initialUrl = fluxUrlFromArgv(process.argv);
  if (initialUrl) handleFluxUrl(initialUrl);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Never leave a shell child behind.
app.on("before-quit", () => reapPtys());

// ---------------------------------------------------------------------------
// IPC: frameless window controls
// ---------------------------------------------------------------------------
ipcMain.handle("win:minimize", (e) =>
  BrowserWindow.fromWebContents(e.sender)?.minimize(),
);
ipcMain.handle("win:maximizeToggle", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (w.isMaximized()) {
    w.unmaximize();
    return false;
  }
  w.maximize();
  return true;
});
ipcMain.handle("win:close", (e) =>
  BrowserWindow.fromWebContents(e.sender)?.close(),
);
ipcMain.handle(
  "win:isMaximized",
  (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
);

// App / user paths (for the user-level config + reference library, etc.)
ipcMain.handle("app:paths", () => ({
  home: app.getPath("home"),
  userData: app.getPath("userData"),
  documents: app.getPath("documents"),
}));

// Global preferences (FluxLib path, etc.) — see prefsFile()/readPrefs() above.
ipcMain.handle("prefs:get", () => readPrefs());
ipcMain.handle("prefs:set", (_e, patch) => {
  const cur = readPrefs();
  const next = { ...cur, ...(patch || {}), schemaVersion: cur.schemaVersion || "0.1.0" };
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  noteWrite(prefsFile());
  fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2) + "\n");
  if (typeof next.fluxLibPath === "string" && next.fluxLibPath.trim()) {
    fluxLibRoot = path.resolve(next.fluxLibPath); // refresh the fsGuard allowlist
  }
  return next;
});

// ---------------------------------------------------------------------------
// IPC: file dialogs + filesystem + PDF export
// ---------------------------------------------------------------------------
ipcMain.handle("dlg:open", async (_e, opts) => {
  const res = await dialog.showOpenDialog({
    properties: opts.directory
      ? ["openDirectory"]
      : opts.multiple
        ? ["openFile", "multiSelections"]
        : ["openFile"],
    filters: opts.filters,
    title: opts.title,
  });
  if (res.canceled) return null;
  // M9: the user reached this dir on purpose — allow reading it + its siblings
  // (the plot importer reads manifest/recipe next to a chosen .svg).
  res.filePaths.forEach(approveDir);
  return opts.multiple ? res.filePaths : res.filePaths[0];
});

ipcMain.handle("dlg:save", async (_e, opts) => {
  const res = await dialog.showSaveDialog({
    defaultPath: opts.defaultPath,
    filters: opts.filters,
    title: opts.title,
  });
  if (res.canceled) return null;
  approveDir(res.filePath); // M9: allow writing the chosen export + sidecars
  return res.filePath;
});

ipcMain.handle("fs:readFile", async (_e, p) => {
  fsGuard(p);
  const buf = await fs.promises.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle("fs:writeFile", async (_e, p, data) => {
  fsGuard(p);
  noteWrite(p);
  await fs.promises.writeFile(p, Buffer.from(data));
});
ipcMain.handle("fs:readText", async (_e, p) => {
  fsGuard(p);
  return fs.promises.readFile(p, "utf8");
});
ipcMain.handle("fs:writeText", async (_e, p, text) => {
  fsGuard(p);
  noteWrite(p);
  await fs.promises.writeFile(p, text, "utf8");
});
ipcMain.handle("fs:mkdir", async (_e, p) => {
  fsGuard(p);
  await fs.promises.mkdir(p, { recursive: true });
});
ipcMain.handle("fs:exists", async (_e, p) => {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle("fs:readdir", async (_e, p) => {
  try {
    const es = await fs.promises.readdir(p, { withFileTypes: true });
    return es.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
});

// ---------------------------------------------------------------------------
// File-watch live reload (F1): the renderer registers the open project root; we
// watch plots/, fig/, manuscript/**, references/ and emit debounced fs:changed
// events ({ subsystem, path }), skipping the app's own writes so agent/script
// edits "pop into" the open window non-destructively.
// ---------------------------------------------------------------------------
function subsystemFor(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  if (rel.startsWith("plots/")) return "plots";
  if (rel.startsWith("fig/")) return "fig";
  if (rel.startsWith("manuscript/")) return "manuscript";
  if (rel.startsWith("references/")) return "references";
  return null;
}

ipcMain.handle("watch:setRoot", async (_e, root) => {
  // M9: the open project root is the primary fs allowlist entry.
  currentRoot = root ? path.resolve(root) : null;
  // WS4: bring the live agent bridge up/down with the open project.
  startBridgeFor(currentRoot);
  if (projectWatcher) {
    await projectWatcher.close().catch(() => {});
    projectWatcher = null;
  }
  if (!root) return false;
  const ck = await loadChokidar();
  if (!ck) return false;
  const targets = ["plots", "fig", "manuscript", "references"].map((d) => path.join(root, d));
  const pending = new Map(); // subsystem -> latest changed path
  let timer = null;
  const flush = () => {
    timer = null;
    for (const [subsystem, p] of pending)
      mainWindow?.webContents.send("fs:changed", { subsystem, path: p });
    pending.clear();
  };
  projectWatcher = ck.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  projectWatcher.on("all", (_evt, abs) => {
    if (isSelfWrite(abs)) return;
    const subsystem = subsystemFor(root, abs);
    if (!subsystem) return;
    pending.set(subsystem, abs);
    if (!timer) timer = setTimeout(flush, 200);
  });
  return true;
});

// F2: re-run a plot's recipe (the user's own generating script, gated behind an
// explicit action). Returns the emitted SVG/manifest text so the renderer can
// hot-swap it in place. Mirrors flux-core.runRecipe; persists merged params.
ipcMain.handle("recipe:run", async (_e, { recipePath, params = {} }) => {
  const recipe = JSON.parse(await fs.promises.readFile(recipePath, "utf8"));
  const dir = path.dirname(recipePath);
  const merged = { ...(recipe.params || {}), ...params };
  const args = [...(recipe.args || [])];
  for (const [k, v] of Object.entries(merged)) args.push(`--${k}`, String(v));
  const cwd = path.resolve(dir, recipe.cwd || ".");
  const res = await new Promise((resolve) => {
    const child = spawn(recipe.command, args, {
      cwd,
      env: { ...process.env, FLUX_PARAMS: JSON.stringify(merged) },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e2) => resolve({ code: -1, stdout: out, stderr: String(e2) }));
    child.on("close", (c) => resolve({ code: c ?? 0, stdout: out, stderr: err }));
  });
  recipe.params = merged;
  recipe.lastRun = new Date().toISOString();
  noteWrite(recipePath);
  await fs.promises.writeFile(recipePath, JSON.stringify(recipe, null, 2) + "\n");
  const outAbs = recipe.output ? path.resolve(dir, recipe.output) : null;
  let svgText = null;
  let manifestText = null;
  if (outAbs && fs.existsSync(outAbs)) {
    noteWrite(outAbs);
    svgText = await fs.promises.readFile(outAbs, "utf8");
    const manAbs = outAbs.replace(/\.svg$/, ".fluxplot.json");
    if (fs.existsSync(manAbs)) {
      noteWrite(manAbs);
      manifestText = await fs.promises.readFile(manAbs, "utf8");
    }
  }
  return { ...res, svgText, manifestText, recipeText: JSON.stringify(recipe) };
});

// Slide export (E): emit a self-contained offline .html for a deck. The engine is
// Node-only (esbuild bundles the runtime; fs inlines assets), so we run the same
// `flux export-deck` CLI verb in a child process using Electron's bundled Node
// (ELECTRON_RUN_AS_NODE) + the tsx loader. Returns the written path.
ipcMain.handle("slides:exportDeck", async (_e, { root, deckId }) => {
  if (!root || !deckId) return { ok: false, error: "missing root or deckId" };
  const appRoot = path.resolve(__dirname, "..");
  const res = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "flux-cli.ts", "export-deck", String(deckId), "--root", String(root)],
      { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e2) => resolve({ code: -1, stderr: String(e2) }));
    child.on("close", (c) => resolve({ code: c ?? 0, stderr: err }));
  });
  const outPath = path.join(root, "exports", `${deckId}.html`);
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    return { ok: false, error: (res.stderr || `export exited ${res.code}`).trim() };
  }
  noteWrite(outPath); // don't let the file-watcher echo our own write
  return { ok: true, path: outPath };
});

// Render a standalone SVG to a vector PDF via Chromium's print engine.
ipcMain.handle("export:pdf", async (_e, { svg, outPath, w, h }) => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const tmp = path.join(os.tmpdir(), `flux-${process.pid}-${Date.now()}.html`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>${svg}</body></html>`;
  try {
    await fs.promises.writeFile(tmp, html, "utf8");
    await win.loadFile(tmp);
    const microns = (px) => Math.round((px / 96) * 25400);
    const data = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: { width: microns(w), height: microns(h) },
    });
    await fs.promises.writeFile(outPath, data);
  } finally {
    win.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
  return true;
});

// Render a full HTML document to a multi-page PDF. Unlike export:pdf (one page
// sized to a figure), this lets CSS @page rules drive size + pagination.
ipcMain.handle("print:pdf", async (_e, { html, outPath, opts = {} }) => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const tmp = path.join(os.tmpdir(), `flux-doc-${process.pid}-${Date.now()}.html`);
  try {
    await fs.promises.writeFile(tmp, html, "utf8");
    await win.loadFile(tmp);
    const data = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      ...(opts.margins ? { margins: opts.margins } : {}),
    });
    await fs.promises.writeFile(outPath, data);
  } finally {
    win.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
  return true;
});

// Citation metadata via CrossRef (main process has global fetch in Electron 33;
// running here avoids renderer CORS). Polite User-Agent per CrossRef etiquette.
ipcMain.handle("cite:fetchDoi", async (_e, doi) => {
  const clean = String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  try {
    const res = await fetch(
      "https://api.crossref.org/works/" + encodeURIComponent(clean),
      { headers: { "User-Agent": "Flux/0.1 (manuscript editor)", Accept: "application/json" } },
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { message: json.message };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// Resolve a paper URL (or DOI) to a DOI: fetch the page (global fetch → no CORS)
// and scrape its citation meta tags. Backs the Library paste box and web capture.
ipcMain.handle("cite:resolveUrl", (_e, url) => resolveToDoi(url, fetch));

// OpenAlex fetch (library hydration + whole-world lookups) — runs in main to avoid
// renderer CORS. The renderer builds the URL via src/lib/references/openalex.ts and
// passes it here; we only allow the OpenAlex host. No API key needed (polite mailto).
ipcMain.handle("cite:openalex", async (_e, url) => {
  let u = String(url || "");
  if (!/^https:\/\/api\.openalex\.org\//i.test(u)) return { error: "blocked: non-OpenAlex URL" };
  const key = getKey("openAlexKey"); // free key → 10× daily budget
  const mailto = getKey("mailto");
  if (key && !/[?&]api_key=/.test(u)) u += (u.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(key);
  if (mailto && !/[?&]mailto=/.test(u)) u += (u.includes("?") ? "&" : "?") + "mailto=" + encodeURIComponent(mailto);
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": "Flux/0.1 (reference hydration)", Accept: "application/json" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// Semantic Scholar fetch (recommendations, citation contexts/intents) — runs in main
// to avoid CORS; attaches the x-api-key header when an S2 key is set. Host-restricted.
ipcMain.handle("cite:s2", async (_e, url) => {
  const u = String(url || "");
  if (!/^https:\/\/api\.semanticscholar\.org\//i.test(u)) return { error: "blocked: non-S2 URL" };
  const key = getKey("s2Key");
  try {
    const res = await fetch(u, {
      headers: {
        "User-Agent": "Flux/0.1 (reference)",
        Accept: "application/json",
        ...(key ? { "x-api-key": key } : {}),
      },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// Generic PDF-acquisition fetch (FluxFinder GUI). The renderer runs the resolver
// waterfall (src/lib/references/pdfFinder.ts) and routes every fetch (metadata JSON +
// the PDF bytes) here to dodge renderer CORS — mirroring the flux-core/acquire.ts Node
// path so both share one waterfall. http(s)-only + private-range blocked (SSRF guard);
// always user-initiated ("Get PDF" / "Get PDFs"). mode ∈ json | text | bytes.
function publicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || /\.local$/.test(h)) return null;
  if (/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h)) return null;
  return u.toString();
}
ipcMain.handle("pdf:netGet", async (_e, url, mode = "bytes") => {
  const safe = publicHttpUrl(url);
  if (!safe) return { error: "blocked: non-public http(s) URL" };
  const mailto = getKey("mailto") || "flux";
  const UA = `Flux/0.1 (PDF acquisition; mailto:${mailto})`;
  try {
    const accept = mode === "json" ? "application/json" : mode === "text" ? "text/*,*/*" : "application/pdf,*/*";
    const res = await fetch(safe, { redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    if (mode === "json") return { json: await res.json() };
    if (mode === "text") return { text: await res.text() };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 80 * 1024 * 1024) return { error: "too large" };
    return {
      bytesB64: buf.toString("base64"),
      contentType: res.headers.get("content-type") || "",
      finalUrl: res.url || safe,
    };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

// --- Library proxy (EZProxy) — user-initiated paywalled access, last resort -----
// A persistent, isolated session partition ("persist:fluxproxy") holds the user's
// library SSO cookies across runs. We NEVER store passwords; the login happens in a
// real window the user drives. Paywalled fetch runs an in-page fetch() inside the
// proxied publisher page (carries its TLS fingerprint + cf_clearance + cookies —
// the native-Electron port of ~/fluxfinder/fetch/browser.py). OA is always tried
// first (the renderer only calls this after the OA waterfall fails).
const PROXY_PARTITION = "persist:fluxproxy";
function ezproxyPrefix() {
  return (getKey("ezproxyPrefix") || "").trim();
}

// Build a proxied entry URL from the configured "login?url=" prefix by appending the
// target RAW (exactly like the library's bookmarklet: `...login?url=' + location.href`).
// CRITICAL: do NOT percent-encode it. EZProxy only accepts the url= value as a real
// target when it literally begins with "http(s)://"; a %3A%2F%2F-encoded value is
// rejected and EZProxy falls back to url=menu → its dead-end "Remote Access Menu". An
// EMPTY target hits the same menu, so always pass a real, unencoded target.
function proxiedUrl(target) {
  return ezproxyPrefix() + String(target || "");
}
// A resource the university licenses, used only to drive the login/status flow through
// NetID SSO. Any non-empty proxiable target works; the landing page is irrelevant because
// the login window auto-closes once it reaches a proxied host, and the status probe only
// inspects the redirect chain.
const PROXY_AUTH_TARGET = "https://www.nature.com/";
// True if `u` is EZProxy's own login/menu plumbing or an identity provider (NetID SSO,
// Shibboleth, Duo) rather than a proxied resource — i.e. the request bounced to sign-in.
// This is what distinguishes "signed in" from "session expired".
function isProxyLoginUrl(u) {
  try {
    const h = new URL(u).hostname;
    if (/^login\./i.test(h)) return true; // EZProxy auth connector + NetID SSO (login.wisc.edu)
    if (/(^|\.)duosecurity\.com$/i.test(h)) return true; // Duo MFA
    return /\/(login|connect|idp|saml|sso|shibboleth)\b|[?&]url=menu\b/i.test(u);
  } catch {
    return false;
  }
}
// Probe whether the persisted session is ACTUALLY authenticated (not just "a cookie
// exists"): request a proxied resource with the partition's cookies, follow the redirect
// chain, and see where it lands. A proxied host ⇒ signed in; the NetID/EZProxy login ⇒
// session expired. Best-effort — resolves false on any error and never hangs the pill.
function probeProxySignedIn() {
  return new Promise((resolve) => {
    let url, prefixHost;
    try {
      prefixHost = new URL(ezproxyPrefix()).hostname;
      url = proxiedUrl(PROXY_AUTH_TARGET);
    } catch {
      return resolve(false);
    }
    let settled = false;
    const decide = (u) => {
      let h = "";
      try {
        h = new URL(u).hostname;
      } catch {
        return false;
      }
      const onResource = h === prefixHost || h.endsWith("." + prefixHost);
      return onResource && !isProxyLoginUrl(u);
    };
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const req = net.request({ url, session: session.fromPartition(PROXY_PARTITION), redirect: "manual" });
      let finalUrl = url;
      let hops = 0;
      req.on("redirect", (_status, _method, redirectUrl) => {
        finalUrl = redirectUrl || finalUrl;
        if (++hops > 8) {
          try {
            req.abort();
          } catch {
            /* ignore */
          }
          return finish(decide(finalUrl));
        }
        try {
          req.followRedirect();
        } catch {
          finish(decide(finalUrl));
        }
      });
      req.on("response", (res) => {
        finish(decide(finalUrl));
        res.on("data", () => {});
        res.on("end", () => {});
        try {
          req.abort();
        } catch {
          /* ignore */
        }
      });
      req.on("error", () => finish(false));
      req.end();
      setTimeout(() => finish(false), 8000);
    } catch {
      finish(false);
    }
  });
}

// Credentials are stored ENCRYPTED via the OS keychain (Electron safeStorage:
// macOS Keychain / Windows DPAPI / Linux libsecret) in ~/FluxLib/.proxy.json (0600) —
// never plaintext. They auto-fill the SSO login form so re-auth is seamless; combined
// with the persistent session + a trusted-device (Duo "remember me") cookie, the user
// signs in rarely. We never transmit them anywhere but the university's own login page.
function proxyCredPath() {
  return path.join(fluxLibDir(), ".proxy.json");
}
function readProxyCred() {
  try {
    return JSON.parse(fs.readFileSync(proxyCredPath(), "utf8"));
  } catch {
    return {};
  }
}
function proxyPassword() {
  const c = readProxyCred();
  if (!c.passwordEnc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(c.passwordEnc, "base64"));
  } catch {
    return null;
  }
}
// Fill a detected SSO login form with the stored NetID + password and tick any
// "remember/trust this device" box (so Duo MFA is skipped on later sessions). Fires on
// every navigation; a no-op when the page has no password field. Best-effort; the user
// still approves Duo the first time in the visible window.
function autofillCreds(win, submit) {
  const user = String(readProxyCred().username || "").trim();
  const pass = proxyPassword();
  if (!user && !pass) return;
  const js =
    `(() => { try {
      const p = document.querySelector('input[type=password]');
      if (!p) return false;
      const form = p.form || document;
      const u = form.querySelector('input[type=text],input[type=email],input[name*=user i],input[id*=user i],input[name=j_username]');
      if (u && ${JSON.stringify(user)}) { u.value = ${JSON.stringify(user)}; u.dispatchEvent(new Event('input',{bubbles:true})); }
      if (${JSON.stringify(pass || "")}) { p.value = ${JSON.stringify(pass || "")}; p.dispatchEvent(new Event('input',{bubbles:true})); }
      for (const c of document.querySelectorAll('input[type=checkbox]')) {
        const t = (c.name||'')+(c.id||'')+((c.closest('label')||{}).textContent||'');
        if (/remember|trust|stay|keep/i.test(t)) c.checked = true;
      }
      ${submit ? "if (u && u.value && p.value) { const b = form.querySelector('button[type=submit],input[type=submit],button'); if (b) b.click(); else if (form.submit) form.submit(); }" : ""}
      return true;
    } catch (e) { return false; } })()`;
  win.webContents.executeJavaScript(js, true).catch(() => {});
}

// Store / inspect / clear the proxy credentials (OS-keychain encrypted).
ipcMain.handle("proxy:setCredentials", (_e, { username, password } = {}) => {
  try {
    if (!safeStorage.isEncryptionAvailable())
      return { error: "Your OS secure storage (keychain) isn't available, so credentials can't be stored safely." };
    fs.mkdirSync(fluxLibDir(), { recursive: true });
    const cur = readProxyCred();
    const next = { username: username != null ? String(username) : cur.username || "" };
    if (password) next.passwordEnc = safeStorage.encryptString(String(password)).toString("base64");
    else if (cur.passwordEnc) next.passwordEnc = cur.passwordEnc;
    fs.writeFileSync(proxyCredPath(), JSON.stringify(next), { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});
ipcMain.handle("proxy:hasCredentials", () => {
  const c = readProxyCred();
  return { username: c.username || "", hasPassword: !!c.passwordEnc, available: safeStorage.isEncryptionAvailable() };
});
ipcMain.handle("proxy:clearCredentials", () => {
  try {
    fs.unlinkSync(proxyCredPath());
  } catch {
    /* already gone */
  }
  return { ok: true };
});

// Open a real window to the library's EZProxy login and let the user sign in. We enter
// through a PROXIED resource (proxiedUrl, not the bare /login origin — that lands on
// EZProxy's dead-end "Remote Access Menu") so EZProxy routes into NetID SSO. Credentials
// auto-fill; the user completes Duo and ticks "trust this browser". The window then
// auto-closes the moment navigation reaches a proxied host = authentication succeeded.
ipcMain.handle("proxy:login", async () => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { error: "Set your library's EZProxy prefix in ⚙ Keys first." };
  let loginUrl, prefixHost;
  try {
    prefixHost = new URL(prefix).hostname; // validate + capture the proxy host
    loginUrl = proxiedUrl(PROXY_AUTH_TARGET);
  } catch {
    return { error: "Invalid EZProxy prefix URL." };
  }
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 920,
      height: 820,
      title: "Sign in to your library",
      autoHideMenuBar: true,
      parent: mainWindow || undefined,
      webPreferences: { partition: PROXY_PARTITION },
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ ok: true });
      if (!win.isDestroyed()) win.close();
    };
    // Auto-fill stored NetID + password on each login page (no auto-submit — the user
    // reviews credentials, approves Duo, and ticks "trust this browser").
    win.webContents.on("did-finish-load", () => autofillCreds(win, false));
    // Past all the login/connect/SSO/Duo hops, navigation lands on the proxied resource
    // host (a subdomain of the proxy) — the session cookie is now set, so sign-in worked.
    win.webContents.on("did-navigate", (_e, url) => {
      try {
        const h = new URL(url).hostname;
        if ((h === prefixHost || h.endsWith("." + prefixHost)) && !isProxyLoginUrl(url)) finish();
      } catch {
        /* ignore non-URL navigations */
      }
    });
    win.loadURL(loginUrl).catch(() => {});
    win.on("closed", () => finish());
  });
});

// Report whether the proxy is configured + can ACTUALLY reach paywalled content (drives
// the status pill). We always probe a proxied resource rather than checking cookies:
// access can come from a signed-in session OR from IP-based autologin (on-campus / VPN),
// which grants access with no cookie at all — so cookie presence is neither necessary nor
// sufficient. The probe is the ground truth: does a proxied request reach the resource?
ipcMain.handle("proxy:status", async () => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { configured: false, signedIn: false };
  try {
    new URL(prefix);
  } catch {
    return { configured: false, signedIn: false };
  }
  return { configured: true, signedIn: await probeProxySignedIn() };
});

// Fetch a paywalled PDF for `target` (a DOI URL or landing page) through the proxy, in a
// real (non-offscreen) hidden window so publisher anti-bot JS challenges pass — offscreen/
// headless get blocked. Two phases: (1) scrape a direct PDF link (citation_pdf_url etc.)
// and fetch it in-page; (2) if that's a challenge/redirect endpoint (e.g. Elsevier
// /pdfft), NAVIGATE to it so Chromium solves the challenge, then fetch the resolved PDF
// from that page context (main-process net.request can't — it lacks the solved context).
ipcMain.handle("pdf:fetchViaProxy", async (_e, target) => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { error: "No EZProxy prefix configured." };
  let prefixHost;
  try {
    prefixHost = new URL(prefix).hostname;
  } catch {
    return { error: "Invalid EZProxy prefix URL." };
  }
  const entryUrl = proxiedUrl(target);
  // NOT offscreen: offscreen rendering is detected like headless and fails anti-bot checks.
  const win = new BrowserWindow({ show: false, webPreferences: { partition: PROXY_PARTITION } });
  const wc = win.webContents;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // In-page fetch of `u` → validated PDF bytes (base64) or null. Runs in the page context
  // so it carries the session cookies AND any cookie a prior navigation's challenge set.
  const grab = (u) =>
    wc
      .executeJavaScript(
        `(async () => { try {
          const r = await fetch(${JSON.stringify(u)}, { credentials: 'include' });
          if (!r.ok) return null;
          const b = new Uint8Array(await r.arrayBuffer());
          if (!(b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46)) return null;
          let s = ''; const CH = 0x8000;
          for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
          return { bytesB64: btoa(s), contentType: r.headers.get('content-type') || '', finalUrl: r.url || ${JSON.stringify(u)} };
        } catch (e) { return null; } })()`,
      )
      .catch(() => null);
  try {
    await wc.loadURL(entryUrl).catch(() => {}); // redirect chains can reject; inspect what landed anyway
    // Settle: wait out the EZProxy login?url→resource hops AND publisher interstitials
    // (e.g. Elsevier LinkingHub's meta-refresh) until we're on a stable, real page.
    let last = "";
    for (let start = Date.now(); Date.now() - start < 12000; ) {
      await sleep(400);
      const u = wc.getURL();
      if (!wc.isLoading() && u && u === last && !isProxyLoginUrl(u) && !/\/(retrieve|linkinghub|articleselect)/i.test(u)) break;
      last = u;
    }
    if (isProxyLoginUrl(wc.getURL())) {
      return { error: "Your library session isn't active. Open ⚙ Keys → Re-sign in, complete NetID + Duo, then try again." };
    }
    // Scrape candidate PDF links. nav:true = needs a real navigation to resolve (JS anti-
    // bot challenge / redirect, e.g. Elsevier /pdfft); nav:false = directly fetchable.
    const candidates = await wc.executeJavaScript(`(() => {
      const PD = ${JSON.stringify(prefixHost)};
      const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return null; } };
      const out = [];
      const m = document.querySelector('meta[name="citation_pdf_url"]'); if (m && m.content) out.push({ url: abs(m.content), nav: false });
      try {
        const h = document.documentElement.innerHTML;
        const b = (h.match(/"pdfDownload":\\{[\\s\\S]{0,800}?\\}\\}/) || [])[0] || '';
        const g = (re) => (b.match(re) || [])[1];
        const md5 = g(/"md5":"([^"]+)"/), pid = g(/"pid":"([^"]+)"/), pii = g(/"pii":"([^"]+)"/), ext = g(/"pdfExtension":"([^"]+)"/), p = g(/"path":"([^"]+)"/);
        if (md5 && pid && pii && ext && p) out.push({ url: location.origin + '/' + p + '/' + pii + ext + '?md5=' + md5 + '&pid=' + encodeURIComponent(pid), nav: true });
      } catch (e) {}
      for (const l of document.querySelectorAll('link[type="application/pdf"]')) if (l.href) out.push({ url: abs(l.href), nav: false });
      for (const a of document.querySelectorAll('a[href]')) {
        const hh = abs(a.getAttribute('href')); if (!hh) continue;
        if (/\\.pdf(\\?|#|$)/i.test(hh)) out.push({ url: hh, nav: false });
        else if (/\\/pdfft\\b|\\/pdfdirect\\b|[?&](format|type)=pdf\\b/i.test(hh)) out.push({ url: hh, nav: true });
      }
      // Rewrite non-proxied publisher URLs into EZProxy's host-rewritten form (dots→dashes).
      const rp = (u) => { try { const x = new URL(u); if (x.hostname === PD || x.hostname.endsWith('.' + PD)) return u; const rw = x.hostname.replace(/-/g, '--').replace(/\\./g, '-') + '.' + PD; return x.protocol + '//' + rw + x.pathname + x.search + x.hash; } catch (e) { return u; } };
      const seen = new Set(), res = []; for (const c of out) { if (!c.url) continue; const u = rp(c.url); if (seen.has(u)) continue; seen.add(u); res.push({ url: u, nav: c.nav }); } return res;
    })()`);
    if (!candidates || !candidates.length)
      return { error: "No PDF link found on the article page (it may need a different access route)." };

    // Phase 1 — direct in-page fetch for real .pdf links (wins for Nature/Springer/etc.).
    // We deliberately do NOT pre-fetch nav candidates: an XHR to a challenge endpoint (e.g.
    // Elsevier /pdfft) flags the session and makes the challenge-solving navigation fail.
    for (const c of candidates.filter((c) => !c.nav)) {
      const got = await grab(c.url);
      if (got && got.bytesB64) return got;
    }

    // Phase 2 — navigate so Chromium solves any JS anti-bot challenge, then capture a forced
    // download or fetch the resolved PDF from that page context. The challenge fails
    // intermittently (redirecting back with ?ref=cra_js_challenge), so retry a few times.
    const nav = candidates.find((c) => c.nav) || candidates[0];
    const ses = session.fromPartition(PROXY_PARTITION);
    let downloadDone = null;
    const onDownload = (_event, item) => {
      try {
        const p = path.join(os.tmpdir(), "flux-proxy-" + Date.now() + ".pdf");
        item.setSavePath(p); // set a path so Electron never pops a (blocking, invisible) save dialog
        downloadDone = new Promise((res) => item.once("done", (_e, state) => res(state === "completed" ? p : null)));
      } catch {
        /* ignore */
      }
    };
    ses.on("will-download", onDownload);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        downloadDone = null;
        await wc.loadURL(nav.url).catch(() => {}); // a PDF nav often "fails" as ERR_ABORTED / becomes a download
        let cur = "";
        for (let start = Date.now(); Date.now() - start < 15000; ) {
          await sleep(500);
          if (downloadDone) break;
          cur = wc.getURL();
          if (!wc.isLoading() && (/sciencedirectassets|\.pdf(\?|$)/i.test(cur) || /cra_js_challenge/i.test(cur))) break;
        }
        if (downloadDone) {
          const file = await Promise.race([downloadDone, sleep(20000).then(() => null)]);
          if (file) {
            try {
              const buf = fs.readFileSync(file);
              fs.unlink(file, () => {});
              if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
                return { bytesB64: buf.toString("base64"), contentType: "application/pdf", finalUrl: nav.url };
            } catch {
              /* fall through */
            }
          }
        }
        cur = wc.getURL();
        if (isProxyLoginUrl(cur)) break; // session expired mid-flow — retrying won't help
        if (!/cra_js_challenge/i.test(cur)) {
          const got = await grab(cur);
          if (got && got.bytesB64) return got;
        }
        await sleep(800); // brief backoff before retrying a failed challenge
      }
    } finally {
      ses.removeListener("will-download", onDownload);
    }
    return {
      error: "Found a PDF link but the publisher blocked the automated download. Open the article in your browser (or the library bookmarklet) and use “Add PDF…”.",
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    win.destroy();
  }
});

// API-key store (machine-global ~/FluxLib/keys.json). keys:get returns the raw map
// for the settings form (the user's own machine); keys:set merge-writes it.
ipcMain.handle("keys:get", () => readKeys());
ipcMain.handle("keys:set", (_e, patch) => {
  try {
    fs.mkdirSync(fluxLibDir(), { recursive: true });
    const next = { ...readKeys(), ...(patch || {}) };
    fs.writeFileSync(fluxKeysPath(), JSON.stringify(next, null, 2) + "\n");
    return next;
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
});

ipcMain.handle("shell:openExternal", (_e, url) => {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
});

// Optional Quarto compile (publication-grade output). Detected, never required.
ipcMain.handle("quarto:available", async () => {
  return new Promise((resolve) => {
    try {
      const p = spawn("quarto", ["--version"]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", () => resolve({ installed: false }));
      p.on("close", (code) =>
        resolve(code === 0 ? { installed: true, version: out.trim() } : { installed: false }),
      );
    } catch {
      resolve({ installed: false });
    }
  });
});

ipcMain.handle("quarto:render", async (e, { root, to }) => {
  return new Promise((resolve) => {
    try {
      const p = spawn("quarto", ["render", "manuscript/main.qmd", "--to", to || "pdf"], {
        cwd: root,
      });
      let log = "";
      const send = (s) => {
        log += s;
        e.sender.send("quarto:log", s);
      };
      p.stdout.on("data", (d) => send(String(d)));
      p.stderr.on("data", (d) => send(String(d)));
      p.on("error", (err) => resolve({ ok: false, log: String(err.message) }));
      p.on("close", (code) => resolve({ ok: code === 0, code, log }));
    } catch (err) {
      resolve({ ok: false, log: String(err) });
    }
  });
});

// ---------------------------------------------------------------------------
// IPC: integrated terminal. The renderer's xterm.js front-end drives a native
// login shell ($SHELL on macOS/Linux) running in a real PTY here, so colors,
// curses apps, and job control all work. A session outlives margin view
// switches (the renderer keeps one alive) and is reaped with its window / on
// quit. Streaming mirrors quarto:log + onFsChanged (send + on/unsubscribe).
// ---------------------------------------------------------------------------
const ptySessions = new Map(); // id -> { pty, wc }
let ptySeq = 0;

function defaultShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

// Kill + forget sessions matching `pred` (all of them when `pred` is omitted).
function reapPtys(pred) {
  for (const [id, s] of [...ptySessions]) {
    if (!pred || pred(s)) {
      try {
        s.pty.kill();
      } catch {
        /* already gone */
      }
      ptySessions.delete(id);
    }
  }
}

ipcMain.handle("pty:create", (e, opts = {}) => {
  if (!nodePty) return { ok: false, error: "Terminal backend unavailable (node-pty not loaded)." };
  const wc = e.sender;
  // Optional command (e.g. the agent drawer spawns `claude`); default = the login shell.
  const command = typeof opts.command === "string" && opts.command.trim() ? opts.command : defaultShell();
  const cmdArgs = Array.isArray(opts.args) ? opts.args.map(String) : [];
  // Open in the requested dir, else the open project root, else home.
  const wanted = opts.cwd;
  const cwd =
    wanted && fs.existsSync(wanted)
      ? wanted
      : currentRoot && fs.existsSync(currentRoot)
        ? currentRoot
        : app.getPath("home");
  const cols = Math.max(1, opts.cols | 0) || 80;
  const rows = Math.max(1, opts.rows | 0) || 24;
  let child;
  try {
    child = nodePty.spawn(command, cmdArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        TERM_PROGRAM: "Flux",
        COLORTERM: "truecolor",
        ...(opts.env && typeof opts.env === "object" ? opts.env : {}),
      },
    });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  const id = `pty${++ptySeq}`;
  ptySessions.set(id, { pty: child, wc });
  child.onData((data) => {
    if (!wc.isDestroyed()) wc.send("pty:data", { id, data });
  });
  child.onExit(({ exitCode, signal }) => {
    if (!wc.isDestroyed()) wc.send("pty:exit", { id, exitCode, signal });
    ptySessions.delete(id);
  });
  return { ok: true, id, shell, cwd, pid: child.pid };
});

ipcMain.on("pty:write", (_e, id, data) => {
  const s = ptySessions.get(id);
  if (s) {
    try {
      s.pty.write(data);
    } catch {
      /* closed mid-write */
    }
  }
});

ipcMain.on("pty:resize", (_e, id, cols, rows) => {
  const s = ptySessions.get(id);
  if (s) {
    try {
      s.pty.resize(Math.max(1, cols | 0) || 80, Math.max(1, rows | 0) || 24);
    } catch {
      /* closed mid-resize */
    }
  }
});

ipcMain.handle("pty:kill", (_e, id) => {
  const s = ptySessions.get(id);
  if (s) {
    try {
      s.pty.kill();
    } catch {
      /* already gone */
    }
    ptySessions.delete(id);
  }
  return true;
});
