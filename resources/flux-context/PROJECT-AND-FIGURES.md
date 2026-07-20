# The project on disk, and building figures

## The canonical tree

```
<project>/                       # the Flux project (lives INSIDE the analysis dir)
├── project.json                 # the manifest / map — read this first (DERIVED rollup, rebuildable)
├── AGENTS.md                    # stub → routes agents to the two Context folders
├── Context/                     # the agent layer (see README.md here)
│   ├── Project/MISSION.qmd      #   goals/charter (co-owned with the user)
│   ├── NOTEBOOK.md              #   the principal's running memory (agent-owned)
│   ├── RULES.md                 #   project rules (promoted from feedback)
│   ├── Transcripts/             #   principal-session transcripts (machine-captured)
│   └── Dispatches/              #   worker dispatch records (brief/log/result)
├── manuscript/                  # USER-OWNED prose — source of truth
│   ├── main.qmd                 #   the Quarto manuscript
│   └── comments.json            #   the user's review comments (sidecar; see MANUSCRIPT-AND-REVIEW.md)
├── plots/                       # USER-OWNED drop-zone — your fluxplot output lands here
│   └── growth.{svg,fluxplot.json,recipe.json}
├── fig/                         # APP-MANAGED — NEVER hand-edit
│   ├── index.json               #   canvases + figures rollup
│   ├── canvases/<id>.json       #   the real figure composition (figures → elements)
│   ├── captions/<id>.md         #   each figure's caption (the single source)
│   ├── assets/                  #   Flux's imported copies of your plot SVGs
│   └── renders/                 #   auto static renders (derived)
├── references/library.bib       # USER-OWNED bibliography (BibTeX, [@citekey])
├── slides/<deckId>/deck.json    # Flux Slide decks (see SLIDES.md)
├── exports/                     # final compiled outputs (derived, git-ignored)
└── .meta/                       # tool state: journal.ndjson, feedback.ndjson, locks/, schema/, live/
```

## Ownership — what you edit vs. what you never touch

- **Edit directly:** `manuscript/**.qmd`, `references/library.bib`, and **`plots/`** (via
  fluxplot). These are the source of truth.
- **Never hand-edit `fig/`** — it's app-managed. Build figures through the verbs
  (`compose-figure`, `restyle`, …), which write `fig/` correctly and keep the index coherent.
- **Derived / rebuildable** (don't treat as authority): `project.json.figures[]` (rebuilt by
  `reindex` from `fig/index.json`), `fig/renders/`, `exports/`. If `project.json` looks stale
  after direct edits, run `reindex`.

**The `plots/` ↔ `fig/` seam:** you own `plots/` (any names/subfolders you like); Flux only
*reads* it and copies what you compose into `fig/assets/`. Regenerating a plot in `plots/`
hot-swaps its panel live when the app is open; headless, run `sync-figure` to refresh the
copies in place — either way your per-part restyles survive (they're keyed by stable id).

## The figure model

Hierarchy: **Project → Canvases → Figures → Elements**.
- A **canvas** is a page/workspace (like a Figma page); a project can have several.
- A **figure** is one publication figure (a bounded frame) on a canvas.
- An **element** is a panel inside a figure — usually an imported plot (a *semantic plot*
  element that points back to `plots/` and carries per-part overrides), plus panel-label text.

Cross-reference handles: **`@fig-<label>`** for the figure, **`@fig-<label>-a`** for panel *a*.
The `<label>` comes from `fig/index.json` (e.g. `fig-growth`); "Figure 3" is derived from order,
never stored — so reordering never breaks a reference.

## Building a figure — compose, look, restyle

**1. Compose** (the flagship verb): import N plots, grid them, auto-letter the panels, write a
caption stub. Run from the project dir.

```bash
# multi-panel: imports each, arranges 2 rows, letters a,b,c…, captions
{{FLUX_CLI}} compose-figure plots/*.svg --id fig3 --rows 2
# single plot is fine too (no panel letters until there are ≥2 panels)
{{FLUX_CLI}} compose-figure plots/growth.svg --id growth
```

**2. Look** — render to a PNG and actually view it (this is non-negotiable; don't ship blind):

```bash
{{FLUX_CLI}} render-figure growth --png --out /tmp/growth.png
# then open/Read /tmp/growth.png
{{FLUX_CLI}} render-canvas --png --out /tmp/canvas.png
# the whole canvas at once — check the figures' LAYOUT too (new figures
# auto-stack below the previous one; set-figure-layout moves them)
```

(Via MCP it's `get_figure_image {id:"growth"}` / `get_canvas_image {}`, returning the PNG
inline — preferred for looking.)

**3. Restyle a part** by its stable id — the override **survives regeneration**:

```bash
{{FLUX_CLI}} restyle growth control.line --stroke '#205EA6'
{{FLUX_CLI}} restyle growth treatment.line --stroke '#BC5215'
```

(Use the Flexoki hexes from `fluxplot.style` — `fx.FLEXOKI["blue"]` — for consistency. `restyle`
is new-style — no `.`.)

**4. Re-grid / re-letter** if needed: `arrange <figId> --rows 2`, `auto-label <figId>`
(letters follow reading order; panels without a label get one created first, so the
import-plots → arrange → auto-label route works on a blank figure too).

**Loop:** compose → render (look) → restyle/arrange → re-render, until it's right.

## Captions

Captions live on the figure MODEL (a lead sentence + one block per panel — what the app's
Caption Editor shows); `fig/captions/<id>.md` is the composed read-out. Write them journal
style — bold letter + comma:

```bash
{{FLUX_CLI}} set-caption growth "Growth of control vs treatment under nutrient stress over 24 h. **a**, Control. **b**, Treatment."
#   the '**a**, …' convention is DISTRIBUTED into the per-panel blocks automatically
{{FLUX_CLI}} set-caption growth "Control (revised)." --panel a   # rewrite ONE panel
{{FLUX_CLI}} caption growth      # read the composed caption back
```

The manuscript reads captions from the model (embed lines carry NO caption text — see
`MANUSCRIPT-AND-REVIEW.md`); use `@fig-growth-a` in the caption/prose to refer to panels.
