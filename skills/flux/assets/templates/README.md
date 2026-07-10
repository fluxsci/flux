# Analysis-dir glue templates

Drop these into a `/data/<project>` analysis dir so an agent invokes Flux frictionlessly. The
Flux skill is global (for example, `~/.agents/skills/flux/` for Codex or
`~/.claude/skills/flux/` for Claude Code); these files carry only project-specific science and
MCP wiring.

- **`analysis-AGENTS.md`** → copy to `<analysis-dir>/AGENTS.md` for Codex or another
  AGENTS-aware agent. Fill in the research context, Flux project path, and plotting environment.
- **`analysis-CLAUDE.md`** → copy to `<analysis-dir>/CLAUDE.md` for Claude Code.
- **`codex-config.toml`** → copy to `<analysis-dir>/.codex/config.toml` and set the Flux project
  path. This is the Codex MCP configuration.
- **`mcp.json`** → copy to `<analysis-dir>/.mcp.json` and set the Flux project path. This is the
  Claude Code MCP configuration.

MCP is optional but recommended: it gives an agent typed Flux verbs, inline figure PNGs
(`get_figure_image`), and the live bridge. The CLI works without it.

Quick setup for a new analysis project:

```bash
cd /data/<project>
cp ~/.agents/skills/flux/assets/templates/analysis-AGENTS.md ./AGENTS.md  # then edit
mkdir -p .codex
cp ~/.agents/skills/flux/assets/templates/codex-config.toml ./.codex/config.toml  # set project path
/usr/bin/node /home/driessen2/flux/dist/flux-cli.mjs new ./paper --title "<title>"
```
