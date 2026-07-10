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
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeVersion } from "./lib/nodeCheck.mjs";

assertNodeVersion("run-verifies"); // WS-0b: gates only count on the CI runtime

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "verify-manifest.json"), "utf8"));

// ---------- args ----------
const args = process.argv.slice(2);
const opt = { tiers: [], groups: [], only: null, list: false, timeout: 120000, jobs: 1, changed: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--tier") opt.tiers.push(...String(args[++i] || "").split(",").filter(Boolean));
  else if (a === "--group") opt.groups.push(...String(args[++i] || "").split(",").filter(Boolean));
  else if (a === "--only") opt.only = args[++i];
  else if (a === "--list") opt.list = true;
  else if (a === "--timeout") opt.timeout = Number(args[++i]) || opt.timeout;
  else if (a === "--jobs") opt.jobs = Math.max(1, Number(args[++i]) || 1);
  else if (a === "--changed") opt.changed = true;
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
// ---------- --changed: map the branch diff to the scripts that gate it ----------
// manifest.pathMap is an ORDERED list of { glob, run } entries; the first glob a
// changed file matches wins for that file; the union of all matched `run` sets
// (plus tier:pure as the safety floor when any file matches nothing) executes.
// run entries: "tier:<name>" | "group:<name>" | "self" (a changed verify script
// runs itself).
if (opt.changed) {
  const { execSync } = await import("node:child_process");
  const globRe = (g) =>
    new RegExp(
      "^" +
        g
          .split(/(\*\*\/?|\*)/)
          .map((part) =>
            part === "**" || part === "**/" ? "(?:.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("") +
        "$",
    );
  let files = [];
  try {
    const base = execSync("git merge-base origin/main HEAD", { cwd: repoRoot }).toString().trim();
    files = execSync(`git diff --name-only ${base}`, { cwd: repoRoot }).toString().trim().split("\n").filter(Boolean);
    const dirty = execSync("git status --porcelain", { cwd: repoRoot })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^.* -> /, ""));
    files = [...new Set([...files, ...dirty])];
  } catch (e) {
    console.error(`--changed: git diff failed (${e.message}) — falling back to full pure tier`);
  }
  const entries = (manifest.pathMap ?? []).map((e) => ({ ...e, re: globRe(e.glob) }));
  const wanted = new Set();
  let unmatched = false;
  for (const f of files) {
    const hit = entries.find((e) => e.re.test(f));
    if (!hit) {
      unmatched = true;
      continue;
    }
    for (const r of hit.run) wanted.add(r === "self" ? `self:${f}` : r);
  }
  if (unmatched || files.length === 0) wanted.add("tier:pure"); // safety floor
  for (const w of wanted) {
    if (w.startsWith("tier:")) {
      const t = manifest.tiers[w.slice(5)];
      if (!t) console.warn(`--changed: pathMap names unknown tier "${w.slice(5)}" — skipped (does it land in a later phase?)`);
      else t.forEach(add);
    } else if (w.startsWith("group:")) {
      const g = manifest.groups[w.slice(6)];
      if (!g) console.warn(`--changed: pathMap names unknown group "${w.slice(6)}" — skipped`);
      else g.forEach(add);
    } else if (w.startsWith("self:")) {
      const f = w.slice(5);
      const base = path.basename(f);
      if (f.startsWith("scripts/verify-") || f.startsWith("scripts/figenh-")) {
        if (tierOf.has(base)) add(base);
      }
    }
  }
  console.log(`--changed: ${files.length} changed file(s) → ${set.length} script(s)`);
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
  // Children run THIS runner's runtime (process.execPath), never whatever `node`
  // happens to be first on PATH — the WS-0b version gate must cover the whole
  // tier. `--import tsx` replaces the npx→tsx wrapper chain (same loader, one
  // process, ~0.4s less overhead per script).
  const [cmd, cargs] = name.endsWith(".ts")
    ? [process.execPath, ["--import", "tsx", file]]
    : [process.execPath, [file]];
  const timeout = manifest.timeouts?.[name] ?? opt.timeout;
  return new Promise((resolve) => {
    const t0 = Date.now();
    // FLUX_NO_MIGRATE: tests spawn the real CLI/MCP, which run the FluxConfig
    // migration on startup — never against the developer's real HOME from a
    // verify run. (verify-fluxconfig.ts clears it inside its scratch-HOME sims.)
    const child = spawn(cmd, cargs, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, FLUX_NO_MIGRATE: "1" },
    });
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
      // WS-7.4: scripts on harness.mjs print `##VERIFY## {json}` — parse it so
      // summary.json carries check counts; exit code stays the source of truth.
      let sentinel = null;
      const m = out.match(/##VERIFY## (\{.*\})/g);
      if (m) {
        try {
          sentinel = JSON.parse(m[m.length - 1].slice("##VERIFY## ".length));
        } catch {}
      }
      resolve({ name, ms: Date.now() - t0, code: timedOut ? "timeout" : code, out, sentinel });
    });
  });
}

