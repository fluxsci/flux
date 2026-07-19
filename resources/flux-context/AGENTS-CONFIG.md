# agents.json — the agent roster (stock — shipped with Flux, do not edit)

`<FluxConfig>/agents.json` names the agent CLIs on this machine: which command is the
**principal** (the user's standing collaborator, launched in the app's Agent drawer or via
`flux agent`) and which are **workers** (dispatched by the principal via
`flux dispatch <role> --brief <file>`). Swapping models/vendors = editing this one file.

## Format

```json
{
  "principal": {
    "command": ["claude", "--mcp-config", "{mcpJson}", "--allowedTools", "mcp__flux", "{prompt}"],
    "cwd": "parent"
  },
  "principalPass": {
    "command": ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits"]
  },
  "workers": {
    "analysis": { "command": ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits"] },
    "engineer": { "command": ["codex", "exec", "--full-auto", "{prompt}"] }
  }
}
```

- **`principal`** — the interactive session (the app's Agent drawer, `flux agent`).
- **`principalPass`** — the NON-interactive principal `flux attend` runs when the user
  hits Send (defaults to the principal when omitted — but an interactive command would
  hang there, so keep a `-p`/`exec`-style entry).
- **`workers.<role>`** — dispatch targets (`flux dispatch <role> --brief-file <f>`).

- **`command`** — argv array. Placeholders substituted at launch:
  - `{prompt}` — the launch prompt / brief text, inline.
  - `{briefPath}` — absolute path to the brief file (for CLIs that read a file).
  - `{project}` — the Flux project root.
  - `{mcpJson}` — the flux MCP server spec as JSON (for `claude --mcp-config`). When
    unavailable, the placeholder AND the flag before it are dropped.
  If neither `{prompt}` nor `{briefPath}` appears, the prompt is appended as the final
  argument.
- **`cwd`** — `"project"` (the Flux project root), `"parent"` (its parent directory — the
  analysis workspace), or an absolute path. Default: `"parent"` when the parent looks like
  an analysis workspace (contains `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, or `.codex/`),
  else `"project"`.
- **`env`** — optional extra environment variables. `FLUX_PROJECT` and `FLUX_CLIENT`
  (`principal` / `worker`) are always set for you.
- Worker **roles** are free-form names; give each a role-appropriate permission profile in
  its own argv.

A default `agents.json` is created on first run; edit it to taste. `flux agents` prints
the resolved roster; `flux agent --print` shows the exact principal launch for the current
project without running it.
