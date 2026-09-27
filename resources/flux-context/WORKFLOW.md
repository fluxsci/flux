# The end-to-end playbook (stock — shipped with Flux, do not edit)

The concrete session recipe: analysis results → blessed figures → write-up → review.
Read the relevant manual before each stage. These commands assume the project is
cwd (or selected with `--root` / `FLUX_PROJECT`); CLI input paths still use cwd.
MCP uses the connected binding and accepts a per-call `project` override.
`F=` below is shorthand:

```bash
F="{{FLUX_CLI}}"
```

## 0. Orient

You are connected: the bundle has the user's context, ProjectContext and its links,
Rules, recent Log, the project map and open-item overview. Work from that reading;
read the indexed task-specific references and the user's figure reference images
when needed. If not connected, suggest flux-connect; do not connect unasked.

```bash
cd /path/to/project                 # has project.json
"$F" list                           # figures + references when you need a current map
"$F" connect --refresh              # catch up within this connected session
```

A CLI connect does not set the root for future shell commands. Keep cwd in the
project or pass `--root`. MCP remains bound. Read change details with `read_delta`
when the automatic "↻ Since you last looked" notice names relevant edits.

For a requested new project, use `"$F" new ./paper --title "Study title"` from the
analysis workspace, then work in its project folder. Keep analysis/scratch outside
its presentation output. Read PYTHON-CONVENTIONS.md before setting up Python.

When the user asks you to record work, use
`"$F" log --agent "<your model>" --title "…" "…"`. The byline is automatic.
Use `--checkpoint` only for a requested summary; older entries stay intact.

## 1. Make plots (in the analysis env → into `plots/`)

- Write/extend a plotting script in the **analysis dir** (the workshop). Use `fluxplot` + the
  house style, name every series, and save into the project's `plots/` with a recipe
  (`fp.save(fig, "plots/<name>.svg", recipe=dict(script=__file__, params=…, inputs=…))`). Full detail +
  example: `PLOTS-AND-STYLE.md`.
- Run it through the project's **uv** environment (`uv run …` — every analysis project
  gets a uv project with fluxplot as a dependency; the standing rules are
  `PYTHON-CONVENTIONS.md`, machine specifics in `UserContext/`). Then validate each plot:

```bash
"$F" validate-plot plots/<name>.svg     # manifest valid + every part addressable + geometry sane
                                      # (rejects e.g. log-axis bars anchored at 0 — fix the script)
```

Only promote results worth keeping — the workshop holds the exploration, the project holds the
blessed figures. But keep the *evidence behind* each blessed plot close: drop per-subject/
per-condition panels, alternative analyses, and `_stats/` CSVs into
`plots/_dissections/<plot>/` (subfolders = named groups; the user views them with **D** on the
plot — see `PROJECT-AND-FIGURES.md`). Dissections stay outside ordinary gallery
searches and figure exports; use `_` to browse reserved folders explicitly.

## 2. Compose figures + LOOK + restyle

```bash
"$F" compose-figure plots/*.svg --id fig1 --rows 2     # import → grid → letter a,b… → caption stub
                                                     # (new figures auto-stack below the previous one)
"$F" render-figure fig1 --png --out /tmp/fig1.png      # render…
# → open/Read /tmp/fig1.png and actually look at it; or via MCP: get_figure_image {id:"fig1"}
"$F" restyle fig1 control.line --stroke '#205EA6'      # fix parts (survives regeneration)
"$F" render-figure fig1 --png --out /tmp/fig1.png      # re-look. Repeat until right.
"$F" render-canvas --png --out /tmp/canvas.png         # the WHOLE canvas — check figure layout too
```

Details + the canvas/figure/panel model: `PROJECT-AND-FIGURES.md`.

## 3. Write it up

