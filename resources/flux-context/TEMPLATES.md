# Analysis-dir glue templates (stock — shipped with Flux, do not edit)

Copy-paste starters for wiring an **analysis workspace** (the directory a Flux project
lives inside) so agents launched there find Flux frictionlessly. The principal and
dispatched workers do NOT need any of this — their launch wires context and MCP
automatically; these serve standalone sessions you start yourself.

## `<analysis-dir>/AGENTS.md` (Codex and other AGENTS-aware CLIs)

```markdown
# <Project name> — analysis workspace

## Research context
- **Question:** <what we are trying to learn>
- **Key data:** <datasets, locations, formats>
- **Domain notes / conventions / gotchas:** <facts an agent must know>

## Presenting results through Flux
- **Machine context:** read everything under `<FluxConfig>/Context/UserContext/`
  (run `{{FLUX_CLI}} config` for the path) and orient via
  `Context/FluxContext/README.md`.
- **Flux project:** `./paper/` (scaffold with
  `{{FLUX_CLI}} new ./paper --title "<title>"` if absent). Its `Context/` holds the
  mission, notebook, and rules — read them before working.
- **Plotting environment:** <env with fluxplot — see UserContext for machine defaults>.

Keep analysis/scratch here; promote only current, reproducible plots into
`paper/plots/` (with recipes). Address review feedback via `{{FLUX_CLI}} feedback`
and `{{FLUX_CLI}} comments`, resolving each item.
```

For **Claude Code**, put the same content in `<analysis-dir>/CLAUDE.md`.

## MCP wiring — Codex: `<analysis-dir>/.codex/config.toml`

```toml
[mcp_servers.flux]
command = "node"
args = ["{{FLUX_MCP_PATH}}", "<ABSOLUTE PATH TO THE FLUX PROJECT>"]

[mcp_servers.flux.env]
FLUX_CLIENT = "codex"
```

## MCP wiring — Claude Code: `<analysis-dir>/.mcp.json`

```json
{ "mcpServers": { "flux": {
  "command": "node",
  "args": ["{{FLUX_MCP_PATH}}", "<ABSOLUTE PATH TO THE FLUX PROJECT>"],
  "env": { "FLUX_CLIENT": "claude" }
} } }
```

Point the last arg at *this* analysis dir's Flux project folder (the MCP server's root is
fixed at launch). MCP adds typed verbs, inline figure PNGs (`get_figure_image` — the look
step), and the live bridge; the CLI is always a complete fallback.
