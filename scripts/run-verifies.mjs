#!/usr/bin/env node
// Aggregate verify runner — runs curated tiers of the scripts/verify-* suite.
//
//   node scripts/run-verifies.mjs --tier pure            # the `npm test` gate (hermetic)
//   node scripts/run-verifies.mjs --tier ui              # browser suite (spawns :1420 if absent)
//   node scripts/run-verifies.mjs --group paper-gate     # the paper editor regression suite
//   node scripts/run-verifies.mjs --tier pure,ui --only slide
//   node scripts/run-verifies.mjs --list
//
// Tiers/groups live in scripts/verify-manifest.json — new verify scripts must be
// added there to join the gate. Scripts run sequentially (they own ports, temp
// dirs, and the shared dev server). Exit code = number of failures.

import { executionSpec, executeAttempt, missingPrerequisites, isolatedEnv, discardTemporaryRoot } from "./lib/verifyRuntime.mjs";
import { TestProcessScope } from "./lib/testProcess.mjs";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeVersion } from "./lib/nodeCheck.mjs";
import { collectChangedRuns, resolveChangedRuns } from "./lib/changedVerifies.mjs";
import { sourceIdentity } from './lib/releasePolicy.mjs';
import os from 'node:os';

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
  for (const s of scripts) if (!tierOf.has(s)) tierOf.set(s, tier);

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
// run entries: "tier:<name>" | "group:<name>" | a registered script filename |
// "self" (a changed verify script runs itself).
if (opt.changed) {
  const { execSync } = await import("node:child_process");
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
  const selected = resolveChangedRuns(collectChangedRuns(files, manifest.pathMap), manifest);
  selected.scripts.forEach(add);
  selected.diagnostics.forEach((message) => console.warn(`--changed: ${message}`));
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

// ---------- execution contracts and unique evidence ----------
const APP_URL = process.env.FLUX_URL || "http://127.0.0.1:1420/";
const t0 = Date.now();
const sourceStart = await sourceIdentity(repoRoot);
const runDir = path.join(repoRoot, 'test-results', 'runs', `${new Date(t0).toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
mkdirSync(runDir, { recursive: true });
const specs = new Map(run.map(name => [name, executionSpec(manifest, name)]));
const serverScope = new TestProcessScope();
let serverProblem = null, serverTemporaryRoot = null;
const stop=new AbortController();let interruption=null;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interruption=signal;stop.abort(signal);void serverScope.dispose();});
async function serving() { try { return (await fetch(APP_URL, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }
async function ensureServer() {
  if (await serving()) return;
  const url = new URL(APP_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Refusing to start a non-loopback verification server');
  // Direct Vite avoids npm.cmd wrappers and honors the requested port.
  const serverEnv=isolatedEnv(path.join(runDir,'server'));serverTemporaryRoot=serverEnv.TMPDIR;
  const entry = serverScope.spawn(path.join(repoRoot, 'node_modules/vite/bin/vite.js'), ['--host', url.hostname, '--port', url.port || '1420', '--strictPort'], { cwd: repoRoot, env: serverEnv, nodeArgs: [], deadlineMs: 24 * 60 * 60 * 1000 });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !entry.exited) { if (await serving()) return; await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`server unavailable at ${APP_URL}: ${entry.spawnError || entry.stderr || 'startup deadline'}`);
}
if ([...specs.values()].some(s => s.prerequisites.includes('server'))) {
  try { await ensureServer(); } catch (e) { serverProblem = e.message; }
}
async function execWithRetry(name) {
  const spec = specs.get(name);
  const missing = await missingPrerequisites(spec, repoRoot);
  if (spec.prerequisites.includes('server') && serverProblem) missing.push(serverProblem);
  if (missing.length) return { name, status: 'blocked', code: 'blocked', ms: 0, attempts: [], reason: missing.join('; '), out: missing.join('; ') };
  const attempts = [];
  const attempt = () => executeAttempt({ spec, file: path.join(repoRoot, 'scripts', name), dir: path.join(runDir, name, `attempt-${attempts.length + 1}`), cwd: repoRoot, timeout: manifest.timeouts?.[name] ?? spec.timeoutMs ?? opt.timeout, signal:stop.signal, env:{...process.env,FLUX_VERIFY_SOURCE_DIGEST:sourceStart.digest,FLUX_VERIFY_COMMIT:sourceStart.commit} });
  attempts.push(await attempt());
  // Performance gates are never retried to select a luckier sample.
  if (!stop.signal.aborted && attempts[0].code !== 0 && !spec.exclusive && manifest.retryOnce?.includes(name)) attempts.push(await attempt());
  const last = attempts.at(-1);
  const status = attempts.length > 1 && last.code === 0 ? 'flaky' : last.status;
  return { ...last, name, status, code: status === 'flaky' ? 'flaky' : last.code, ms: attempts.reduce((sum,a) => sum+a.ms, 0), attempts };
}
function report(r) {
  console.log(`${r.status === 'passed' ? '  ✓' : '  ✗'} ${r.name}: ${r.status} (${(r.ms/1000).toFixed(1)}s)${r.attempts.length > 1 ? ` [${r.attempts.length} attempts retained]` : ''}`);
  if (r.status !== 'passed') console.log(r.out.trimEnd().split('\n').slice(-30).join('\n'));
}
const results = [];
try {
  console.log(`Running ${run.length} scripts; evidence ${runDir}`);
  const pooled = opt.jobs > 1 ? run.filter(n => !specs.get(n).exclusive) : [];
  const serial = opt.jobs > 1 ? run.filter(n => specs.get(n).exclusive) : run;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(opt.jobs, pooled.length) }, async () => {
    while (!stop.signal.aborted && next < pooled.length) { const result = await execWithRetry(pooled[next++]); results.push(result); report(result); }
  }));
  for (const name of serial) { if(stop.signal.aborted)break;const result = await execWithRetry(name); results.push(result); report(result); }
} finally { await serverScope.dispose();if(serverTemporaryRoot)discardTemporaryRoot(serverTemporaryRoot); }
if(interruption)for(const name of run)if(!results.some(result=>result.name===name))results.push({name,status:'interrupted',code:'interrupted',ms:0,attempts:[],reason:`Not started: ${interruption}`,out:''});
const failed = results.filter(r => r.status !== 'passed');
const sourceEnd = await sourceIdentity(repoRoot);
const sourceChanged = sourceStart.commit !== sourceEnd.commit || sourceStart.digest !== sourceEnd.digest || sourceStart.dirty !== sourceEnd.dirty;
const commit = sourceStart.commit;
const strip = ({ out, ...value }) => value;
const summary = { sourceStart, sourceEnd, sourceChanged, interrupted:interruption, startedAt: new Date(t0).toISOString(), commit, repoRoot, directory: runDir, node: process.versions.node, platform: process.platform, config: { host:{arch:process.arch,cpu:os.cpus()[0]?.model || null,cores:os.cpus().length,totalMemory:os.totalmem()}, privateDisplay:process.env.FLUX_PRIVATE_DISPLAY==='1'||!!process.env.FLUX_XVFB, runtimeEvidence:'Per-attempt artifacts/runtime-environment.json records observed browser viewport, screen, device scale, GPU and served application modules where the browser driver is used; absent files are not observations.', appUrl: APP_URL, chrome: process.env.FLUX_CHROME || null, display: process.env.DISPLAY || null, xvfb: process.env.FLUX_XVFB || null, electronNoSandbox: process.env.FLUX_ELECTRON_NO_SANDBOX === '1', displayQualification: 'software or physical display must be independently recorded; not inferred from environment' }, tiers: opt.tiers, groups: opt.groups, only: opt.only, passed: results.length-failed.length, total: results.length, totalMs: Date.now()-t0, results: results.map(r => ({ ...strip(r), tier: tierOf.get(r.name), execution: specs.get(r.name), attempts: r.attempts.map(strip) })) };
writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary,null,2)+'\n');
writeFileSync(path.join(repoRoot, 'test-results/summary.json'), JSON.stringify(summary,null,2)+'\n');
console.log(`\n${summary.passed}/${summary.total} passed; ${failed.length} failed/blocked/flaky. Evidence: ${runDir}`);
if (sourceChanged) console.error('Source changed during this cohort; per-script results are retained, but this run cannot qualify one exact source revision.');
process.exitCode = interruption ? (interruption==='SIGINT'?130:143) : Math.min(failed.length + (sourceChanged ? 1 : 0), 100);
