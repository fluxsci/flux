const { app, BrowserWindow, Menu, ipcMain: rawIpcMain, dialog, shell, session, safeStorage, net } = require("electron");
// WS-9.4: every registration goes through the channel contract — an undeclared
// or kind-mismatched channel throws at startup, and assertAllRegistered() (in
// whenReady) catches declared-but-orphaned ones. verify-ipc-contract.ts checks
// the preload + push sides statically.
const ipcContract = require("./ipc/contract.cjs").wrapIpcMain(rawIpcMain);
const ipcMain = { handle: ipcContract.handle, on: ipcContract.on };
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { resolveToDoi } = require("./resolveDoi.cjs");
const { createCaptureIntake, newestXpi } = require("./captureIntake.cjs");
const { pickRelease } = require("./updateCheck.cjs");
const fluxPaths = require("./fluxPaths.cjs");
const { resolveSpawn } = require("./execResolve.cjs");

// Machine config is ALWAYS the lowercase app dir (~/.config/flux on Linux) —
// pinned before ANYTHING touches userData (the single-instance lock, prefs,
// textstyles, Chromium session state). Without this, packaged builds derive
// the capital-F dir from productName while dev + flux-core resolve lowercase.
// See AGENTS.md "Machine config paths"; gated by verify-fluxconfig.ts.
app.setPath("userData", fluxPaths.userDataDir());

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

// WS-9.4b: the FILES family (write-safety core + fsGuard + fs:*/dlg:* handlers)
// lives in ipc/files.cjs. main keeps the project-lifecycle roots it owns —
// currentRoot (set by watch:setRoot) and the WS-9.3 single pending-open slot —
// and lends them to the guard as a getter.
let currentRoot = null;
let pendingRoot = null;
const fileCore = require("./ipc/files.cjs").createFileCore({
  app,
  dialog,
  roots: () => [
    currentRoot,
    pendingRoot, // WS-9.3: the project being opened right now (single slot)
    getFluxConfigRoot(), // FluxLib lives inside; kept separately for the EXDEV-fallback state
    getFluxLibRoot(),
    // Zotero sync (2026-07-29): when connected, the BBT auto-export's folder and the
    // Zotero data dir are durable roots — startup sync reads the .bib and link-mode
    // papers resolve into storage/ without a per-session dialog approval. Evaluated
    // per call, so connecting/disconnecting applies immediately.
    ...zoteroRoots(),
  ],
  setPendingRoot: (ab) => {
    pendingRoot = ab;
  },
});

/** The user-configured Zotero dirs (prefs.zotero), [] when not connected. */
function zoteroRoots() {
  const z = readPrefs().zotero;
  if (!z || typeof z !== "object" || typeof z.bibPath !== "string" || !z.bibPath) return [];
  const out = [path.dirname(path.resolve(z.bibPath))];
  if (typeof z.dataDir === "string" && z.dataDir) out.push(path.resolve(z.dataDir));
  return out;
}
const { noteWrite, atomicWriteMain, isSelfWrite, fsGuard, approveDir, underDir } = fileCore;
const { TMP_WRITE_RE } = require("./ipc/files.cjs");


// ---------------------------------------------------------------------------
// Global preferences: <userData>/preferences.json — the first file-based config
// the GUI and the CLI/agents share (holds the FluxLib path). flux-core computes
// the same userData dir, so both sides agree on where the library lives.
// ---------------------------------------------------------------------------
const prefsFile = () => path.join(app.getPath("userData"), "preferences.json");

