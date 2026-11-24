#!/usr/bin/env node
// Paper's artifacts in the real app: the flux-artifact: protocol, the frame's own origin and
// process, the page policy (no network, no path out of its folder), the folder link as a
// machine preference, following the files, and the app's chords from inside a page. The parts a
// browser harness cannot show: there a page is served by the dev server and shares its site.
//
// Requires npm run build. Window-free by construction: Electron runs with the headless ozone
// platform and without DISPLAY / WAYLAND_DISPLAY, so nothing can appear on a desktop. Scratch
// HOME, userData and single-instance lock; never touches the user's running app.
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const electronBinary = require("electron");
const repo = path.resolve(__dirname, "..");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flux-artifacts-")));
const home = path.join(scratch, "home"), root = path.join(scratch, "project"), temp = path.join(scratch, "temp"), linked = path.join(scratch, "linked");
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(temp);
const env = { ...process.env, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata"),
  FLUX_NO_MIGRATE: "1", PROBE_SCRATCH: scratch, PROBE_PROJECT: root, PROBE_LINKED: linked };
for (const k of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "DISPLAY", "WAYLAND_DISPLAY", "FLUX_PROJECT"]) delete env[k];
let checks = 0, failed = 0;
const ok = (condition, label) => { checks++; if (!condition) failed++; console.log(`${condition ? "✓" : "✗"} ${label}`); };

function writeFixture() {
  const made = spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "flux-cli.ts"), "new", root, "--title", "Artifact probe"], { env, cwd: repo, encoding: "utf8", timeout: 60000 });
  if (made.status !== 0) throw new Error(`flux new failed: ${made.stdout}\n${made.stderr}`);
  fs.cpSync(path.join(repo, "scripts/fixtures/artifacts"), path.join(root, "artifacts"), { recursive: true });
  // What must never be served: a hidden file, and a link that leaves the folder.
  fs.writeFileSync(path.join(root, "artifacts/explorer/.secret"), "hidden");
  // Data two folders down, which a page loads only when asked: watched once it has been served, never before.
  fs.mkdirSync(path.join(root, "artifacts/explorer/data/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts/explorer/data/deep/extra.json"), '{"n":1}');
  fs.writeFileSync(path.join(root, "artifacts/explorer/data/deep/unread.json"), '{"n":1}');
  fs.writeFileSync(path.join(scratch, "outside.txt"), "outside the artifact folder");
  fs.symlinkSync(path.join(scratch, "outside.txt"), path.join(root, "artifacts/explorer/out.txt"));
  // The linked folder: outside the project, with a page at the top, one three folders down, and one inside node_modules.
  fs.mkdirSync(path.join(linked, "deep/tool"), { recursive: true });
  fs.mkdirSync(path.join(linked, "node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(linked, "report.html"), "<!doctype html><title>Loose report</title><h1>Report</h1>");
  fs.writeFileSync(path.join(linked, "deep/tool/index.html"), "<!doctype html><title>Linked tool</title><h1>Tool</h1>");
  fs.writeFileSync(path.join(linked, "node_modules/pkg/index.html"), "<!doctype html><title>A dependency's demo</title>");
  // The capture watcher's folder defaults to <downloads>/flux, which under a scratch config is HOME itself (guide §9).
  fs.mkdirSync(path.join(scratch, "captures"));
}

const runElectron = (args, childEnv) => new Promise(resolve => {
  const child = spawn(electronBinary, args, { env: childEnv, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", partial = "", reported = false, reap;
  const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
  child.stdout.on("data", chunk => {
    const text = String(chunk); output += text; partial += text;
    const lines = partial.split("\n"); partial = lines.pop();
    for (const line of lines) if (line.startsWith("PROBE ")) {
      if (process.env.FLUX_PROBE_VERBOSE === "1" || line.startsWith("PROBE uncaught")) console.log(line);
      if (line.startsWith("PROBE result=")) { reported = true; reap = setTimeout(() => child.kill("SIGKILL"), 750); }
    }
  });
  child.stderr.on("data", chunk => { output += String(chunk); });
  child.on("error", error => { clearTimeout(timer); clearTimeout(reap); resolve({ status: null, output, error }); });
  child.on("close", status => { clearTimeout(timer); clearTimeout(reap); resolve({ status, output, reported }); });
});

async function main() {
  try {
    if (!fs.existsSync(path.join(repo, "dist/index.html"))) throw new Error("dist/ is missing: run npm run build first");
    writeFixture();
    const flags = process.platform === "linux" ? ["--ozone-platform=headless", ...(process.env.FLUX_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])] : [];
    const run = await runElectron([path.join(__dirname, "lib/artifactsProbe.cjs"), root, ...flags], env);
    const resultLine = run.output.split("\n").find(l => l.startsWith("PROBE result="));
    let result; try { result = JSON.parse(resultLine?.slice("PROBE result=".length) || "null"); } catch { /* failure below */ }
    for (const entry of result?.checks || []) ok(entry.ok, `${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`);
    const completed = run.reported && result?.ok === true;
    ok(completed, `probe completed (${run.error?.message || result?.error || (completed ? "reported and reaped" : `exit ${run.status}`)})`);
    if (!completed) console.error(run.output.slice(-15000));
  } catch (e) { ok(false, e.message); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  console.log(`##VERIFY## ${JSON.stringify({ script: "verify-artifacts-electron", ok: failed === 0, checks, failed })}`);
  process.exitCode = failed ? 1 : 0;
}
void main();
