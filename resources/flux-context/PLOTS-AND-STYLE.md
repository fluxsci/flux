# Plots: fluxplot + the Flux house style

## What fluxplot is

`fluxplot` is an external **Python library** (`pip install fluxplot`) you use in your analysis
environment. It's "matplotlib, but every meaningful thing has a name": you plot in ordinary
matplotlib via thin helpers, and `fp.save()` emits a **semantic SVG** whose every part (a
series' line, its 4th point, the x-axis title) has a **stable id** — which is what lets Flux
restyle parts and keep your hand-tuning when a plot is regenerated.

Your analysis env must have `fluxplot` installed (plus `cmasher` for continuous colormaps:
`pip install "fluxplot[style]"`). **The user's plotting environment (which env manager, where
the envs live) is a UserContext fact — check `UserContext/` before running scripts.** If
`fluxplot` is missing, install it into the active env — ask first if you're unsure which
env to use.

Everything you need lives in the library — Flux bundles **no plotting code** of its own:
`fp.line/scatter/...`, `fp.save`, `fp.params`, and the house style `fp.style` (`fp.use_light()`).

## The house style — `fluxplot.style`

The style is a **general fluxplot utility**, not a Flux-only thing:

```python
from fluxplot import style as fx
fx.use_light()          # paper-background theme (default); fx.use_dark() for dark
```

