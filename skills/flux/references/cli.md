# Running Flux from the command line (and MCP)

## How to run the CLI

The `flux` CLI is **not on `PATH`**. It lives in the Flux repo and must resolve against that
repo's `node_modules`, but it **operates on any project directory**. Run it with:

```bash
/usr/bin/node /home/driessen2/flux/dist/flux-cli.mjs <verb> [args] [--flags]
```

(First run installs `tsx` transiently; that's fine.) `npm run flux -- <verb>` also works but
only from inside the repo — prefer the absolute-path form above from anywhere.

**The one rule that avoids all foot-guns: `cd` into the Flux project and run from there.**
Then set your identity and pin the project for the session:

```bash
cd /data/microns_analysis/paper          # the Flux project (has project.json)
export FLUX_PROJECT="$PWD" FLUX_CLIENT=agent
```

`FLUX_CLIENT=agent` stamps your writes in the provenance journal and as the lock owner.
Working from the project dir also matters because **plot/asset paths are resolved against the
current directory**, not against `--root` — so `compose-figure plots/*.svg` only globs
correctly when the project is your cwd.

## Root resolution (unified)

**Every verb** resolves the project root the same way: `--root` → `$FLUX_PROJECT` → cwd.
With the session export above, `render-figure growth --png` just works.

- A **leading positional root** is still accepted for back-compat (`render-figure . growth`,
  `list /path/to/proj`): the first positional counts as the root only when it plainly IS one
  (`.`, `..`, a path with `/`, or a directory holding `project.json`) — otherwise it's the
  verb's first real argument.
- A wrong root fails fast with a diagnosis: `…/dir is not a Flux project (no project.json) —
  did you mean <nearest real root>?` (never a misleading "figure not found").
- **File-path verbs** take a file, no root: `validate-plot <plot.svg>`, `rerun-plot <recipe.json>`.

## Verb cheat-sheet

| Verb (CLI) | MCP tool | What it does |
|---|---|---|
| `new <dir> [--title T] [--author A]` | — | scaffold a new project |
| `list` · `reindex` | `list_project` · `reindex` | overview / rebuild `project.json.figures[]` |
| `compose-figure <plots…> [--rows N\|--cols N] [--id slug] [--gap N]` | `compose_figure` | **flagship:** N plots → one labeled, gridded, captioned figure |
| `create-figure [--id slug] [--name N]` | `create_figure` | blank figure |
| `arrange <figId> [--rows N\|--cols N]` · `auto-label <figId>` | `arrange_figure` · `auto_label` | grid panels / letter panels a,b,c… |
| `restyle <figId> <partId> [--stroke c] [--fill c] …` | `restyle_part` | restyle a plot part by **stable id** (survives regeneration) |
| `set-style <ids…> [--fill] [--stroke] …` | `set_style` | element-level style |
| `delete-element <ids…>` · `delete-figure <figId>` · `duplicate-figure <figId>` | `delete_elements` · `delete_figure` · `duplicate_figure` | remove elements / remove or copy a whole figure |
| `align <figId> <edge> [--ids a,b,c]` · `group <ids…>` · `ungroup <ids…>` | `align_figure` · `group_elements` · `ungroup_elements` | align (left/right/top/bottom/centerH/centerV) / group / ungroup |
| `set-z <figId> <front\|back\|forward\|backward> --ids a,b,c` · `set-figure-layout <figId> [--x --y --width --height --background --name]` | `set_z` · `set_figure_layout` | stacking order / figure frame |
| `render-figure <id> [--png] [--out f] [--scale n]` | `get_figure_image {id}` · `render_figure {id}` (SVG) | render to SVG/**PNG** — the **look** step (warns when panels are stale vs `plots/`) |
| `render-canvas [canvasId] [--png] [--out f]` | `get_canvas_image` | render the WHOLE canvas (all figures at their x/y) — catches overlap/layout problems per-figure renders can't |
| `sync-figure [figId]` | `sync_figure` | refresh `fig/assets` copies from regenerated `plots/` sources IN PLACE (captions/restyles survive) |
| `caption <id>` · `set-caption <id> <md> [--panel a]` | `get_caption` · `set_caption` | read / write the caption; the `Lead. **a**, … **b**, …` convention is DISTRIBUTED into per-panel blocks; `--panel` writes one panel |
| `normalize-embeds` | `normalize_embeds` | clear legacy alt-text captions from embed lines (canonical embeds are `![](…){#fig-id}`) |
| `manuscript [--doc r]` · `set-manuscript [--doc r] <text\|--file f>` | `get_manuscript` · `set_manuscript` | read / overwrite a `.qmd` |
| `docs` · `new-doc <name>` | `list_documents` · `create_document` | list / add documents |
| `ref <figId> [--doc r]` | `insert_figure_ref` | append `@fig-<label>` to a doc |
| `add-reference . <bibtex\|--file f>` · `cite-doi <doi>` | `add_reference` · `cite_doi` | grow `references/library.bib` |
| `comments [--doc r] [--all]` · `resolve-comment <id\|quote> [--doc r] [--note "…"]` | `list_comments` · `resolve_comment` | the **review loop** (see manuscript-and-review.md) |
| `compile [--to pdf\|html\|docx]` | `compile` | render the manuscript via Quarto (needs `quarto`) |
| `validate [file]` · `validate-plot <svg>` | `validate_project` · `validate_plot` | check writes / check a semantic plot |
| `rerun-plot <recipe.json> [--key v…]` | `rerun_plot` | **regenerate** a plot from its recipe |
| `fetch-pdfs [--key K]` · `ingest-pdf <file> --key K` | `fetch_pdfs` · `ingest_pdf` | download OA PDFs / file a hand-downloaded PDF into `items/<citekey>/` |
| `annotations [search q] [--key K]` · `add-annotation --key K --quote "…"` | `list_annotations`/`search_annotations` · `add_annotation` | read / add FluxReader highlights & notes |
| — | `get_app_context` · `dispatch_command` · `act_on_selection` | the **live bridge** (app open only) |

### Slides (Flux Slide — see `slides.md`)

| Verb (CLI) | MCP tool | What it does |
|---|---|---|
| `decks` · `new-deck [--title T] [--theme T]` | `list_decks` · `create_deck` | list / create a deck |
| `add-slide <deck> [--name N] [--layout L]` · `delete-slide <deck> <s>` · `duplicate-slide <deck> <s>` | `add_slide` · `delete_slide` · `duplicate_slide` | slide structure |
| `reorder-slides <deck> --order a,b,c` · `set-slide <deck> <s> [--notes\|--camera-x/-y/-zoom\|--layout\|--background]` | `reorder_slides` · `set_slide` | reorder / patch a slide (notes, camera, …) |
| `set-theme <deck> <theme>` | `set_deck_theme` | flux-dark\|light\|midnight\|slate\|sepia\|contrast |
| `add-text <deck> <s> "…"` · `add-math <deck> <s> "\tex"` · `add-embed-figure <deck> <s> <figId>` | `add_slide_text` · `add_slide_math` · `add_slide_figure` | add content (embed-figure keeps panels addressable) |
| `add-beat <deck> <s> [--label L]` · `set-animation <deck> <s> <beat> --target E [--preset P …]` | `add_beat` · `set_animation` | build timeline + animation tracks |
| `validate-deck [deck]` · `export-deck <deck> [--out F]` | `validate_deck` · `export_deck` | schema-check / export one offline `.html` |

## MCP server (richer: typed verbs + inline figure PNGs)

Start per-project (the root is fixed at launch):

```bash
/usr/bin/node /home/driessen2/flux/dist/flux-mcp.mjs /data/microns_analysis/paper
```

Usually you do not start it by hand: configure it for the active agent with either a Codex
project `.codex/config.toml` or a Claude Code `.mcp.json` (see
`manuscript-and-review.md` / the analysis-dir glue). Prefer MCP when you want to **see** a
figure (`get_figure_image` returns the PNG inline) or act on the user's live selection.

## Provenance & locks

- Every write appends a line to `.meta/journal.ndjson` (`ts`, `client`, `action`). Read it to
  see what changed since you last looked (`{action, client}` per line).
- Writes take advisory locks (`project` for figures, `manuscript` for prose/comments). If you
  get `deferred: "<name>" is locked …`, the user is mid-edit in the app — **wait a moment and
  retry**; the lock auto-expires after 30 s if the holder is gone. Never force.