// Crash-safe SYNC write for machine-global state (prefs/textstyles). writePrefs
// is called inline from sync path resolvers, so it can't go async — but a
// truncated write (crash mid-write, or two Flux processes racing) would make
// readPrefs() silently fall back to defaults and re-resolve FluxConfig/FluxLib to
// the WRONG location. tmp + fsync + rename is atomic on POSIX (the preset writer
// already does tmp+rename for its files; this adds the fsync for durability).
let atomicSyncSeq = 0;
function atomicWriteSync(p, str) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}-${++atomicSyncSeq}`);
  noteWrite(tmp);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, str);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  noteWrite(p);
}

let _prefsCorruptHandled = false;
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8"));
  } catch (e) {
    // A MISSING file is normal (first run) → defaults, silently. A file that
    // EXISTS but won't parse is corruption: preserve it once (it holds the
    // fluxConfigPath pointer) and warn, rather than silently adopting the
    // fallback FluxConfig/FluxLib resolution as if nothing were wrong.
    if (e && e.code !== "ENOENT" && !_prefsCorruptHandled) {
      _prefsCorruptHandled = true;
      try {
        const bak = prefsFile() + `.corrupt-${Date.now()}`;
        fs.copyFileSync(prefsFile(), bak);
        console.error(`[flux] preferences.json is unreadable — backed up to ${bak} and continuing with defaults; re-check your FluxConfig folder in Settings.`);
      } catch {
        /* best-effort backup — never let a prefs read throw */
      }
    }
    return { schemaVersion: "0.1.0" };
  }
}
function writePrefs(next) {
  atomicWriteSync(prefsFile(), JSON.stringify(next, null, 2) + "\n");
}
// FluxLib is DERIVED from FluxConfig (<cfg>/FluxLib, legacy fallbacks
// pre-migration) — cached because fsGuard consults it on every guarded fs op.
// Invalidated on prefs:set and after ensureFluxConfig moves things.
let fluxLibRoot; // undefined = not yet resolved
function getFluxLibRoot() {
  if (fluxLibRoot !== undefined) return fluxLibRoot;
  fluxLibRoot = fluxPaths.resolveFluxLibPathSync(readPrefs());
  return fluxLibRoot;
}
let fluxConfigRoot; // undefined = not yet resolved (same cache discipline)
function getFluxConfigRoot() {
  if (fluxConfigRoot !== undefined) return fluxConfigRoot;
  fluxConfigRoot = fluxPaths.resolveFluxConfigPathSync(readPrefs());
  return fluxConfigRoot;
}
function invalidatePathCaches() {
  fluxLibRoot = undefined;
  fluxConfigRoot = undefined;
}

// API keys (machine-global <FluxLib>/keys.json), shared across every project.
// Read in main so credentials are attached here, never baked into renderer URLs.
const fluxLibDir = () => getFluxLibRoot();

// WS-9.4b: the AGENT family (live bridge + agent:mcpSpec) lives in ipc/agent.cjs.
const agentFamily = require("./ipc/agent.cjs").createAgentFamily({
  app,
  getMainWindow: () => mainWindow,
  getCurrentRoot: () => currentRoot,
  appendJournalLine,
  noteWrite,
  appRoot: path.resolve(__dirname, ".."),
});
agentFamily.registerHandlers(ipcMain);
const { startBridgeFor, stopBridge } = agentFamily;

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
// Ozone is Linux-only Chromium plumbing — don't emit the switch elsewhere.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}
// SHL-15: a stable V1 respects Chromium's GPU blocklist by default (it exists to avoid
// crashes on known-bad driver combos) rather than forcing accel over it, and
// enable-gpu-rasterization is a modern-Chromium default so it's dropped as redundant.
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
// TILEMEM=<mb> raises the compositor's GPU memory budget (tile memory), e.g.
// TILEMEM=1024. Diagnostic escape hatch ONLY — deliberately NOT a default:
// the "tile memory limits exceeded" spam came from the figure canvas's
// permanently composited .scene layer growing as content-bounds × zoom², and
// the real fix is the will-change lifecycle + one-repaint-per-zoom-gesture in
// src/lib/Canvas.svelte (figure-v1 P6). Raising the budget by default would
// mask any regression of that fix. Use it on a monitor-attached GPU to test
// whether residual warnings during deep-zoom gestures are budget-bound (see
// notes/Flux_Electron_Compositor_Notes.md for the count protocol).
if (process.env.TILEMEM) {
  app.commandLine.appendSwitch("force-gpu-mem-available-mb", process.env.TILEMEM);
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
  // Windows dev runs (`npx electron .`) have no packaged exe icon — point the
  // window at the repo's .ico so the taskbar doesn't show the Electron default.
  // macOS/Linux keep today's exact window options.
  const winIcon = path.join(__dirname, "..", "build", "icons", "icon.ico");
  const win = new BrowserWindow({
    ...(process.platform === "win32" && fs.existsSync(winIcon) ? { icon: winIcon } : {}),
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#100f0f",
    title: "Flux", // flux-cap-ok (display name, not a path)
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
}

// ---------------------------------------------------------------------------
// Single-instance lock. Web capture no longer rides a flux:// protocol handler —
// the bookmarklet downloads a file and the capture watcher picks it up (see
// src/lib/references/captureIntake.svelte.ts) — so this only keeps one app alive.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  // One-time machine init/migration (FluxConfig, capital→lowercase config-dir
  // merge, FluxLib move, Guidelines seed) BEFORE the window exists, so the
  // renderer and the FluxLib watcher only ever see post-migration state. A
  // failure must never block launch — the path resolvers keep legacy fallbacks.
  try {
    await fluxPaths.ensureFluxConfig();
  } catch (e) {
    console.error("flux config init failed:", (e && e.message) || e);
  }
  invalidatePathCaches(); // migration may have moved the library
  // WS-9.1: inject the CSP as a RESPONSE HEADER for the dev-server document —
  // the meta in index.html covers the packaged file:// load, but headers are
  // the stronger mechanism and cover dev before the parser sees the meta.
  // Scoped to the app's own dev origin on the DEFAULT session only — the
  // publisher proxy-capture windows run in their own partitions and must never
  // inherit app policy.
  if (DEV_URL) {
    const { session } = require("electron");
    const DEV_CSP =
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-Q5r/0YfmAtc2/to6EHsX0PaBtKO7BSpnAkNsqnhWKas=' 'sha256-8Yu/cmPzQpyhF7nWdsKoaj4FeP+hooq1bXRxlVz1CLE=' 'sha256-F6i5nGBIqfoaCOZiZzX7PEXC7HagpdnrdJHeF3PJ3rU='; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; " +
      "connect-src 'self' ws://localhost:1420 ws://127.0.0.1:1420 http://localhost:1420 http://127.0.0.1:1420; " +
      "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'self'; form-action 'none'";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const isAppDoc =
        details.resourceType === "mainFrame" &&
        /^http:\/\/(localhost|127\.0\.0\.1):1420\//.test(details.url);
      if (!isAppDoc) return callback({ responseHeaders: details.responseHeaders });
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [DEV_CSP],
        },
      });
    });
  }
  buildAppMenu(); // W6: replace the default menu (kills the stray reload accelerator)
  ipcContract.assertAllRegistered(); // WS-9.4: no declared channel may be orphaned
  createWindow();
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
    networkFamily.disposeProxy(); // tear down the reusable proxy capture window
  } catch {
    /* not created yet */
  }
  try {
    correctionFamily.shutdown();
  } catch {
    /* correction family was not initialized yet */
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

// Global preferences (FluxConfig pointer, etc.) — see prefsFile()/readPrefs()
// above. `fluxLibResolved`/`fluxConfigResolved` are the absolute paths actually
// in use (FluxLib is DERIVED from FluxConfig), so the Settings UI can display +
// reveal them without knowing $HOME.
ipcMain.handle("prefs:get", () => ({
  ...readPrefs(),
  fluxLibResolved: fluxLibDir(),
  fluxConfigResolved: getFluxConfigRoot(),
  // The machine Context layer (principal-agent scheme) — display/open helpers.
  contextResolved: fluxPaths.contextPathSync(readPrefs()),
}));
ipcMain.handle("prefs:set", (_e, patch) => {
  const cur = readPrefs();
  const next = { ...cur, ...(patch || {}), schemaVersion: cur.schemaVersion || "0.1.0" };
  writePrefs(next);
  invalidatePathCaches(); // fluxConfigPath (or legacy fluxLibPath) may have changed
  return next;
});

// Move the whole FluxConfig folder (Settings "Move…"): user picks the new
// PARENT dir; the folder is always named exactly "FluxConfig". The watcher is
// closed first (open fds on the tree being renamed); the renderer requires a
// restart afterwards — same contract as the old library-folder change.
ipcMain.handle("config:move", async (_e, parentDir) => {
  if (projectWatcher) {
    await projectWatcher.close().catch(() => {});
    projectWatcher = null;
  }
  const r = await fluxPaths.moveFluxConfig(parentDir);
  invalidatePathCaches();
  return r;
});

// Machine-global named text-style library: <userData>/textstyles.json
// ({ schemaVersion, styles: TextStyle[] }). Shared across every project;
// applying a library style copies it into the project (copy-on-apply — the
// renderer owns that logic; this is a dumb list store). flux-core reads the
// same file for the CLI's --global listing (userDataDir parity, like prefs).
const textStylesFile = () => path.join(app.getPath("userData"), "textstyles.json");
ipcMain.handle("textstyles:get", () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(textStylesFile(), "utf8"));
    return Array.isArray(parsed?.styles) ? parsed.styles : [];
  } catch {
    return [];
  }
});
ipcMain.handle("textstyles:set", (_e, styles) => {
  atomicWriteSync(
    textStylesFile(),
    JSON.stringify({ schemaVersion: "0.1.0", styles: Array.isArray(styles) ? styles : [] }, null, 2) + "\n",
  );
  return true;
});

// Machine-global DESIGN-PRESET library: <FluxConfig>/presets/designs/**.json —
// the user's reusable primitive designs (line/path/rect/ellipse), one preset
// per file, subfolders allowed. Dumb path-safe file store; the renderer's
// picker + save flow own all semantics. rel paths are normalized and must stay
// inside the designs dir (no traversal, no absolutes).
const presetsDir = () => path.join(fluxPaths.resolveFluxConfigPathSync(readPrefs()), "presets", "designs");
const presetPathSafe = (rel) => {
  const clean = path.normalize(String(rel || "")).replace(/^([/\\.])+/, "");
  if (!clean || clean.split(/[/\\]/).some((s) => s === "..")) return null;
  if (!/\.json$/i.test(clean)) return null;
  const root = presetsDir();
  const abs = path.join(root, clean);
  return abs.startsWith(root + path.sep) ? abs : null;
};
ipcMain.handle("presets:list", () => {
  const root = presetsDir();
  const out = [];
  const walk = (dir, rel) => {
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (out.length >= 500) return; // sanity cap, not a UX limit anyone should hit
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && e.name.endsWith(".json")) {
        try {
          out.push({ rel: r, preset: JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")) });
        } catch {
          /* unreadable preset file — skip, never break the whole listing */
        }
      }
    }
  };
  walk(root, "");
  return out;
});
ipcMain.handle("presets:save", (_e, rel, preset) => {
  const abs = presetPathSafe(rel);
  if (!abs || !preset || typeof preset !== "object") return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(preset, null, 2) + "\n");
  fs.renameSync(tmp, abs);
  return true;
});
ipcMain.handle("presets:delete", (_e, rel) => {
  const abs = presetPathSafe(rel);
  if (!abs) return false;
  try {
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
});

// Machine-global ANIMATION preset/template library (animation rework §7):
// <FluxConfig>/presets/animations/**.json (presets) and
// <FluxConfig>/presets/anim-templates/**.json (templates). Same dumb
// path-safe file store as the design presets; `kind` picks the root.
const animlibDir = (kind) =>
  path.join(
    fluxPaths.resolveFluxConfigPathSync(readPrefs()),
    "presets",
    kind === "template" ? "anim-templates" : "animations",
  );
const animlibPathSafe = (kind, rel) => {
  const clean = path.normalize(String(rel || "")).replace(/^([/\\.])+/, "");
  if (!clean || clean.split(/[/\\]/).some((s) => s === "..")) return null;
  if (!/\.json$/i.test(clean)) return null;
  const root = animlibDir(kind);
  const abs = path.join(root, clean);
  return abs.startsWith(root + path.sep) ? abs : null;
};
ipcMain.handle("animlib:list", (_e, kind) => {
  const root = animlibDir(kind);
  const out = [];
  const walk = (dir, rel) => {
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (out.length >= 500) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && e.name.endsWith(".json")) {
        try {
          out.push({ rel: r, payload: JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")) });
        } catch {
          /* unreadable file — skip, never break the whole listing */
        }
      }
    }
  };
  walk(root, "");
  return out;
});
ipcMain.handle("animlib:save", (_e, kind, rel, payload) => {
  const abs = animlibPathSafe(kind, rel);
  if (!abs || !payload || typeof payload !== "object") return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  fs.renameSync(tmp, abs);
  return true;
});
ipcMain.handle("animlib:delete", (_e, kind, rel) => {
  const abs = animlibPathSafe(kind, rel);
  if (!abs) return false;
  try {
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
});

// Machine-global SLIDE-PRESET library: <FluxConfig>/presets/slides/**.json —
// whole-slide snapshots (elements + groups + beats + background + embedded
// asset bytes) saved from any deck and re-insertable anywhere. Same dumb
// path-safe file store as the design/animation libraries above; the renderer
// (src/lib/slide/presetLib.ts) owns all semantics.
const slidelibDir = () => path.join(fluxPaths.resolveFluxConfigPathSync(readPrefs()), "presets", "slides");
const slidelibPathSafe = (rel) => {
  const clean = path.normalize(String(rel || "")).replace(/^([/\\.])+/, "");
  if (!clean || clean.split(/[/\\]/).some((s) => s === "..")) return null;
  if (!/\.json$/i.test(clean)) return null;
  const root = slidelibDir();
  const abs = path.join(root, clean);
  return abs.startsWith(root + path.sep) ? abs : null;
};
ipcMain.handle("slidelib:list", () => {
  const root = slidelibDir();
  const out = [];
  const walk = (dir, rel) => {
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (out.length >= 500) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && e.name.endsWith(".json")) {
        try {
          out.push({ rel: r, payload: JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")) });
        } catch {
          /* unreadable preset file — skip, never break the whole listing */
        }
      }
    }
  };
  walk(root, "");
  return out;
});
ipcMain.handle("slidelib:save", (_e, rel, payload) => {
  const abs = slidelibPathSafe(rel);
  if (!abs || !payload || typeof payload !== "object") return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  fs.renameSync(tmp, abs);
  return true;
});
ipcMain.handle("slidelib:delete", (_e, rel) => {
  const abs = slidelibPathSafe(rel);
  if (!abs) return false;
  try {
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// Update check (5.3). Packaged builds only, at most once per day: ask GitHub for
// the latest release and, if its tag is newer than app.getVersion(), hand the
// renderer { version, url } to toast. The renderer owns the user opt-out
// (settings.updateCheck) and the toast; main owns the packaged-only guard, the
// daily throttle (prefs.lastUpdateCheck), and the fetch (no renderer CORS/UA
// issues). Best-effort — any failure resolves to null (never nags, never errors).
// ---------------------------------------------------------------------------
const RELEASES_API = "https://api.github.com/repos/fluxsci/flux/releases/latest";
const RELEASES_PAGE = "https://github.com/fluxsci/flux/releases/latest";
const UPDATE_THROTTLE_MS = 24 * 60 * 60 * 1000;

ipcMain.handle("update:check", async () => {
  try {
    if (!app.isPackaged) return null; // dev / electron:dev never self-check
    const prefs = readPrefs();
    const last = Number(prefs.lastUpdateCheck) || 0;
    if (Date.now() - last < UPDATE_THROTTLE_MS) return null; // ≤1/day
    // Record the attempt up front so repeated launches in a day don't re-hit GitHub.
    writePrefs({ ...prefs, lastUpdateCheck: Date.now(), schemaVersion: prefs.schemaVersion || "0.1.0" });
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": "Flux/0.1 (update check)", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    // pickRelease (updateCheck.cjs) owns the parse + newer-than-current decision.
    return pickRelease(await res.json(), app.getVersion(), RELEASES_PAGE);
  } catch {
    return null; // offline / rate-limited / malformed — silently skip
  }
});

// ---------------------------------------------------------------------------
// IPC: file dialogs + filesystem (the FILES family — ipc/files.cjs)
// ---------------------------------------------------------------------------
fileCore.registerHandlers(ipcMain);

// ---------------------------------------------------------------------------
// File-watch live reload (F1): the renderer registers the open project root; we
// watch plots/, fig/, manuscript/**, references/, slides/ and emit debounced
// fs:changed events ({ subsystem, path }), skipping the app's own writes so
// agent/script edits "pop into" the open window non-destructively.
// ---------------------------------------------------------------------------
// Dissection material (per-plot companion folders under plots/) gets its OWN subsystem: a
// script dropping 20 per-subject panels must live-refresh an open Dissect viewer, not trigger
// 20 plots re-sync sweeps. dissectRules.js is ESM (the renderer + flux-core import it too), so
// this CommonJS file loads it by dynamic import — resolved at watch setup, before any event
// can arrive; if it somehow fails to load, the events safely degrade to the plots subsystem.
// Lighttable collections under plots/ are the other reserved folder (plotsFolders.js, same
// ESM/dynamic-import story): exploratory image sets Flux never reads. They are pruned from the
// watch targets outright — this is the belt to that braces, so a path that slips through can
// still never be mistaken for a plot re-sync.
// A sync tool's leftovers get their own treatment BEFORE any subsystem sees them
// (conflictRules.js, same ESM/dynamic-import story). Without this a Syncthing conflict
// copy of main.qmd routes to "manuscript" and lands in the document list as a document,
// and every in-flight `.syncthing.*.tmp` transfer bumps a revision for nothing. Temp
// files vanish; conflict copies raise the dedicated "conflict" subsystem, which the
// renderer turns into a banner the user has to clear.
let conflictRules = null;
let plotFolderRules = null;
let dissectRules = null;
function subsystemFor(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  if (conflictRules) {
    if (conflictRules.isSyncTempPath(rel)) return null;
    if (conflictRules.isConflictPath(rel)) return "conflict";
  }
  if (rel.startsWith("plots/")) {
    if (plotFolderRules && plotFolderRules.isLighttableProjectRel(rel)) return null;
    return dissectRules && dissectRules.isDissectionProjectRel(rel) ? "dissections" : "plots";
  }
  if (rel.startsWith("fig/")) return "fig";
  if (rel.startsWith("manuscript/")) return "manuscript";
  if (rel.startsWith("references/")) return "references";
  if (rel.startsWith("slides/")) return "slides"; // W10 (SLD-1)
  // Principal-agent scheme: Context docs (+ their comments sidecars) live-reload
  // through the same chain as manuscript docs. Transcripts/Dispatches writes
  // also land here — harmless: the renderer suffix-matches the active doc.
  if (rel.startsWith("Context/")) return "context";
  if (rel === ".meta/feedback.ndjson") return "feedback";
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
    // `_unresolved/` is our own filing; `_captured_supplements/` is capture staging waiting on
    // a citekey — neither is a paper to identify, so neither may wake the assign scan.
    if (rel.includes("_unresolved/") || rel.includes("_captured_supplements/")) return null;
    return /\.pdf$/i.test(rel) ? "assign-inbox" : null;
  }
  return null;
}

// Web capture: the bookmarklet downloads `flux-<slug>.pdf` / `.fluxcap` into the browser's
// download folder. We watch ONLY for that prefix, so an ordinary download can never be
// mistaken for a capture and nothing of the user's is ever touched by accident.
// captureRules.js is ESM (the renderer imports it too), so this CommonJS file loads it by
// dynamic import — resolved once at watch setup, before any event can arrive.
//
// The event is a NOTIFICATION, not a trigger: the renderer only re-reads the waiting COUNT so
// the Library's Assign button stays live. Intake itself is user-initiated (startup or that
// button), so a capture landing here never rearranges the download folder on its own.
let captureRules = null;
function captureSubsystemFor(dir, abs) {
  if (!captureRules) return null;
  const rel = path.relative(dir, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  // Two drop points: the extension writes into `<downloads>/flux/` (one click can produce an
  // article plus several supplements), the bookmarklet can only write to the root because
  // `<a download>` cannot name a directory. Nothing deeper is watched.
  const parts = rel.split("/");
  const name = parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === captureRules.CAPTURE_SUBDIR ? parts[1] : null;
  return name && captureRules.isCaptureFile(name) ? "capture" : null;
}

/** The folder the browser downloads into. Overridable in prefs for a non-default setup. */
function captureDir() {
  const raw = readPrefs().captureDir;
  if (typeof raw === "string" && raw.trim()) return path.resolve(raw.trim());
  try {
    return app.getPath("downloads");
  } catch {
    return null;
  }
}
ipcMain.handle("capture:dir", () => captureDir());

// Web-capture intake. Implementation lives in ./captureIntake.cjs (extracted so the e2e gate
// can drive it without booting the app); main only injects the paths and registers channels.
const captureIntakeEngine = createCaptureIntake({
  captureDir,
  fluxLibDir,
  path,
  fs,
  fsp: require("node:fs/promises"),
  loadRules: () => import("./captureRules.js"),
});
ipcMain.handle("capture:count", () => captureIntakeEngine.count());
ipcMain.handle("capture:intake", () => captureIntakeEngine.intake());
ipcMain.handle("capture:discard", (_e, name) => captureIntakeEngine.discard(name));
ipcMain.handle("capture:park", (_e, name, note) => captureIntakeEngine.park(name, note));

// Web-capture onboarding. The extension is installed from a folder (Chromium) or a signed
// .xpi (Firefox), and a browser will not let a page navigate to chrome://extensions or
// about:addons — so the honest affordances are "open the folder for me" and "open the add-on
// file for me", with the address copied for the user to paste.
function extensionDir() {
  // Packaged: shipped beside the app. Dev: the build output.
  const packaged = path.join(process.resourcesPath || "", "extension", "dist");
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, "..", "extension", "dist");
}
function signedXpi() {
  for (const dir of [path.join(process.resourcesPath || "", "extension", "signed"), path.join(__dirname, "..", "extension", "signed")]) {
    try {
      // NEWEST, not first: signing bumps the version and leaves the old .xpi behind, and
      // readdir order is arbitrary — see newestXpi's note.
      const hit = newestXpi(fs.readdirSync(dir));
      if (hit) return path.join(dir, hit);
    } catch {
      /* not there */
    }
  }
  return null;
}
ipcMain.handle("capture:extensionInfo", () => ({ dir: extensionDir(), hasDir: fs.existsSync(extensionDir()), xpi: signedXpi() }));
ipcMain.handle("capture:revealExtension", () => {
  const dir = extensionDir();
  if (!fs.existsSync(dir)) return { error: "the extension folder isn't in this build" };
  shell.showItemInFolder(path.join(dir, "manifest.json"));
  return { ok: true };
});
ipcMain.handle("capture:installXpi", async () => {
  const xpi = signedXpi();
  if (!xpi) return { error: "the signed add-on isn't bundled in this build yet" };
  // openPath hands the file to whatever the OS registered for `.xpi`. macOS registers NOTHING
  // — Launch Services answers "there is no application set to open the file" — and Linux and
  // Windows only sometimes do, depending on how Firefox was installed. So a failure here is the
  // NORMAL case on a Mac, not an exception, and reporting it as an error left the one browser
  // that needs a signed add-on with no working route at all.
  //
  // Falling back to revealing the file is the same honest move the Chromium column already
  // makes: Flux cannot drive about:addons from outside (browsers refuse that deliberately), so
  // it puts the file in front of you and hands you the address to paste.
  // And it does not always ANSWER. macOS fails fast with a message; Linux hands off to the
  // desktop's opener, which for an unregistered type can sit there indefinitely (measured: no
  // answer after 6s for a .xpi). An await with no bound is a button that does nothing at all,
  // forever, with no way for the panel to say so — so the wait is bounded and the fallback is
  // identical either way.
  const outcome = await Promise.race([
    shell.openPath(xpi).then((err) => (err ? "failed" : "opened")),
    new Promise((r) => setTimeout(() => r("no-answer"), 2500)),
  ]);
  if (outcome === "opened") return { ok: true };
  shell.showItemInFolder(xpi);
  return { revealed: true, path: xpi };
});

// ---------------------------------------------------------------------------
// Sync-conflict scan. The watcher only sees a conflict copy that lands while the app is
// OPEN; most arrive while it is closed, so the renderer also scans on project open and
// after every "conflict" event. Walks the whole project — including .meta/, whose
// append-only ledgers are the likeliest thing to conflict — and skips only VCS/tooling
// internals. Capped, because an unresolved conflict is a handful of files, never
// thousands: hitting the cap still surfaces the banner, which is the point.
// ---------------------------------------------------------------------------
const CONFLICT_SCAN_SKIP_DIRS = new Set([".git", "node_modules", ".stversions", ".stfolder"]);
const CONFLICT_SCAN_MAX = 200;
const CONFLICT_IDENTICAL_MAX_BYTES = 8 * 1024 * 1024;

async function scanConflicts(root) {
  if (!conflictRules) conflictRules = await import("./conflictRules.js").catch(() => null);
  if (!conflictRules || !root) return [];
  const fsp = require("node:fs/promises");
  const out = [];
  const walk = async (dirAbs, dirRel) => {
    if (out.length >= CONFLICT_SCAN_MAX) return;
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable dir — nothing to report
    }
    for (const e of entries) {
      if (out.length >= CONFLICT_SCAN_MAX) return;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (CONFLICT_SCAN_SKIP_DIRS.has(e.name)) continue;
        if (plotFolderRules && plotFolderRules.isLighttableProjectRel(rel)) continue;
        await walk(path.join(dirAbs, e.name), rel);
        continue;
      }
      if (!e.isFile() || !conflictRules.isConflictPath(e.name)) continue;
      const info = conflictRules.parseConflictPath(rel);
      if (!info) continue;
      const abs = path.join(dirAbs, e.name);
      const baseAbs = path.join(root, info.base);
      let size = 0;
      let baseExists = false;
      let identical = false;
      try {
        size = (await fsp.stat(abs)).size;
      } catch {
        continue; // vanished mid-scan (someone resolved it) — not an error
      }
      try {
        const bs = await fsp.stat(baseAbs);
        baseExists = bs.isFile();
        // Byte-identical sides happen a lot (both machines saved the same text).
        // Saying so up front turns a scary banner into one Discard click.
        if (baseExists && bs.size === size && size <= CONFLICT_IDENTICAL_MAX_BYTES) {
          const [a, b] = await Promise.all([fsp.readFile(abs), fsp.readFile(baseAbs)]);
          identical = a.equals(b);
        }
      } catch {
        /* no base file — the "restore or discard" case */
      }
      out.push({
        rel,
        base: info.base,
        when: info.when,
        device: info.device,
        baseExists,
        identical,
        mergeable: conflictRules.isMergeableConflict(rel),
        size,
      });
    }
  };
  await walk(root, "");
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

ipcMain.handle("conflicts:scan", async (_e, root) => {
  const r = root ? path.resolve(root) : currentRoot;
  if (!r) return [];
  try {
    return await scanConflicts(r);
  } catch {
    return [];
  }
});

ipcMain.handle("watch:setRoot", async (_e, root) => {
  releaseAllGuiLocks(); // W3: locks belong to the outgoing project/session
  // M9: the open project root is the primary fs allowlist entry.
  currentRoot = root ? path.resolve(root) : null;
  // WS-9.3: dialog approvals belong to the outgoing project/session too — a dir
  // approved for an import in project A must not stay writable from project B
  // (or from Home, root=null). The pending pre-approval is promoted (or dropped)
  // by this registration either way.
  fileCore.clearApprovals();
  pendingRoot = null;
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
  // Zotero sync: when connected, watch the BBT auto-export so a Zotero-side change
  // syncs live while the app is open. Resolved here (not hot-reloaded) — the Library
  // pane re-invokes watch:setRoot after connecting, so the target stays current.
  const capDir = captureDir();
  if (capDir && !captureRules) captureRules = await import("./captureRules.js").catch(() => null);
  if (!dissectRules) dissectRules = await import("./dissectRules.js").catch(() => null);
  if (!plotFolderRules) plotFolderRules = await import("./plotsFolders.js").catch(() => null);
  if (!conflictRules) conflictRules = await import("./conflictRules.js").catch(() => null);
  const zoteroPrefs = readPrefs().zotero;
  const zoteroBib =
    zoteroPrefs && typeof zoteroPrefs === "object" && typeof zoteroPrefs.bibPath === "string" && zoteroPrefs.bibPath
      ? path.resolve(zoteroPrefs.bibPath)
      : null;
  const targets = [
    ...["plots", "fig", "manuscript", "references", "slides", "Context"].map((d) =>
      path.join(root, d),
    ),
    // The feedback ledger: agent resolves/sends live-refresh the open app.
    path.join(root, ".meta", "feedback.ndjson"),
    // W10: the machine-global FluxLib (agent adds/enrich/fetch land here too).
    path.join(libRoot, "library.bib"),
    path.join(libRoot, ".fluxlib", "enrich.json"),
    path.join(libRoot, "items"),
    // The assign drop-inbox — a landed PDF triggers a scan in the open app.
    path.join(libRoot, "pdfs_to_assign"),
    ...(zoteroBib ? [zoteroBib] : []),
    // Web capture: the browser's download folder (top level only — see captureSubsystemFor).
    ...(capDir ? [capDir, path.join(capDir, "flux")] : []),
  ];
  const pending = new Map(); // subsystem -> latest changed path
  let timer = null;
  const flush = () => {
    timer = null;
    for (const [subsystem, p] of pending)
      mainWindow?.webContents.send("fs:changed", { subsystem, path: p });
    pending.clear();
  };
  // plots/_lighttable/ can hold thousands of exploratory images that nothing in Flux reads —
  // pruning the subtree here means chokidar never opens a descriptor for any of them, rather
  // than watching them all to discard every event.
  const isPrunedWatchPath = (abs) => {
    if (!plotFolderRules) return false;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    return !rel.startsWith("..") && plotFolderRules.isLighttableProjectRel(rel);
  };
  projectWatcher = ck.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    // Never surface in-flight atomic-write temp files (ours or flux-core's).
    ignored: (p) => TMP_WRITE_RE.test(p) || isPrunedWatchPath(p),
  });
  projectWatcher.on("all", (_evt, abs) => {
    if (isSelfWrite(abs)) return;
    const subsystem =
      subsystemFor(root, abs) ??
      fluxLibSubsystemFor(libRoot, abs) ??
      (zoteroBib && path.resolve(abs) === zoteroBib ? "zotero-bib" : null) ??
      (capDir ? captureSubsystemFor(capDir, abs) : null);
    if (!subsystem) return;
    pending.set(subsystem, abs);
    if (!timer) timer = setTimeout(flush, 200);
  });
  projectWatcher.on("error", (err) =>
    notifyRenderer("error", "Project file-watch stopped", err && err.message),
  );
  return true;
});

// Recipe WORKSPACE TRUST (SEC-1): a recipe.json carries the command that gets
// spawned, and fsGuard contains only the file PATHS, not the command — so
// opening a project authored by someone else and regenerating a plot would run
// arbitrary code. We therefore require the containing project to be TRUSTED
// before the first spawn, keyed by the resolved project-root path (moving/
// copying a project re-prompts — conservative on purpose). Trust persists in
// the atomic prefs (A4).
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, "project.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function isRecipeTrusted(key) {
  const list = readPrefs().trustedRecipeRoots;
  return Array.isArray(list) && list.includes(key);
}
function trustRecipeRoot(key) {
  const prefs = readPrefs();
  const list = Array.isArray(prefs.trustedRecipeRoots) ? prefs.trustedRecipeRoots : [];
  if (!list.includes(key)) writePrefs({ ...prefs, trustedRecipeRoots: [...list, key] });
}
/** Confirm-once-per-project gate before spawning a recipe command. Returns true
 *  to proceed. Shows the exact command; a checkbox persists trust. */
async function confirmRecipeTrust(recipePath, recipe) {
  const key = findProjectRoot(path.dirname(recipePath)) ?? path.dirname(recipePath);
  if (isRecipeTrusted(key)) return true;
  const cmdline = [recipe.command, ...(recipe.args || [])].join(" ");
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["Cancel", "Run"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Run this project's plot recipe?",
    message: "Regenerating this plot runs a command from the project on your computer.",
    detail: `Project:\n${key}\n\nCommand:\n${cmdline}\n\nOnly run recipes from projects you trust — a recipe can run ANY command with your permissions.`,
    checkboxLabel: "Trust this project's recipes from now on",
    checkboxChecked: false,
  });
  if (response !== 1) return false;
  if (checkboxChecked) trustRecipeRoot(key);
  return true;
}

// F2: re-run a plot's recipe (the user's own generating script, gated behind an
// explicit action). Returns the emitted SVG/manifest text so the renderer can
// hot-swap it in place. Mirrors flux-core.runRecipe; persists merged params.
ipcMain.handle("recipe:run", async (_e, { recipePath, params = {} }) => {
  // W12 (SHL-6): the recipe file carries the command that gets spawned + is rewritten
  // in place, so it must live under an allowed root — a planted recipe outside the
  // project can't be pointed at here.
  fsGuard(recipePath);
  const recipe = JSON.parse(await fs.promises.readFile(recipePath, "utf8"));
  // SEC-1: arbitrary-command execution gate — the project must be trusted first.
  if (!(await confirmRecipeTrust(recipePath, recipe))) {
    return { code: -1, stdout: "", stderr: "Recipe run cancelled — this project is not trusted to run commands." };
  }
  const dir = path.dirname(recipePath);
  const merged = { ...(recipe.params || {}), ...params };
  const args = [...(recipe.args || [])];
  for (const [k, v] of Object.entries(merged)) args.push(`--${k}`, String(v));
  const cwd = path.resolve(dir, recipe.cwd || ".");
  const res = await new Promise((resolve) => {
    const rs = resolveSpawn(recipe.command, args);
    const child = spawn(rs.command, rs.args, {
      cwd,
      env: { ...process.env, FLUX_PARAMS: JSON.stringify(merged) },
      windowsVerbatimArguments: rs.windowsVerbatimArguments,
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

// 2.3 Full-text search: run `flux search-text <query> --json` in the bundled CLI
// (ELECTRON_RUN_AS_NODE, W13 pattern) so the streaming disk scan never touches the
// renderer thread. One engine (flux-core/fulltextSearch.ts) behind CLI, MCP, and here.
// Read-only; no fsGuard needed (the child only reads FluxLib). Returns the parsed
// FulltextResult, or { error } — never throws into the renderer.
ipcMain.handle("fulltext:search", async (_e, { query, opts }) => {
  const q = String(query ?? "").trim();
  if (!q) return { hits: [], scanned: 0, missingText: [], truncated: false, elapsedMs: 0 };
  const { appRoot, argv } = fluxCliArgs();
  const args = [...argv, "search-text", q, "--json"];
  if (opts && Number.isFinite(opts.limit)) args.push("--limit", String(opts.limit));
  if (opts && Array.isArray(opts.keys) && opts.keys.length) args.push("--keys", opts.keys.join(","));
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: appRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e2) => resolve({ code: -1, out: "", err: String(e2) }));
    child.on("close", (c) => resolve({ code: c ?? 0, out, err }));
  });
  if (res.code !== 0) return { error: (res.err || `search exited ${res.code}`).trim() };
  try {
    return JSON.parse(res.out);
  } catch {
    return { error: "could not parse search output" };
  }
});

// Render a standalone SVG to a vector PDF via Chromium's print engine.
// SHL-14: ONE reusable hidden window serves every PDF export (figure + document) —
// creating+destroying a BrowserWindow per call paid full window setup each export
// (the proxy engine proved the reuse pattern). Serialized: loadFile/printToPDF on a
// shared window must not interleave. Lazily created, recreated if it ever dies,
// blanked after each print so the last export's DOM doesn't sit resident.
let printWin = null;
let printChain = Promise.resolve();
function runPrintExclusive(fn) {
  const run = printChain.then(fn, fn);
  printChain = run.then(
    () => {},
    () => {},
  );
  return run;
}
function getPrintWin() {
  if (!printWin || printWin.isDestroyed()) {
    // javascript:false — the print window materializes figure/manuscript content
    // as a live DOM, but every print path feeds STATIC output (buildSvg for
    // figures; renderManuscript's KaTeX-prerendered, html:false HTML for docs),
    // so no page script is ever needed. Disabling JS means an unsanitized path
    // could never execute/exfiltrate even though this file:// load gets no
    // session CSP. printToPDF itself runs in the main process (JS-independent).
    printWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
  }
  return printWin;
}
app.on("before-quit", () => {
  try {
    if (printWin && !printWin.isDestroyed()) printWin.destroy();
  } catch {
    /* already gone */
  }
});
async function printHtmlToPdf(html, outPath, pdfOpts, tmpTag) {
  const tmp = path.join(os.tmpdir(), `flux-${tmpTag}-${process.pid}-${Date.now()}.html`);
  return runPrintExclusive(async () => {
    const win = getPrintWin();
    try {
      await fs.promises.writeFile(tmp, html, "utf8");
      await win.loadFile(tmp);
      const data = await win.webContents.printToPDF(pdfOpts);
      await fs.promises.writeFile(outPath, data);
    } finally {
      win.loadURL("about:blank").catch(() => {});
      fs.promises.unlink(tmp).catch(() => {});
    }
    return true;
  });
}

ipcMain.handle("export:pdf", async (_e, { svg, outPath, w, h }) => {
  fsGuard(outPath); // W12 (SHL-6): was an unguarded write of any path
  // Defense-in-depth CSP: block scripts/plugins outright (the window also runs
  // javascript:false). Everything else stays permissive so embedded figure
  // assets (data:/blob: images, inline styles) still render.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline'; script-src 'none'; object-src 'none'">`;
  const html = `<!doctype html><html><head><meta charset="utf-8">${csp}<style>html,body{margin:0;padding:0}</style></head><body>${svg}</body></html>`;
  const microns = (px) => Math.round((px / 96) * 25400);
  return printHtmlToPdf(
    html,
    outPath,
    {
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: { width: microns(w), height: microns(h) },
    },
    "fig",
  );
});