Use it for **any** plotting — a throwaway `plt.plot` in a notebook just as much as a publication
figure — so everything you make looks like one coherent set. It provides the **Flexoki** palette
+ categorical cycle, **cmasher** perceptually-uniform colormaps for continuous data (with Flexoki
fallbacks if cmasher isn't installed), Lato / Latin-Modern typography, and a despined Tufte look.
It is **backend-agnostic** (won't fight your notebook backend); for headless scripts set
`matplotlib.use("Agg")` yourself before importing pyplot.

Apply it at the top of every plotting script (before creating figures). To **tune** the look,
edit `fluxplot/src/fluxplot/style.py` — one place, and every future plot follows; don't sprinkle
ad-hoc `rcParams` in scripts.

## The pattern (worked example)

```python
import matplotlib
matplotlib.use("Agg")                       # headless: analysis scripts never pop a window
import numpy as np
import matplotlib.pyplot as plt
import fluxplot as fp
from fluxplot import style as fx            # the house style (general fluxplot utility)
fx.use_light()                              # apply before creating figures

p = fp.params({"test": "t-test"})           # tunables (overridable on rerun — see below)
t = np.array([0, 4, 8, 12, 16, 20, 24])
control, treatment = ...                    # your real data

fig, ax = plt.subplots(figsize=(6.4, 4.8))
fp.line(ax, t, control,   series="control",   marker="o", label="Control")
fp.line(ax, t, treatment, series="treatment", marker="s", label="Treatment")
ax.set_xlabel("Time (h)"); ax.set_ylabel("OD600"); ax.set_yscale("log"); ax.legend()
fp.significance_bracket(ax, x0=20, x1=24, y=2.0, label="**", between=("control","treatment"), p=0.003)
fx.despine(ax)
fx.title(ax, "Growth under nutrient stress", f"control vs treatment ({p['test']})")

# Save the 3 files straight into the Flux project's plots/ (run from the project dir,
# or give an absolute path). ALWAYS pass a recipe with script=__file__ + params/inputs.
fp.save(fig, "plots/growth.svg", recipe=dict(script=__file__, params=p, inputs=["data/growth.csv"]))
```

This writes three siblings that travel together:

```
plots/growth.svg            ← semantic SVG (named, addressable parts)
plots/growth.fluxplot.json  ← manifest (data + coordinate map + parts inventory)
plots/growth.recipe.json    ← recipe (how it was made — re-runnable; used to regenerate)
```

## fluxplot API (the surface you need)

- **Series helpers** (each takes `series="name"`, returns the real matplotlib artist):
  `fp.line(ax, x, y, series=, marker=, label=)`, `fp.scatter(...)`, `fp.bar(ax, x, height, series=)`,
  `fp.errorbar(ax, x, y, series=, yerr=)`, `fp.area(ax, x, y1, y2, series=)`.
- **Overlays:** `fp.significance_bracket(ax, x0=, x1=, y=, label=, between=, p=)`,
  `fp.reference_line(ax, y= or x=, name=)`, `fp.annotation(ax, name=, text=, ...)`.
- **Escape hatch** for plot types without a helper (box, violin, heatmap, contour…):
  `fp.tag(artist, role="x-…", series=, index=)`, `fp.tag_points(points, series=)`.
- **Save:** `fp.save(fig, path, recipe=dict(script=__file__, params=…, inputs=…))`. When you pass
  `script=`, the recipe it writes is **re-runnable** by `flux rerun-plot` / the in-app *Regenerate*
  (relative paths, so it survives the project being moved). Always pass the recipe — a plot without
  one can't be regenerated.
- **Tunables:** `fp.params(defaults)` merges your defaults with any `FLUX_PARAMS` override (see
  *Regenerating*).

## Style conventions (so plots look like one set)

- **Name every series**, consistently across related plots (`series="control"`, `"treatment"`,
  `"wt"`, `"ko"`…). The name *is* the addressable id (`control.line`, `control.point.3`) Flux
  uses to restyle and to keep overrides across regeneration.
- **One concept per plot.** Compose multiple plots into a multi-panel *figure* in Flux (see
  `PROJECT-AND-FIGURES.md`) rather than cramming subplots into one SVG.
- **Color from the house style:** un-coloured series get the Flexoki cycle automatically; reach
  a specific hue with `fx.FLEXOKI["blue"]` or `fx.CYCLE_LIGHT[i]`. Continuous data: pass
  `cmap=fx.SEQUENTIAL` / `fx.DIVERGING` (or `fx.FLEXOKI_DIVERGING` for a white-centred map, also
  addressable by the name `"flexoki_diverging"`).
- **Reasonable figure sizes** (`figsize=(6.4, 4.8)`-ish per panel); the style sets fonts, DPI,
  grid, and despining for you.

## Validate every plot

```bash
{{FLUX_CLI}} validate-plot plots/growth.svg
```

This checks the manifest is schema-valid **and** that every id it references exists in the SVG
(i.e. the plot is genuinely part-addressable), **and** that the geometry is renderer-sane. Fix
any failure before composing — a plot that fails imports as an opaque image (not restylable).
A plot saved via `fp.save` should pass.

**Log-axis gotcha:** a bar anchored at data 0 on a log axis (`barh(...)` + `set_xscale("log")`)
serializes as a huge off-canvas coordinate — `fp.save` warns at generation time and
`validate-plot` rejects it (naming the id/value). Anchor at a positive value instead:
`barh(y, counts - 1, left=1)`. Compose clamps legacy files so they still render, with a warning.

## Regenerating (not re-saving)

To change a figure, **re-run the script**, don't hand-edit the SVG:

- Quick: re-run the plotting script; the open app hot-swaps the panel live and **keeps your
  per-part restyles** (they're keyed by stable id).
- **Headless / app closed:** composed figures render from a COPY of the plot (`fig/assets/`) —
  after regenerating, refresh it in place:
  ```bash
  {{FLUX_CLI}} sync-figure fig3      # or omit the id for all figures
  ```
  Captions, positions and restyles all survive. Never `delete-figure` + re-compose just to pick
  up a regenerated plot (that destroys them); `render-figure` warns when panels are stale.
- Parameterized: because the script reads tunables via `fp.params({...})` (which honors a
  `FLUX_PARAMS` override), you can regenerate with different settings without editing code:
  ```bash
  {{FLUX_CLI}} rerun-plot plots/growth.recipe.json --test mann-whitney
  ```
  The recipe `fp.save` wrote records the interpreter + script + params (as relative paths), so
  this re-executes the script with the override and re-emits the plot in place. (This is automatic
  whenever you pass `script=__file__` to `fp.save`.)
  **Figure-level scripts are fine:** a script that `fp.save`s several plots can rerun ONE of
  them — `rerun-plot plots/fig2a.recipe.json --only` targets just that recipe's plot
  (`FLUXPLOT_ONLY` makes the sibling saves no-ops, so their files stay untouched). The script
  still executes fully, so `--param` overrides only reach the targeted plot's output. Without
  `--only`, the whole script's outputs regenerate and param overrides leak into siblings.
- **Regenerated at a different size?** `sync-figure` resizes the element true-size (preserving a
  deliberate hand-scale) and grows the figure frame if needed — re-`arrange` when the grid
  should reflow around the new size.
