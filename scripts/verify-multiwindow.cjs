// Multi-window (2026-08-11): two windows must keep INDEPENDENT roots, agent
// bridges, GUI locks, and project watchers — the pre-multi-window design held
// one slot for each, so window B's project open silently took window A's
// watcher, bridge, and locks (plan: notes/aug_10_deferred_updates/
// multi_window_and_dual_paper_panes.md §A1). This boots the REAL app
// (electron/main.cjs) against a scratch config dir (own single-instance lock,
// own prefs/FluxLib — the quit-wedge probe recipe) with the renderer served
// from the dev server, and drives both windows through the real preload bridge.
//
// Run (dev server must be up; uses FLUX_URL or :1420):
//   ./node_modules/.bin/electron --ozone-platform=x11 scripts/verify-multiwindow.cjs --no-sandbox
//
// Needs a display (real windows open briefly) — and --ozone-platform=x11 must
// be a REAL command-line argument: from a detached agent shell, native Wayland
// hangs Electron before whenReady, and an appendSwitch from inside the script
// is parsed too late to save it (guide §9; cost an hour here, 2026-08-11).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Sandbox the machine state BEFORE main.cjs loads (it pins userData at require
// time). HOME too: FluxLib must never resolve to the real ~/FluxConfig.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-mw-"));
process.env.XDG_CONFIG_HOME = path.join(scratch, "xdg");
process.env.HOME = path.join(scratch, "home");
process.env.FLUX_NO_MIGRATE = "1";
fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
// The renderer is the real app served by the dev server (window.fig via the
// real preload) — the whole point is driving the shipped IPC surface.
process.env.VITE_DEV_SERVER_URL = process.env.FLUX_URL || "http://127.0.0.1:1420/";

const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("ozone-platform-hint", "x11"); // guide §9: never trust Wayland from a detached shell
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

// Two scratch "projects" — watch/lock/bridge targets need dirs, not validity.
const rootA = path.join(scratch, "projA");
const rootB = path.join(scratch, "projB");
for (const r of [rootA, rootB]) fs.mkdirSync(path.join(r, "manuscript"), { recursive: true });
fs.writeFileSync(path.join(rootA, "manuscript", "main.qmd"), "# A\n");
// A third dir that LOOKS like a project (parseLaunchArgs checks project.json).
const rootC = path.join(scratch, "projC");
fs.mkdirSync(rootC, { recursive: true });
fs.writeFileSync(path.join(rootC, "project.json"), "{}\n");

// Boot the REAL composition root. Its whenReady handler (registered first)
// creates window 1; ours below runs after it.
require("../electron/main.cjs");

