// electron/agentsConfig.cjs — the machine-level agent roster (<FluxConfig>/
// agents.json). CJS shared by every surface (the fluxPaths idiom): Electron
// main requires it for the in-app principal drawer; flux-core/agents.ts wraps
// it for the `principal` / `agents` / `dispatch` / `attend` verbs. No
// require("electron") — must run under plain Node.
//
// SCHEMA (2026-07-20, the launch-picker rework): the roster is a matrix, not
// fixed commands. `families` holds per-vendor command TEMPLATES (interactive +
// exec) with {model}/{effort} placeholders plus the picker's model/effort
// lists; `defaults` holds the standing selections (worker values may be
// "principal-decides" — the principal then picks per dispatch). The previous
// fixed-entry schema (principal/principalPass/workers argv arrays) is still
// resolved as a LEGACY roster so a hand-rolled config keeps working.
"use strict";
const path = require("node:path");
const fsSync = require("node:fs");

const DECIDES = "principal-decides";

/** Documented in the stock FluxContext AGENTS-CONFIG.md (kept in sync). */
const DEFAULT_AGENTS = {
  _docs: "Agent roster. Format: <FluxConfig>/Context/FluxContext/AGENTS-CONFIG.md",
  families: {
    codex: {
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      efforts: ["low", "medium", "high", "xhigh"],
      interactive: [
        "codex",
        "--model", "{model}",
        "-c", "model_reasoning_effort={effort}",
        "-c", "approval_policy=on-request",
        "-c", "approvals_reviewer=auto_review",
        "-c", "sandbox_mode=workspace-write",
        "{prompt}",
      ],
      exec: [
        "codex", "exec", "--skip-git-repo-check",
        "--model", "{model}",
        "-c", "model_reasoning_effort={effort}",
        "-c", "approval_policy=on-request",
        "-c", "approvals_reviewer=auto_review",
        "-c", "sandbox_mode=workspace-write",
        "{prompt}",
      ],
    },
    claude: {
      models: ["fable", "opus", "sonnet"],
      // Claude Code ≥2.1.227 takes --effort per launch; "default" drops the
      // --effort pair (the standard drop-arg rule) and leaves the session default.
      efforts: ["default", "low", "medium", "high", "xhigh", "max"],
      // {prompt} MUST lead (right after "claude"): Claude Code's `--allowedTools
      // <tools...>` is a VARIADIC option, so a prompt placed AFTER it is greedily
      // swallowed as another tool value — the session then launches with no boot
      // prompt (a blank Claude Code session). Keep the prompt in front of every
      // variadic option. (exec is already safe — its {prompt} rides -p up front.)
      interactive: [
        "claude", "{prompt}",
        "--model", "{model}",
        "--effort", "{effort}",
        "--mcp-config", "{mcpJson}",
        "--allowedTools", "mcp__flux",
      ],
      exec: [
        "claude", "-p", "{prompt}",
        "--model", "{model}",
        "--effort", "{effort}",
        "--permission-mode", "acceptEdits",
        "--mcp-config", "{mcpJson}",
        "--allowedTools", "mcp__flux",
      ],
    },
  },
  defaults: {
    principal: { family: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    worker: { family: "codex", model: DECIDES, effort: DECIDES },
    pass: { family: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
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

/** Parsed roster. New-schema files return {legacy:false, families, defaults};
 *  old fixed-command files return {legacy:true, principal, principalPass,
 *  workers}. Corrupt files fall back to defaults with a warning — never throw. */
function readAgentsConfigSync(cfg) {
  const p = agentsConfigPathSync(cfg);
  try {
    const raw = JSON.parse(fsSync.readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    if (raw.families && typeof raw.families === "object") {
      return {
        legacy: false,
        families: raw.families,
        defaults: { ...DEFAULT_AGENTS.defaults, ...(raw.defaults || {}) },
        path: p,
        warning: null,
      };
    }
    if (raw.principal && Array.isArray(raw.principal.command)) {
      return {
        legacy: true,
        principal: raw.principal,
        principalPass:
          raw.principalPass && Array.isArray(raw.principalPass.command) ? raw.principalPass : raw.principal,
        workers: raw.workers && typeof raw.workers === "object" ? raw.workers : {},
        path: p,
        warning: null,
      };
    }
    throw new Error("neither families nor a principal command");
  } catch (e) {
    return {
      legacy: false,
      families: DEFAULT_AGENTS.families,
      defaults: DEFAULT_AGENTS.defaults,
      path: p,
      warning: fsSync.existsSync(p) ? `agents.json unreadable (${(e && e.message) || e}) — using defaults` : null,
    };
  }
}

// --- last-used picker selection (machine-level, operational — a dotfile so
// --- agents.json itself stays purely the user's config) ----------------------

function lastUsedPathSync(cfg) {
  return path.join(cfg, ".agents-last.json");
}

function readLastUsedSync(cfg) {
  try {
    const v = JSON.parse(fsSync.readFileSync(lastUsedPathSync(cfg), "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function writeLastUsedSync(cfg, sel) {
  try {
    const p = lastUsedPathSync(cfg);
    const tmp = p + ".tmp-" + process.pid;
    fsSync.writeFileSync(tmp, JSON.stringify({ ...sel, ts: new Date().toISOString() }, null, 2) + "\n");
    fsSync.renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

/** The standing selection: last-used picker choice → roster defaults. */
function standingSelectionSync(cfg, roster) {
  const last = readLastUsedSync(cfg);
  const d = roster.defaults || {};
  const norm = (sel, dflt) => ({
    family: (sel && sel.family) || (dflt && dflt.family) || "codex",
    model: (sel && sel.model) || (dflt && dflt.model) || DECIDES,
    effort: (sel && sel.effort) || (dflt && dflt.effort) || DECIDES,
  });
  return {
    principal: norm(last && last.principal, d.principal),
    worker: norm(last && last.worker, d.worker),
  };
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
 * Resolve one FIXED entry (legacy schema) into a concrete launch spec.
 *   entry: { command: string[], cwd?: "project"|"parent"|<abs>, env?: {} }
 *   opts:  { prompt?, briefPath?, projectRoot, mcpSpec?, client, extraEnv? }
 * Whole-arg placeholders: {prompt} {briefPath} {project} {mcpJson}. When neither
 * {prompt} nor {briefPath} appears and a prompt is given, it is appended as the
 * final argument. Args resolving to an unavailable placeholder are dropped WITH
 * their preceding flag (e.g. no mcpSpec → "--mcp-config" goes too).
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
    ...(opts.extraEnv && typeof opts.extraEnv === "object" ? opts.extraEnv : {}),
    FLUX_PROJECT: projectRoot,
    FLUX_CLIENT: opts.client || "agent",
  };
  return { command: args[0], args: args.slice(1), cwd, env };
}

/**
 * Resolve a FAMILY template (new schema) into a launch spec.
 *   roster: readAgentsConfigSync result (legacy:false)
 *   kind:   "interactive" | "exec"
 *   sel:    { family, model, effort } — model/effort of "default"/DECIDES/empty
 *           drop their {…}-bearing args (with the preceding flag).
 *   opts:   as resolveAgentSpec.
 * {model}/{effort} substitute as SUBSTRINGS (e.g. "reasoning={effort}").
 */
function resolveFamilyLaunch(roster, kind, sel, opts) {
  const families = roster.families || {};
  const fam = families[sel && sel.family];
  if (!fam) {
    const names = Object.keys(families).join(", ") || "(none)";
    throw new Error(`no agent family "${sel && sel.family}" in ${roster.path || "agents.json"} — families: ${names}`);
  }
  const template = fam[kind];
  if (!Array.isArray(template) || template.length === 0) {
    throw new Error(`family "${sel.family}" has no "${kind}" command template`);
  }
  const usable = (v) => typeof v === "string" && v && v !== "default" && v !== DECIDES;
  const subs = { "{model}": sel.model, "{effort}": sel.effort };
  const command = [];
  for (const a of template) {
    const holes = Object.keys(subs).filter((k) => a.includes(k));
    if (holes.length) {
      if (holes.some((k) => !usable(subs[k]))) {
        if (command.length > 0 && command[command.length - 1].startsWith("-")) command.pop();
        continue;
      }
      let out = a;
      for (const k of holes) out = out.split(k).join(subs[k]);
      command.push(out);
    } else {
      command.push(a);
    }
  }
  return resolveAgentSpec({ command, cwd: fam.cwd, env: fam.env }, opts);
}

// --- worker policy (the picker's worker row, carried to dispatch) ------------

/** Serialize the worker selection for the principal's environment. */
function workerPolicyEnv(sel) {
  return JSON.stringify({
    family: sel.family,
    model: sel.model || DECIDES,
    effort: sel.effort || DECIDES,
  });
}

function parseWorkerPolicy(raw) {
  try {
    const v = JSON.parse(raw ?? "");
    return v && typeof v === "object" && v.family ? v : null;
  } catch {
    return null;
  }
}

/** The boot-prompt note telling the principal how to dispatch under `sel`. */
function workerMenuNote(roster, sel, cli) {
  if (roster.legacy) {
    return `Dispatch workers with \`${cli} dispatch <name> --brief-file <f>\` (fixed worker roles from agents.json).`;
  }
  const fam = (roster.families || {})[sel.family] || {};
  const models = (fam.models || []).join(", ") || "(see agents.json)";
  const efforts = (fam.efforts || []).join(", ") || "(see agents.json)";
  const decides = sel.model === DECIDES || sel.effort === DECIDES;
  if (decides) {
    return (
      `Dispatch workers with \`${cli} dispatch <name> --model <m> --effort <e> --brief-file <f>\`. ` +
      `YOU choose each worker's model+effort per task (family ${sel.family} — models: ${models}; efforts: ${efforts}). ` +
      `Match effort to difficulty: mechanical/well-specified work low/medium; substantial analysis or tricky code high/${(fam.efforts || []).slice(-1)[0] || "xhigh"}.`
    );
  }
  return `Dispatch workers with \`${cli} dispatch <name> --brief-file <f>\` (worker fixed: ${sel.family}/${sel.model}/${sel.effort}; override with --model/--effort only when a task clearly needs it).`;
}

/** The standard principal boot prompt. `cli` = this machine's resolved flux
 *  invocation; `workerNote` (workerMenuNote) tells it how to dispatch. */
function principalBootPrompt(projectRoot, cli, workerNote) {
  const flux = cli || "flux";
  return (
    "You are the Principal for the Flux project at " +
    projectRoot +
    ". The flux CLI on this machine is: " +
    flux +
    " — run `" +
    flux +
    " config` to locate the machine Context folder, then follow the boot " +
    "sequence in its FluxContext/PRINCIPAL.md (read UserContext, the project's " +
    "Context/, the journal tail, and open feedback/comments), and open with a standup." +
    (workerNote ? " " + workerNote : "")
  );
}

/** The attend-pass prompt: a non-interactive review pass over open feedback. */
function passPrompt(projectRoot, cli, workerNote) {
  const flux = cli || "flux";
  return (
    "Review pass for the Flux project at " +
    projectRoot +
    ". You are the Principal. The flux CLI on this machine is: " +
    flux +
    " — follow FluxContext/PRINCIPAL.md (locate it via `" +
    flux +
    " config`): boot, then drain ALL open feedback notes and comments — address " +
    "each in place, resolve each with a note, update the notebook session log. Do not " +
    "wait for user input; propose (don't perform) anything destructive." +
    (workerNote ? " " + workerNote : "")
  );
}

module.exports = {
  DECIDES,
  DEFAULT_AGENTS,
  agentsConfigPathSync,
  seedAgentsConfigSync,
  readAgentsConfigSync,
  readLastUsedSync,
  writeLastUsedSync,
  standingSelectionSync,
  parentIsWorkspaceSync,
  resolveAgentSpec,
  resolveFamilyLaunch,
  workerPolicyEnv,
  parseWorkerPolicy,
  workerMenuNote,
  principalBootPrompt,
  passPrompt,
};
