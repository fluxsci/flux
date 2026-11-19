// The REAL app deletes the retired library sign-in state at startup (2026-11-18 removal).
//
// Flux used to keep a library sign-in session in its own Electron partition
// (<userData>/Partitions/fluxproxy) and a saved password in <FluxLib>/.proxy.json. The
// feature is gone; an upgrading user's copy must be deleted without asking. The pure gate
// (verify-no-library-proxy.ts) covers the cleanup module itself. This one boots the real
// composition root (electron/main.cjs) on a scratch config dir and checks that startup:
//   - removed Partitions/fluxproxy and left Partitions/fluxnet (the open-access cookie jar)
//     byte-for-byte alone;
//   - removed <FluxLib>/.proxy.json and the retired key from keys.json, keeping the rest.
//
// Machine state is sandboxed BEFORE main.cjs loads (it pins userData at require time).
// FLUX_NO_MIGRATE is cleared on purpose: it is what keeps the cleanup away from a real home,
// and here the home is the scratch dir. Opens one app window: run it on a private display.
//   env -u WAYLAND_DISPLAY DISPLAY=:<own Xvfb> FLUX_PRIVATE_DISPLAY=1 FLUX_ELECTRON_NO_SANDBOX=1 \
//     node scripts/run-verifies.mjs --tier electron --only verify-retired-session-electron.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-retired-session-"));
const home = path.join(scratch, "home");
const xdg = path.join(scratch, "xdg");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.XDG_DATA_HOME = path.join(scratch, "data");
process.env.XDG_CACHE_HOME = path.join(scratch, "cache");
process.env.APPDATA = xdg;
process.env.LOCALAPPDATA = path.join(scratch, "cache");
delete process.env.FLUX_NO_MIGRATE;
delete process.env.VITE_DEV_SERVER_URL; // no dev server needed: the check is main-process only

const userData = require("../electron/fluxPaths.cjs").userDataDir(); // resolves inside the scratch dirs set above
if (!userData.startsWith(scratch)) throw new Error(`userData escaped the scratch dir: ${userData}`);
const parts = path.join(userData, "Partitions");
const lib = path.join(home, "FluxConfig", "FluxLib");
fs.mkdirSync(path.join(parts, "fluxproxy", "Cache"), { recursive: true });
fs.writeFileSync(path.join(parts, "fluxproxy", "Cookies"), "retired session");
fs.mkdirSync(path.join(parts, "fluxnet"), { recursive: true });
fs.writeFileSync(path.join(parts, "fluxnet", "Cookies"), "open-access jar");
fs.mkdirSync(lib, { recursive: true });
fs.writeFileSync(path.join(userData, "preferences.json"), JSON.stringify({ fluxConfigPath: path.join(home, "FluxConfig") }));
fs.writeFileSync(path.join(lib, ".proxy.json"), JSON.stringify({ username: "someone", passwordEnc: "c2VjcmV0" }));
fs.writeFileSync(path.join(lib, "keys.json"), JSON.stringify({ mailto: "app@example.org", ezproxyPrefix: "https://p.example/login?url=" }, null, 2) + "\n");

const { app } = require("electron");
app.commandLine.appendSwitch("ozone-platform-hint", "x11");
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const results = [];
const ok = (cond, name) => {
  results.push([!!cond, name]);
  fs.writeSync(1, `${cond ? "✓" : "✗"} ${name}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require("../electron/main.cjs");

async function main() {
  fs.writeSync(1, `… booted Electron ${process.versions.electron}; userData=${app.getPath("userData") === userData ? "scratch" : app.getPath("userData")}\n`);
  ok(app.getPath("userData") === userData, "the app's userData is the scratch config dir");
  // main.cjs's own whenReady handler ran first; wait for its cleanup to settle.
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && (fs.existsSync(path.join(parts, "fluxproxy")) || fs.existsSync(path.join(lib, ".proxy.json")))) await sleep(100);
  ok(!fs.existsSync(path.join(parts, "fluxproxy")), "startup removed Partitions/fluxproxy");
  ok(fs.existsSync(path.join(parts, "fluxnet", "Cookies")) && fs.readFileSync(path.join(parts, "fluxnet", "Cookies"), "utf8") === "open-access jar", "Partitions/fluxnet is untouched");
  ok(!fs.existsSync(path.join(lib, ".proxy.json")), "startup removed <FluxLib>/.proxy.json");
  let keys = null;
  for (let i = 0; i < 100; i++) {
    keys = JSON.parse(fs.readFileSync(path.join(lib, "keys.json"), "utf8"));
    if (!("ezproxyPrefix" in keys)) break;
    await sleep(100);
  }
  ok(JSON.stringify(keys) === JSON.stringify({ mailto: "app@example.org" }), "startup removed the retired key and kept mailto");
  const failed = results.filter(([pass]) => !pass).length;
  fs.writeSync(1, `##VERIFY## ${JSON.stringify({ script: "verify-retired-session-electron", ok: failed === 0, checks: results.length, failed })}\n`);
  fs.writeSync(1, (failed === 0 ? "RETIRED SESSION VERIFY: PASS" : `RETIRED SESSION VERIFY: FAIL (${failed})`) + "\n");
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(() => sleep(300).then(main)).catch((e) => {
  fs.writeSync(2, `RETIRED SESSION VERIFY: ERROR ${e && e.stack ? e.stack : e}\n`);
  app.exit(2);
});
setTimeout(() => {
  fs.writeSync(2, "RETIRED SESSION VERIFY: TIMEOUT\n");
  app.exit(3);
}, 90000).unref();