const results = [];
// Stream each result immediately (fd 1, unbuffered) — a hung step must leave
// the completed steps visible, not swallow them in a buffered pipe.
const ok = (name) => {
  results.push([true, name]);
  fs.writeSync(1, `✓ ${name}\n`);
};
const bad = (name, extra) => {
  const line = extra ? `${name} — ${extra}` : name;
  results.push([false, line]);
  fs.writeSync(1, `✗ ${line}\n`);
};
const step = (name) => fs.writeSync(1, `… ${name}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const appWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
const bridgeFile = (root) => path.join(root, ".meta", "live", "bridge.json");
const lockFile = (root) => path.join(root, ".meta", "locks", "paper.json");

async function waitFor(fn, label, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(150);
  }
}

/** Wait until the window's renderer has the real preload bridge. */
async function waitBridge(win) {
  await waitFor(async () => {
    try {
      return await win.webContents.executeJavaScript("!!(window.fig && window.fig.watchRoot)");
    } catch {
      return false; // mid-load
    }
  }, "renderer bridge (window.fig)");
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function main() {
  step("waiting for window 1");
  const winA = await waitFor(() => appWindows()[0], "first window");
  await waitBridge(winA);
  ok("boot: window 1 up with the real preload bridge (positive evidence)");

  // ---- second-instance --new-window → a second window ------------------------
  step("second-instance --new-window");
  app.emit("second-instance", null, ["flux", "--new-window"], "/");
  await waitFor(() => appWindows().length === 2, "second window");
  const winB = appWindows().find((w) => w !== winA);
  await waitBridge(winB);
  ok("second-instance --new-window opened window 2");

  // ---- independent roots: B's registration must not tear down A's ------------
  step("watchRoot A");
  await js(winA, `window.fig.watchRoot(${JSON.stringify(rootA)})`);
  await waitFor(() => fs.existsSync(bridgeFile(rootA)), "bridge A");
  step("watchRoot B");
  await js(winB, `window.fig.watchRoot(${JSON.stringify(rootB)})`);
  await waitFor(() => fs.existsSync(bridgeFile(rootB)), "bridge B");
  if (fs.existsSync(bridgeFile(rootA))) ok("window A's agent bridge SURVIVES window B's project open");
  else bad("bridge isolation", "rootA/.meta/live/bridge.json gone after B registered");

  // ---- per-window GUI locks --------------------------------------------------
  await js(winA, `window.fig.lockSet("paper", true)`);
  await js(winB, `window.fig.lockSet("paper", true)`);
  await waitFor(() => fs.existsSync(lockFile(rootA)) && fs.existsSync(lockFile(rootB)), "both lock files");
  ok("each window's paper lock lands in ITS OWN project");
  await js(winB, `window.fig.lockSet("paper", false)`);
  await sleep(300);
  if (fs.existsSync(lockFile(rootA)) && !fs.existsSync(lockFile(rootB)))
    ok("window B's release removes only B's lock (A keeps deferring agents)");
  else bad("lock release isolation", `A=${fs.existsSync(lockFile(rootA))} B=${fs.existsSync(lockFile(rootB))}`);

  // ---- project watcher fan-out: A's file event reaches only A ----------------
  await js(winA, `window.__seen = []; window.fig.onFsChanged((i) => window.__seen.push(i.subsystem)); true`);
  await js(winB, `window.__seen = []; window.fig.onFsChanged((i) => window.__seen.push(i.subsystem)); true`);
  fs.appendFileSync(path.join(rootA, "manuscript", "main.qmd"), "\nexternal edit\n");
  await waitFor(
    () => js(winA, `window.__seen.includes("manuscript")`),
    "window A sees its manuscript change",
    8000,
  );
  ok("external edit in project A reaches window A");
  const bSaw = await js(winB, `window.__seen.includes("manuscript")`);
  if (!bSaw) ok("…and does NOT reach window B (per-window project watchers)");
  else bad("watcher isolation", "window B received project A's manuscript event");

  // ---- A4.1: the same project focuses the existing window --------------------
  const elsewhere = await js(winB, `window.fig.projectOpenElsewhere(${JSON.stringify(rootA)})`);
  if (elsewhere === true) ok("projectOpenElsewhere(rootA) from B → true (focuses A)");
  else bad("projectOpenElsewhere", `expected true, got ${elsewhere}`);
  const nowhere = await js(winB, `window.fig.projectOpenElsewhere(${JSON.stringify(rootC)})`);
  if (nowhere === false) ok("an unopened root reports false");
  else bad("projectOpenElsewhere(unopened)", `expected false, got ${nowhere}`);

  // ---- second-instance with an ALREADY-OPEN project must not duplicate -------
  const before = appWindows().length;
  app.emit("second-instance", null, ["flux", rootA], "/");
  await sleep(800);
  if (appWindows().length === before) ok("second-instance with an open project focuses, never duplicates");
  else bad("second-instance duplicate", `windows ${before} → ${appWindows().length}`);

  // ---- second-instance with a NEW project dir opens a window for it ----------
  app.emit("second-instance", null, ["flux", rootC], "/");
  await waitFor(() => appWindows().length === before + 1, "third window for a project arg");
  ok("second-instance with a project dir opens a new window");

  // ---- closing B tears down ONLY B's session ---------------------------------
  winB.destroy();
  await waitFor(() => !fs.existsSync(bridgeFile(rootB)), "bridge B removed on close");
  if (fs.existsSync(bridgeFile(rootA))) ok("closing window B removes B's bridge and leaves A's alive");
  else bad("close teardown", "window A's bridge died with window B");

  report();
}

function report() {
  // Result lines already streamed as they happened — print only the verdict.
  const failed = results.filter(([pass]) => !pass).length;
  fs.writeSync(1, (failed === 0 ? "MULTIWINDOW VERIFY: PASS" : `MULTIWINDOW VERIFY: FAIL (${failed})`) + "\n");
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* scratch cleanup is best-effort */
  }
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(() => sleep(400).then(main)).catch((e) => {
  fs.writeSync(2, `MULTIWINDOW VERIFY: ERROR ${e && e.stack ? e.stack : e}\n`);
  app.exit(2);
});
