const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, safeStorage, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { resolveToDoi } = require("./resolveDoi.cjs");
const { parseFluxUrl, fluxUrlFromArgv } = require("./fluxUrl.cjs");
const { createProxyEngine } = require("./proxyFetch.cjs");
const { createNetGet } = require("./netFetch.cjs");

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

// W6: quit/close flush handshake. When a window is asked to close (X button, our
// custom title-bar close, Ctrl+W, or Cmd-Q via before-quit), we hold the close,
// ask the renderer to flush every dirty mode, and destroy only once it acks (or
// after a timeout so a wedged renderer can never brick quit). `quitting` records
// that we're tearing the whole app down, so the post-flush destroy re-issues the
// quit (needed on macOS, where destroying the last window doesn't quit). The state
// machine + menu template live in appLifecycle.cjs so they stay unit-testable.
const { createFlushCoordinator, appMenuTemplate } = require("./appLifecycle.cjs");
let quitting = false;
const flushCoordinator = createFlushCoordinator();
ipcMain.on("app:flush:done", (_e, token) => flushCoordinator.ack(token));

// W1 (V1 review): surface main-process failures to the renderer as shell toasts.
// level ∈ "info" | "success" | "error". Falls back to the console when no window.
function notifyRenderer(level, msg, detail) {
  try {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("app:error", {
        level,
        msg,
        detail: detail == null ? undefined : String(detail),
      });
    else console.error(`[flux] ${msg}`, detail ?? "");
  } catch {
    /* window mid-teardown */
  }
}

const recentWrites = new Map(); // absPath -> expiry (ms)
function noteWrite(p) {
  recentWrites.set(path.resolve(p), Date.now() + 1500);
}