```bash
"$F" set-caption fig1 "Synapse density by cortical layer. **a**, … **b**, …"
#   ↑ the '**a**, …' convention is DISTRIBUTED into per-panel caption blocks
#     (what Figure-Meta's Captions tab shows); --panel b rewrites one panel only.
"$F" set-manuscript --file section.qmd     # or edit paper/notes.qmd directly
#   embed figures with EMPTY alts: ![](../fig/renders/fig1.svg){#fig-fig1}
"$F" ref fig1                              # adds 'See @fig-fig1.'  (or write @fig-fig1 / @fig-fig1-a yourself)
"$F" cite-doi <doi>                        # grow references/library.bib (echoes author/title/year — CHECK it)
"$F" compile --to html                     # optional: render via Quarto (needs quarto) — prints the
                                         # output path + figures/citations resolution (fix any
                                         # unresolved @keys it names)
"$F" validate                              # lint: empty figures, figures not
                                         # embedded in any doc, overlapping canvas frames
```

Authoring + cross-refs: `MANUSCRIPT.md`.

## 4. Show the user

Render the figures to PNGs and present them (inline if you have MCP `get_figure_image`), with a
short written summary of what each shows and how it was made. End by telling the user they can
mark up the documents in the Flux app and you'll address the comments.

## 5. Review loop (only when the user asks)

```bash
"$F" inbox --json                    # all annotations + document comments
"$F" inbox --doc paper/notes.qmd --json  # only when the request narrows to this doc
"$F" claim <id> --note "Checking the labels."
# If claimed:false, skip it. Otherwise inspect its targets/picture, do the work, LOOK.
"$F" resolve <id> --note "Updated the labels and checked the figure."
# A decision is missing: ask in this item's thread, leave it unresolved, continue others.
"$F" reply <id> "Which scale should I use?" --needs-input
```

Use `list_inbox {packets:true}` over MCP to include target state and images.
Read REVIEW.md for filters, routing, claims and the watch-mode protocol. Watching
requires a separate request; connecting or listing does not start a watch loop.
The app refreshes changed prose and thread status. For a standing preference,
propose an addition to `Context/RULES.md`; keep one-off requests in their threads.

## 6. Iterate / regenerate (no stale clutter)

To change a figure, **regenerate** rather than re-saving a new SVG:

```bash
"$F" rerun-plot plots/<name>.recipe.json --param value   # re-runs the script with overridden params
# or just re-run the plotting script; the open app hot-swaps the panel live.
"$F" sync-figure fig1        # HEADLESS: refresh fig1's fig/assets copies from plots/ in place
                           # (captions, positions and restyles all survive — never
                           # delete-figure + re-compose to pick up a regenerated plot)
```

`render-figure` warns when a panel is stale vs `plots/` and tells you to `sync-figure`. A
regenerated plot with a NEW physical size is reconciled by `sync-figure` (element resized
true-size, frame grown) — re-`arrange` if the grid should reflow. For a figure-level script that
saves several plots, `rerun-plot <recipe> --only` regenerates just that recipe's plot (siblings
stay untouched on disk; `--param` overrides then reach only the target). Without `--only`, every
output regenerates and overrides leak into siblings.

## Putting it together (one breath)

Analysis script (with `fluxplot.style` + `fp.save`) writes `plots/density.svg` (+ manifest + recipe) → you
`validate-plot` it → `compose-figure` it into **fig1** with siblings → `render-figure` to a PNG
and **look** → `restyle` the series to Flexoki colors → `set-caption` and cite `@fig-fig1` in
the active `.qmd` → show the user the PNG → they comment in the app → you `inbox`, `claim`, fix and inspect the result,
then `resolve` each → done, with full provenance in `.meta/journal.ndjson`.

## CLI vs MCP — quick guidance

- **CLI** project verbs resolve the root as `--root` → `$FLUX_PROJECT` →
  cwd (a leading positional root like `.` is still accepted — `CLI-REFERENCE.md`).
- **MCP** is useful for inline figure images and live selection. Use the binding;
  `flux_verbs` and `flux_verb` reach tools outside core. Setup lives in CLI-REFERENCE.md.
- Both surfaces use the same registered mutations. Use verbs for managed files,
  respect locks, and verify with `reindex` / `validate` where appropriate.
