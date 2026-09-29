// The Claude Code prompt hook through the BUILT launcher (plan §8.8 Delivery 2):
// `flux connect --hook-delta` runs on every prompt of every Claude Code session
// on the machine, so its quiet paths (a session that never connected; a
// connected session with nothing new) must stay within 80 ms p95 and never load
// the 6 MB core. A change prints one line, once. Bundle tier: needs npm run build:cli.
//   node scripts/run-verifies.mjs --tier bundle --only verify-connect-hook
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, appendFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";

const h = harness("verify-connect-hook");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repo, "dist", "flux-cli.mjs");
const HOOK = path.join(repo, "dist", "flux-connect-hook.mjs");
if (!existsSync(CLI) || !existsSync(HOOK)) {
  console.error("verify-connect-hook: dist/ is missing — run npm run build:cli first");
  process.exit(1);
}
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "verify-connect-hook-")));
const env = isolatedEnv(path.join(scratch, "machine"));
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_SANDBOX", "FLUX_PROJECT", "FLUX_CLIENT", "FLUX_HOOK_SESSION"]) delete env[k];
const run = (args, input, extra = {}) => {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...env, ...extra }, cwd: scratch });
  return { ...r, ms: performance.now() - t };
};
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
const key = "5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
const stdin = JSON.stringify({ session_id: key, cwd: scratch, hook_event_name: "UserPromptSubmit", prompt: "hello" });

try {
  // A bare node start is the floor every hook pays; the budget is on top of nothing else.
  const floor = p95(Array.from({ length: 10 }, () => { const t = performance.now(); spawnSync(process.execPath, ["-e", "0"]); return performance.now() - t; }));

  h.section("a session that never connected");
  const cold = Array.from({ length: 20 }, () => run(["connect", "--hook-delta"], JSON.stringify({ session_id: "never-connected-session" })));
  h.ok(cold.every((r) => r.status === 0 && r.stdout === "" && r.stderr === ""), "exit 0, no output");
  h.ok(p95(cold.map((r) => r.ms)) <= 80, `p95 ${p95(cold.map((r) => r.ms)).toFixed(0)} ms ≤ 80 ms (bare node p95 ${floor.toFixed(0)} ms)`);
  h.ok(run(["connect", "--hook-delta"], "").status === 0 && run(["connect", "--hook-delta"], "{not json").stdout === "", "empty or broken stdin: quiet");

  h.section("a connected session");
  const root = path.join(scratch, "proj");
  const made = run(["new", root, "--title", "Hooked"], "");
  h.eq(made.status, 0, "scaffold a project");
  const conn = run(["connect", root, "--no-render", "--json"], "", { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: key });
  h.ok(conn.status === 0 && JSON.parse(conn.stdout).packId, "connect from the session (vendor session id in env)");
  const warm = Array.from({ length: 20 }, () => run(["connect", "--hook-delta"], stdin));
  h.ok(warm.every((r) => r.status === 0 && r.stdout === ""), "nothing changed: quiet");
  h.ok(p95(warm.map((r) => r.ms)) <= 80, `p95 ${p95(warm.map((r) => r.ms)).toFixed(0)} ms ≤ 80 ms`);
  appendFileSync(path.join(root, "Context", "RULES.md"), "- A new rule.\n");
  const changed = run(["connect", "--hook-delta"], stdin);
  h.ok(changed.status === 0 && /^↻ Flux \(Hooked\) · Since you last looked \([^)]*\): Rules edited — details: `flux connect --refresh`\n$/.test(changed.stdout), `a change prints one line: ${changed.stdout.trim()}`);
  h.eq(run(["connect", "--hook-delta"], stdin).stdout, "", "…once");
} finally {
  await h.done(async () => rmSync(scratch, { recursive: true, force: true }));
}
