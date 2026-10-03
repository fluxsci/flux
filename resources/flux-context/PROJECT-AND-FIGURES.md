# The project on disk, and building figures (stock — shipped with Flux, do not edit)

## The canonical tree

```
<project>/                       # the Flux project (lives INSIDE the analysis dir)
├── project.json                 # manifest / map; only the figures rollup is derived
├── AGENTS.md                    # passive pointer to flux-connect
├── CLAUDE.md                    # @AGENTS.md import
├── Context/                     # the agent layer (see README.md here)
│   ├── ProjectContext.qmd       #   background, goals and must-read links
│   ├── NOTEBOOK.md              #   append-only Log, written on request
│   └── RULES.md                 #   your standing project rules
├── paper/                  # USER-OWNED prose — source of truth
│   ├── notes.qmd                 #   a starter document; no required main filename
│   └── notes.comments.json      #   the user's review comments (sidecar; see REVIEW.md)
├── plots/                       # USER-OWNED drop-zone — your fluxplot output lands here
│   ├── growth.{svg,fluxplot.json,recipe.json}
│   ├── neuron.{glb,fluxplot.json,recipe.json}
│   ├── _dissections/growth/     #   growth's companion material (see below) — NOT composable plots
│   └── _lighttable/<name>/      #   Lighttable collections (exploratory image sets) — same
├── fig/                         # APP-MANAGED — NEVER hand-edit
│   ├── index.json               #   canvases + figures rollup
│   ├── canvases/<id>.json       #   the real figure composition (figures → elements)
│   ├── captions/<id>.md         #   readable projection of model caption blocks
│   ├── assets/                  #   imported SVGs, GLBs and metadata sidecars
│   └── renders/                 #   auto static renders (derived)
│       └── model3d/             #   mesh-only PNG posters; vector furniture stays separate
├── references/library.bib       # USER-OWNED bibliography (BibTeX, [@citekey])
├── slides/<deckId>/deck.json    # Flux Slide decks (see SLIDES.md)
├── styles/                      # reusable figure styles
├── assets/                      # project media
├── exports/                     # final compiled outputs (derived, git-ignored)
└── .meta/                       # tool state: journal.ndjson, feedback.ndjson, locks/, schema/, live/
```

## Document discovery

Paper discovers `.qmd` and Context documents recursively under `paper/`, legacy
`manuscript/`, and `Context/`. No `main.qmd` is required and existing manuscript
folders are never automatically renamed. Generated Quarto support/cache trees and
unused legacy `sections/` scaffolds are skipped; discovery does not delete them.
Ordinary folders remain visible. New folders carry a hidden `.flux-folder` marker
so empty or generated-looking names still represent the user's intent.

New manifests use `documentRoot`; `manuscript.path` is the default export pointer,
empty when no documents remain. Use `docs`, `new-doc`, `new-doc-folder` and `move-doc`
for structure. Moves preserve comment sidecars and adjust relative links; collisions
are refused. `delete-doc` removes the document and sidecar, leaving its figures and
references intact. Legacy mains and the three standard Context files are protected.
See CLI-REFERENCE.md for syntax and MANUSCRIPT.md for authoring.

## Ownership — what you edit vs. what you never touch

- **Edit directly:** `paper/**.qmd` (legacy `manuscript/` also works), `references/library.bib`, and **`plots/`** (via
  fluxplot). These are the source of truth. Prefer supported write verbs for locks
  and provenance; keep unrelated text intact.
- **Context belongs to the user:** ProjectContext is the must-read hub and Rules
  holds standing preferences. Propose changes; append to the Log only when asked
  (CONNECT.md). Project-root AGENTS.md suggests flux-connect and CLAUDE.md imports
  it; neither connects unasked.
- **Never hand-edit `.meta/`** — tools own its schema, provenance journal, annotation
  ledger, locks and live bridge. `deferred: … is locked` means wait and retry.