// W2 (V1 review): durable renderer writes — every fs:write* lands via
// write-tmp + fsync + rename, so a crash/power-loss can never truncate a
// project file and no reader (agent CLI, watcher) sees a half-written file.
// The dot-prefixed `.name.tmp-<pid>-<seq>` pattern is shared with
// flux-core/fsx.ts and ignored by the project watcher below.
let atomicSeq = 0;
const TMP_WRITE_RE = /(^|[/\\])\.[^/\\]*\.tmp-\d+-\d+$/;
async function atomicWriteMain(p, data) {
  const dir = path.dirname(p);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.tmp-${process.pid}-${++atomicSeq}`);
  noteWrite(tmp);
  const fh = await fs.promises.open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.promises.rename(tmp, p);
    // SHL-10: refresh the self-write TTL at COMPLETION. The watcher's
    // awaitWriteFinish only fires ≥250ms after the last write, so a large/slow
    // write (e.g. the ~12MB enrich.json) could otherwise outlive the TTL set at
    // write-start and echo back as a spurious "external change".
    noteWrite(p);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
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
  // W12 (SHL-6): dropped app.getPath("home") — allowing the entire user home made
  // the guard nearly a no-op. Imports/exports outside the project still work because
  // a file dialog `approveDir`s the chosen directory. Roots: the project, the app's
  // own dirs, the machine-global FluxLib, and dialog-approved dirs.
  const roots = [
    currentRoot,
    app.getPath("userData"),
    app.getPath("temp"),
    getFluxLibRoot(),
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
// W3: locks held by the GUI are heartbeat-restamped every 10s so a long human
// edit never falsely expires past the 30s TTL, and everything releases on
// quit/project-switch. Lock files mirror flux-core/locks.ts.
const LOCK_TTL_MS = 30_000;
const heldGuiLocks = new Map(); // "scope:name" -> interval
function lockDirFor(scope) {
  if (scope === "fluxlib") return path.join(fluxLibDir(), ".fluxlib", "locks");
  return currentRoot ? path.join(currentRoot, ".meta", "locks") : null;
}
function writeLockFile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  noteWrite(p);
  fs.writeFileSync(p, JSON.stringify({ client: "human", pid: process.pid, ts: new Date().toISOString() }));
}
function releaseGuiLock(key) {
  const held = heldGuiLocks.get(key);
  if (!held) return;
  clearInterval(held.interval);
  heldGuiLocks.delete(key);
  try {
    noteWrite(held.path);
    fs.rmSync(held.path, { force: true });
  } catch {
    /* already gone */
  }
}
function releaseAllGuiLocks() {
  for (const key of [...heldGuiLocks.keys()]) releaseGuiLock(key);
}
ipcMain.handle("lock:set", (_e, { name, held, scope = "project" }) => {
  const dir = lockDirFor(scope);
  if (!dir) return false;
  const key = `${scope}:${name}`;
  const p = path.join(dir, `${name}.json`);
  try {
    if (held) {
      if (heldGuiLocks.has(key)) {
        writeLockFile(p); // restamp now (fresh activity)
        return true;
      }
      writeLockFile(p);
      const interval = setInterval(() => {
        try {
          writeLockFile(p);
        } catch {
          /* transient */
        }
      }, 10_000);
      heldGuiLocks.set(key, { path: p, interval });
    } else {
      releaseGuiLock(key);
    }
    return true;
  } catch (e) {
    console.warn("[flux] lock set failed:", e && e.message);
    return false;
  }
});

// W3: renderer-held short locks around FluxLib/project read-modify-writes (the
// renderer twins of flux-core's withLockAt). Returns { ok } or { ok:false, heldBy }.
ipcMain.handle("lock:acquire", (_e, { scope = "project", name }) => {
  const dir = lockDirFor(scope);
  if (!dir) return { ok: true, noop: true }; // no root yet — nothing to guard
  const p = path.join(dir, `${name}.json`);
  try {
    const info = JSON.parse(fs.readFileSync(p, "utf8"));
    const t = Date.parse(info?.ts);
    const freshLock = Number.isFinite(t) && Date.now() - t < LOCK_TTL_MS;
    if (freshLock && info.client !== "human") return { ok: false, heldBy: info.client };
  } catch {
    /* absent/corrupt lock — treat as free */
  }
  try {
    writeLockFile(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, heldBy: "error: " + (e && e.message) };
  }
});
ipcMain.handle("lock:release", (_e, { scope = "project", name }) => {
  const dir = lockDirFor(scope);
  if (!dir) return true;
  const p = path.join(dir, `${name}.json`);
  try {
    const info = JSON.parse(fs.readFileSync(p, "utf8"));
    if (info?.client && info.client !== "human") return true; // never release another client's lock
  } catch {
    /* fall through to remove */
  }
  try {
    noteWrite(p);
    fs.rmSync(p, { force: true });
  } catch {
    /* already gone */
  }
  return true;
});

// ---------------------------------------------------------------------------
// Crank the GPU knobs: prefer hardware rasterization/compositing everywhere.
// (Chromium handles large canvases on NVIDIA far better than WebKitGTK.)
// ---------------------------------------------------------------------------
// GPU config. On NVIDIA the default XWayland path can segfault the GPU process;
// native Wayland (what the Figma desktop app uses on this machine) is stable.
// `ozone-platform-hint=auto` picks Wayland when available, else X11 elsewhere.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
// SHL-15: a stable V1 respects Chromium's GPU blocklist by default (it exists to avoid
// crashes on known-bad driver combos) rather than forcing accel over it, and
// enable-gpu-rasterization is the Chromium-130 default so it's dropped as redundant.
// FORCEGPU=1 restores the old always-force behaviour where the blocklist is overly cautious.
if (process.env.FORCEGPU === "1") {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
}

// Escape hatches if a machine still has GPU trouble:
//   FORCEGPU=1     ignore the GPU blocklist (force hardware acceleration)
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

// W6: a deliberate application menu. The default menu was hidden but its
// accelerators stayed live — most dangerously Ctrl/Cmd+R (reload) and
// Ctrl/Cmd+Shift+I, which silently wipe unsaved renderer state. The template
// (which platform gets what) lives in appLifecycle.cjs; here we just realize it.
function buildAppMenu() {
  const template = appMenuTemplate({
    isMac: process.platform === "darwin",
    isDev: !!DEV_URL,
  });
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}

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

  // W12 (SHL-3): lock the top frame to the app document. A stray navigation — a file
  // dropped onto non-dropzone chrome, a clicked external link, window.open — would
  // otherwise load a new origin INTO this window, and the preload re-injects window.fig
  // (fs / spawn / keys) into whatever loads. Deny any in-window navigation that isn't the
  // app itself, and route http(s) targets to the OS browser instead of a new Electron window.
  const appUrl = DEV_URL || require("node:url").pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
  const isAppDoc = (url) => {
    try {
      const u = new URL(url);
      const a = new URL(appUrl);
      return u.origin === a.origin && u.pathname === a.pathname; // ignore hash/query (SPA)
    } catch {
      return false;
    }
  };
  win.webContents.on("will-navigate", (e, url) => {
    if (isAppDoc(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Keep the renderer's custom maximize/restore button in sync.
  win.on("maximize", () => win.webContents.send("win:maximized", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized", false));

  // W6: hold the close until the renderer has flushed unsaved work. `destroy()`
  // force-closes without re-emitting `close`, so there's no re-entrancy; a repeat
  // close while the handshake is running is simply ignored.
  let flushing = false;
  win.on("close", (e) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return; // nothing to flush
    e.preventDefault();
    if (flushing) return;
    flushing = true;
    flushCoordinator.request(win, () => {
      if (!win.isDestroyed()) win.destroy();
      if (quitting) app.quit(); // finish the app-wide quit (matters on macOS)
    });
  });

  // Reap any integrated-terminal PTYs owned by this window's renderer on close,
  // and tear down the live agent bridge (removes .meta/live/bridge.json).
  win.on("closed", () => {
    reapPtys((s) => s.wc.isDestroyed());
    stopBridge();
    // SHL-7: drop the dead window + its file watcher, so a later external write
    // can't call .send() on destroyed webContents (macOS: window closed, app
    // stays in the dock).
    if (mainWindow === win) mainWindow = null;
    if (projectWatcher) {
      projectWatcher.close().catch(() => {});
      projectWatcher = null;
    }
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
  buildAppMenu(); // W6: replace the default menu (kills the stray reload accelerator)
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
app.on("before-quit", () => {
  quitting = true; // W6: the post-flush destroy re-issues app.quit() to finish the quit
  reapPtys();
  releaseAllGuiLocks(); // W3: never leave a stale "human" lock deferring agents
  stopBridge(); // W12 (SHL-8): remove .meta/live/bridge.json (+ its token) on quit
  try {
    proxyEngine.dispose(); // tear down the reusable proxy capture window
  } catch {
    /* not created yet */
  }
});

// W12 (SHL-8): a kill / Ctrl-C / SIGTERM used to leave a live-looking bridge.json
// (with its bearer token) on disk. Tear the bridge down + quit so the file is removed.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      stopBridge();
    } catch {
      /* already down */
    }
    app.quit();
  });
}

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
// SHL-12: reflect the app's unsaved state in the OS window chrome (macOS shows a dot in the
// close button; a no-op elsewhere). Fire-and-forget from the renderer's dirty indicator.
ipcMain.on("win:setDocumentEdited", (e, edited) => {
  BrowserWindow.fromWebContents(e.sender)?.setDocumentEdited?.(!!edited);
});

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
  await atomicWriteMain(p, Buffer.from(data));
});
ipcMain.handle("fs:readText", async (_e, p) => {
  fsGuard(p);
  return fs.promises.readFile(p, "utf8");
});
ipcMain.handle("fs:writeText", async (_e, p, text) => {
  fsGuard(p);
  noteWrite(p);
  await atomicWriteMain(p, Buffer.from(String(text), "utf8"));
});
ipcMain.handle("fs:mkdir", async (_e, p) => {
  fsGuard(p);
  await fs.promises.mkdir(p, { recursive: true });
});
ipcMain.handle("fs:exists", async (_e, p) => {
  fsGuard(p); // W12 (SHL-6): was unguarded — an existence-probe of any path
  try {
    await fs.promises.access(p);
    return true;
  } catch (err) {
    // SHL-18: only ENOENT means "not there". EACCES/EPERM etc. mean the path EXISTS but isn't
    // accessible — reporting that as absent would let a caller wrongly treat it as free to create.
    return !!(err && err.code && err.code !== "ENOENT");
  }
});
ipcMain.handle("fs:readdir", async (_e, p) => {
  fsGuard(p); // W12 (SHL-6): was unguarded — a directory-listing of any path
  try {
    const es = await fs.promises.readdir(p, { withFileTypes: true });
    return es.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
});
// Delete a file (used to clear a paper's fetch-failure record on a later success). Guarded
// to the same project/app roots as every other write; a missing file is a no-op success.
ipcMain.handle("fs:remove", async (_e, p) => {
  fsGuard(p);
  try {
    await fs.promises.rm(p, { force: true });
  } catch {
    /* already gone / unremovable — treat as removed */
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
  if (rel.startsWith("slides/")) return "slides"; // W10 (SLD-1)
  return null;
}

// W10 (LR-3): the machine-global FluxLib lives outside the project root, so classify
// its watched paths separately. We watch library.bib + .fluxlib/enrich.json + items/
// (NOT .fluxlib/locks/, whose 10s heartbeats would spam spurious revisions).
function fluxLibSubsystemFor(libRoot, abs) {
  const rel = path.relative(libRoot, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  if (rel === "library.bib" || rel === ".fluxlib/enrich.json" || rel.startsWith("items/")) {
    return "fluxlib";
  }
  // The drop-inbox: only landed PDFs count — sidecar notes and our own _unresolved/
  // filing must not re-trigger a scan (awaitWriteFinish already debounces mid-copy).
  if (rel.startsWith("pdfs_to_assign/")) {
    return !rel.includes("_unresolved/") && /\.pdf$/i.test(rel) ? "assign-inbox" : null;
  }
  return null;
}

ipcMain.handle("watch:setRoot", async (_e, root) => {
  releaseAllGuiLocks(); // W3: locks belong to the outgoing project/session
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
  if (!ck) {
    notifyRenderer(
      "error",
      "Live file-watch is unavailable",
      "chokidar failed to load — agent/script edits won't live-reload this session",
    );
    return false;
  }
  const libRoot = fluxLibDir();
  const targets = [
    ...["plots", "fig", "manuscript", "references", "slides"].map((d) => path.join(root, d)),
    // W10: the machine-global FluxLib (agent adds/enrich/fetch land here too).
    path.join(libRoot, "library.bib"),
    path.join(libRoot, ".fluxlib", "enrich.json"),
    path.join(libRoot, "items"),
    // The assign drop-inbox — a landed PDF triggers a scan in the open app.
    path.join(libRoot, "pdfs_to_assign"),
  ];
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
    // Never surface in-flight atomic-write temp files (ours or flux-core's).
    ignored: (p) => TMP_WRITE_RE.test(p),
  });
  projectWatcher.on("all", (_evt, abs) => {
    if (isSelfWrite(abs)) return;
    const subsystem = subsystemFor(root, abs) ?? fluxLibSubsystemFor(libRoot, abs);
    if (!subsystem) return;
    pending.set(subsystem, abs);
    if (!timer) timer = setTimeout(flush, 200);
  });
  projectWatcher.on("error", (err) =>
    notifyRenderer("error", "Project file-watch stopped", err && err.message),
  );
  return true;
});

// F2: re-run a plot's recipe (the user's own generating script, gated behind an
// explicit action). Returns the emitted SVG/manifest text so the renderer can
// hot-swap it in place. Mirrors flux-core.runRecipe; persists merged params.
ipcMain.handle("recipe:run", async (_e, { recipePath, params = {} }) => {
  // W12 (SHL-6): the recipe file carries the command that gets spawned + is rewritten
  // in place, so it must live under an allowed root — a planted recipe outside the
  // project can't be pointed at here. (Regenerating a plot IS meant to run the user's
  // configured command; containment is on the file paths, not the command itself.)
  fsGuard(recipePath);
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
  if (outAbs) fsGuard(outAbs); // W12: contain the plot output read to allowed roots
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

// W13: resolve the bundled CLI (dist/flux-cli.mjs — esbuild-built, self-contained).
// Packaged, it's asar-UNPACKED (a child launched with ELECTRON_RUN_AS_NODE has no
// asar support, so it must be on real disk); in dev it sits in <appRoot>/dist. If
// the bundle hasn't been built yet in dev, fall back to running the .ts via tsx.
function fluxCliArgs() {
  const appRoot = path.resolve(__dirname, "..");
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "flux-cli.mjs")
    : path.join(appRoot, "dist", "flux-cli.mjs");
  if (fs.existsSync(bundled)) return { appRoot, argv: [bundled] };
  return { appRoot, argv: ["--import", "tsx", "flux-cli.ts"] }; // dev, unbuilt
}

// Slide export (E): emit a self-contained offline .html for a deck. The engine is
// Node-only (prebaked runtime + inlined assets), so we run the `flux export-deck`
// verb in a child process using Electron's bundled Node (ELECTRON_RUN_AS_NODE).
// Returns the written path.
ipcMain.handle("slides:exportDeck", async (_e, { root, deckId }) => {
  if (!root || !deckId) return { ok: false, error: "missing root or deckId" };
  // W12 (SHL-6): deckId is interpolated into the output path — reject separators / ".."
  // so it can't escape <root>/exports/.
  if (/[\\/\x00]/.test(String(deckId)) || String(deckId).startsWith(".")) {
    return { ok: false, error: `unsafe deckId: ${deckId}` };
  }
  const { appRoot, argv } = fluxCliArgs();
  const res = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...argv, "export-deck", String(deckId), "--root", String(root)],
      { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e2) => resolve({ code: -1, stderr: String(e2) }));
    child.on("close", (c) => resolve({ code: c ?? 0, stderr: err }));
  });
  const outPath = path.join(root, "exports", `${deckId}.html`);
  fsGuard(outPath); // W12: keep the write inside allowed roots
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    return { ok: false, error: (res.stderr || `export exited ${res.code}`).trim() };
  }
  noteWrite(outPath); // don't let the file-watcher echo our own write
  return { ok: true, path: outPath };
});

// Render a standalone SVG to a vector PDF via Chromium's print engine.
ipcMain.handle("export:pdf", async (_e, { svg, outPath, w, h }) => {
  fsGuard(outPath); // W12 (SHL-6): was an unguarded write of any path
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
  fsGuard(outPath); // W12 (SHL-6): was an unguarded write of any path
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

// DOI → raw BibTeX via doi.org content negotiation. Registrar-agnostic — this is
// how entry creation rescues DataCite DOIs (arXiv 10.48550/*, Zenodo, theses) that
// Crossref's works API 404s. Returns { bibtex } or { error: "HTTP <status>" | msg }.
ipcMain.handle("cite:fetchDoiBibtex", async (_e, doi) => {
  const clean = String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) return { error: "not a DOI" };
  try {
    const res = await fetch("https://doi.org/" + encodeURIComponent(clean), {
      headers: { Accept: "application/x-bibtex", "User-Agent": "Flux/0.1 (manuscript editor)" },
      redirect: "follow",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const bibtex = (await res.text()).trim();
    if (!bibtex.startsWith("@")) return { error: "DOI did not return BibTeX" };
    return { bibtex };
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
// path so both share one waterfall. Backed by electron/netFetch.cjs: Chromium net stack
// on a persistent cookie-jar partition (one server-side session per publisher, not one
// per request/redirect-hop — the multiplier behind the Cell Press IP blocks), SSRF
// guard, per-mode timeouts. Always user-initiated ("Get PDF" / "Get PDFs").
const netGet = createNetGet({ session, getKey });
ipcMain.handle("pdf:netGet", (_e, url, mode = "bytes") => netGet(url, mode));

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
  // Fast path: the net.request probe. If it says signed-in, trust it. If it says NOT
  // signed-in, it may be a FALSE negative — net.request can't run the JavaScript that
  // EZProxy's IP-based-autologin `/connect?session=…&qurl=…` page uses to forward to the
  // resource, so it stalls on that page and misreads it as a login bounce. Confirm with a
  // real browser navigation (the same window that actually fetches), serialized via the mutex.
  let signedIn = await probeProxySignedIn();
  if (!signedIn) {
    try {
      const r = await runProxyExclusive(() => proxyEngine.checkSignedIn({ target: PROXY_AUTH_TARGET }));
      signedIn = !!(r && r.signedIn);
    } catch {
      /* keep the net.request result */
    }
  }
  return { configured: true, signedIn };
});

// The publisher-agnostic capture engine (electron/proxyFetch.cjs). Instead of scraping a
// PDF link and fetching it (fragile per-publisher; blocked by anti-bot; broken by viewer
// pages), it drives the real authenticated browser toward the PDF and captures the bytes
// off the network however the publisher delivers them (CDP interception + forced download
// + in-page fetch). Deps are the same proxy primitives defined above.
const proxyEngine = createProxyEngine({
  session,
  BrowserWindow,
  ezproxyPrefix,
  proxiedUrl,
  isProxyLoginUrl,
  PROXY_PARTITION,
  path,
  fs,
  os,
});

// Only ONE proxy window may exist at a time: the capture net's `will-download` hook lives
// on the shared persist:fluxproxy session, so overlapping fetches would cross-capture each
// other's bytes. This promise-chain mutex serializes every proxy call (bulk loop items AND
// a stray manual "Get via library" click) through a single queue. A cancelled *queued*
// call is rejected before it ever creates a window.
let proxyChain = Promise.resolve();
function runProxyExclusive(fn) {
  const run = proxyChain.then(fn, fn);
  // Keep the chain alive regardless of this call's outcome (never let a rejection break it).
  proxyChain = run.then(
    () => {},
    () => {},
  );
  return run;
}
// Per-call cancellation registry. The renderer passes an opaque token with each fetch and
// can abort it (or all in-flight, "*") via proxy:cancel — which fires the AbortController
// so the engine tears down its window and the fetch returns in ~1s instead of ~50s.
const proxyCalls = new Map(); // token -> AbortController

// Fetch a paywalled PDF for `target` (a DOI URL or landing page) through the proxy. Thin
// wrapper: validate config, register a cancel token, then run the capture engine inside the
// serialization mutex. Return contract is unchanged — { bytesB64, contentType, finalUrl } |
// { error, reason?, diag? } — so pdfFinderBridge needs no change (the extra reason/diag feed
// the Part C failure log).
ipcMain.handle("pdf:fetchViaProxy", async (_e, target, token) => {
  const prefix = ezproxyPrefix();
  if (!prefix) return { error: "No EZProxy prefix configured.", reason: "not-configured" };
  try {
    new URL(prefix);
  } catch {
    return { error: "Invalid EZProxy prefix URL.", reason: "not-configured" };
  }
  const ctrl = new AbortController();
  if (token != null) {
    // A cancel that arrived before this call was dequeued: honor it immediately.
    if (proxyCalls.get(token) === "cancelled") {
      proxyCalls.delete(token);
      return { error: "Cancelled.", reason: "cancelled" };
    }
    proxyCalls.set(token, ctrl);
  }
  try {
    return await runProxyExclusive(() => {
      if (ctrl.signal.aborted) return { error: "Cancelled.", reason: "cancelled" };
      return proxyEngine.capturePdfViaBrowser({ target, signal: ctrl.signal });
    });
  } catch (e) {
    if (e && e.name === "AbortError") return { error: "Cancelled.", reason: "cancelled" };
    return { error: String((e && e.message) || e), reason: "error" };
  } finally {
    if (token != null) proxyCalls.delete(token);
  }
});

// Cancel one in-flight/queued proxy fetch by token, or all of them with "*". Aborting the
// controller destroys the engine's window (hard-interrupts loadURL/executeJavaScript); a
// token with no live controller yet (still queued) is tombstoned so it aborts on dequeue.
ipcMain.handle("proxy:cancel", (_e, token) => {
  if (token == null || token === "*") {
    for (const ctrl of proxyCalls.values()) if (ctrl && ctrl.abort) ctrl.abort();
    return { ok: true };
  }
  const ctrl = proxyCalls.get(token);
  if (ctrl && ctrl.abort) ctrl.abort();
  else proxyCalls.set(token, "cancelled"); // arrived before the call registered — tombstone
  return { ok: true };
});

// API-key store (machine-global ~/FluxLib/keys.json). keys:get returns the raw map
// for the settings form (the user's own machine); keys:set merge-writes it.
ipcMain.handle("keys:get", () => readKeys());
ipcMain.handle("keys:set", (_e, patch) => {
  try {
    fs.mkdirSync(fluxLibDir(), { recursive: true });
    const next = { ...readKeys(), ...(patch || {}) };
    // W12 (SHL-8): API keys are plaintext — write owner-only, like the proxy creds.
    fs.writeFileSync(fluxKeysPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
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

ipcMain.handle("quarto:render", async (e, { root, to, docPath }) => {
  // Render the ACTIVE document, not always main.qmd. Containment: the doc must be
  // a .qmd resolving under the project root (no traversal via a crafted docPath).
  const rootAbs = path.resolve(String(root || ""));
  const rel = typeof docPath === "string" && docPath.trim() ? docPath : "manuscript/main.qmd";
  const docAbs = path.resolve(rootAbs, rel);
  if (!underDir(docAbs, rootAbs) || !/\.qmd$/i.test(docAbs)) {
    return { ok: false, log: `invalid document path: ${rel}` };
  }
  return new Promise((resolve) => {
    try {
      const p = spawn("quarto", ["render", rel, "--to", to || "pdf"], {
        cwd: rootAbs,
      });
      let log = "";
      const send = (s) => {
        log += s;
        e.sender.send("quarto:log", s);
      };
      p.stdout.on("data", (d) => send(String(d)));
      p.stderr.on("data", (d) => send(String(d)));
      p.on("error", (err) => resolve({ ok: false, log: String(err.message) }));
      p.on("close", (code) => {
        // Verify the artifact actually landed (a _quarto.yml output-dir moves it —
        // report what we found so the renderer can Reveal the real file).
        const ext = String(to || "pdf").toLowerCase();
        const candidates = [
          docAbs.replace(/\.qmd$/i, `.${ext}`),
          path.join(rootAbs, "_output", path.basename(docAbs).replace(/\.qmd$/i, `.${ext}`)),
        ];
        const outPath = candidates.find((c) => fs.existsSync(c));
        resolve({ ok: code === 0 && !!outPath, code, log: outPath ? log : log + "\n(no output file found)", outPath });
      });
    } catch (err) {
      resolve({ ok: false, log: String(err) });
    }
  });
});

// Reveal an exported file in the OS file manager (fsGuard'd — project/app roots +
// dialog-approved dirs only).
ipcMain.handle("shell:showItemInFolder", (_e, p) => {
  const abs = path.resolve(String(p || ""));
  fsGuard(abs);
  shell.showItemInFolder(abs);
  return true;
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

// R3 (FluxReader "Ask Claude"): how a `claude` session should launch the flux MCP
// server for the open project. The renderer embeds this in `claude --mcp-config`;
// claude then spawns the server itself (cwd = its own, so every path here must be
// absolute). Dev: the repo's tsx bin runs flux-mcp.ts. Packaged: a bundled
// dist/flux-mcp.mjs (asar-unpacked, like flux-cli.mjs) on Electron-as-Node.
ipcMain.handle("agent:mcpSpec", () => {
  const appRoot = path.resolve(__dirname, "..");
  const projectRoot = currentRoot && fs.existsSync(currentRoot) ? currentRoot : app.getPath("home");
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "flux-mcp.mjs")
    : path.join(appRoot, "dist", "flux-mcp.mjs");
  if (fs.existsSync(bundled)) {
    return {
      ok: true,
      projectRoot,
      command: process.execPath,
      args: [bundled, projectRoot],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const tsxBin = path.join(appRoot, "node_modules", ".bin", "tsx");
  const entry = path.join(appRoot, "flux-mcp.ts");
  if (!app.isPackaged && fs.existsSync(tsxBin) && fs.existsSync(entry)) {
    return { ok: true, projectRoot, command: tsxBin, args: [entry, projectRoot] };
  }
  return { ok: false, projectRoot };
});

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
  // SHL-18: report the shell/command actually launched (a path string), NOT the imported
  // electron `shell` module — the renderer's TermInfo.shell expects the former.
  return { ok: true, id, shell: command, cwd, pid: child.pid };
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
