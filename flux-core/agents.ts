// flux-core/agents.ts — the principal/worker runtime, headless engine.
// Thin TS wrapper over the shared CJS core (electron/agentsConfig.cjs — the
// fluxPaths idiom: one resolver for Electron main AND flux-core):
//   • `flux principal` (alias `agent`) — the launch picker + the user's
//     configured principal, run interactively IN THE USER'S TERMINAL inside a
//     PTY interposer that captures transcripts to Context/Transcripts/ (the
//     same rendered-buffer capture the in-app drawer does; works under any
//     terminal/multiplexer stack since we own the innermost PTY).
//   • `flux dispatch` — run a worker with a brief, recorded in Context/Dispatches/.
//     Worker model/effort resolve: flags → FLUX_WORKER_POLICY (the picker's
//     worker row, carried in the principal's env) → roster defaults; a
//     "principal-decides" policy REQUIRES the flags (the boot prompt tells the
//     principal the menu).
//   • `flux attend` — watch the feedback ledger; a send wakes a principal pass.
// Vendor-agnostic by construction: families/templates live in agents.json.

import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import * as fluxPathsMod from "../electron/fluxPaths.cjs";
import * as agentsConfigMod from "../electron/agentsConfig.cjs";
import { parseLedger, foldLedger, FEEDBACK_REL } from "../src/lib/project/feedback";
import { CONTEXT_PATHS } from "../src/lib/project/contextTemplates";
import {
  serializeTerminalBuffer,
  transcriptDoc,
  transcriptStamp,
} from "../src/lib/terminal/bufferText";
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

const requireRuntime = createRequire(import.meta.url);

export interface AgentSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface AgentSelection {
  family: string;
  model: string;
  effort: string;
}

