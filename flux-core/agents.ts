// flux-core/agents.ts — the principal/worker runtime, headless engine.
// Thin TS wrapper over the shared CJS core (electron/agentsConfig.cjs — the
// fluxPaths idiom: one resolver for Electron main AND flux-core):
//   • `flux agent`    — launch the user's configured principal interactively
//   • `flux dispatch` — run a worker with a brief, recorded in Context/Dispatches/
//   • `flux attend`   — watch the feedback ledger; a send wakes a principal pass
// Workers/passes are spawned processes of the CONFIGURED CLIs (agents.json) —
// vendor-agnostic by construction.

import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as fluxPathsMod from "../electron/fluxPaths.cjs";
import * as agentsConfigMod from "../electron/agentsConfig.cjs";
import { parseLedger, foldLedger, FEEDBACK_REL } from "../src/lib/project/feedback";
import { CONTEXT_PATHS } from "../src/lib/project/contextTemplates";
import { ensureProjectContext } from "./context";
import { journal } from "./journal";
import { safeJoin } from "./model";
import { slugify } from "../src/lib/project/types";

// CJS interop guard (tsx/esbuild sometimes surface module.exports on .default).
/* eslint-disable @typescript-eslint/no-explicit-any */
const fluxPaths: any = (fluxPathsMod as any).resolveFluxConfigPathSync
  ? fluxPathsMod
  : (fluxPathsMod as any).default;
const agentsConfig: any = (agentsConfigMod as any).resolveAgentSpec
  ? agentsConfigMod
  : (agentsConfigMod as any).default;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface AgentSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** The flux MCP server spec for a headless-launched agent (mirrors
 *  agent.cjs mcpSpecFor, resolved from THIS install). */
function mcpSpecForCli(projectRoot: string): { command: string; args: string[]; env?: Record<string, string> } | null {
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const dist = path.join(appRoot, "dist", "flux-mcp.mjs");
  if (fsSync.existsSync(dist)) return { command: "node", args: [dist, projectRoot] };
  const tsxBin = path.join(appRoot, "node_modules", ".bin", "tsx");
  const entry = path.join(appRoot, "flux-mcp.ts");
  if (fsSync.existsSync(tsxBin) && fsSync.existsSync(entry)) {
    return { command: tsxBin, args: [entry, projectRoot] };
  }
  return null;
}

export function readRoster(): {
  principal: unknown;
  principalPass?: unknown;
  workers: Record<string, unknown>;
  path: string;
  warning: string | null;
} {
  const cfg = fluxPaths.resolveFluxConfigPathSync();
  return agentsConfig.readAgentsConfigSync(cfg);
}

/** Resolve the interactive principal launch for a project (the `flux agent`
 *  and drawer contract — boot prompt + MCP wiring + cwd rule). */
export function principalSpec(root: string): AgentSpec {
  const roster = readRoster();
  return agentsConfig.resolveAgentSpec(roster.principal, {
    prompt: agentsConfig.principalBootPrompt(root),
    projectRoot: root,
    mcpSpec: mcpSpecForCli(root),
    client: "principal",
  });
}

/** `flux agent` — hand the terminal to the principal (stdio inherit). */
export async function runPrincipal(root: string): Promise<number> {
  await ensureProjectContext(root);
  const spec = principalSpec(root);
  await journal(root, { action: "principal_launch", target: spec.command });
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export interface DispatchResult {
  role: string;
  name: string;
  dir: string;
  briefPath: string;
  logPath: string;
  exitCode: number;
  ms: number;
  /** The tail of the worker's output — its report (workers put the report last). */
  report: string;
}

function dispatchStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Run one worker with a brief; everything is recorded under
 *  Context/Dispatches/<stamp>-<name>/ (brief.md, log.txt, result.md). */
export async function dispatch(
  root: string,
  opts: { role: string; brief?: string; briefFile?: string; name?: string; echo?: boolean },
): Promise<DispatchResult> {
  const roster = readRoster();
  const worker = roster.workers?.[opts.role];
  if (!worker) {
    const roles = Object.keys(roster.workers ?? {}).join(", ") || "(none)";
    throw new Error(`no worker role "${opts.role}" in ${roster.path} — roles: ${roles}`);
  }
  let briefText = opts.brief;
  if (!briefText && opts.briefFile) briefText = await fs.readFile(path.resolve(opts.briefFile), "utf8");
  if (!briefText?.trim()) throw new Error("dispatch needs --brief <text> or --brief-file <path>");

  await ensureProjectContext(root);
  const name = slugify(opts.name || opts.role);
  const dirRel = `${CONTEXT_PATHS.dispatchesDir}/${dispatchStamp()}-${name}`;
  const dir = safeJoin(root, dirRel);
  await fs.mkdir(dir, { recursive: true });
  const briefPath = path.join(dir, "brief.md");
  const logPath = path.join(dir, "log.txt");
  await fs.writeFile(briefPath, briefText);

  const spec: AgentSpec = agentsConfig.resolveAgentSpec(worker, {
    prompt: briefText,
    briefPath,
    projectRoot: root,
    mcpSpec: mcpSpecForCli(root),
    client: "worker",
  });
  await journal(root, { action: "dispatch", role: opts.role, target: dirRel });

  const t0 = Date.now();
  const log = fsSync.createWriteStream(logPath);
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b: Buffer) => {
      log.write(b);
      if (opts.echo) process.stdout.write(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      log.write(b);
      if (opts.echo) process.stderr.write(b);
    });
    child.on("error", (e) => {
      log.end();
      reject(new Error(`could not spawn ${spec.command}: ${e.message}`));
    });
    child.on("close", (code) => {
      log.end();
      resolve(code ?? 0);
    });
  });
  const ms = Date.now() - t0;
  const out = await fs.readFile(logPath, "utf8").catch(() => "");
  const tail = out.split("\n").slice(-100).join("\n").trim();
  const result = [
    `# Dispatch result — ${name}`,
    "",
    `- role: ${opts.role}`,
    `- command: ${spec.command}`,
    `- cwd: ${spec.cwd}`,
    `- exit: ${exitCode}`,
    `- duration: ${(ms / 1000).toFixed(1)}s`,
    "",
    "## Report (output tail)",
    "",
    "```text",
    tail,
    "```",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "result.md"), result);
  await journal(root, { action: "dispatch_done", role: opts.role, target: dirRel, exit: exitCode });
  return { role: opts.role, name, dir: dirRel, briefPath, logPath, exitCode, ms, report: tail };
}