// Render a full HTML document to a multi-page PDF. Unlike export:pdf (one page
// sized to a figure), this lets CSS @page rules drive size + pagination.
ipcMain.handle("print:pdf", async (_e, { html, outPath, opts = {} }) => {
  fsGuard(outPath); // W12 (SHL-6): was an unguarded write of any path
  return printHtmlToPdf(
    html,
    outPath,
    {
      printBackground: true,
      preferCSSPageSize: true,
      ...(opts.margins ? { margins: opts.margins } : {}),
    },
    "doc",
  );
});

// WS-9.4b: the NETWORK family (keys, cite:*, pdf:netGet, EZProxy machinery)
// lives in ipc/network.cjs.
const networkFamily = require("./ipc/network.cjs").createNetworkFamily({
  session,
  BrowserWindow,
  safeStorage,
  net,
  fluxLibDir,
  getMainWindow: () => mainWindow,
  resolveToDoi,
  locks: { lockDirFor, writeLockFile, LOCK_TTL_MS },
  files: { atomicWriteMain, noteWrite },
});
networkFamily.registerHandlers(ipcMain);

// Paper's contextual correction provider is a bounded IPC family. Only main
// owns the Flux-managed llama.cpp helper, Ollama/OpenAI calls, model assets, or
// durable language-profile files; the renderer gets decisions and lifecycle
// controls, never an arbitrary fetch/spawn primitive.
const correctionRuntime = require("./ipc/correctionRuntime.cjs").createCorrectionRuntime({
  configRoot: () => getFluxConfigRoot(),
  resourcesPath: () => process.resourcesPath,
  isPackaged: () => app.isPackaged,
  atomicWrite: atomicWriteSync,
});
correctionRuntime.registerHandlers(ipcMain);
const correctionFamily = require("./ipc/corrections.cjs").createCorrectionFamily({
  safeStorage,
  configRoot: () => getFluxConfigRoot(),
  currentProjectRoot: () => currentRoot,
  atomicWrite: atomicWriteSync,
  runtime: correctionRuntime,
});
correctionFamily.registerHandlers(ipcMain);

