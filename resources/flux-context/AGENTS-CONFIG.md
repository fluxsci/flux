# agents.json — the agent roster (stock — shipped with Flux, do not edit)

`<FluxConfig>/agents.json` describes the agent CLIs on this machine as a **matrix**:
per-vendor command **templates** (`families`) plus the standing **defaults** for the
principal, workers, and attend passes. The launch pickers (`flux principal` in a
terminal) read this matrix; a session's choices are remembered
in `.agents-last.json` beside it. Swapping vendors or models is a picker choice, not a
config edit.

## Format

```json
{
  "families": {
    "codex": {
      "models": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      "efforts": ["low", "medium", "high", "xhigh"],
      "interactive": ["codex", "--model", "{model}",
                      "-c", "model_reasoning_effort={effort}",
                      "-c", "approval_policy=on-request",
                      "-c", "approvals_reviewer=auto_review",
                      "-c", "sandbox_mode=workspace-write",
                      "{prompt}"],
      "exec": ["codex", "exec", "--skip-git-repo-check", "--model", "{model}",
               "-c", "model_reasoning_effort={effort}",
               "-c", "approval_policy=on-request",
               "-c", "approvals_reviewer=auto_review",
               "-c", "sandbox_mode=workspace-write",
               "{prompt}"]
    },
    "claude": {
      "models": ["fable", "opus", "sonnet"],
      "efforts": ["default", "low", "medium", "high", "xhigh", "max"],
      "interactive": ["claude", "{prompt}", "--model", "{model}",
                      "--effort", "{effort}",
                      "--mcp-config", "{mcpJson}", "--allowedTools", "mcp__flux"],
      "exec": ["claude", "-p", "{prompt}", "--model", "{model}",
               "--effort", "{effort}",
               "--permission-mode", "acceptEdits",
               "--mcp-config", "{mcpJson}", "--allowedTools", "mcp__flux"]
    }
  },
  "defaults": {
    "principal": { "family": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "worker":    { "family": "codex", "model": "principal-decides", "effort": "principal-decides" },
    "pass":      { "family": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" }
  }
}
```

## Families

- **`interactive`** — the argv for a live session (`flux principal`).
- **`exec`** — the argv for headless runs (dispatched workers, attend passes). Codex
  needs `--skip-git-repo-check` here (it refuses untrusted non-git dirs headlessly).
- **`models` / `efforts`** — the picker menus (typing an unlisted value still works;
  the lists are UI, not validation).
- Optional per-family `cwd` (`"project"` | `"parent"` | absolute) and `env`.

**Placeholders** — substituted at launch:

| Placeholder | Meaning |
|---|---|
| `{model}`, `{effort}` | the picked values — substituted as SUBSTRINGS (`reasoning={effort}` works); a value of `default`/`principal-decides` drops the arg AND its preceding flag |
| `{prompt}` | the boot prompt / brief text (appended as final arg when absent) |
| `{briefPath}` | absolute path to the brief file |
| `{project}` | the Flux project root |
| `{mcpJson}` | the flux MCP server spec as JSON (for `claude --mcp-config`); unavailable → dropped with its flag |

`FLUX_PROJECT` and `FLUX_CLIENT` (`principal`/`worker`) are always set on the child.

> **Ordering trap — put `{prompt}` before any variadic option.** Claude Code's
> `--allowedTools <tools...>` is *variadic*: it greedily consumes every following
> argument until the next flag. A `{prompt}` placed after it is swallowed as a
> tool value and the session launches with no prompt (a blank Claude Code
> window). Lead the `interactive` template with `{prompt}` (right after the
> binary), or keep the prompt ahead of the variadic flag. `exec` is already safe
> because its `{prompt}` rides `-p` up front.
**MCP for Codex** wires globally instead: `~/.codex/config.toml` with NO root argument —
the server resolves the project from `FLUX_PROJECT`:

```toml
[mcp_servers.flux]
command = "node"
args = ["{{FLUX_MCP_PATH}}"]
```

## Defaults + the worker policy

- **`principal`** — the interactive session's standing choice (pickers pre-fill it;
  last-used overrides it).
- **`worker`** — the standing dispatch policy. `"principal-decides"` for model/effort
  means each `flux dispatch` must pass `--model`/`--effort` — the principal picks per
  task (its boot prompt carries the menu + guidance). Fixed values make dispatch use
  them automatically. Either way the choice is carried in `FLUX_WORKER_POLICY` on the
  principal's environment and recorded in each dispatch's `result.md`.
- **`pass`** — the non-interactive principal `flux attend` runs on Send (uses the
  family's `exec` template; keep it a flagship model — it's the principal, unattended).

## Legacy form

A roster with fixed argv entries (`principal.command`, `workers.<role>.command`) still
resolves — the pickers deactivate and dispatch selects by role name. New machines seed
the family schema above.

`approvals_reviewer = "auto_review"` (Codex) makes its reviewer adjudicate permission
requests in-session — interactive sessions escalate to the human only when it can't
decide; headless runs auto-decide or fail the action safely.