async function execWithRetry(name) {
  let r = await runScript(name);
  // Timing-gated scripts (frame budgets, perf medians) get ONE retry — a shared-server
  // suite run can spike them. A genuine regression fails twice.
  if (r.code !== 0 && manifest.retryOnce?.includes(name)) {
    r = await runScript(name);
    r.retried = true;
  }
  return r;
}

function report(r) {
  const secs = (r.ms / 1000).toFixed(1);
  const checks = r.sentinel ? ` [${r.sentinel.checks} checks]` : "";
  console.log(
    `${r.code === 0 ? "  ✓" : "  ✗"} ${r.name} (${secs}s)${checks}${r.retried ? " [retried]" : ""}${r.code === 0 ? "" : ` — exit ${r.code}`}`,
  );
  if (r.code !== 0) {
    const tail = r.out.trimEnd().split("\n").slice(-40).join("\n");
    console.log(`    ┄┄ output tail ┄┄\n${tail.replace(/^/gm, "    ")}\n`);
  }
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

console.log(`Running ${run.length} verify script(s)…${opt.jobs > 1 ? ` (--jobs ${opt.jobs}, pure tier only)` : ""}\n`);
const results = [];
// WS-7.6c: --jobs N parallelizes the PURE tier only (hermetic — own temp dirs,
// no shared server). ui/scale/bundle stay strictly sequential: they share :1420
// and frame-timing budgets.
const pooled = opt.jobs > 1 ? run.filter((n) => tierOf.get(n) === "pure") : [];
const serial = opt.jobs > 1 ? run.filter((n) => tierOf.get(n) !== "pure") : run;
if (pooled.length) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opt.jobs, pooled.length) }, async () => {
      while (next < pooled.length) {
        const name = pooled[next++];
        const r = await execWithRetry(name);
        results.push(r);
        report(r);
      }
    }),
  );
}
for (const name of serial) {
  process.stdout.write(`  … ${name}`);
  const r = await execWithRetry(name);
  results.push(r);
  process.stdout.write("\r");
  report(r);
}

const failed = results.filter((r) => r.code !== 0);
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${total}s`);
if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);

// WS-0b: every recorded run is attributable to a runtime. CI uploads this file.
try {
  mkdirSync(path.join(repoRoot, "test-results"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "test-results", "summary.json"),
    JSON.stringify(
      {
        startedAt: new Date(t0).toISOString(),
        node: process.versions.node,
        platform: process.platform,
        tiers: opt.tiers,
        groups: opt.groups,
        only: opt.only,
        passed: results.length - failed.length,
        total: results.length,
        totalMs: Date.now() - t0,
        results: results.map((r) => ({
          name: r.name,
          tier: tierOf.get(r.name) ?? null,
          code: r.code,
          ms: r.ms,
          ...(r.retried ? { retried: true } : {}),
          ...(r.sentinel ? { checks: r.sentinel.checks, failedChecks: r.sentinel.failed } : {}),
        })),
      },
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  console.warn(`(could not write test-results/summary.json: ${e})`);
}
process.exit(Math.min(failed.length, 100));
