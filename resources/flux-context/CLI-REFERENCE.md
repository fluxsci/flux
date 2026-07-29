# Running Flux from the command line (and MCP) — stock, shipped with Flux

## How to run the CLI

The `flux` CLI is usually **not on `PATH`**. This machine's resolved invocation (baked in
when Flux synced this doc) is:

```bash
{{FLUX_CLI}} <verb> [args] [--flags]
```

It **operates on any project directory** — where you run it from doesn't pin the project
(see root resolution below), though `cd`-ing into the project is the ergonomic default.

**Drift check:** `flux version` prints `{version, commit, entry}` — if a documented
verb/flag is missing, the bundle may lag the repo; note the mismatch so the owner can
rebuild (`npm run build:cli` in the Flux repo).

**The one rule that avoids all foot-guns: `cd` into the Flux project and run from there.**
Then set your identity and pin the project for the session:

```bash
cd /data/my_analysis/paper               # the Flux project (has project.json)
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
| `arrange <figId> [--rows N\|--cols N]` · `auto-label <figId>` | `arrange_figure` · `auto_label` | grid panels / letter panels a,b,c… (panels missing a label get one created first, so import-plots → arrange → auto-label just works) |
| `add-fig-text <figId> "text" [--x --y --size-pt n] [--panel-label]` | `add_fig_text` | add a text element; `--panel-label` = a semantic panel label auto-label letters |
| `restyle <figId> <partId> [--stroke c] [--fill c] …` | `restyle_part` | restyle a plot part by **stable id** (survives regeneration) |
| `set-style <ids…> [--fill] [--stroke] …` | `set_style` | element-level style |
| `delete-element <ids…>` · `delete-figure <figId>` · `duplicate-figure <figId>` | `delete_elements` · `delete_figure` · `duplicate_figure` | remove elements / remove or copy a whole figure |
| `align <figId> <edge> [--ids a,b,c]` · `group <ids…>` · `ungroup <ids…>` | `align_figure` · `group_elements` · `ungroup_elements` | align (left/right/top/bottom/centerH/centerV) / group / ungroup |
| `cascade <figId> <property> <ids…> [--delta n\|--factor n] [--dl --dc --dh] [--order selection\|layer\|x\|y] [--reverse] [--first-fixed]` | `cascade` | stepped delta across elements — rank k gets `value + delta·step` (step = k with `--first-fixed`, else k+1; `--factor` = ×factor^step); property ∈ x/y/rotation/width/height/opacity/strokeWidth/cornerRadius/fontSize(pt)/fill/stroke/color (colors step in OKLCh via `--dl/--dc/--dh`); a group is ONE rigid rank |
| `set-z <figId> <front\|back\|forward\|backward> --ids a,b,c` · `set-figure-layout <figId> [--x --y --width --height --background --name]` | `set_z` · `set_figure_layout` | stacking order / figure frame |
| `render-figure <id> [--png] [--out f] [--scale n]` | `get_figure_image {id}` · `render_figure {id}` (SVG) | render to SVG/**PNG** — the **look** step (warns when panels are stale vs `plots/`) |
| `render-canvas [canvasId] [--png] [--out f]` | `get_canvas_image` | render the WHOLE canvas (all figures at their x/y) — catches overlap/layout problems per-figure renders can't |
| `sync-figure [figId]` | `sync_figure` | refresh `fig/assets` copies from regenerated `plots/` sources IN PLACE (captions/restyles survive); a changed intrinsic plot size resizes the element true-size + grows the figure frame — re-`arrange` if the grid should reflow |
| `caption <id>` · `set-caption <id> <md> [--panel a]` | `get_caption` · `set_caption` | read / write the caption; the `Lead. **a**, … **b**, …` convention is DISTRIBUTED into per-panel blocks; `--panel` writes one panel |
| `normalize-embeds` | `normalize_embeds` | clear legacy alt-text captions from embed lines (canonical embeds are `![](…){#fig-id}`) |
| `manuscript [--doc r]` · `set-manuscript [--doc r] <text\|--file f>` | `get_manuscript` · `set_manuscript` | read / overwrite a `.qmd` |
| `docs` · `new-doc <name>` | `list_documents` · `create_document` | list / add documents |
| `ref <figId> [--doc r]` | `insert_figure_ref` | append `@fig-<label>` to a doc |
| `add-reference . <bibtex\|--file f>` · `cite-doi <doi>` | `add_reference` · `cite_doi` | grow `references/library.bib` |
| `comments [--doc r] [--all]` · `resolve-comment <id\|quote> [--doc r] [--note "…"]` | `list_comments` · `resolve_comment` | project-wide list/unique resolve by default; `--doc` targets one document (see MANUSCRIPT-AND-REVIEW.md) |
| `add-comment --quote "…" --body "…" [--doc r] [--at n]` | `add_comment` | open a NEW thread — ask the human a question in their margin |
| `feedback [--all]` · `resolve-feedback <id\|text> [--note "…"]` · `send` | `list_feedback` · `resolve_feedback` · `send_feedback` | the **feedback ledger** (context-stamped notes from the app; see MANUSCRIPT-AND-REVIEW.md) |
| `context-init` · `agents` · `dispatch <name> --brief-file f [--model m] [--effort e] [--family fam]` | `ensure_context` · `list_agents` · `dispatch` | heal `Context/` / show the roster matrix / run a worker with a brief (recorded in `Context/Dispatches/`; model/effort default to the session's worker policy — a principal-decides policy REQUIRES the flags) |
| `principal [root] [--no-picker] [--no-transcript] [--print]` (alias `agent`) · `attend [root] [--interval ms]` | — | CLI-only: the launch picker + YOUR principal in THIS terminal with transcript capture / watch the ledger — Send wakes a review pass |
| `compile [--to pdf\|html\|docx]` | `compile` | render via Quarto (needs `quarto`); reports the output path + figures/citations resolution (unresolved `@keys` named) |
| `validate [file]` · `validate-plot <svg>` | `validate_project` · `validate_plot` | check writes + lint (EMPTY figures, figures embedded in no doc, overlapping frames) / check a semantic plot (manifest ids + geometry — rejects log-zero bar anchors) |
| `rerun-plot <recipe.json> [--key v…] [--only [name]]` | `rerun_plot` | **regenerate** a plot from its recipe; `--only` reruns just this recipe's plot from a figure-level script (sibling files untouched) |
| `version` · `config` | `config_paths` | this build's version/commit (bundle vs source) / machine paths + build info |
| `fetch-pdfs [--key K]` · `ingest-pdf <file> --key K` | `fetch_pdfs` · `ingest_pdf` | download OA PDFs / file a hand-downloaded PDF into `items/<citekey>/` |
| `annotations [search q] [--key K]` · `add-annotation --key K --quote "…"` | `list_annotations`/`search_annotations` · `add_annotation` | read / add FluxReader highlights & notes |
| — | `get_app_context` · `dispatch_command` · `act_on_selection` | the **live bridge** (app open only) |

### Slides (Flux Slide — see `SLIDES.md`)

| Verb (CLI) | MCP tool | What it does |
|---|---|---|
| `decks` · `new-deck [--title T] [--theme T]` | `list_decks` · `create_deck` | list / create a deck |
| `add-slide <deck> [--name N] [--layout L]` · `delete-slide <deck> <s>` · `duplicate-slide <deck> <s>` | `add_slide` · `delete_slide` · `duplicate_slide` | slide structure |
| `reorder-slides <deck> --order a,b,c` · `set-slide <deck> <s> [--notes\|--camera-x/-y/-zoom\|--layout\|--background]` | `reorder_slides` · `set_slide` | reorder / patch a slide (notes, camera, …) |
| `set-theme <deck> <theme>` | `set_deck_theme` | flux-dark\|light\|midnight\|slate\|sepia\|contrast |
| `add-text <deck> <s> "…"` · `add-figure <deck> <s> <figId>` | `add_slide_text` · `add_slide_figure` | add content (add-figure COPIES a project figure in — panels stay addressable; slide text is the figure text element: no math/rich-text slide elements) |
| `add-beat <deck> <s> [--label L]` · `set-animation <deck> <s> <beat> --target E [--preset P …]` | `add_beat` · `set_animation` | build timeline + appearance tracks (drawOn/writeOn/fades, trim windows) |
| `set-transform <deck> <s> <beat> --target E […]` · `apply-anim-template <deck> <s>` · `group-tracks` / `ungroup-tracks` | `set_transform` · `apply_anim_template` · `group_tracks` / `ungroup_tracks` | TRANSFORM tracks (element tweens to a changed version of itself; plot data-morphs) / role-matched templates / animator lanes |
| `validate-deck [deck]` · `export-deck <deck> [--out F]` | `validate_deck` · `export_deck` | schema-check / export one offline `.html` |

## MCP server (richer: typed verbs + inline figure PNGs)

Start per-project (the root is fixed at launch):

```bash
{{FLUX_MCP}} /path/to/project
```

Usually you do not start it by hand: the **principal and dispatched workers get it wired
automatically** via the `{mcpJson}` placeholder in `agents.json` (see `AGENTS-CONFIG.md`),
and standalone sessions configure it per analysis dir with `.codex/config.toml` /
`.mcp.json` (templates in `TEMPLATES.md`). Prefer MCP when you want to **see** a figure
(`get_figure_image` returns the PNG inline) or act on the user's live selection.

## Provenance & locks

- Every write appends a line to `.meta/journal.ndjson` (`ts`, `client`, `action`). Read it to
  see what changed since you last looked (`{action, client}` per line).
- Writes take advisory locks (`project` for figures, `manuscript` for prose/comments). If you
  get `deferred: "<name>" is locked …`, the user is mid-edit in the app — **wait a moment and
  retry**; the lock auto-expires after 30 s if the holder is gone. Never force.
