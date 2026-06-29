const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

let chokidar;
try {
  chokidar = require("chokidar");
} catch {
  chokidar = null; // file-watch (F1 live reload) degrades gracefully without the dep
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
    ...approvedDirs,
  ].filter(Boolean);
  if (roots.some((r) => underDir(ab, path.resolve(r)))) return;
  throw new Error(`refused path outside project/app roots: ${p}`);
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
}

app.whenReady().then(() => {
  createWindow();
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
  if (!root || !chokidar) return false;
  const targets = ["plots", "fig", "manuscript", "references"].map((d) => path.join(root, d));
  const pending = new Map(); // subsystem -> latest changed path
  let timer = null;
  const flush = () => {
    timer = null;
    for (const [subsystem, p] of pending)
      mainWindow?.webContents.send("fs:changed", { subsystem, path: p });
    pending.clear();
  };
  projectWatcher = chokidar.watch(targets, {
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
  const shell = defaultShell();
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
    child = nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", TERM_PROGRAM: "Flux", COLORTERM: "truecolor" },
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
