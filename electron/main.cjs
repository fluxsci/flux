const { app, BrowserWindow, Menu, ipcMain: rawIpcMain, dialog, shell, session, safeStorage, net, protocol } = require("electron");
// Range-streamed video capabilities work in both Vite and packaged file pages.
// The handler permits only an approved project asset token, never arbitrary URLs.
protocol.registerSchemesAsPrivileged([{ scheme: "flux-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
// WS-9.4: every registration goes through the channel contract — an undeclared
// or kind-mismatched channel throws at startup, and assertAllRegistered() (in
// whenReady) catches declared-but-orphaned ones. verify-ipc-contract.ts checks
// the preload + push sides statically.
const ipcContract = require("./ipc/contract.cjs").wrapIpcMain(rawIpcMain, { validateSender: (event) => {
  const owner = sessionFor(event);
  if (!owner || owner.win.isDestroyed() || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(DEV_URL || require("node:url").pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch { return false; }
} });
const ipcMain = { handle: ipcContract.handle, on: ipcContract.on };
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { resolveToDoi } = require("./resolveDoi.cjs");
const { pickRelease } = require("./updateCheck.cjs");
const fluxPaths = require("./fluxPaths.cjs");
const { resolveSpawn } = require("./execResolve.cjs");

// Machine config is ALWAYS the lowercase app dir (~/.config/flux on Linux) —
// pinned before ANYTHING touches userData (the single-instance lock, prefs,
// textstyles, Chromium session state). Without this, packaged builds derive
// the capital-F dir from productName while dev + flux-core resolve lowercase.
// See AGENTS.md "Machine config paths"; gated by verify-fluxconfig.ts.
app.setPath("userData", fluxPaths.userDataDir());
const nativeDiagnostics = require('./nativeDiagnostics.cjs').createNativeDiagnostics(path.join(app.getPath('userData'), 'diagnostics'));
app.on('child-process-gone', (_event, details) => {
  if (details?.reason !== 'clean-exit') nativeDiagnostics.record({ family: 'native', outcome: 'failed', code: 'CHILD_PROCESS_GONE' });
});

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

// Multi-window (2026-08-11): one process, N windows, each on its own project.
// ALL per-window lifecycle state lives in one session record — the window, its
// open project root, its project file-watcher, and the root it was created to
// open (CLI arg / second-instance path, read once by the renderer at boot).
// Machine-global state (FluxLib watching, capture intake, the print/proxy
// utility windows) stays process-wide. The old single `mainWindow` /
// `currentRoot` / `projectWatcher` slots are gone — the moment window B opened
// a project they silently took window A's watcher, bridge, and locks
// (notes/aug_10_deferred_updates/multi_window_and_dual_paper_panes.md, A1).
const sessions = new Map(); // webContents.id -> { win, root, watcher, watchGen, initialRoot }
function sessionFor(e) {
  return e && e.sender ? sessions.get(e.sender.id) : undefined;
}
function rootFor(e) {
  return sessionFor(e)?.root ?? null;
}
function sessionRoots() {
  const out = [];
  for (const s of sessions.values()) if (s.root) out.push(s.root);
  return out;
}
function windowForRoot(root) {
  if (!root) return null;
  const ab = path.resolve(root);
  for (const s of sessions.values()) if (s.root === ab && !s.win.isDestroyed()) return s.win;
  return null;
}
function liveWindows() {
  return [...sessions.values()].map((s) => s.win).filter((w) => !w.isDestroyed());
}
// The window a plain re-launch / parentless dialog should land on.
let lastFocusedWindow = null;
function focusTargetWindow() {
  const live = liveWindows();
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed() && live.includes(lastFocusedWindow))
    return lastFocusedWindow;
  return BrowserWindow.getFocusedWindow() ?? live[0] ?? null;
}

// W6: quit/close flush handshake. When a window is asked to close (X button, our
// custom title-bar close, Ctrl+W, or Cmd-Q via before-quit), we hold the close,
// ask the renderer to flush every dirty mode, and destroy only once it acks (or
// after a timeout so a wedged renderer can never brick quit). `quitting` records
// that we're tearing the whole app down, so the post-flush destroy re-issues the
// quit (needed on macOS, where destroying the last window doesn't quit). The state
// machine + menu template live in appLifecycle.cjs so they stay unit-testable.
const { createFlushCoordinator, createAppWindowPolicy, appMenuTemplate } = require("./appLifecycle.cjs");
let quitting = false;
const flushCoordinator = createFlushCoordinator();
ipcMain.on("app:flush:done", (e, result) => flushCoordinator.ack(e.sender.id, result));
// Quit-wedge R2: only APP windows participate in the quit decision — the
// hidden proxy-capture/print windows are never registered, so they can no
// longer keep a windowless process alive holding the single-instance lock.
const appWindowPolicy = createAppWindowPolicy({
  isMac: process.platform === "darwin",
  quit: () => app.quit(),
});

// W1 (V1 review): surface main-process failures to the renderer as shell toasts.
// level ∈ "info" | "success" | "error". Broadcast — a main-process failure is
// rarely one window's business; falls back to the console when no window.
function notifyRenderer(level, msg, detail) {
  try {
    const wins = liveWindows();
    if (!wins.length) {
      console.error(`[flux] ${msg}`, detail ?? "");
      return;
    }
    for (const w of wins)
      w.webContents.send("app:error", {
        level,
        msg,
        detail: detail == null ? undefined : String(detail),
      });
  } catch {
    /* window mid-teardown */
  }
}

// WS-9.4b: the FILES family (write-safety core + fsGuard + fs:*/dlg:* handlers)
// lives in ipc/files.cjs. main keeps the project-lifecycle roots it owns — the
// per-window session roots (set by watch:setRoot) and the WS-9.3 pending-open
// slots (now per-window too) — and lends them to the guard as a getter. The
// guard's allowlist is the UNION across windows: its job is keeping writes
// inside Flux's world, not partitioning projects from each other (dialog
// APPROVALS, by contrast, are per-window — see files.cjs).
const pendingRoots = new Map(); // webContents.id -> project being opened right now
const fileCore = require("./ipc/files.cjs").createFileCore({
  app,
  diagnostics: nativeDiagnostics,
  dialog,
  shell, // fs:trash — OS trash for deleted documents
  roots: () => [
    ...sessionRoots(),
    ...pendingRoots.values(), // WS-9.3: projects being opened right now
    getFluxConfigRoot(), // FluxLib lives inside; kept separately for the EXDEV-fallback state
    getFluxLibRoot(),
    // Zotero sync (2026-07-29): when connected, the BBT auto-export's folder and the
    // Zotero data dir are durable roots — startup sync reads the .bib and link-mode
    // papers resolve into storage/ without a per-session dialog approval. Evaluated
    // per call, so connecting/disconnecting applies immediately.
    ...zoteroRoots(),
  ],
  setPendingRoot: (senderId, ab) => {
    if (ab) pendingRoots.set(senderId, ab);
    else pendingRoots.delete(senderId);
  },
  windowFor: (e) => BrowserWindow.fromWebContents(e.sender),
  projectRootFor: (senderId) => [sessions.get(senderId)?.root, pendingRoots.get(senderId)].filter(Boolean),
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
const sourceWatchCore = require("./ipc/sourceWatch.cjs").createSourceWatchCore({
  sessionFor,
  pendingRootFor: (senderId) => pendingRoots.get(senderId),
  fileCore,
  loadChokidar,
  notify: notifyRenderer,
});
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
// Multi-window: bridges are keyed by root, one per open project, each pinned to
// the window that opened it — see agent.cjs.
const agentFamily = require("./ipc/agent.cjs").createAgentFamily({
  app,
  rootForSender: (e) => rootFor(e),
  appendJournalLine,
  noteWrite,
  appRoot: path.resolve(__dirname, ".."),
});
agentFamily.registerHandlers(ipcMain);
const { setBridgeFor, stopBridgeForWindow, stopAllBridges } = agentFamily;

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
ipcMain.handle("journal:append", (e, entry) => {
  appendJournalLine(rootFor(e), entry || {});
  return true;
});
// One shared operation-token protocol for GUI and headless writers.
const guiLeases = require("./guiLeases.cjs").createGuiLeases({ rootFor: (e, expected) => {
  const pending = pendingRoots.get(e.sender?.id);
  return expected && pending && path.resolve(expected) === path.resolve(pending) ? pending : rootFor(e);
}, fluxLibDir });
guiLeases.register(ipcMain);
const releaseAllGuiLocks = () => guiLeases.releaseAll();
const releaseGuiLocksFor = (senderId) => guiLeases.releaseFor(senderId);

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
    onNewWindow: () => createWindow(),
  });
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}

// Unpackaged runs (`npx electron .`) carry no bundled app icon, so the taskbar
// falls back to the platform default — the Electron atom on macOS, the desktop
// theme's generic cog on Linux. Point the window at the repo's own phyllotaxis
// icon (build/icons, regenerated by scripts/gen-app-icons.mjs). Packaged builds
// already get theirs from electron-builder; re-setting it is harmless.
// Platform notes: macOS ignores BrowserWindow.icon entirely — the Dock is set
// via app.dock.setIcon (below). Wayland has no client-side window-icon protocol
// either, so there the compositor matches a .desktop file by app_id instead
// (the .deb/AppImage install one; a dev run needs scripts/install-desktop-entry.mjs).
function appIconPath() {
  const p = path.join(
    __dirname,
    "..",
    "build",
    "icons",
    process.platform === "win32" ? "icon.ico" : "icon.png",
  );
  return fs.existsSync(p) ? p : null;
}

function createWindow(initialRoot) {
  const isMac = process.platform === "darwin";
  const winIcon = appIconPath();
  // Cascade: a second window must not open exactly over the first.
  const base = focusTargetWindow();
  let pos = {};
  if (base) {
    try {
      const [x, y] = base.getPosition();
      pos = { x: x + 24, y: y + 24 };
    } catch {
      /* base mid-teardown — default placement */
    }
  }
  const win = new BrowserWindow({
    ...(!isMac && winIcon ? { icon: winIcon } : {}),
    ...pos,
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
  // The session record — all per-window lifecycle state. wcId is captured now
  // because win.webContents is unreachable from the `closed` handler.
  const wcId = win.webContents.id;
  sessions.set(wcId, {
    win,
    root: null,
    watcher: null,
    watchGen: 0,
    initialRoot: initialRoot ? path.resolve(initialRoot) : null,
  });
  const unregisterAppWindow = appWindowPolicy.register(win);
  require('./rendererRecovery.cjs').attachRendererRecovery(win, {
    diagnostics: nativeDiagnostics, showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),
    getRoot: () => sessions.get(wcId)?.root ?? sessions.get(wcId)?.initialRoot ?? null,
    restart: async root => { createWindow(root ?? undefined); win.destroy(); },
  });
  win.on("focus", () => {
    lastFocusedWindow = win;
  });
  if (!lastFocusedWindow) lastFocusedWindow = win;

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
  const galleryUrl = new URL("plot-gallery.html", appUrl).href;
  const galleryWindows = new Set();
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === galleryUrl && frameName === "flux-plot-gallery") return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 1060, height: 780, minWidth: 480, minHeight: 420,
        frame: true, titleBarStyle: "default", backgroundColor: "#100f0f",
        webPreferences: { preload: path.join(__dirname, "galleryPreload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
      },
    };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-create-window", (child) => {
    galleryWindows.add(child);
    child.setMenuBarVisibility(false);
    // A gallery is an inert view, never another project session or an external browser.
    // Electron emits the initial window.open navigation after did-create-window.
    // Admit that inert document; denying it too leaves a never-loaded blank window.
    child.webContents.on("will-navigate", (e, url) => { if (url !== galleryUrl) e.preventDefault(); });
    child.webContents.on("will-redirect", e => e.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.on("closed", () => galleryWindows.delete(child));
  });
  win.on("closed", () => { for (const child of galleryWindows) if (!child.isDestroyed()) child.destroy(); });

  // Keep the renderer's custom maximize/restore button in sync.
  win.on("maximize", () => win.webContents.send("win:maximized", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized", false));

  // W6: hold the close until the renderer has flushed unsaved work. `destroy()`
  // force-closes without re-emitting `close`, so there's no re-entrancy; a repeat
  // close while the handshake is running is simply ignored.
  let flushing = false;
  const requestClose = () => {
    if (flushing || win.isDestroyed()) return;
    flushing = true;
    flushCoordinator.request(win, async (result) => {
      if (win.isDestroyed()) return;
      if (result.status === "saved") {
        win.destroy();
        if (quitting) app.quit();
        return;
      }
      // Native UI remains reachable even when a renderer is wedged. Cancel is
      // the default; only the explicit third button permits unsaved destruction.
      let response = 1;
      try {
        ({ response } = await dialog.showMessageBox(win, {
          type: "warning", title: "Work could not be saved", message: "Flux kept this window open to protect unsaved work.",
          detail: result.reason || "Saving did not complete. Retry after resolving the save error, or cancel to continue editing.",
          buttons: ["Retry save", "Cancel close", "Close without saving"], defaultId: 1, cancelId: 1, noLink: true,
        }));
      } catch { /* a failed dialog does not grant permission to discard */ }
      flushing = false;
      if (response === 0) requestClose();
      else if (response === 2) { win.destroy(); if (quitting) app.quit(); }
      else quitting = false;
    });
  };
  win.on("close", (e) => {
    e.preventDefault();
    requestClose();
  });

  // Per-window teardown: reap this renderer's PTYs, stop ITS agent bridge
  // (removes .meta/live/bridge.json), close ITS project watcher, release ITS
  // locks/approvals — and ONLY its own; another window's project must keep its
  // watcher, bridge, and locks (SHL-7 + multi-window A3.1). The quit decision
  // then goes through the app-window policy, which ignores hidden utility
  // windows (quit-wedge R2).
  win.on("closed", () => {
    reapPtys((s) => s.wc.isDestroyed());
    stopBridgeForWindow(win);
    releaseGuiLocksFor(wcId);
    fileCore.clearApprovals(wcId);
    void sourceWatchCore.clear(wcId);
    pendingRoots.delete(wcId);
    const s = sessions.get(wcId);
    if (s?.watcher) {
      s.watcher.close().catch(() => {});
      s.watcher = null;
    }
    sessions.delete(wcId);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
    unregisterAppWindow();
    appWindowPolicy.noteClosed({ quitting });
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
// src/lib/references/captureIntake.svelte.ts) — so this keeps one PROCESS
// alive; windows multiply inside it. A denied second launch is handed to the
// running instance through `second-instance`, which distinguishes three cases:
//   flux --new-window        → a fresh window at Home (the taskbar action)
//   flux <project-dir>       → focus the window already on that project, else
//                              open a new window straight into it (Zed/VS Code)
//   flux                     → focus the most recent window (a plain re-launch
//                              from the launcher must not spawn windows)
// ---------------------------------------------------------------------------

/** Parse an argv for the multi-window launch contract. `cwd` anchors relative
 *  paths (the second instance's own working directory). Only a directory that
 *  actually contains project.json counts as a project — `.` in a dev checkout,
 *  Chromium switches, and stray file args all fall through. */
function parseLaunchArgs(argv, cwd) {
  let newWindow = false;
  let projectRoot = null;
  for (const raw of (argv || []).slice(1)) {
    const a = String(raw);
    if (a === "--new-window") {
      newWindow = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (!projectRoot) {
      try {
        const ab = path.resolve(cwd || process.cwd(), a);
        if (fs.existsSync(path.join(ab, "project.json"))) projectRoot = ab;
      } catch {
        /* unreadable arg — not a project */
      }
    }
  }
  return { newWindow, projectRoot };
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Quit-wedge R1: the denied path used to be a mute exit-0 — indistinguishable
  // from "the app is broken" (and a windowless wedged holder made that a trap).
  console.error(
    "[flux] another Flux is already running — asked it to take over (it opens or focuses a window); this launch exits",
  );
  app.quit();
} else {
  app.on("second-instance", (_e, argv, workingDirectory) => {
    const { newWindow, projectRoot } = parseLaunchArgs(argv, workingDirectory);
    if (projectRoot) {
      const existing = windowForRoot(projectRoot);
      if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return;
      }
      createWindow(projectRoot);
      return;
    }
    if (newWindow) {
      createWindow();
      return;
    }
    const win = focusTargetWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else createWindow();
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
      "default-src 'self'; script-src 'self' " + require("./slideEmbedCsp.gen.cjs") + " 'wasm-unsafe-eval' 'sha256-Q5r/0YfmAtc2/to6EHsX0PaBtKO7BSpnAkNsqnhWKas=' 'sha256-8Yu/cmPzQpyhF7nWdsKoaj4FeP+hooq1bXRxlVz1CLE=' 'sha256-F6i5nGBIqfoaCOZiZzX7PEXC7HagpdnrdJHeF3PJ3rU='; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' data: blob: flux-media:; font-src 'self' data:; " +
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
  // macOS Dock: BrowserWindow.icon is a no-op there, and an unpackaged run shows
  // Electron.app's own atom. Packaged builds already carry icon.icns, so only the
  // dev run needs the override.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const dockIcon = appIconPath();
    if (dockIcon) {
      try {
        app.dock.setIcon(dockIcon);
      } catch (e) {
        console.error("dock icon:", (e && e.message) || e);
      }
    }
  }
  // A project dir on the FIRST launch's command line opens straight into it
  // (`flux ~/papers/myc` from a terminal — same contract second-instance honors).
  const initialLaunch = parseLaunchArgs(process.argv, process.cwd());
  createWindow(initialLaunch.projectRoot ?? undefined);
  app.on("activate", () => {
    // macOS dock re-activate: only APP windows count — a surviving hidden
    // utility window must not suppress reopening the UI (quit-wedge R2's twin).
    if (appWindowPolicy.count() === 0) createWindow();
  });
});

// Quit-wedge R2: the REAL quit trigger is the app-window policy in each
// window's `closed` handler — this stays as the belt for the case where every
// BrowserWindow (utility ones included) is genuinely gone.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Never leave a shell child behind.
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  reapPtys();
  releaseAllGuiLocks(); // W3: never leave a stale "human" lock deferring agents
  stopAllBridges(); // W12 (SHL-8): remove every .meta/live/bridge.json (+ tokens) on quit
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
// (with its bearer token) on disk. Tear the bridges down + quit so the files are removed.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      stopAllBridges();
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
// Snapshot & annotate (Note to agent): a PNG of the calling window — its own
// pixels only (capturePage on the sender), optionally one CSS-px rect. Read
// scope: nothing touches the filesystem here; the renderer composes the crop and
// writes it into the project's .meta/feedback/ through the guarded fs:writeFile.
ipcMain.handle("win:capture", async (e, rect) => {
  const r =
    rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)
      ? {
          x: Math.max(0, Math.round(rect.x || 0)),
          y: Math.max(0, Math.round(rect.y || 0)),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        }
      : undefined;
  const img = await e.sender.capturePage(r);
  const size = img.getSize();
  return { png: img.toPNG(), width: size.width, height: size.height };
});
ipcMain.handle(
  "win:isMaximized",
  (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
);
// SHL-12: reflect the app's unsaved state in the OS window chrome (macOS shows a dot in the
// close button; a no-op elsewhere). Fire-and-forget from the renderer's dirty indicator.
ipcMain.on("win:setDocumentEdited", (e, edited) => {
  BrowserWindow.fromWebContents(e.sender)?.setDocumentEdited?.(!!edited);
});
// Multi-window entry points. `win:new` backs every in-app New Window affordance
// (Ctrl+Shift+N, the Home button); the taskbar action arrives via second-instance.
ipcMain.handle("win:new", () => {
  createWindow();
  return true;
});
// The root this window was created to open (CLI arg / second-instance project
// path). One-shot: the shell reads it once at boot and opens the project.
ipcMain.handle("win:initialProject", (e) => {
  const s = sessionFor(e);
  if (!s || !s.initialRoot) return null;
  const root = s.initialRoot;
  s.initialRoot = null;
  return root;
});
// A4.1: the same project must never be open in two windows — two live editors
// autosaving the same manuscript/ is the one configuration that can actually
// lose writing. The renderer asks before loading; a hit focuses the window that
// already has it and the open is aborted renderer-side.
ipcMain.handle("win:projectOpenElsewhere", (e, root) => {
  if (!root) return false;
  const ab = path.resolve(String(root));
  const self = sessionFor(e);
  for (const s of sessions.values()) {
    if (s === self || s.win.isDestroyed() || s.root !== ab) continue;
    if (s.win.isMinimized()) s.win.restore();
    s.win.focus();
    return true;
  }
  return false;
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
ipcMain.handle("prefs:set", async (_e, patch) => {
  const cur = readPrefs();
  const next = { ...cur, ...(patch || {}), schemaVersion: cur.schemaVersion || "0.1.0" };
  const movingLibrary = next.fluxConfigPath !== cur.fluxConfigPath;
  const resume = movingLibrary ? await nativeReadJobs.suspend() : () => {};
  const resumeContext = movingLibrary ? await readerContextFamily.suspend() : () => {};
  try { writePrefs(next); invalidatePathCaches(); }
  finally { resume(); resumeContext(); }
  return next;
});

// Move the whole FluxConfig folder (Settings "Move…"): user picks the new
// PARENT dir; the folder is always named exactly "FluxConfig". The watcher is
// closed first (open fds on the tree being renamed); the renderer requires a
// restart afterwards — same contract as the old library-folder change.
ipcMain.handle("config:move", async (_e, parentDir) => {
  // Drain the resident derived-index writer before renaming its library root.
  // Searches remain refused throughout the move, including queued invocations.
  const resume = await nativeReadJobs.suspend();
  const resumeContext = await readerContextFamily.suspend();
  try {
  // Close EVERY watcher (each window's project watcher + the global one) —
  // open fds on the tree being renamed would make the move fail.
  for (const s of sessions.values()) {
    if (s.watcher) {
      await s.watcher.close().catch(() => {});
      s.watcher = null;
    }
  }
  await closeGlobalWatcher();
  await sourceWatchCore.clearAll();
  const r = await fluxPaths.moveFluxConfig(parentDir);
  invalidatePathCaches();
  return r;
  } finally { resume(); resumeContext(); }
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
const readerContextFamily = require("./ipc/readerContext.cjs").createReaderContext({rootFor:()=>getFluxLibRoot(),windowFor:sender=>BrowserWindow.fromWebContents(sender),atomicWrite:fileCore.atomicWriteMain,guard:(e,p)=>fileCore.fsGuard(p,e.sender.id)});
readerContextFamily.registerHandlers(ipcMain);
app.on("will-quit",()=>readerContextFamily.dispose());
sourceWatchCore.registerHandlers(ipcMain);

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
  if (rel.startsWith("paper/") || rel.startsWith("manuscript/")) return "manuscript";
  if (rel.startsWith("references/")) return "references";
  if (rel.startsWith("slides/")) return "slides"; // W10 (SLD-1)
  // Principal-agent scheme: Context docs (+ their comments sidecars) live-reload
  // through the same chain as manuscript docs. Transcripts/Dispatches writes
  // also land here — harmless: the renderer suffix-matches the active doc.
  if (rel.startsWith("Context/")) return "context";
  if (rel === ".meta/feedback.ndjson") return "feedback";
  return null;
}

const captureFamily = require("./ipc/capture.cjs").createCaptureFamily({ app, shell, readPrefs, fluxLibDir, appRoot: path.resolve(__dirname, "..") });
captureFamily.registerHandlers(ipcMain);
const screenColorPicker = require("./ipc/colorPicker.cjs").createColorPicker();
screenColorPicker.registerHandlers(ipcMain);
app.on("before-quit", () => screenColorPicker.cancelAll());
const captureDir = captureFamily.captureDir;
app.on("will-quit", () => { void captureFamily.dispose(); });

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

ipcMain.handle("conflicts:scan", async (e, root) => {
  const r = root ? path.resolve(root) : rootFor(e);
  if (!r) return [];
  try {
    return await scanConflicts(r);
  } catch {
    return [];
  }
});

// ---------------------------------------------------------------------------
// The watcher split (multi-window A3.4). One PROCESS-WIDE watcher covers the
// machine-global targets — FluxLib, the assign inbox, the Zotero bib, the
// capture download folder — and fans out to every window; each window carries
// a small PROJECT watcher of its own. The old single watcher mixed both target
// classes, so two windows would have redundantly double-watched the global
// paths and window B's registration silently killed window A's project watch.
// ---------------------------------------------------------------------------
const globalLibraryWatcher = require("./globalLibraryWatcher.cjs").createGlobalLibraryWatcher({loadChokidar,fluxLibDir,captureDir,readPrefs,liveWindows,writeOrigin:fileCore.writeOrigin,notifyRenderer,TMP_WRITE_RE,onLibraryChange:(root,abs)=>nativeReadJobs.libraryChanged(root,abs)});
const closeGlobalWatcher = () => globalLibraryWatcher.close();
const rebuildGlobalWatcher = () => globalLibraryWatcher.rebuild();
app.on("will-quit", () => { void globalLibraryWatcher.dispose(); });

ipcMain.handle("watch:setRoot", async (e, root) => {
  const s = sessionFor(e);
  if (!s) return false;
  const senderId = e.sender.id;
  releaseGuiLocksFor(senderId); // W3: locks belong to the outgoing project/session
  // WS-9.3: dialog approvals belong to the outgoing project/session too — a dir
  // approved for an import in project A must not stay writable from project B
  // (or from Home, root=null). Scoped to THIS window: another window's in-flight
  // approvals survive its neighbor's project switch.
  fileCore.clearApprovals(senderId);
  pendingRoots.delete(senderId);
  // M9: the open project root joins the fs allowlist union (roots() above).
  s.root = root ? path.resolve(root) : null;
  await sourceWatchCore.setRoot(senderId, s.root);
  // WS4: bring THIS window's live agent bridge up/down with its open project.
  setBridgeFor(s.root, s.win);
  // The machine-global watcher rides every registration (Zotero/capture-dir
  // re-resolve) — including root=null, so Home keeps the Library live.
  void rebuildGlobalWatcher();
  // Tear down this window's previous project watcher; a stale async build must
  // not resurrect it (generation check below).
  const gen = ++s.watchGen;
  if (s.watcher) {
    await s.watcher.close().catch(() => {});
    s.watcher = null;
  }
  if (!s.root) return false;
  const ck = await loadChokidar();
  if (!ck) {
    notifyRenderer(
      "error",
      "Live file-watch is unavailable",
      "chokidar failed to load — agent/script edits won't live-reload this session",
    );
    return false;
  }
  if (!dissectRules) dissectRules = await import("./dissectRules.js").catch(() => null);
  if (!plotFolderRules) plotFolderRules = await import("./plotsFolders.js").catch(() => null);
  if (!conflictRules) conflictRules = await import("./conflictRules.js").catch(() => null);
  if (gen !== s.watchGen) return false; // superseded by a newer registration
  const projectRoot = s.root;
  const targets = [
    ...["plots", "fig", "manuscript", "references", "slides", "Context"].map((d) =>
      path.join(projectRoot, d),
    ),
    // The feedback ledger: agent resolves/sends live-refresh the open app.
    path.join(projectRoot, ".meta", "feedback.ndjson"),
  ];
  const pending = new Map(); // subsystem -> latest changed path
  let timer = null;
  const flush = () => {
    timer = null;
    if (!s.win.isDestroyed())
      for (const [subsystem, p] of pending)
        s.win.webContents.send("fs:changed", { subsystem, path: p });
    pending.clear();
  };
  // plots/_lighttable/ can hold thousands of exploratory images that nothing in Flux reads —
  // pruning the subtree here means chokidar never opens a descriptor for any of them, rather
  // than watching them all to discard every event.
  const isPrunedWatchPath = (abs) => {
    if (!plotFolderRules) return false;
    const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
    return !rel.startsWith("..") && plotFolderRules.isLighttableProjectRel(rel);
  };
  const watcher = ck.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    // Never surface in-flight atomic-write temp files (ours or flux-core's).
    ignored: (p) => TMP_WRITE_RE.test(p) || isPrunedWatchPath(p),
  });
  watcher.on("all", (_evt, abs) => {
    if (isSelfWrite(abs)) return;
    const subsystem = subsystemFor(projectRoot, abs);
    if (!subsystem) return;
    pending.set(subsystem, abs);
    if (!timer) timer = setTimeout(flush, 200);
  });
  watcher.on("error", (err) =>
    notifyRenderer("error", "Project file-watch stopped", err && err.message),
  );
  if (gen !== s.watchGen) {
    // A newer registration won the race while chokidar spun up.
    await watcher.close().catch(() => {});
    return false;
  }
  s.watcher = watcher;
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
 *  to proceed. Shows the exact command; a checkbox persists trust. Parents to
 *  the REQUESTING window — a modal on another window would block the wrong one. */
async function confirmRecipeTrust(recipePath, invocation, parentWin) {
  const key = findProjectRoot(path.dirname(recipePath)) ?? path.dirname(recipePath);
  if (isRecipeTrusted(key)) return true;
  const cmdline = [invocation.executable, ...invocation.argv].map(x => JSON.stringify(x)).join(" ");
  const { response, checkboxChecked } = await dialog.showMessageBox(parentWin ?? focusTargetWindow(), {
    type: "warning",
    buttons: ["Cancel", "Run"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Run this project's plot recipe?",
    message: "Regenerating this plot runs a command from the project on your computer.",
    detail: `Project:\n${key}\n\nCommand:\n${cmdline}\n\nWorking directory:\n${invocation.cwd}\n\nEnvironment:\n${JSON.stringify(invocation.envDelta, null, 2)}\n\nDeadline: 24 hours. Cancel remains available while the recipe runs.\n\nOnly run recipes from projects you trust — a recipe can run ANY command with your permissions.`,
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
const recipeJobs = new Map();
ipcMain.handle("recipe:cancel", (e, jobId) => {
  const job = recipeJobs.get(jobId);
  if (!job || job.sender !== e.sender.id) return false;
  job.controller.abort(new Error("Recipe cancelled by user")); return true;
});
ipcMain.handle("recipe:run", async (e, { recipePath, params = {}, jobId = require("node:crypto").randomUUID() }) => {
  if (typeof jobId !== "string" || !jobId || jobId.length > 128 || recipeJobs.has(jobId)) throw new Error("Invalid or active recipe job ID");
  fsGuard(recipePath, e.sender.id);
  return require("./recipeJob.cjs").withRecipeLease(recipePath, async assertOwned => {
  // W12 (SHL-6): the recipe file carries the command that gets spawned + is rewritten
  // in place, so it must live under an allowed root — a planted recipe outside the
  // project can't be pointed at here.
  fsGuard(recipePath, e.sender.id);
  const recipeText = await require("./recipeJob.cjs").readRecipeText(recipePath);
  const recipe = JSON.parse(recipeText);
  const dir = path.dirname(recipePath);
  const { recipeInvocation, completedRecipe } = await import("../src/lib/plot/recipeContract.mjs");
  const { params: merged, args } = recipeInvocation(recipe, params);
  const invocation = { executable: recipe.command, argv: args, cwd: path.resolve(dir, recipe.cwd || "."),
    envDelta: { FLUX_PARAMS: JSON.stringify(merged), ...(recipe.plot ? { FLUXPLOT_ONLY: recipe.plot } : {}) } };
  if (!(await confirmRecipeTrust(recipePath, invocation, BrowserWindow.fromWebContents(e.sender)))) {
    return { code: -1, stdout: "", stderr: "Recipe run cancelled — this project is not trusted to run commands." };
  }
  const controller = new AbortController();
  const snapshot = await require("./recipeJob.cjs").snapshotRecipe(recipePath, recipeText);
  recipeJobs.set(jobId, {sender: e.sender.id, controller});
  const onDestroyed = () => controller.abort(new Error("Recipe owner closed"));
  e.sender.once("destroyed", onDestroyed);
  let res;
  try { res = await require("./processRunner.cjs").runProcess(invocation, { signal: controller.signal }); }
  finally { e.sender.removeListener("destroyed", onDestroyed); recipeJobs.delete(jobId); }
  let updatedRecipe = recipe;
  if (res.code === 0 && res.status === "exited") {
    let emitted;
    try { emitted = JSON.parse(await require("./recipeJob.cjs").readRecipeText(recipePath)); recipeInvocation(emitted, {}); }
    catch (error) { throw new Error(`The command emitted malformed recipe metadata. Previous good recipe: ${snapshot}`, {cause: error}); }
    updatedRecipe = completedRecipe(emitted, merged, params, new Date().toISOString());
    noteWrite(recipePath);
    await assertOwned();
    await atomicWriteMain(recipePath, JSON.stringify(updatedRecipe, null, 2) + "\n");
    await require("./recipeJob.cjs").discardRecipeSnapshot(snapshot);
  }
  const outAbs = res.code === 0 && res.status === "exited" && updatedRecipe.output ? path.resolve(dir, updatedRecipe.output) : null;
  if (outAbs) fsGuard(outAbs, e.sender.id); // W12: contain the plot output read to allowed roots
  let svgText = null;
  let manifestText = null;
  if (outAbs && fs.existsSync(outAbs)) {
    noteWrite(outAbs);
    if ((await fs.promises.stat(outAbs)).size > 64 * 1024 * 1024) throw new Error("Recipe SVG exceeds 64 MiB");
    svgText = await fs.promises.readFile(outAbs, "utf8");
    const manAbs = outAbs.replace(/\.svg$/, ".fluxplot.json");
    if (fs.existsSync(manAbs)) {
      noteWrite(manAbs);
      if ((await fs.promises.stat(manAbs)).size > 32 * 1024 * 1024) throw new Error("Recipe manifest exceeds 32 MiB");
      manifestText = await fs.promises.readFile(manAbs, "utf8");
    }
  }
  return { ...res, svgText, manifestText, recipeText: JSON.stringify(updatedRecipe) };
  });
});

// W13: resolve the bundled CLI (dist/flux-cli.mjs — esbuild-built, self-contained).
// Packaged, it's asar-UNPACKED (a child launched with ELECTRON_RUN_AS_NODE has no
// asar support, so it must be on real disk); in dev it sits in <appRoot>/dist. If
// the bundle hasn't been built yet in dev, fall back to running the .ts via tsx.
const nativeReadJobs = require("./ipc/readJobs.cjs").createReadJobs({app,appRoot:path.resolve(__dirname,".."),fluxLibDir});
const fluxCliArgs = nativeReadJobs.fluxCliArgs;
nativeReadJobs.registerHandlers(ipcMain);
app.on("will-quit", () => nativeReadJobs.dispose());

// Video jobs belong to their requesting window and cancel when it closes.
const slideVideoCore = require("./ipc/slideVideo.cjs").createSlideVideoCore({ app, dialog, BrowserWindow, rootFor, fluxCliArgs, fsGuard, approveDir, noteWrite });
slideVideoCore.registerHandlers(ipcMain);
app.on("will-quit", () => slideVideoCore.cancelAll());
const videoMediaCore = require("./ipc/videoMedia.cjs").createVideoMediaCore({ app, protocol, rootFor, fsReadGuard: fileCore.fsReadGuard, noteWrite });
videoMediaCore.registerHandlers(ipcMain);
app.on("will-quit", () => videoMediaCore.cancelAll());

// Slide export (E): emit a self-contained offline .html for a deck. The engine is
// Node-only (prebaked runtime + inlined assets), so we run the `flux export-deck`
// verb in a child process using Electron's bundled Node (ELECTRON_RUN_AS_NODE).
// Returns the written path.
ipcMain.handle("slides:exportDeck", async (e, { root, deckId }) => {
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
      [...argv, "export-deck", String(deckId), "--root", String(root), "--saved"],
      { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e2) => resolve({ code: -1, stderr: String(e2) }));
    child.on("close", (c) => resolve({ code: c ?? 0, stderr: err }));
  });
  const outPath = path.join(root, "exports", `${deckId}.html`);
  fsGuard(outPath, e.sender.id); // W12: keep the write inside allowed roots
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    return { ok: false, error: (res.stderr || `export exited ${res.code}`).trim() };
  }
  noteWrite(outPath); // don't let the file-watcher echo our own write
  return { ok: true, path: outPath, warnings: res.stderr.trim() ? [res.stderr.trim()] : [] };
});

const staticPrint = require("./ipc/staticPrint.cjs").createStaticPrint({BrowserWindow,session,underDir,atomicWriteMain,fsGuard,rootFor,appRoot:path.resolve(__dirname,"..")});
staticPrint.registerHandlers(ipcMain);
app.on("will-quit", () => staticPrint.dispose());

// WS-9.4b: the NETWORK family (keys, cite:*, pdf:netGet, EZProxy machinery)
// lives in ipc/network.cjs.
const networkFamily = require("./ipc/network.cjs").createNetworkFamily({
  dialog,
  session,
  BrowserWindow,
  safeStorage,
  net,
  fluxLibDir,
  // proxy:login's parent — the focused window, not a fixed "main" one.
  getMainWindow: () => focusTargetWindow(),
  resolveToDoi,
  locks: { lockDirFor: scope => {
    if (scope !== "fluxlib") throw new Error("Network key lease requires FluxLib scope");
    return path.join(fluxLibDir(), ".fluxlib", "locks");
  } },
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
  rootForSender: (e) => rootFor(e),
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
      fsGuard(destAbs, e.sender.id);
    } catch (err) {
      return { ok: false, log: `refusing to write outside an allowed directory: ${destAbs}` };
    }
  }
  const temporaryName = `.flux-export-${require("node:crypto").randomUUID()}.${String(to || "pdf").toLowerCase()}`;
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
        path.basename(docAbs),
        "--to",
        to || "pdf",
        "--output", temporaryName,
        ...(prof ? ["--profile", prof] : []),
      ]);
      const p = spawn(q.command, q.args, {
        cwd: path.dirname(docAbs),
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
      p.on("close", (code, signal) => {
        if (signal) code = 1;
        flush(true);
        if (runId) quartoRuns.delete(runId);
        cleanupProfile();
        if (run.cancelled) return resolve({ ok: false, cancelled: true, code, log });
        // Verify the artifact actually landed (a _quarto.yml output-dir moves it —
        // report what we found so the renderer can Reveal the real file).
        const ext = String(to || "pdf").toLowerCase();
        const candidates = [
          path.join(path.dirname(docAbs), temporaryName),
          path.join(rootAbs, "_output", temporaryName),
        ];
        const created = /Output created:\s*(.+)/.exec(log);
        if (created) for (const base of [path.dirname(docAbs), rootAbs]) {
          const candidate = path.resolve(base, created[1].trim());
          if (underDir(candidate, rootAbs) && path.basename(candidate) === temporaryName) candidates.push(candidate);
        }
        if (code !== 0) { for (const candidate of candidates) { try { fs.rmSync(candidate, { force: true }); } catch {} } return resolve({ ok: false, code, log }); }
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
ipcMain.handle("shell:showItemInFolder", (e, p) => {
  const abs = path.resolve(String(p || ""));
  fsGuard(abs, e.sender.id);
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
  const underProject = sessionRoots().some((r) => (abs + path.sep).startsWith(r + path.sep));
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

// Open pre-rendered documentation. Installed help lives outside app.asar so
// the OS browser can follow its relative pages, scripts and styles.
ipcMain.handle("docs:open", async () => {
  const { openDocumentation } = require('./documentation.cjs');
  return openDocumentation({ packaged: app.isPackaged, resourcesPath: process.resourcesPath,
    sourceRoot: path.join(__dirname, '..') }, index => shell.openPath(index));
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
  rootForSender: (e) => rootFor(e),
});
const { reapPtys } = terminalFamily;

// (agent:mcpSpec lives in ipc/agent.cjs)

terminalFamily.registerHandlers(ipcMain);
