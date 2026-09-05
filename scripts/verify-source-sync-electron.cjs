#!/usr/bin/env node
// Real main/preload/watchers and actual disk writes. Requires npm run build;
// FLUX_SOURCE_PROBE_DEV_URL optionally uses a real dev renderer during work.
// Each launch gets its own scratch userData/single-instance lock. Never
// attaches to or terminates the user's running Electron process.
"use strict";
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const electronBinary = require("electron");
const repo = path.resolve(__dirname, ".."), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-source-native-"));
// app.getPath("temp") is an allowed IPC read root, so the external files
// deliberately live outside it: this also exercises exact-file read grants.
const artifactRoot = path.join(repo, "test-results"); fs.mkdirSync(artifactRoot, { recursive: true });
const home = path.join(scratch, "home"), root = path.join(scratch, "project"), external = fs.mkdtempSync(path.join(artifactRoot, "native-source-external-"));
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", PROBE_SCRATCH: scratch, PROBE_PROJECT: root, PROBE_EXTERNAL: external };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
if (process.env.FLUX_SOURCE_PROBE_DEV_URL) env.VITE_DEV_SERVER_URL = process.env.FLUX_SOURCE_PROBE_DEV_URL;
let checks = 0, failed = 0;
const runElectron = (args, childEnv) => new Promise(resolve => {
  // Spawn the executable itself, not Electron's Node launcher wrapper, so
  // watchdog signals address exactly this probe's main process.
  const child = spawn(electronBinary, args, { env: childEnv, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", partial = "", reported = false, reap;
  // Reap only the process this runner spawned. The functional report arrives
  // after durable reads; retained native watchers must not hold the test open.
  const timer = setTimeout(() => child.kill("SIGKILL"), 100000);
  child.stdout.on("data", chunk => {
    const text = String(chunk); output += text; partial += text;
    const lines = partial.split("\n"); partial = lines.pop();
    for (const line of lines) if (line.startsWith("PROBE ")) {
      console.log(line);
      if (line.startsWith("PROBE result=")) {
        reported = true;
        reap = setTimeout(() => child.kill("SIGKILL"), 750);
      }
    }
  });
  child.stderr.on("data", chunk => { output += String(chunk); });
  child.on("error", error => { clearTimeout(timer); clearTimeout(reap); resolve({ status: null, output, error }); });
  child.on("close", status => { clearTimeout(timer); clearTimeout(reap); resolve({ status, output, reported }); });
});
const ok = (condition, label) => { checks++; if (!condition) failed++; console.log(`${condition ? "✓" : "✗"} ${label}`); };
async function main() { try {
  const fixture = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "lib/sourceSyncFixture.ts"), root, external], { env, cwd: repo, encoding: "utf8", timeout: 30000 });
  if (fixture.status !== 0) throw new Error(`Fixture failed: ${fixture.stdout}\n${fixture.stderr}`);
  for (const phase of ["initial", "reopen"]) {
    const flags = process.platform === "linux" ? ["--ozone-platform=x11", "--no-sandbox"] : [];
    const run = await runElectron([path.join(__dirname, "lib/sourceSyncProbeEntry.cjs"), root, ...flags], { ...env, PROBE_PHASE: phase });
    const output = run.output;
    ok(/PROBE boot=.*"windows":1/.test(output), `${phase}: positive native window/preload evidence`);
    const resultLine = output.split("\n").find(l => l.startsWith("PROBE result="));
    let result; try { result = JSON.parse(resultLine?.slice("PROBE result=".length) || "null"); } catch { /* failure below */ }
    for (const entry of result?.checks || []) ok(entry.ok, `${phase}: ${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`);
    const completed = run.reported && result?.ok === true;
    ok(completed, `${phase}: probe completed (${run.error?.message || result?.error || (completed ? "reported and reaped" : run.status)})`);
    if (!completed) { console.error(output.slice(-15000)); break; }
  }
} catch (e) { ok(false, e.message); }
finally { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }); }
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-source-sync-electron", ok: failed === 0, checks, failed })}`);
process.exitCode = failed ? 1 : 0; }
void main();
