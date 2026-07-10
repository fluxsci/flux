<!-- TEMPLATE — copy to <analysis-dir>/AGENTS.md and fill in. This carries the
     project-specific scientific context an agent needs; the global Flux skill holds
     the reusable workflow. -->

# <Project name> — analysis workspace

## Research context

- **Question:** <what we are trying to learn>
- **Key data:** <datasets, locations, formats>
- **Domain notes / conventions / gotchas:** <facts an agent must know>

## Presenting results through Flux

- **Machine-wide conventions:** if `~/FluxConfig/Guidelines/` exists, read every document there
  before making figures or writing.
- **Flux project:** `./paper/` (a subfolder of this analysis dir — create with
  `/usr/bin/node /home/driessen2/flux/dist/flux-cli.mjs new ./paper --title "<title>"` if absent).
- **Plotting environment:** <Python or R environment containing fluxplot and dependencies>.
- **House style:** begin Fluxplot scripts with
  `from fluxplot import style as fx; fx.use_light()`.

Keep analysis and scratch work in this directory; promote only current, reproducible plots into
`paper/plots/`. Generate plots with a recipe, compose figures, write the manuscript, and render
the result for visual review before declaring it complete. Address Flux review comments in place
and resolve them when finished.

The project-local `.codex/config.toml` wires Flux MCP. It provides typed figure, manuscript,
library, and slide operations, `get_figure_image` for the visual review step, and live-bridge
tools when the Flux app is open. The CLI remains a complete fallback.
