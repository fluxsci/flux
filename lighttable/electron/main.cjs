"use strict";
// Lighttable main process. All filesystem work, sorting, alignment, and
// thumbnailing happen here; the renderer is UI only and receives already-
// aligned data over a tiny IPC surface. Image bytes are served by the
// privileged ltfile:// protocol (never piped over IPC).
const { app, BrowserWindow, protocol, dialog, ipcMain, shell, net } = require("electron");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { scanCollection, toManifest } = require("./scan.cjs");
const thumbs = require("./thumbs.cjs");
const prefs = require("./prefs.cjs");
const { mimeFor } = require("./lib/pure.cjs");

const DEV_URL = process.env.LT_DEV_SERVER_URL || null;

// Lowercase name -> ~/.config/lighttable (config-dir hygiene; userData/cache
// never mix with Flux's). Display strings say "Lighttable".
app.setName("lighttable");
if (process.env.LT_USER_DATA) app.setPath("userData", process.env.LT_USER_DATA); // test isolation seam

let win = null;
let currentScan = null; // the open collection's scan (root, sets, index, …)

// ---- ltfile:// token registry -----------------------------------------------
// Opaque token <-> absolute path, minted only for paths main itself resolved.
// Dedup by path (repeated requests reuse the token; bounded by distinct
// paths); cleared on every collection open. The renderer never sees or sends
// filesystem paths.
const pathByTok = new Map();
const tokByPath = new Map();
function mint(abs) {
  let t = tokByPath.get(abs);
  if (!t) {
    t = crypto.randomUUID();
    tokByPath.set(abs, t);
    pathByTok.set(t, abs);
  }
  return t;
}

const allowedRoots = () => [currentScan?.root, thumbs.cacheRoot()].filter(Boolean);
// Defense in depth: even though tokens are minted by main, the handler
// re-validates that the resolved path sits inside an allowed root.
function within(abs) {
  const rp = path.resolve(abs);
  return allowedRoots().some((r) => {
    const root = path.resolve(r);
    return rp === root || rp.startsWith(root + path.sep);
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: "ltfile", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---- collection open ---------------------------------------------------------
async function openCollection(p) {
  const scan = await scanCollection(p);
  if (!scan) return null;
  currentScan = scan;
  pathByTok.clear();
  tokByPath.clear();
  prefs.pushRecent(scan.root);
  return toManifest(scan);
}

function resolveItemPath(setId, key) {
  if (typeof setId !== "string" || typeof key !== "string") return null;
  return currentScan?.index.get(setId)?.get(key) ?? null;
}

async function openAndSend(p) {
  const m = await openCollection(p);
  if (m && win && !win.isDestroyed()) win.webContents.send("lt:open", m);
}

// CLI arg: `lighttable <path>` / `electron . <path>`; LT_OPEN is the dev-mode
// equivalent (concurrently can't forward args through electron:dev).
function cliOpenPath(argv) {
  if (process.env.LT_OPEN) return process.env.LT_OPEN;
  const args = argv.slice(1).filter((a) => a && !a.startsWith("-") && a !== ".");
  return args[args.length - 1] || null;
}

// ---- single instance ---------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const p = cliOpenPath(argv);
    if (p) void openAndSend(p);
  });

  // macOS Finder open
  let pendingOpenFile = null;
  app.on("open-file", (e, p) => {
    e.preventDefault();
    if (app.isReady() && win) void openAndSend(p);
    else pendingOpenFile = p;
  });

  app.whenReady().then(() => {
    prefs.initPrefs(app.getPath("userData"));
    thumbs.initThumbs(path.join(app.getPath("userData"), "thumbs"));
    // Raster work runs in a crash-isolated utilityProcess, NEVER in this
    // process (@napi-rs/canvas segfaults main under burst load).
    thumbs.useWorkerBackend(path.join(__dirname, "thumbWorker.cjs"));
    void thumbs.sweepCache(); // best-effort background LRU sweep

    protocol.handle("ltfile", async (req) => {
      // ltfile://thumb/<token> | ltfile://full/<token> — the host is cosmetic;
      // within() is the load-bearing check.
      let abs;
      try {
        const u = new URL(req.url);
        abs = pathByTok.get(u.pathname.replace(/^\/+/, ""));
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (!abs || !within(abs)) return new Response("forbidden", { status: 403 });
      try {
        const r = await net.fetch(pathToFileURL(abs).toString());
        if (!r.ok) return new Response("not found", { status: 404 });
        return new Response(r.body, { headers: { "Content-Type": mimeFor(abs) } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });

    ipcMain.handle("lt:openDialog", async () => {
      const r = await dialog.showOpenDialog(win, { title: "Open collection", properties: ["openDirectory"] });
      if (r.canceled || !r.filePaths[0]) return null;
      return openCollection(r.filePaths[0]);
    });
    ipcMain.handle("lt:openPath", (_e, p) => (typeof p === "string" && p ? openCollection(p) : null));
    ipcMain.handle("lt:recents", () => prefs.recents());
    ipcMain.handle("lt:thumbUrl", async (_e, setId, key, px) => {
      const src = resolveItemPath(setId, key);
      if (!src) return null;
      const pxN = Math.max(32, Math.min(2048, Number(px) || 256));
      const served = await thumbs.ensureThumb(src, pxN);
      return `ltfile://thumb/${mint(served)}`;
    });
    ipcMain.handle("lt:fullUrl", (_e, setId, key) => {
      const src = resolveItemPath(setId, key);
      return src ? `ltfile://full/${mint(src)}` : null;
    });
    ipcMain.handle("lt:reveal", (_e, setId, key) => {
      const p = resolveItemPath(setId, key);
      if (p) shell.showItemInFolder(p);
    });
    ipcMain.handle("lt:prefsGet", () => prefs.get());
    ipcMain.handle("lt:prefsSet", (_e, p) => prefs.set(p));

    createWindow();

    const initial = pendingOpenFile || cliOpenPath(process.argv);
    if (initial) {
      win.webContents.once("did-finish-load", () => void openAndSend(initial));
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#100f0f",
    title: "Lighttable",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => {
    win = null;
  });

  const appUrl = DEV_URL || pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
  // Navigation lockdown: the window shows the app document and nothing else;
  // external links go to the system browser.
  win.webContents.on("will-navigate", (e, url) => {
    const ok = DEV_URL ? url.startsWith(DEV_URL) : url === appUrl;
    if (!ok) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadURL(appUrl);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  prefs.flushSync();
});
