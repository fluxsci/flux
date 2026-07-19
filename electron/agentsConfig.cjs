// electron/agentsConfig.cjs — the machine-level agent roster (<FluxConfig>/
// agents.json): which CLI is the principal, which are dispatchable workers.
// CJS shared by every surface (the fluxPaths idiom): Electron main requires it
// for the in-app principal drawer; flux-core/agents.ts wraps it for the
// `agent` / `agents` / `dispatch` / `attend` verbs. No require("electron") —
// must run under plain Node.
"use strict";
const path = require("node:path");
const fsSync = require("node:fs");

/** Documented in the stock FluxContext AGENTS-CONFIG.md (kept in sync). */
const DEFAULT_AGENTS = {
  _docs: "Agent roster. Format: <FluxConfig>/Context/FluxContext/AGENTS-CONFIG.md",
  principal: {
    command: [
      "claude",
      "--mcp-config",
      "{mcpJson}",
      "--allowedTools",
      "mcp__flux",
      "{prompt}",
    ],
  },
  // Non-interactive principal for `flux attend` review passes.
  principalPass: {
    command: [
      "claude",
      "-p",
      "{prompt}",
      "--permission-mode",
      "acceptEdits",
      "--mcp-config",
      "{mcpJson}",
      "--allowedTools",
      "mcp__flux",
    ],
  },
  workers: {
    analysis: {
      command: ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits"],
    },
    engineer: {
      command: ["codex", "exec", "--full-auto", "{prompt}"],
    },
  },
};

function agentsConfigPathSync(cfg) {
  return path.join(cfg, "agents.json");
}

/** Seed <cfg>/agents.json once (user-owned afterwards). Returns true if written. */
function seedAgentsConfigSync(cfg) {
  const p = agentsConfigPathSync(cfg);
  if (fsSync.existsSync(p)) return false;
  fsSync.mkdirSync(cfg, { recursive: true });
  const tmp = p + ".tmp-" + process.pid;
  fsSync.writeFileSync(tmp, JSON.stringify(DEFAULT_AGENTS, null, 2) + "\n");
  fsSync.renameSync(tmp, p);
  return true;
}

/** Parsed roster; falls back to defaults (with a warning field) on bad JSON. */
function readAgentsConfigSync(cfg) {
  const p = agentsConfigPathSync(cfg);
  try {
    const raw = JSON.parse(fsSync.readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    return {
      principal: raw.principal && Array.isArray(raw.principal.command) ? raw.principal : DEFAULT_AGENTS.principal,
      principalPass:
        raw.principalPass && Array.isArray(raw.principalPass.command)
          ? raw.principalPass
          : DEFAULT_AGENTS.principalPass,
      workers: raw.workers && typeof raw.workers === "object" ? raw.workers : DEFAULT_AGENTS.workers,
      path: p,
      warning: null,
    };
  } catch (e) {
    return {
      principal: DEFAULT_AGENTS.principal,
      principalPass: DEFAULT_AGENTS.principalPass,
      workers: DEFAULT_AGENTS.workers,
      path: p,
      warning: fsSync.existsSync(p) ? `agents.json unreadable (${(e && e.message) || e}) — using defaults` : null,
    };
  }
}

/** Does the project's parent dir look like an analysis workspace? */
function parentIsWorkspaceSync(projectRoot) {
  const parent = path.dirname(projectRoot);
  if (parent === projectRoot) return false;
  return ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".codex"].some((n) =>
    fsSync.existsSync(path.join(parent, n)),
  );
}

/**
 * Resolve one roster entry into a concrete launch spec.
 *   entry: { command: string[], cwd?: "project"|"parent"|<abs>, env?: {} }
 *   opts:  { prompt?, briefPath?, projectRoot, mcpSpec?, client }
 * Placeholders in argv: {prompt} {briefPath} {project} {mcpJson}. When neither
 * {prompt} nor {briefPath} appears and a prompt is given, it is appended as the
 * final argument. Args that resolve to an empty/unavailable placeholder are
 * dropped WITH their preceding flag (e.g. no mcpSpec → "--mcp-config" goes too).
 */
function resolveAgentSpec(entry, opts) {
  if (!entry || !Array.isArray(entry.command) || entry.command.length === 0) {
    throw new Error("agent entry has no command");
  }
  const projectRoot = path.resolve(opts.projectRoot);
  const mcpJson = opts.mcpSpec
    ? JSON.stringify({
        mcpServers: {
          flux: {
            command: opts.mcpSpec.command,
            args: opts.mcpSpec.args ?? [],
            ...(opts.mcpSpec.env ? { env: opts.mcpSpec.env } : {}),
          },
        },
      })
    : null;
  const values = {
    "{prompt}": typeof opts.prompt === "string" ? opts.prompt : null,
    "{briefPath}": typeof opts.briefPath === "string" ? opts.briefPath : null,
    "{project}": projectRoot,
    "{mcpJson}": mcpJson,
  };
  const src = entry.command.slice();
  const args = [];
  let usedPromptSlot = false;
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    if (Object.prototype.hasOwnProperty.call(values, a)) {
      if (a === "{prompt}" || a === "{briefPath}") usedPromptSlot = true;
      const v = values[a];
      if (v === null) {
        // unavailable placeholder: drop it, and the flag right before it
        if (args.length > 0 && args[args.length - 1].startsWith("-")) args.pop();
        continue;
      }
      args.push(v);
    } else {
      args.push(a);
    }
  }
  if (!usedPromptSlot && typeof opts.prompt === "string" && opts.prompt) args.push(opts.prompt);

  let cwd;
  if (entry.cwd === "project") cwd = projectRoot;
  else if (entry.cwd === "parent") cwd = path.dirname(projectRoot);
  else if (typeof entry.cwd === "string" && path.isAbsolute(entry.cwd)) cwd = entry.cwd;
  else cwd = parentIsWorkspaceSync(projectRoot) ? path.dirname(projectRoot) : projectRoot;

  const env = {
    ...(entry.env && typeof entry.env === "object" ? entry.env : {}),
    FLUX_PROJECT: projectRoot,
    FLUX_CLIENT: opts.client || "agent",
  };
  return { command: args[0], args: args.slice(1), cwd, env };
}

/** The standard principal boot prompt: everything else lives in the files. */
function principalBootPrompt(projectRoot) {
  return (
    "You are the Principal for the Flux project at " +
    projectRoot +
    ". Run `flux config` to locate the machine Context folder, then follow the boot " +
    "sequence in its FluxContext/PRINCIPAL.md (read UserContext, the project's " +
    "Context/, the journal tail, and open feedback/comments), and open with a standup."
  );
}

/** The attend-pass prompt: a non-interactive review pass over open feedback. */
function passPrompt(projectRoot) {
  return (
    "Review pass for the Flux project at " +
    projectRoot +
    ". You are the Principal. Follow FluxContext/PRINCIPAL.md (locate it via " +
    "`flux config`): boot, then drain ALL open feedback notes and comments — address " +
    "each in place, resolve each with a note, update the notebook session log. Do not " +
    "wait for user input; propose (don't perform) anything destructive."
  );
}

module.exports = {
  DEFAULT_AGENTS,
  agentsConfigPathSync,
  seedAgentsConfigSync,
  readAgentsConfigSync,
  parentIsWorkspaceSync,
  resolveAgentSpec,
  principalBootPrompt,
  passPrompt,
};
