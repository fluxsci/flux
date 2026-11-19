#!/usr/bin/env node
// The real app, a new-layout project (documentRoot "paper"), a document with a margin comment
// open in Paper, and an agent working through the real CLI. Proves (2026-11-19 fix):
//   1. the project watcher reports paper/ changes, so an agent's reply appears in the open app
//      and an agent's document edit reaches the open editor;
//   2. a reply made in the GUI afterwards keeps the agent's reply on disk;
//   3. an agent reply landing while a GUI reply waits to be saved survives that save too.
// Before the fix paper/ was not watched: the app never heard of the agent's reply and the GUI's
// next save wrote its stale thread list over the sidecar, erasing it.
//
// Requires npm run build (FLUX_PAPER_WATCH_DEV_URL optionally points the renderer at a dev
// server instead). Window-free by construction: Electron runs with the headless ozone platform
// and without DISPLAY / WAYLAND_DISPLAY, so nothing can appear on a desktop. Scratch HOME,
// userData and single-instance lock; never touches the user's running app.
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const electronBinary = require("electron");
const repo = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-paper-watch-"));
const home = path.join(scratch, "home"), root = path.join(scratch, "project"), temp = path.join(scratch, "temp");
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(temp);
const env = { ...process.env, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata"),
  FLUX_NO_MIGRATE: "1", PROBE_SCRATCH: scratch, PROBE_PROJECT: root, PROBE_NODE: process.execPath, PROBE_REPO: repo };
for (const k of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "DISPLAY", "WAYLAND_DISPLAY", "FLUX_PROJECT"]) delete env[k];
if (process.env.FLUX_PAPER_WATCH_DEV_URL) env.VITE_DEV_SERVER_URL = process.env.FLUX_PAPER_WATCH_DEV_URL;
let checks = 0, failed = 0;
const ok = (condition, label) => { checks++; if (!condition) failed++; console.log(`${condition ? "✓" : "✗"} ${label}`); };

const TEXT = "---\ntitle: Watch probe\n---\n\n# Results\n\nMycelial growth slowed under nutrient stress. The control group recovered.\n";
const QUOTE = "growth slowed";
function writeFixture() {
  const made = spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "flux-cli.ts"), "new", root, "--title", "Watch probe"], { env, cwd: repo, encoding: "utf8", timeout: 60000 });
  if (made.status !== 0) throw new Error(`flux new failed: ${made.stdout}\n${made.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
  if (manifest.documentRoot !== "paper" || manifest.manuscript.path !== "paper/notes.qmd") throw new Error(`Unexpected scaffold: ${JSON.stringify(manifest.manuscript)}`);
  fs.writeFileSync(path.join(root, "paper/notes.qmd"), TEXT);
  const start = TEXT.indexOf(QUOTE), end = start + QUOTE.length;
  const thread = { id: "c-watch", anchor: { start, end, quote: QUOTE, prefix: TEXT.slice(Math.max(0, start - 32), start), suffix: TEXT.slice(end, end + 32) },
    resolved: false, messages: [{ author: "You", body: "Is this the right verb?", createdAt: "2026-11-19T09:00:00.000Z", kind: "human" }] };
  fs.writeFileSync(path.join(root, "paper/notes.comments.json"), JSON.stringify({ version: 1, threads: [thread] }, null, 2) + "\n");
}

const runElectron = (args, childEnv) => new Promise(resolve => {
  const child = spawn(electronBinary, args, { env: childEnv, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", partial = "", reported = false, reap;
  const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
  child.stdout.on("data", chunk => {
    const text = String(chunk); output += text; partial += text;
    const lines = partial.split("\n"); partial = lines.pop();
    for (const line of lines) if (line.startsWith("PROBE ")) {
      console.log(line);
      if (line.startsWith("PROBE result=")) { reported = true; reap = setTimeout(() => child.kill("SIGKILL"), 750); }
    }
  });
  child.stderr.on("data", chunk => { output += String(chunk); });
  child.on("error", error => { clearTimeout(timer); clearTimeout(reap); resolve({ status: null, output, error }); });
  child.on("close", status => { clearTimeout(timer); clearTimeout(reap); resolve({ status, output, reported }); });
});

async function main() {
  try {
    if (!process.env.FLUX_PAPER_WATCH_DEV_URL && !fs.existsSync(path.join(repo, "dist/index.html"))) throw new Error("dist/ is missing: run npm run build first");
    writeFixture();
    const flags = process.platform === "linux" ? ["--ozone-platform=headless", ...(process.env.FLUX_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])] : [];
    const run = await runElectron([path.join(__dirname, "lib/paperCommentWatchProbe.cjs"), root, ...flags], env);
    const resultLine = run.output.split("\n").find(l => l.startsWith("PROBE result="));
    let result; try { result = JSON.parse(resultLine?.slice("PROBE result=".length) || "null"); } catch { /* failure below */ }
    for (const entry of result?.checks || []) ok(entry.ok, `${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`);
    const completed = run.reported && result?.ok === true;
    ok(completed, `probe completed (${run.error?.message || result?.error || (completed ? "reported and reaped" : `exit ${run.status}`)})`);
    if (!completed) console.error(run.output.slice(-15000));
  } catch (e) { ok(false, e.message); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  console.log(`##VERIFY## ${JSON.stringify({ script: "verify-paper-comment-watch-electron", ok: failed === 0, checks, failed })}`);
  process.exitCode = failed ? 1 : 0;
}
void main();