- **Never hand-edit `fig/`** — it's app-managed. Build figures through the verbs
  (`compose-figure`, `restyle`, …), which write `fig/` correctly and keep the index coherent.
- **Derived / rebuildable** (don't treat as authority): `project.json.figures[]` (rebuilt by
  `reindex` from `fig/index.json`), `fig/renders/`, `exports/`. If `project.json` looks stale
  after direct edits, run `reindex`.

**The `plots/` ↔ `fig/` seam:** you own `plots/` (any names/subfolders you like); never
reorganize existing outputs just to compose them. Flux only
*reads* it and copies what you compose into `fig/assets/`. Regenerating a plot in `plots/`
hot-swaps its panel live when the app is open; headless, run `sync-figure` to refresh the
copies in place — either way your per-part restyles survive (they're keyed by stable id).

**Dissections — companion material per plot:** `plots/_dissections/<plot-rel-path-sans-ext>/`
holds a plot's supporting evidence — per-subject breakdown panels, alternative analyses,
`_stats/` CSVs. The folder is the API: just write files there (subfolders become named groups;
images svg/png/jpg/webp and csv/tsv tables are first-class). Everything under `_dissections/`
is deliberately OUT OF THE WAY of composition — absent from an ordinary plot-importer search,
never part of a figure or export by accident. The user views it with **D** on the selected
plot (an open viewer live-refreshes as you write files); `list-dissections [plot]` enumerates
it headless. When you finish an analysis, dropping the per-subject/per-condition panels behind
each summary plot into its dissection folder is a cheap, high-value habit.

**Lighttable collections — exploratory image sets:** `plots/_lighttable/<collection>/` is the
home for image-set triage batches (a parameter sweep, one image per cell/condition — the
Lighttable companion app's folder-of-subfolders layout). Write them there rather than loose in
`plots/`: `_lighttable` is the second RESERVED name, so a batch of ten thousand triage PNGs
never pollutes the importer's search or the project watcher.

Both reserved folders stay reachable on purpose: in the importer the user types `_` to list
them, Enter to go in, and searching then applies only inside that folder. Reserved means out
of the way, not unavailable — so put anything exploratory or explanatory in them freely.

**The global plot library — plots for every project:** `<FluxConfig>/plot_library/`
(`plotLibraryPath` in `config` output) is the user's machine-wide `plots/`: logos,
schematics, reference panels, colour keys — anything reused across projects. Same rules as a
project's `plots/` (any subfolders; the reserved `_` names are hidden the same way); the Plot
gallery's **Project | Global** switch browses it, and a Settings preference decides whether a
search spans project, global, or both. Put a plot there ONLY when the user wants it reusable
beyond this project — per-analysis output belongs in the project's `plots/`. Composing a
library plot works headless too (`compose-figure <plotLibraryPath>/logos/lab.svg --id …`): like
a GUI insert it is stored as an EXTERNAL source (absolute path, `external: true`) with the
pixels copied into `fig/assets/`, so the project stays self-contained while regenerating the
library file still hot-swaps it on this machine.

## The figure model

Hierarchy: **Project → Canvases → Figures → Elements**.
- A **canvas** is a page/workspace (like a Figma page); a project can have several.
- A **figure** is one publication figure (a bounded frame) on a canvas.
- An **element** is a panel inside a figure — usually an imported plot (a *semantic plot*
  element that points back to `plots/` and carries per-part overrides), plus panel-label text.

## 3D model panels

A `model3d` element stores a physical rectangle, camera, named shape weights and
semantic overrides. Its immutable GLB copy and metadata live in `fig/assets/`;
figure JSON and history contain metadata, never mesh bytes. Ordinary arrange,
rotate, flip, group, duplicate and delete operations work on its rectangle.
Double-click in Flux to orbit; Home restores the source view. Shape sliders edit
named states; a sequence also has a derived Frame control.

```bash
"{{FLUX_CLI}}" model-info plots/neuron.glb
"{{FLUX_CLI}}" add-model fig3 plots/neuron.glb --width 260 --name Neuron
# Use the returned elementId below.
"{{FLUX_CLI}}" set-model-view <elementId> --preset front --azimuth 25 --colors source
"{{FLUX_CLI}}" restyle-part fig3 neuron.axon --element <elementId> --fill '#205EA6'
"{{FLUX_CLI}}" set-model-field <elementId> thickness.field --cmap viridis --min 0 --max 4
"{{FLUX_CLI}}" render-model-posters --figure fig3
```

`restyle-part` is an alias of `restyle`; both address 2D plot and 3D mesh/furniture
parts. Mesh part fills show only with source colours (`--colors source`; the
Inspector calls it **From file**); `--colors uniform` uses the whole element's fill.
A mesh fill on a uniform model therefore switches it to source colours in the same
edit (CLI, MCP, live bridge and the GUI palette alike), so the fill shows.
Field edits switch to source colours and keep explicit part fills, which can
intentionally hide a value map on that part. `--reset` on `set-model-field` removes
that field's remapping only.

To recolour a whole series at once — its line, points, bars, error bars AND its legend swatch —
use `set-series-color <figureId> <seriesId> '#205EA6' [--element <elementId>]` (`--clear` restores the
generated colours). It writes one override per part, so it survives regeneration like `restyle`;
a colour-mapped series (heatmap, hexmatrix, scatter with c=) is refused — edit its colour scale with
`set-plot-color-scale` instead. `restyle` of a series' whole line or points repaints its legend
swatch too, so the key never lies about the colour.

To reason about a figure precisely, read its data instead of its picture:
`get-plot-data <figureId> [elementId] [--series id] [--fields series,axes,overlays] [--offset n --limit n]`
returns the manuscript-grade facts fluxplot recorded — every series' exact x/y and per-point ids,
hexmatrix bins (count, value, x, y per hexagon), glowbar / fluxbox statistics, histogram
distributions, heatmap values, image channels, axis domains, and each significance bracket's test,
p and effect size. Long arrays are windowed (`pages` lists every cut with its true length): page
with `--offset` rather than asking for everything.

Use `--state inflated=.5 --state bent=.2` to patch named weights (`0` removes a
weight), or `--frame 2.5` for a sequence; the two forms are exclusive. `--state` is
the only repeatable flag; duplicate names, unknown shapes and non-finite weights are
errors. Stored finite weights can extrapolate outside 0–1; the UI sliders cover 0–1.
The camera framing covers the base and each shape at weight 1, so combined or
extrapolated shapes may extend beyond it. A sequence's Frame value is derived from
the weights and never stored. Home restores the accepted source defaults. Use
`model-info a.glb --morph-with b.glb` to check correspondence before authoring a morph.

An invalid/newer/mismatched optional manifest degrades to a named plain mesh
with a warning; its original bytes remain stored. Geometry refusal is explicit.
An unavailable renderer retains the imported model and reports an unavailable
poster. Import/view/field/restyle commands attempt a matching poster after saving;
a poster failure is only a warning on a successful edit, and `--no-poster` leaves the
poster for a later explicit render. Cached posters are derived;
`render-model-posters --prune` removes only unreferenced entries older than 14 days,
considering every saved figure and every deck's Design and build-step stills (the
app's own cleanup keeps the same set). Connect
uses cached posters or labeled placeholders without reading GLB bytes or
creating model posters. Explicit image requests/export can render them. Exports
embed mesh pixels at the requested resolution and keep furniture as SVG text
and paths; GLB bytes are never embedded in figure SVG.

These commands target Figures. Deck selectors and 3D figure-to-slide conversion
remain unavailable until the Slides integration is enabled.

## Conventions and identity

Use the figure's stable `referenceKey` from the model/index for cross-references
(for example `@fig-growth`, panel `@fig-growth-a`). `family` and `number` give the
publication designation, while `nickname` is its human title. Canvas array order is
independent: reordering figures does not renumber them or change reference keys.
Use stable IDs/slugs in filenames and tools, never infer an ID from "Figure 3".

Panel letters are semantic panel-label text elements; `auto-label` follows reading
order. Use `@tbl-id` for a Markdown table with `: Caption {#tbl-id}` beneath it.
Keep plain-text changes small; let verbs own JSON serialization. CLI-REFERENCE.md
is the canonical verb list.

Use `create-figure` and the element/arrangement verbs for a custom composition;
`compose-figure` is the usual import → grid → label → caption starting point.
Read SLIDES.md before reusing a figure in a talk, and LIBRARY.md for source-paper snips.

## Building a figure — compose, look, restyle

**1. Compose** (the flagship verb): import N plots, grid them, auto-letter the panels, write a
caption stub. Run from the project dir.

```bash
# multi-panel: imports each, arranges 2 rows, letters a,b,c…, captions
"{{FLUX_CLI}}" compose-figure plots/*.svg --id fig3 --rows 2
# single plot is fine too (no panel letters until there are ≥2 panels)
"{{FLUX_CLI}}" compose-figure plots/growth.svg --id growth
```

**2. Look** — render to a PNG and actually view it (this is non-negotiable; don't ship blind):

```bash
"{{FLUX_CLI}}" render-figure growth --png --out /tmp/growth.png
# then open/Read /tmp/growth.png
"{{FLUX_CLI}}" render-canvas --png --out /tmp/canvas.png
# the whole canvas at once — check the figures' LAYOUT too (new figures
# auto-stack below the previous one; set-figure-layout moves them)
```

(Via MCP it's `get_figure_image {id:"growth"}` / `get_canvas_image {}`, returning the PNG
inline — preferred for looking.)

**3. Restyle a part** by its stable id — the override **survives regeneration**:

```bash
"{{FLUX_CLI}}" restyle growth control.line --stroke '#205EA6'
"{{FLUX_CLI}}" restyle growth treatment.line --stroke '#BC5215'
```

(Use the Flexoki hexes from `fluxplot.style` — `fx.FLEXOKI["blue"]` — for consistency. `restyle`
is new-style — no `.`.)

**4. Re-grid / re-letter** if needed: `arrange <figId> --rows 2`, `auto-label <figId>`
(letters follow reading order; panels without a label get one created first, so the
import-plots → arrange → auto-label route works on a blank figure too).

**Loop:** compose → render (look) → restyle/arrange → re-render, until it's right.

## Captions

Captions live on the figure MODEL (a lead sentence + one block per panel + optional closing prose — what the app's
Figure-Meta Captions tab shows (Alt+M in Figure or Paper)); `fig/captions/<id>.md` is the composed read-out. Write them journal
style — bold letter + comma:

```bash
"{{FLUX_CLI}}" set-caption growth "Growth of control vs treatment under nutrient stress over 24 h. **a**, Control. **b**, Treatment."
#   the '**a**, …' convention is DISTRIBUTED into the per-panel blocks automatically
"{{FLUX_CLI}}" set-caption growth "Control (revised)." --panel a   # rewrite ONE panel
"{{FLUX_CLI}}" set-caption growth "All error bars show SEM." --panel __ps__ # closing prose, no label
"{{FLUX_CLI}}" caption growth      # read the composed caption back
```

The `__ps__` block stays last regardless of panel order. Its readable projection has no marker;
whole-caption edits preserve an unchanged known suffix, while rewritten closing prose is imported
into the ordinary blocks without duplicating the old text. `--panel ps` is also accepted when no
actual panel is named ps.

The manuscript reads captions from the model (embed lines carry NO caption text — see
`MANUSCRIPT.md`); use `@fig-growth-a` in the caption/prose to refer to panels.

Validate with `validate` after changing structure, and `validate-plot` before import.
Re-read captions and inspect both the figure and whole-canvas render before reporting completion.
