# Python conventions (stock — shipped with Flux, do not edit)

How analysis code and Python environments are set up on this machine. These are standing
rules for principals AND workers — follow them unless the user explicitly instructs
otherwise for a given project.

## The rule: uv, always

All custom Python environments, projects, and libraries are managed with
[`uv`](https://docs.astral.sh/uv/) — never bare `pip`/`venv`/conda, never ad-hoc
`pip install` into whatever Python is on PATH.

**New analysis project (the common case).** If a project needs Python (it likely does),
set up a **uv project** for its analysis code and environment, with fluxplot as a
dependency:

```bash
cd <analysis-dir>          # the workspace the Flux project lives inside
uv init
uv add --editable ~/fluxplot
uv add cmasher             # fluxplot's continuous-colormap companion
uv add <whatever the analysis needs>   # numpy, pandas, scipy, …
uv run python analysis/make_plots.py   # run everything through uv
```

- **fluxplot lives at `~/fluxplot`** (a local clone — it's an editable path dependency,
  in `pyproject.toml` via uv's sources). If it is NOT there, either ask the user to
  clone it or clone it yourself:
  `git clone https://github.com/kortdriessen/fluxplot ~/fluxplot`.
- Every plotting script then follows `PLOTS-AND-STYLE.md` (house style, named series,
  `fp.save` with a recipe into the Flux project's `plots/`).

**Reusable analysis packages.** When you (the principal) need — or have workers
develop — a longer-running custom package of reusable analysis code (loaders, metrics,
pipelines used across scripts or projects), build it as a **uv library**
(`uv init --lib <name>`, proper `src/` layout, added to consuming projects with
`uv add --editable <path>`). Don't let reusable code accumulate as loose scripts.

## Practical notes

- Run scripts with `uv run` (or the project venv's interpreter) so the environment is
  always the project's own — never assume a global Python has the deps.
- Machine-specific facts (where existing envs live, user preferences) are in
  `UserContext/` — read it; it overrides nothing here but fills in specifics.
- Missing prerequisites (uv itself, fluxplot clone, quarto/TeX, fonts)? The human
  install guide doubles as your troubleshooting reference:
  `{{FLUX_REPO}}/docs/installation.qmd` (when this machine has the Flux source
  checkout; otherwise summarize the gap and ask the user).