// ---------------------------------------------------------------------------
// attend — the review-pass watcher. Polls the feedback ledger (single-file
// mtime, dependency-free); a NEW send event with open notes wakes one
// non-interactive principal pass (roster.principalPass). State survives
// restarts via .meta/agent/attend-state.json; passes are serialized and logged
// under .meta/agent/passes/.
// ---------------------------------------------------------------------------

interface AttendState {
  processedSendId: string | null;
}

async function readAttendState(root: string): Promise<AttendState> {
  try {
    return JSON.parse(await fs.readFile(safeJoin(root, ".meta/agent/attend-state.json"), "utf8"));
  } catch {
    return { processedSendId: null };
  }
}

async function writeAttendState(root: string, st: AttendState): Promise<void> {
  const p = safeJoin(root, ".meta/agent/attend-state.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(st, null, 2) + "\n");
}

async function writeStatus(root: string, state: string, detail?: string): Promise<void> {
  const p = safeJoin(root, ".meta/agent/status.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ state, detail: detail ?? null, at: new Date().toISOString(), pid: process.pid }, null, 2) + "\n");
}

/** One pass: spawn the configured non-interactive principal over the open
 *  feedback. Returns the exit code (also logged + journaled). */
export async function runPass(root: string, opts: { echo?: boolean } = {}): Promise<number> {
  const roster = readRoster();
  const entry = roster.principalPass ?? roster.principal;
  const spec: AgentSpec = agentsConfig.resolveAgentSpec(entry, {
    prompt: agentsConfig.passPrompt(root),
    projectRoot: root,
    mcpSpec: mcpSpecForCli(root),
    client: "principal",
  });
  const passDir = safeJoin(root, ".meta/agent/passes");
  await fs.mkdir(passDir, { recursive: true });
  const logPath = path.join(passDir, `${dispatchStamp()}.log`);
  await journal(root, { action: "attend_pass_start" });
  const log = fsSync.createWriteStream(logPath);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b: Buffer) => {
      log.write(b);
      if (opts.echo) process.stdout.write(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      log.write(b);
      if (opts.echo) process.stderr.write(b);
    });
    child.on("error", (e) => {
      log.write(`\n[attend] spawn failed: ${e.message}\n`);
      log.end();
      resolve(127);
    });
    child.on("close", (c) => {
      log.end();
      resolve(c ?? 0);
    });
  });
  await journal(root, { action: "attend_pass_done", exit: code });
  return code;
}

/** The attend loop. Blocks forever (Ctrl+C to stop); `onEvent` lets the CLI
 *  narrate. Only sends NEWER than the persisted state trigger (a send fired
 *  while nobody was attending is picked up on the next start). */
export async function attend(
  root: string,
  opts: { intervalMs?: number; echo?: boolean; onEvent?: (msg: string) => void } = {},
): Promise<never> {
  const interval = Math.max(500, opts.intervalMs ?? 1500);
  const say = opts.onEvent ?? (() => {});
  const ledger = safeJoin(root, FEEDBACK_REL);
  await ensureProjectContext(root);
  let state = await readAttendState(root);
  let lastMtime = 0;
  await writeStatus(root, "idle", "attending");
  say(`attending ${root} (ledger: ${FEEDBACK_REL}, every ${interval}ms — Ctrl+C to stop)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, interval));
    let mtime = 0;
    try {
      mtime = fsSync.statSync(ledger).mtimeMs;
    } catch {
      continue; // no ledger yet
    }
    if (mtime === lastMtime) continue;
    lastMtime = mtime;
    const st = foldLedger(parseLedger(fsSync.readFileSync(ledger, "utf8")));
    const send = st.lastSend;
    if (!send || send.id === state.processedSendId) continue;
    if (st.sent.length === 0 && st.open.length === 0) {
      // A bare send with nothing open — acknowledge it, nothing to do.
      state = { processedSendId: send.id };
      await writeAttendState(root, state);
      continue;
    }
    say(`send ${send.id}: ${st.sent.length || st.open.length} note(s) → principal pass`);
    await writeStatus(root, "working", `${st.sent.length || st.open.length} notes`);
    const code = await runPass(root, { echo: opts.echo });
    state = { processedSendId: send.id };
    await writeAttendState(root, state);
    await writeStatus(root, "done", `pass exit ${code}`);
    say(`pass finished (exit ${code}) — back to watching`);
  }
}
