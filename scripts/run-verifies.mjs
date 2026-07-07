#!/usr/bin/env node
// Aggregate verify runner — runs curated tiers of the scripts/verify-* suite.
//
//   node scripts/run-verifies.mjs --tier pure            # the `npm test` gate (hermetic)
//   node scripts/run-verifies.mjs --tier ui              # browser suite (spawns :1420 if absent)
//   node scripts/run-verifies.mjs --group paper-gate     # the EDITING-FEEL contract
//   node scripts/run-verifies.mjs --tier pure,ui --only slide
//   node scripts/run-verifies.mjs --list
//
// Tiers/groups live in scripts/verify-manifest.json — new verify scripts must be
// added there to join the gate. Scripts run sequentially (they own ports, temp
// dirs, and the shared dev server). Exit code = number of failures.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "verify-manifest.json"), "utf8"));

// ---------- args ----------
const args = process.argv.slice(2);
const opt = { tiers: [], groups: [], only: null, list: false, timeout: 120000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--tier") opt.tiers.push(...String(args[++i] || "").split(",").filter(Boolean));
  else if (a === "--group") opt.groups.push(...String(args[++i] || "").split(",").filter(Boolean));
  else if (a === "--only") opt.only = args[++i];
  else if (a === "--list") opt.list = true;
  else if (a === "--timeout") opt.timeout = Number(args[++i]) || opt.timeout;
  else {
    console.error(`Unknown arg: ${a}`);
    process.exit(2);
  }
}
if (opt.list) {
  for (const [tier, scripts] of Object.entries(manifest.tiers))
    console.log(`${tier} (${scripts.length}):\n  ${scripts.join("\n  ")}`);
  for (const [g, scripts] of Object.entries(manifest.groups))
    console.log(`group:${g} (${scripts.length}):\n  ${scripts.join("\n  ")}`);
  process.exit(0);
}
if (!opt.tiers.length && !opt.groups.length) opt.tiers = ["pure"];

// ---------- resolve the run set ----------
const tierOf = new Map();
for (const [tier, scripts] of Object.entries(manifest.tiers))
  for (const s of scripts) tierOf.set(s, tier);

const set = [];
const seen = new Set();
const add = (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  set.push(name);
};
for (const t of opt.tiers) {
  const scripts = manifest.tiers[t];
  if (!scripts) {
    console.error(`Unknown tier "${t}" (have: ${Object.keys(manifest.tiers).join(", ")})`);
    process.exit(2);
  }
  scripts.forEach(add);
}
for (const g of opt.groups) {
  const scripts = manifest.groups[g];
  if (!scripts) {
    console.error(`Unknown group "${g}" (have: ${Object.keys(manifest.groups).join(", ")})`);
    process.exit(2);
  }
  scripts.forEach(add);
}
const run = opt.only ? set.filter((s) => s.includes(opt.only)) : set;
if (!run.length) {
  console.error("Nothing to run.");
  process.exit(2);
}

// Untracked scripts are a manifest bug — surface loudly when a tier file vanished.
for (const s of run)
  if (!existsSync(path.join(repoRoot, "scripts", s))) {
    console.error(`Manifest references missing script: scripts/${s}`);
    process.exit(2);
  }

// ---------- shared dev server (ui tiers) ----------
const APP_URL = process.env.FLUX_URL || "http://127.0.0.1:1420/";
const needsServer = run.some((s) => ["ui", "ui-extra", "scale"].includes(tierOf.get(s)));
const needsBuild = run.filter((s) => ["bundle", "startup"].includes(tierOf.get(s)));
let ownedServer = null;

async function serving() {
  try {
    const r = await fetch(APP_URL, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serving()) {
    console.log(`· dev server already up at ${APP_URL}`);
    return;
  }
  console.log("· starting dev server (npm run dev)…");
  ownedServer = spawn("npm", ["run", "dev"], { cwd: repoRoot, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serving()) return;
    if (ownedServer.exitCode !== null) break;
  }
  throw new Error(`dev server did not become reachable at ${APP_URL}`);
}

function stopServer() {
  if (!ownedServer || ownedServer.exitCode !== null) return;
  try {
    process.kill(-ownedServer.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-ownedServer.pid, "SIGKILL");
    } catch {}
  }, 2000).unref();
}
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

// ---------- per-script execution ----------
function runScript(name) {
  const file = path.join(repoRoot, "scripts", name);
  const [cmd, cargs] = name.endsWith(".ts") ? ["npx", ["tsx", file]] : ["node", [file]];
  const timeout = manifest.timeouts?.[name] ?? opt.timeout;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, cargs, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const cap = (d) => {
      out += d;
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ name, ms: Date.now() - t0, code: timedOut ? "timeout" : code, out });
    });
  });
}

// ---------- main ----------
const t0 = Date.now();
if (needsBuild.length) {
  const cli = path.join(repoRoot, "dist", "flux-cli.mjs");
  if (!existsSync(cli)) {
    console.error(`bundle/startup tiers need build artifacts — run \`npm run build\` first (missing ${path.relative(repoRoot, cli)})`);
    process.exit(2);
  }
}
if (needsServer) await ensureServer();

console.log(`Running ${run.length} verify script(s)…\n`);
const results = [];
for (const name of run) {
  process.stdout.write(`  … ${name}`);
  let r = await runScript(name);
  // Timing-gated scripts (frame budgets, perf medians) get ONE retry — a shared-server
  // suite run can spike them. A genuine regression fails twice.
  let retried = false;
  if (r.code !== 0 && manifest.retryOnce?.includes(name)) {
    retried = true;
    r = await runScript(name);
  }
  results.push(r);
  const secs = (r.ms / 1000).toFixed(1);
  process.stdout.write(
    `\r${r.code === 0 ? "  ✓" : "  ✗"} ${name} (${secs}s)${retried ? " [retried]" : ""}${r.code === 0 ? "" : ` — exit ${r.code}`}\n`,
  );
  if (r.code !== 0) {
    const tail = r.out.trimEnd().split("\n").slice(-40).join("\n");
    console.log(`    ┄┄ output tail ┄┄\n${tail.replace(/^/gm, "    ")}\n`);
  }
}

const failed = results.filter((r) => r.code !== 0);
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${total}s`);
if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
process.exit(Math.min(failed.length, 100));
