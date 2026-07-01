// W6 verify (real Electron): the quit/close flush handshake + the menu template.
//
// Run:  DISPLAY=:0 ./node_modules/.bin/electron scripts/verify-w6-flush.cjs --no-sandbox
//
// Exercises the ACTUAL shipped code: the flush coordinator from appLifecycle.cjs
// and the REAL electron/preload.cjs bridge (onFlushRequest / flushDone). A hidden
// BrowserWindow loads with the real preload; the coordinator asks it to flush and
// we prove the round-trip main→renderer→main completes, that a non-acking renderer
// still releases via the timeout (never bricks quit), that a gone window releases
// immediately, and that the platform menu templates are well-formed.

const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("node:path");
const { createFlushCoordinator, appMenuTemplate } = require("../electron/appLifecycle.cjs");

// Headless CI: no GPU. Match the app's own defensive flags so the renderer
// process doesn't crash on load.
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();
// Destroying a test window would otherwise trip Electron's default
// "quit when all windows close" and abandon main() before the report runs.
app.on("window-all-closed", () => {});

const results = [];
const ok = (name) => results.push([true, name]);
const bad = (name, extra) => results.push([false, extra ? `${name} — ${extra}` : name]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Headless renderer startup occasionally rejects the very first load with a
  // transient ERR_FAILED; retry a couple times. preload still runs → window.fig.
  for (let attempt = 0; ; attempt++) {
    try {
      await win.loadURL("about:blank");
      return win;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(200);
    }
  }
}

async function main() {
  await sleep(300); // let the app fully settle before the first window
  // ---- 1. Live renderer acks → done fires, nothing left pending -------------
  {
    const coord = createFlushCoordinator({ timeoutMs: 4000 });
    ipcMain.on("app:flush:done", (_e, token) => coord.ack(token));
    const win = await makeWindow();
    // Register the ack handler through the REAL preload bridge (window.fig).
    await win.webContents.executeJavaScript(`
      window.__acked = false;
      const off = window.fig.onFlushRequest((token) => {
        window.__acked = true;
        window.fig.flushDone(token);
      });
      typeof off === "function";
    `);
    let done = false;
    const t0 = Date.now();
    coord.request(win, () => { done = true; });
    for (let i = 0; i < 40 && !done; i++) await sleep(25);
    const acked = await win.webContents.executeJavaScript("window.__acked");
    const dt = Date.now() - t0;
    if (done && acked && coord.pendingCount() === 0 && dt < 2000) ok(`live renderer acked (${dt}ms)`);
    else bad("live renderer ack", `done=${done} acked=${acked} pending=${coord.pendingCount()} dt=${dt}`);
    ipcMain.removeAllListeners("app:flush:done");
    win.destroy();
  }

  // ---- 2. Non-acking renderer → done fires via the timeout (no brick) -------
  {
    const coord = createFlushCoordinator({ timeoutMs: 300 });
    // deliberately DO NOT wire ack — simulate a wedged renderer
    const win = await makeWindow(); // real preload, but no onFlushRequest handler
    let done = false;
    const t0 = Date.now();
    coord.request(win, () => { done = true; });
    for (let i = 0; i < 40 && !done; i++) await sleep(25);
    const dt = Date.now() - t0;
    if (done && dt >= 280 && dt < 1500 && coord.pendingCount() === 0) ok(`wedged renderer released by timeout (${dt}ms)`);
    else bad("timeout release", `done=${done} dt=${dt} pending=${coord.pendingCount()}`);
    win.destroy();
  }

  // ---- 3. Already-gone window → done fires immediately ----------------------
  {
    const coord = createFlushCoordinator({ timeoutMs: 2500 });
    const win = await makeWindow();
    win.destroy();
    let done = false;
    coord.request(win, () => { done = true; });
    // synchronous: no send, no timer
    if (done && coord.pendingCount() === 0) ok("destroyed window releases synchronously");
    else bad("destroyed window", `done=${done} pending=${coord.pendingCount()}`);
  }

  // ---- 4. Menu templates are correct per platform + build without throwing --
  {
    const prodLinux = appMenuTemplate({ isMac: false, isDev: false });
    const devLinux = appMenuTemplate({ isMac: false, isDev: true });
    const prodMac = appMenuTemplate({ isMac: true, isDev: false });
    const devMac = appMenuTemplate({ isMac: true, isDev: true });

    if (prodLinux === null) ok("prod Linux/Win → no menu (kills stray reload accel)");
    else bad("prod Linux menu", "expected null");

    const devHasReload =
      Array.isArray(devLinux) &&
      JSON.stringify(devLinux).includes('"reload"');
    if (devHasReload) ok("dev Linux/Win → View menu keeps reload/devtools");
    else bad("dev Linux menu", "expected a View submenu with reload");

    const macHasEdit =
      Array.isArray(prodMac) && prodMac.some((m) => m.role === "editMenu");
    const macProdNoReload = !JSON.stringify(prodMac).includes('"reload"');
    if (macHasEdit && macProdNoReload) ok("prod macOS → app/Edit/Window roles, no reload");
    else bad("prod macOS menu", `edit=${macHasEdit} noReload=${macProdNoReload}`);

    try {
      Menu.buildFromTemplate(prodMac);
      Menu.buildFromTemplate(devMac);
      Menu.buildFromTemplate(devLinux);
      ok("Menu.buildFromTemplate accepts every template");
    } catch (e) {
      bad("Menu.buildFromTemplate", e.message);
    }
  }

  // ---- report --------------------------------------------------------------
  // app.exit() terminates before Node flushes buffered stdout, so write the
  // report synchronously to fd 1.
  const fs = require("node:fs");
  let failed = 0;
  let out = "";
  for (const [pass, name] of results) {
    out += `${pass ? "✓" : "✗"} ${name}\n`;
    if (!pass) failed++;
  }
  out += (failed === 0 ? "W6 VERIFY: PASS" : `W6 VERIFY: FAIL (${failed})`) + "\n";
  fs.writeSync(1, out);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  require("node:fs").writeSync(2, `W6 VERIFY: ERROR ${e && e.stack ? e.stack : e}\n`);
  app.exit(2);
});