ipcMain.handle("shell:openExternal", (_e, url) => {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
});

// Optional Quarto compile (publication-grade output). Detected, never required.
ipcMain.handle("quarto:available", async () => {
  return new Promise((resolve) => {
    try {
      const q = resolveSpawn("quarto", ["--version"]);
      const p = spawn(q.command, q.args, { windowsVerbatimArguments: q.windowsVerbatimArguments });
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

// In-flight renders by token, so the renderer can cancel a long compile
// (Nielsen §6: past ~10s an operation must be interruptible).
const quartoRuns = new Map();

ipcMain.handle("quarto:cancel", async (_e, token) => {
  const run = quartoRuns.get(String(token || ""));
  if (!run) return false;
  run.cancelled = true;
  try {
    run.child.kill("SIGTERM");
    // Quarto spawns pandoc/LaTeX children; if the tree ignores SIGTERM, escalate.
    setTimeout(() => {
      try {
        if (!run.child.killed) run.child.kill("SIGKILL");
      } catch {}
    }, 3000).unref?.();
  } catch {
    return false;
  }
  return true;
});

/** Shipped journal assets (CSL, Word reference docs) — resources/ beside the app. */
const journalResourcesDir = () => path.resolve(__dirname, "..", "resources");

/**
 * Materialize a style's assets + its Quarto profile before a render.
 *
 * The renderer computes BOTH from the shared pure module
 * (src/lib/style/journalAssets.ts) and passes them here as data — main only
 * performs the IO. That keeps one source of truth for the profile's content
 * (flux-core generates it from the same function) instead of a CJS re-write
 * that could drift.
 *
 * Returns the profile path to clean up, or null.
 */
async function writeJournalAssets(rootAbs, manuscriptDir, profileYaml, assets) {
  for (const a of Array.isArray(assets) ? assets : []) {
    const rel = String(a?.rel || "");
    const resource = String(a?.resource || "");
    // Both come from the renderer: treat them as untrusted path input.
    if (!rel || !resource || rel.includes("..") || resource.includes("..")) continue;
    const dest = path.resolve(rootAbs, rel);
    if (!underDir(dest, rootAbs)) continue;
    const src = path.resolve(journalResourcesDir(), resource);
    if (!underDir(src, journalResourcesDir())) continue;
    try {
      const bytes = fs.readFileSync(src);
      // Skip a byte-identical rewrite so re-exporting never churns mtimes.
      let same = false;
      try {
        same = fs.readFileSync(dest).equals(bytes);
      } catch {}
      if (!same) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
        noteWrite?.(dest);
      }
    } catch {
      /* a missing shipped asset must not abort the render */
    }
  }
  if (!profileYaml) return null;
  const profileAbs = path.resolve(rootAbs, manuscriptDir, "_quarto-flux-export.yml");
  if (!underDir(profileAbs, rootAbs)) return null;
  try {
    fs.mkdirSync(path.dirname(profileAbs), { recursive: true });
    fs.writeFileSync(profileAbs, String(profileYaml));
    noteWrite?.(profileAbs);
    return profileAbs;
  } catch {
    return null;
  }
}

ipcMain.handle("quarto:render", async (e, { root, to, docPath, profile, outPath, token, profileYaml, assets }) => {
  // Render the ACTIVE document, not always main.qmd. Containment: the doc must be
  // a .qmd resolving under the project root (no traversal via a crafted docPath).
  const rootAbs = path.resolve(String(root || ""));
  const rel = typeof docPath === "string" && docPath.trim() ? docPath : "manuscript/main.qmd";
  const docAbs = path.resolve(rootAbs, rel);
  if (!underDir(docAbs, rootAbs) || !/\.qmd$/i.test(docAbs)) {
    return { ok: false, log: `invalid document path: ${rel}` };
  }
  // A Quarto profile name reaches the command line — keep it to a slug so it
  // can never introduce an argument of its own.
  const prof = typeof profile === "string" && /^[a-z0-9-]{1,32}$/.test(profile) ? profile : null;
  if (profile && !prof) return { ok: false, log: `invalid profile: ${String(profile)}` };
  // The requested destination is a WRITE — it must clear the same guard as any
  // other renderer-driven write (project/app roots + dialog-approved dirs).
  let destAbs = null;
  if (typeof outPath === "string" && outPath.trim()) {
    destAbs = path.resolve(outPath);
    try {
      fsGuard(destAbs);
    } catch (err) {
      return { ok: false, log: `refusing to write outside an allowed directory: ${destAbs}` };
    }
  }
  const runId = typeof token === "string" && token ? token : null;
  // Journal assets + the ephemeral profile, written before the spawn and
  // removed in the close handler. Nothing here edits the user's _quarto.yml.
  const manuscriptDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const profileAbs = await writeJournalAssets(rootAbs, manuscriptDir, profileYaml, assets);
  const cleanupProfile = () => {
    if (profileAbs) {
      try {
        fs.rmSync(profileAbs, { force: true });
      } catch {}
    }
  };
  return new Promise((resolve) => {
    try {
      const q = resolveSpawn("quarto", [
        "render",
        rel,
        "--to",
        to || "pdf",
        ...(prof ? ["--profile", prof] : []),
      ]);
      const p = spawn(q.command, q.args, {
        cwd: rootAbs,
        windowsVerbatimArguments: q.windowsVerbatimArguments,
      });
      const run = { child: p, cancelled: false };
      if (runId) quartoRuns.set(runId, run);
      let log = "";
      // Stream progress lines to the renderer's export card. (A quarto:log push
      // existed here once and was removed as an orphan when nothing subscribed;
      // it is back with a real subscriber, declared in contract.cjs.)
      let pending = "";
      let lastFlush = 0;
      const flush = (force) => {
        const now = Date.now();
        if (!pending || (!force && now - lastFlush < 100)) return;
        lastFlush = now;
        const chunk = pending;
        pending = "";
        if (!e.sender.isDestroyed()) e.sender.send("quarto:log", { token: runId, chunk });
      };
      const collect = (s) => {
        log += s;
        pending += s;
        flush(false);
      };
      p.stdout.on("data", (d) => collect(String(d)));
      p.stderr.on("data", (d) => collect(String(d)));
      p.on("error", (err) => {
        if (runId) quartoRuns.delete(runId);
        cleanupProfile();
        resolve({ ok: false, log: String(err.message) });
      });
      p.on("close", (code) => {
        flush(true);
        if (runId) quartoRuns.delete(runId);
        cleanupProfile();
        if (run.cancelled) return resolve({ ok: false, cancelled: true, code, log });
        // Verify the artifact actually landed (a _quarto.yml output-dir moves it —
        // report what we found so the renderer can Reveal the real file).
        const ext = String(to || "pdf").toLowerCase();
        const candidates = [
          docAbs.replace(/\.qmd$/i, `.${ext}`),
          path.join(rootAbs, "_output", path.basename(docAbs).replace(/\.qmd$/i, `.${ext}`)),
        ];
        let found = candidates.find((c) => fs.existsSync(c));
        // Move the artifact where the user asked. Quarto writes beside the source
        // (or into _output); without this, docx silently lands in manuscript/.
        if (found && destAbs && path.resolve(found) !== destAbs) {
          try {
            fs.mkdirSync(path.dirname(destAbs), { recursive: true });
            try {
              fs.renameSync(found, destAbs);
            } catch {
              fs.copyFileSync(found, destAbs); // cross-device rename fails
              fs.unlinkSync(found);
            }
            noteWrite?.(destAbs);
            found = destAbs;
          } catch (err) {
            log += `\n(could not move output to ${destAbs}: ${err.message})`;
          }
        }
        resolve({
          ok: code === 0 && !!found,
          code,
          log: found ? log : log + "\n(no output file found)",
          outPath: found,
        });
      });
    } catch (err) {
      if (runId) quartoRuns.delete(runId);
      cleanupProfile();
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

// Open a file in the OS default editor. Deliberately TIGHTER than fsGuard:
// only files under the FluxConfig root (the Context layer / agents.json) or the
// open project qualify — this spawns an external program on the path.
ipcMain.handle("shell:openPath", async (_e, p) => {
  const abs = path.resolve(String(p || ""));
  const cfgRoot = getFluxConfigRoot();
  const underCfg = cfgRoot && (abs + path.sep).startsWith(cfgRoot + path.sep);
  const underProject = currentRoot && (abs + path.sep).startsWith(currentRoot + path.sep);
  if (!underCfg && !underProject) return false;
  const err = await shell.openPath(abs);
  return !err;
});

// Launch the Lighttable sidecar (`lighttable/` beside this checkout — a separate
// app, see AGENTS.md "Sidecars"). A convenience spawn only: no code or state
// crosses the boundary, and the child is detached so it outlives Flux. Second
// presses are handled by Lighttable's own single-instance lock (focuses the
// existing window). Source-checkout only — the packaged app doesn't bundle it.
ipcMain.handle("lighttable:launch", async () => {
  const ltDir = path.join(__dirname, "..", "lighttable");
  // Each failure mode gets its own message: they have DIFFERENT fixes, and a
  // catch-all "isn't installed" actively misleads. Electron's binary arrives via
  // a postinstall that can fail on its own, leaving node_modules/electron/
  // present but empty — telling that user to re-run the install they already ran
  // sends them in a circle (cost a real support round-trip, 2026-08-05).
  if (!fs.existsSync(ltDir)) {
    return { ok: false, error: "Lighttable needs the Flux source checkout — the packaged app doesn't bundle it." };
  }
  if (!fs.existsSync(path.join(ltDir, "node_modules"))) {
    return { ok: false, error: "Lighttable's dependencies aren't installed — run `npm ci` in lighttable/." };
  }
  let bin = null;
  try {
    // electron's install layout: dist/<contents of path.txt> is the binary
    // (platform-dependent name) — the same resolution `require("electron")` does.
    const binName = fs
      .readFileSync(path.join(ltDir, "node_modules", "electron", "path.txt"), "utf8")
      .trim();
    bin = path.join(ltDir, "node_modules", "electron", "dist", binName);
  } catch {
    /* path.txt absent — the postinstall never ran; handled just below */
  }
  if (!bin || !fs.existsSync(bin)) {
    return {
      ok: false,
      error:
        "Lighttable's Electron binary is missing — its download didn't finish. Run `node node_modules/electron/install.js` in lighttable/.",
    };
  }
  if (!fs.existsSync(path.join(ltDir, "dist", "index.html"))) {
    return { ok: false, error: "Lighttable isn't built yet — run `npm run build` in lighttable/ once." };
  }
  try {
    const env = { ...process.env };
    // Inherited from a dev shell this would turn the child into plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(bin, [ltDir], { cwd: ltDir, detached: true, stdio: "ignore", env });
    child.on("error", () => {});
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Lighttable failed to launch: ${e.message}` };
  }
});

// Open the user documentation (the docs/ Quarto site beside this checkout) in
// the OS browser. Rendered output only — a button press must not hide a
// multi-second `quarto render` behind it, so a missing _site says how to build
// it instead. Source-checkout only, like lighttable:launch.
ipcMain.handle("docs:open", async () => {
  const index = path.join(__dirname, "..", "docs", "_site", "index.html");
  if (!fs.existsSync(index)) {
    return { ok: false, error: "Docs aren't rendered yet — run `quarto render docs` in the Flux repo once (source checkout only)." };
  }
  const err = await shell.openPath(index);
  return err ? { ok: false, error: err } : { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: integrated terminal. The renderer's xterm.js front-end drives a native
// login shell ($SHELL on macOS/Linux) running in a real PTY here, so colors,
// curses apps, and job control all work. A session outlives margin view
// switches (the renderer keeps one alive) and is reaped with its window / on
// quit. Streaming mirrors quarto:log + onFsChanged (send + on/unsubscribe).
// ---------------------------------------------------------------------------
// WS-9.4b: the TERMINAL (PTY) family lives in ipc/terminal.cjs.
const terminalFamily = require("./ipc/terminal.cjs").createTerminalFamily({
  app,
  nodePty,
  getCurrentRoot: () => currentRoot,
});
const { reapPtys } = terminalFamily;

// (agent:mcpSpec lives in ipc/agent.cjs)

terminalFamily.registerHandlers(ipcMain);
