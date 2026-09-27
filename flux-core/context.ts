// flux-core/context.ts — the project Context layer, headless engine.
// ensureProjectContext heals Context/ into projects scaffolded before the
// Context layer (additive + existence-guarded; the GUI twin is
// src/lib/project/contextHeal.ts — both drive contextTemplates.ts).
// writeLog appends notebook Log entries under the manuscript lock.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  agentsStubTemplate,
  appendLogEntry,
  claudeStubTemplate,
  parseLog,
  type ContextHealResult,
  type LogEntry,
  contextScaffoldEntries,
  isRetiredAgentsGuide,
  logStamp,
  CONTEXT_PATHS,
} from "../src/lib/project/contextTemplates";
import { loadManifest, requireProject, safeJoin, exists, writeText } from "./model";
import { withLock } from "./locks";
import { CLIENT, journal } from "./journal";

import { detectAgentIdentity, describeIdentity, type AgentIdentity } from "./agentIdentity";

export { CONTEXT_PATHS, parseLog };
export type { LogEntry, ContextHealResult };

export async function ensureProjectContext(root: string, prepared?: { title: string }): Promise<ContextHealResult> {
  if (!(await exists(safeJoin(root, "project.json")))) return { created: [], skipped: "not-a-project" };
  const title = (prepared ? prepared.title : (await loadManifest(root)).title) || path.basename(root);
  const created: string[] = [];
  const { dirs, files } = contextScaffoldEntries(title);
  for (const d of dirs) {
    const p = safeJoin(root, d);
    if (!(await exists(p))) {
      await fs.mkdir(p, { recursive: true });
      created.push(d + "/");
    }
  }
  for (const [rel, body] of files) {
    const p = safeJoin(root, rel);
    if (!(await exists(p))) {
      await fs.writeFile(p, body, { flag: "wx" });
      created.push(rel);
    }
  }
  const agentsPath = safeJoin(root, "AGENTS.md");
  if (!(await exists(agentsPath))) {
    await fs.writeFile(agentsPath, agentsStubTemplate(), { flag: "wx" });
    created.push("AGENTS.md");
  } else {
    const cur = await fs.readFile(agentsPath, "utf8").catch(() => "");
    if (isRetiredAgentsGuide(cur)) {
      await fs.writeFile(agentsPath, agentsStubTemplate());
      created.push("AGENTS.md (retired guide → stub)");
    }
  }
  const claudePath = safeJoin(root, "CLAUDE.md");
  if (!(await exists(claudePath))) {
    await fs.writeFile(claudePath, claudeStubTemplate(), { flag: "wx" });
    created.push("CLAUDE.md");
  }
  if (created.length) await journal(root, { action: "ensure-context", detail: created.join(", ") });
  return { created };
}

export interface LogResult {
  rel: string;
  heading: string;
  createdSection: boolean;
}

/** MCP supplies its handshake identity and client cwd (null when unknown).
 *  CLI callers use environment detection and process.cwd(). */
export interface LogCaller {
  identity?: AgentIdentity;
  cwd?: string | null;
}

export interface WriteLogOptions extends LogCaller {
  text?: string;
  file?: string;
  title?: string;
  agent?: string;
  surface?: string;
  checkpoint?: boolean;
}

/** The entire read→append→write is under the manuscript lock, shared with
 *  Paper. Recovery must finish before that lease to avoid recursive locking. */
export async function writeLog(root: string, opts: WriteLogOptions = {}): Promise<LogResult> {
  await requireProject(root);
  let body = opts.text;
  if (!body?.trim() && opts.file) body = await fs.readFile(path.resolve(opts.file), "utf8");
  if (!body?.trim()) throw new Error("log needs text (positional or --text) or --file <path>");
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  const identity = opts.identity ?? detectAgentIdentity(process.env);
  // The model name the agent passes, plus the product Flux detected, so an
  // entry says both: "Claude Opus 5.5 (Claude Code) · CLI · host:cwd".
  const agent = oneLine(opts.agent ?? "");
  const detected = identity.product ?? (process.env.FLUX_CLIENT || null);
  const bylineIdentity = {
    ...identity,
    product: agent && detected && !agent.toLowerCase().includes(detected.toLowerCase()) ? `${agent} (${detected})` : agent || detected,
    surface: opts.surface?.trim() || identity.surface,
  };
  const cwd = opts.cwd === undefined ? (CLIENT === "mcp" ? null : process.cwd()) : opts.cwd;
  const location = os.hostname().split(".")[0] + (cwd ? `:${oneLine(cwd)}` : "");
  const byline = `*${oneLine(describeIdentity(bylineIdentity))} · ${location}*`;
  const title = oneLine(opts.title?.trim() || body.trim().slice(0, 60));
  const heading = `### ${logStamp()} — ${opts.checkpoint ? "Checkpoint: " : ""}${title}`;
  const entry = `${heading}\n\n${byline}\n\n${body.trim()}\n`;
  const rel = CONTEXT_PATHS.notebook;
  let createdSection = false;
  const manifest = await loadManifest(root);
  await withLock(root, "manuscript", CLIENT, async () => {
    await ensureProjectContext(root, { title: manifest.title });
    const p = safeJoin(root, rel);
    const doc = await fs.readFile(p, "utf8");
    const r = appendLogEntry(doc, entry);
    createdSection = r.createdSection;
    await writeText(p, r.text);
  });
  await journal(root, { action: "log", target: rel, heading });
  return { rel, heading, createdSection };
}

export interface ReadLogOptions {
  tail?: number;
  sinceCheckpoint?: boolean;
  titles?: boolean;
}

/** Read-only: a missing notebook is an empty Log, never a reason to scaffold. */
export async function readLog(root: string, opts: ReadLogOptions = {}): Promise<LogEntry[]> {
  await requireProject(root);
  if (opts.tail !== undefined && (!Number.isSafeInteger(opts.tail) || opts.tail < 0))
    throw new Error("read-log --tail must be a nonnegative integer");
  let doc: string;
  try { doc = await fs.readFile(safeJoin(root, CONTEXT_PATHS.notebook), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let entries = parseLog(doc);
  if (opts.sinceCheckpoint) {
    const at = entries.map(e => e.isCheckpoint).lastIndexOf(true);
    if (at >= 0) entries = entries.slice(at);
  }
  if (opts.tail !== undefined) entries = opts.tail === 0 ? [] : entries.slice(-opts.tail);
  return opts.titles ? entries.map(e => ({ ...e, body: "" })) : entries;
}
