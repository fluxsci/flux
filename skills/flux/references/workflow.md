# The end-to-end playbook

The concrete session recipe. Read `SKILL.md` for the mental model; this is the "what to actually
do." Commands assume you've `cd`'d into the Flux project and run
`export FLUX_PROJECT="$PWD" FLUX_CLIENT=agent` (see `cli.md`). `F=` below is shorthand:

```bash
F="/usr/bin/node /home/driessen2/flux/dist/flux-cli.mjs"
```

## 0. Orient

```bash
# Locate the project (a folder with project.json) inside the analysis dir, or scaffold one:
$F new ./paper --title "MICrONS synapse organization" --author "K. Driessen"   # if none exists (confirm first)
cd ./paper && export FLUX_PROJECT="$PWD" FLUX_CLIENT=agent
$F config                        # machine paths — note guidelinesPath
# read EVERYTHING in <guidelinesPath>/ (every .md + image) before working —
# the user's standing conventions for all Flux output
$F list                          # current figures + references
cat project.json AGENTS.md       # the map + per-project conventions
tail -5 .meta/journal.ndjson     # what changed since last session
```

## 1. Make plots (in the analysis env → into `plots/`)

- Write/extend a plotting script in the **analysis dir** (the workshop). Use `fluxplot` + the
  house style, name every series, and save into the project's `plots/` with a recipe
  (`fx.save(fig, "plots/<name>.svg", script=__file__, params=…, inputs=…)`). Full detail +
  example: `plots-and-style.md`.
- Run it with the env that has `fluxplot` (the user's `uv` env). Then validate each plot:

```bash
$F validate-plot plots/<name>.svg     # manifest valid + every part addressable
```

Only promote results worth keeping — the workshop holds the exploration, the project holds the
blessed figures.

## 2. Compose figures + LOOK + restyle

```bash
$F compose-figure plots/*.svg --id fig1 --rows 2     # import → grid → letter a,b… → caption stub
                                                     # (new figures auto-stack below the previous one)
$F render-figure fig1 --png --out /tmp/fig1.png      # render…
# → open/Read /tmp/fig1.png and actually look at it; or via MCP: get_figure_image {id:"fig1"}
$F restyle fig1 control.line --stroke '#205EA6'      # fix parts (survives regeneration)
$F render-figure fig1 --png --out /tmp/fig1.png      # re-look. Repeat until right.
$F render-canvas --png --out /tmp/canvas.png         # the WHOLE canvas — check figure layout too
```

Details + the canvas/figure/panel model: `project-and-figures.md`.

## 3. Write it up

```bash
$F set-caption fig1 "Synapse density by cortical layer. **a**, … **b**, …"
#   ↑ the '**a**, …' convention is DISTRIBUTED into per-panel caption blocks
#     (what the app's Caption Editor shows); --panel b rewrites one panel only.
$F set-manuscript --file section.qmd     # or edit manuscript/main.qmd directly
#   embed figures with EMPTY alts: ![](../fig/renders/fig1.svg){#fig-fig1}
$F ref fig1                              # adds 'See @fig-fig1.'  (or write @fig-fig1 / @fig-fig1-a yourself)
$F cite-doi 10.1038/s41586-024-...       # grow references/library.bib (echoes author/title/year — CHECK it)
$F compile --to html                     # optional: render via Quarto (needs quarto)
```

Authoring + cross-refs: `manuscript-and-review.md`.

## 4. Show the user

Render the figures to PNGs and present them (inline if you have MCP `get_figure_image`), with a
short written summary of what each shows and how it was made. End by telling the user they can
mark up the documents in the Flux app and you'll address the comments.

## 5. Review loop (when the user says "address my comments")

```bash
$F comments                    # list open threads: each has an id + anchor.quote (the targeted text)
# for each: find the quote in the .qmd, make the change (set-manuscript / edit the file), then:
$F resolve-comment <id> --note "Done: <what you changed>."
```

Full procedure + the on-disk comment format: `manuscript-and-review.md`. With the app open, your
prose edits and your resolves both refresh live.

## 6. Iterate / regenerate (no stale clutter)

To change a figure, **regenerate** rather than re-saving a new SVG:

```bash
$F rerun-plot plots/<name>.recipe.json --param value   # re-runs the script with overridden params
# or just re-run the plotting script; the open app hot-swaps the panel live.
$F sync-figure fig1        # HEADLESS: refresh fig1's fig/assets copies from plots/ in place
                           # (captions, positions and restyles all survive — never
                           # delete-figure + re-compose to pick up a regenerated plot)
```

`render-figure` warns when a panel is stale vs `plots/` and tells you to `sync-figure`. Note
`rerun-plot` re-executes the WHOLE script — a script that saves several plots regenerates all of
them, and `--param` overrides leak into those siblings; keep one script per plot when you need
per-panel params.

## Putting it together (one breath)

Analysis script (with `fluxplot.style` + `fp.save`) writes `plots/density.svg` (+ manifest + recipe) → you
`validate-plot` it → `compose-figure` it into **fig1** with siblings → `render-figure` to a PNG
and **look** → `restyle` the series to Flexoki colors → `set-caption` and cite `@fig-fig1` in
`main.qmd` → show the user the PNG → they comment in the app → you `comments`, fix the `.qmd`,
`resolve-comment` each → done, with full provenance in `.meta/journal.ndjson`.

## CLI vs MCP — quick guidance

- **CLI** (this doc) always works; every verb resolves the root as `--root` → `$FLUX_PROJECT` →
  cwd (a leading positional root like `.` is still accepted — `cli.md`).
- **MCP** is nicer for **looking** (`get_figure_image` → inline PNG) and for **live** edits on
  the user's selection. Wire it per-project with `.codex/config.toml` for Codex or `.mcp.json`
  for Claude Code (`manuscript-and-review.md`).
- Either way, **the files are the contract** — when in doubt, read/write the files directly and
  run `reindex` / `validate`.