export interface LaunchSelection {
  principal: AgentSelection;
  worker: AgentSelection;
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

function cliCmd(): string {
  return fluxPaths.resolveOwnCliCommandsSync().cli;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readRoster(): any {
  const cfg = fluxPaths.resolveFluxConfigPathSync();
  return agentsConfig.readAgentsConfigSync(cfg);
}

/** The standing selection: last-used picker choice → roster defaults. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function standingSelection(roster: any): LaunchSelection {
  return agentsConfig.standingSelectionSync(fluxPaths.resolveFluxConfigPathSync(), roster);
}

/** Resolve the interactive principal launch (boot prompt + worker policy env +
 *  MCP wiring + cwd rule). Legacy rosters use their fixed entries. */
export function principalSpec(root: string, sel?: LaunchSelection): AgentSpec {
  const roster = readRoster();
  const selection = sel ?? standingSelection(roster);
  const workerNote = agentsConfig.workerMenuNote(roster, selection.worker, cliCmd());
  const opts = {
    prompt: agentsConfig.principalBootPrompt(root, cliCmd(), workerNote),
    projectRoot: root,
    mcpSpec: mcpSpecForCli(root),
    client: "principal",
    extraEnv: { FLUX_WORKER_POLICY: agentsConfig.workerPolicyEnv(selection.worker) },
  };
  if (roster.legacy) return agentsConfig.resolveAgentSpec(roster.principal, opts);
  return agentsConfig.resolveFamilyLaunch(roster, "interactive", selection.principal, opts);
}

// ---------------------------------------------------------------------------
// The terminal picker (flux principal). Plain readline — works in any TTY
// (ghostty/zellij/tmux/ssh); Enter-through launches with the standing choice.
// ---------------------------------------------------------------------------

function fmtSel(s: AgentSelection): string {
  const me = (v: string) => (v === agentsConfig.DECIDES ? "principal decides" : v);
  return `${s.family} · ${me(s.model)} · ${me(s.effort)}`;
}

async function pickFrom(
  rl: readline.Interface,
  label: string,
  options: string[],
  current: string,
  extra?: { key: string; label: string },
): Promise<string> {
  const rows = options.map((o, i) => `  ${i + 1}. ${o}${o === current ? "  (current)" : ""}`);
  if (extra) rows.push(`  ${extra.key}. ${extra.label}${current === agentsConfig.DECIDES ? "  (current)" : ""}`);
  process.stdout.write(`${label}:\n${rows.join("\n")}\n`);
  const raw = (await rl.question(`  choose [Enter = keep current]: `)).trim();
  if (!raw) return current;
  if (extra && raw.toLowerCase() === extra.key) return agentsConfig.DECIDES;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  if (options.includes(raw)) return raw;
  process.stdout.write(`  (kept ${current})\n`);
  return current;
}

/** Interactive selection. Returns null when the user quits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pickSelection(roster: any, initial: LaunchSelection): Promise<LaunchSelection | null> {
  const sel: LaunchSelection = JSON.parse(JSON.stringify(initial));
  const families = Object.keys(roster.families ?? {});
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      process.stdout.write(
        `\nPrincipal:  ${fmtSel(sel.principal)}\nWorkers:    ${fmtSel(sel.worker)}\n` +
          `[Enter] launch · p principal · w workers · q quit\n`,
      );
      const c = (await rl.question("> ")).trim().toLowerCase();
      if (c === "" || c === "l") return sel;
      if (c === "q") return null;
      if (c === "p" || c === "w") {
        const row = c === "p" ? sel.principal : sel.worker;
        row.family = await pickFrom(rl, "  family", families, row.family);
        const fam = roster.families[row.family] ?? {};
        const decideOpt = c === "w" ? { key: "d", label: "principal decides" } : undefined;
        row.model = await pickFrom(rl, "  model", fam.models ?? [], row.model, decideOpt);
        row.effort = await pickFrom(rl, "  effort", fam.efforts ?? [], row.effort, decideOpt);
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// The PTY transcript interposer. We own the innermost pseudo-terminal: the
// child talks to our PTY; we mirror bytes to the REAL terminal unchanged and
// feed a headless xterm whose rendered buffer becomes the transcript (raw TUI
// streams are repaint noise; the rendered screen is what a human saw).
// ---------------------------------------------------------------------------

const TRANSCRIPT_FLUSH_MS = 30_000;

function loadPtyDeps(): { pty: any; Terminal: any } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pty: any = requireRuntime("@lydell/node-pty");
    const { Terminal } = requireRuntime("@xterm/headless");
    return { pty, Terminal };
  } catch {
    return null;
  }
}

async function runPtyWithTranscript(spec: AgentSpec, transcriptPath: string): Promise<number> {
  const deps = loadPtyDeps();
  if (!deps || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runInherit(spec); // graceful: no capture, plain passthrough
  }
  const { pty, Terminal } = deps;
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const term = new Terminal({ cols, rows, scrollback: 50_000, allowProposedApi: true });
  const startedAt = new Date().toISOString();
  let lastSig = "";
  const flush = async (force = false) => {
    try {
      const body = serializeTerminalBuffer(term);
      const sig = `${body.length}:${body.slice(-80)}`;
      if (!force && sig === lastSig) return;
      lastSig = sig;
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, transcriptDoc(startedAt, body));
    } catch {
      /* transcripts are best-effort */
    }
  };

  const child = pty.spawn(spec.command, spec.args, {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
  });

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  const onIn = (d: Buffer) => child.write(d.toString("utf8"));
  stdin.on("data", onIn);
  const onResize = () => {
    const c = process.stdout.columns || cols;
    const r = process.stdout.rows || rows;
    try {
      child.resize(c, r);
      term.resize(c, r);
    } catch {
      /* mid-exit races are fine */
    }
  };
  process.stdout.on("resize", onResize);
  child.onData((d: string) => {
    process.stdout.write(d);
    term.write(d);
  });
  const timer = setInterval(() => void flush(), TRANSCRIPT_FLUSH_MS);
  const onTerm = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.once("SIGTERM", onTerm);
  process.once("SIGHUP", onTerm);

  const exitCode: number = await new Promise((resolve) => {
    child.onExit(({ exitCode: code }: { exitCode: number }) => resolve(code ?? 0));
  });

  clearInterval(timer);
  process.stdout.off("resize", onResize);
  stdin.off("data", onIn);
  stdin.setRawMode?.(wasRaw ?? false);
  stdin.pause();
  process.off("SIGTERM", onTerm);
  process.off("SIGHUP", onTerm);
  // Let the terminal settle, then capture the final screen.
  await new Promise((r) => setTimeout(r, 50)); // annotated: xterm parses async; final bytes may lag one tick
  await flush(true);
  process.stdout.write(`\n[flux] transcript → ${transcriptPath}\n`);
  return exitCode;
}

