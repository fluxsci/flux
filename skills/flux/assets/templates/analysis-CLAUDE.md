<!-- TEMPLATE — copy to <analysis-dir>/CLAUDE.md and fill in. This carries the *science*
     (project-specific context the agent needs) and points at the global Flux skill for
     presenting results. The Flux skill itself holds all the Flux know-how. -->

# <Project name> — analysis workspace

## Research context (the science)
- **Question:** <what we're trying to learn>
- **Key data:** <datasets, where they live, formats>
- **Domain notes / conventions / gotchas:** <anything project-specific the agent must know>

## Presenting results — use Flux
Present all figures and write-ups via the global **Flux** skill (works from here).

- **Machine-wide context:** read every document under `<FluxConfig>/Context/UserContext/`
  (`flux config` prints the path); orient via `Context/FluxContext/README.md`. Legacy note: if `~/FluxConfig/Guidelines/` still exists, read every document there
  before making figures or writing.
- **Flux project for this work:** `./paper/` (a subfolder of this analysis dir — create with
  `/usr/bin/node /home/driessen2/flux/dist/flux-cli.mjs new ./paper --title "<title>"` if it doesn't exist).
- **Plotting env** (has `fluxplot` + `cmasher` — `pip install "fluxplot[style]"`):
  `<e.g. /home/driessen2/uv_envs/<name>>` — run plotting scripts with this Python.
- **House style:** `from fluxplot import style as fx; fx.use_light()` at the top of every
  plotting script (a general fluxplot utility — tune it by editing `fluxplot/src/fluxplot/style.py`).

Workflow: generate plots with fluxplot + the house style into `paper/plots/`, compose figures,
write the analysis up in the manuscript, **render the figures and show me** before finishing.
When I leave comments in the Flux app, address them in place and resolve them.
