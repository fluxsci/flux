const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

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

  // Keep the renderer's custom maximize/restore button in sync.
  win.on("maximize", () => win.webContents.send("win:maximized", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized", false));

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
  return opts.multiple ? res.filePaths : res.filePaths[0];
});

ipcMain.handle("dlg:save", async (_e, opts) => {
  const res = await dialog.showSaveDialog({
    defaultPath: opts.defaultPath,
    filters: opts.filters,
    title: opts.title,
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle("fs:readFile", async (_e, p) => {
  const buf = await fs.promises.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle("fs:writeFile", async (_e, p, data) => {
  await fs.promises.writeFile(p, Buffer.from(data));
});
ipcMain.handle("fs:readText", async (_e, p) => fs.promises.readFile(p, "utf8"));
ipcMain.handle("fs:writeText", async (_e, p, text) => {
  await fs.promises.writeFile(p, text, "utf8");
});
ipcMain.handle("fs:mkdir", async (_e, p) => {
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