function runInherit(spec: AgentSpec): Promise<number> {
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

export interface RunPrincipalOpts {
  family?: string;
  model?: string;
  effort?: string;
  workerFamily?: string;
  workerModel?: string;
  workerEffort?: string;
  noPicker?: boolean;
  noTranscript?: boolean;
}

/** `flux principal` — pick (or keep) the agents, then hand the terminal to the
 *  principal, capturing a transcript. Returns the exit code. */
export async function runPrincipal(root: string, opts: RunPrincipalOpts = {}): Promise<number> {
  await ensureProjectContext(root);
  const roster = readRoster();
  if (roster.warning) console.error(`[flux] ${roster.warning}`);
  let sel = standingSelection(roster);
  // CLI flag overrides (also imply --no-picker for the overridden rows).
  const hasFlags = !!(opts.family || opts.model || opts.effort || opts.workerFamily || opts.workerModel || opts.workerEffort);
  sel = {
    principal: {
      family: opts.family ?? sel.principal.family,
      model: opts.model ?? sel.principal.model,
      effort: opts.effort ?? sel.principal.effort,
    },
    worker: {
      family: opts.workerFamily ?? sel.worker.family,
      model: opts.workerModel ?? sel.worker.model,
      effort: opts.workerEffort ?? sel.worker.effort,
    },
  };
  if (!roster.legacy && !opts.noPicker && !hasFlags && process.stdin.isTTY && process.stdout.isTTY) {
    const picked = await pickSelection(roster, sel);
    if (!picked) return 0; // user quit the picker
    sel = picked;
  }
  const cfg = fluxPaths.resolveFluxConfigPathSync();
  agentsConfig.writeLastUsedSync(cfg, sel);

  const spec = principalSpec(root, sel);
  await journal(root, {
    action: "principal_launch",
    target: spec.command,
    detail: roster.legacy ? "legacy roster" : `${fmtSel(sel.principal)} | workers ${fmtSel(sel.worker)}`,
  });
  if (opts.noTranscript) return runInherit(spec);
  const transcriptPath = safeJoin(root, `${CONTEXT_PATHS.transcriptsDir}/${transcriptStamp()}.md`);
  return runPtyWithTranscript(spec, transcriptPath);
}

export interface DispatchResult {
  role: string;
  name: string;
  dir: string;
  briefPath: string;
  logPath: string;
  exitCode: number;
  ms: number;
  /** family/model/effort actually used ("legacy" for fixed-entry rosters). */
  agent: string;
  /** The tail of the worker's output — its report (workers put the report last). */
  report: string;
}

function dispatchStamp(): string {
  return transcriptStamp();
}

/** Resolve the worker launch for a dispatch: flags → FLUX_WORKER_POLICY (the
 *  picker's worker row) → roster defaults. "principal-decides" left standing
 *  means the caller MUST pass --model/--effort. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveWorkerSel(roster: any, opts: { family?: string; model?: string; effort?: string }): AgentSelection {
  const envPolicy = agentsConfig.parseWorkerPolicy(process.env.FLUX_WORKER_POLICY);
  const d = roster.defaults?.worker ?? {};
  const sel: AgentSelection = {
    family: opts.family ?? envPolicy?.family ?? d.family ?? "codex",
    model: opts.model ?? (envPolicy?.model !== agentsConfig.DECIDES ? envPolicy?.model : undefined) ?? d.model ?? agentsConfig.DECIDES,
    effort: opts.effort ?? (envPolicy?.effort !== agentsConfig.DECIDES ? envPolicy?.effort : undefined) ?? d.effort ?? agentsConfig.DECIDES,
  };
  const missing: string[] = [];
  if (sel.model === agentsConfig.DECIDES) missing.push("--model");
  if (sel.effort === agentsConfig.DECIDES) missing.push("--effort");
  if (missing.length) {
    const fam = roster.families?.[sel.family] ?? {};
    throw new Error(
      `worker ${missing.join(" + ")} unset and the policy is principal-decides — pass ${missing.join(" and ")} ` +
        `(family ${sel.family}: models ${(fam.models ?? []).join(", ") || "?"}; efforts ${(fam.efforts ?? []).join(", ") || "?"})`,
    );
  }
  return sel;
}

/** Run one worker with a brief; everything is recorded under
 *  Context/Dispatches/<stamp>-<name>/ (brief.md, log.txt, result.md). */
export async function dispatch(
  root: string,
  opts: {
    role: string;
    brief?: string;
    briefFile?: string;
    name?: string;
    echo?: boolean;
    family?: string;
    model?: string;
    effort?: string;
  },
): Promise<DispatchResult> {
  const roster = readRoster();
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

  let spec: AgentSpec;
  let agentDesc: string;
  const common = {
    prompt: briefText,
    briefPath,
    projectRoot: root,
    mcpSpec: mcpSpecForCli(root),
    client: "worker",
  };
  if (roster.legacy) {
    const worker = roster.workers?.[opts.role];
    if (!worker) {
      const roles = Object.keys(roster.workers ?? {}).join(", ") || "(none)";
      throw new Error(`no worker role "${opts.role}" in ${roster.path} — roles: ${roles}`);
    }
    spec = agentsConfig.resolveAgentSpec(worker, common);
    agentDesc = `legacy:${opts.role}`;
  } else {
    const sel = resolveWorkerSel(roster, opts);
    spec = agentsConfig.resolveFamilyLaunch(roster, "exec", sel, common);
    agentDesc = `${sel.family}/${sel.model}/${sel.effort}`;
  }
  await journal(root, { action: "dispatch", role: opts.role, target: dirRel, agent: agentDesc });

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
    `- agent: ${agentDesc}`,
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
  return { role: opts.role, name, dir: dirRel, briefPath, logPath, exitCode, ms, agent: agentDesc, report: tail };
}

// ---------------------------------------------------------------------------
// attend — the review-pass watcher (unchanged mechanics; pass resolution now
// rides roster.defaults.pass on new-schema rosters).
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
  const workerSel = standingSelection(roster).worker;
  const workerNote = agentsConfig.workerMenuNote(roster, workerSel, cliCmd());
  const common = {
    prompt: agentsConfig.passPrompt(root, cliCmd(), workerNote),
    projectRoot: root,
    mcpSpec: mcpSpecForCli(root),
    client: "principal",
    extraEnv: { FLUX_WORKER_POLICY: agentsConfig.workerPolicyEnv(workerSel) },
  };
  const spec: AgentSpec = roster.legacy
    ? agentsConfig.resolveAgentSpec(roster.principalPass ?? roster.principal, common)
    : agentsConfig.resolveFamilyLaunch(roster, "exec", roster.defaults?.pass ?? standingSelection(roster).principal, common);
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
