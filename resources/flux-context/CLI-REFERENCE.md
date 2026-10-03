# Running Flux from the command line and MCP (stock — shipped with Flux, do not edit)

## Invocation and root resolution

Use this machine's stable launcher; shell commands below use `flux` as shorthand:

```bash
"{{FLUX_CLI}}" <verb> [args] [--flags]
```

`flux version` reports the version, commit and entry point. If help and a documented
flag disagree, identify the installation with `config` / `connect_doctor`; a source
checkout may need `npm run build:cli`. Do not silently switch installations.

Project CLI verbs resolve `--root` → `FLUX_PROJECT` → cwd. Working from the project
is convenient, but not required. A leading positional root remains supported where
unambiguous (`list /path/to/project`, `render-figure . growth`). Machine/file verbs
such as `config`, `validate-plot` and `rerun-plot` do not require a project.

**Path rule:** CLI filesystem inputs resolve from shell cwd, even with `--root`.
MCP inputs resolve from the project default. Absolute paths work on both surfaces.
Document/folder identifiers remain project-relative model identifiers. A shell glob
expands before Flux sees it; `compose-figure plots/*.svg` requires the intended cwd.
MCP binding and per-call `project` details are below.

Identity is detected from the agent environment/MCP handshake. `FLUX_CLIENT` is an
optional journal/lock identity override, not a required session role. A CLI connect
does not set cwd or environment for subsequent commands.

## Connect, read the pack, return the receipt

```sh
"{{FLUX_CLI}}" connect [<project>|global] [--live] [--refresh] [--depth core|full] [--no-render] [--json]
```

Invoke only when asked for flux-connect. An omitted target finds the project around
cwd; a path may name the project or a directory inside it. Global mode reads machine
context and lists known projects, preserving an existing MCP project binding.

The brief is the reading plan (at most 10,000 characters). Read FLUX.md, CONNECT.md,
then the bundle and named images. Core depth includes ProjectContext and immediate
links, Rules, recent Log and its title index, a project map, open items/activity and
canvas overviews. Full depth adds all documents, individual figures and deck sheets.
`--no-render` omits images; say so in the receipt. `--json` returns structured pack
metadata; it is not a substitute for reading the brief/bundle.

Check every section-end marker and the final sentinel. If a tool truncated the
middle or end, read smaller parts until complete. Use `read_pack {packId,section:"brief"}`,
`read_pack {packId,section:"A"}` (the brief lists section IDs), or sequential
`read_pack {packId,part:1}` calls. Parts are at most 20,000 characters; advance `part`
until the bundle is complete. View images with `get_pack_image {packId,index:0}`
(0-based), or open the printed PNG paths. A stdout-only fallback prints the exact
`connect --part … --pack … --sources …` command to use; keep its source digest.

Return the brief's receipt shape using only what you read and saw. Proof codes are
at bundle section ends and image corners, not in the brief. Never invent them.
`flux connect --check-receipt <packId> "<proof line>"` checks coverage; MCP uses
`connect_doctor {checkReceipt:{packId,proof:"<proof line>"}}`. Report missing sections,
trimmed material, unavailable renders and template ProjectContext honestly, then wait.

A "↻ Since you last looked" line on MCP results, and the Claude Code prompt hook,
reports external changes during a connected session. `read_delta {}` reads details
and advances the cursor; it can include new canvas images. `connect --refresh`
(or MCP `connect {refresh:true}`) produces a refreshed pack and change summary.
Read relevant changes before acting. Refresh does not authorize new work or watching.

## Verb cheat-sheet

| Verb (CLI) | MCP tool | What it does |
|---|---|---|
| `connect [<project>\|global] [--live] [--refresh] [--depth core\|full] [--no-render] [--json]` | `connect` | read context and images, then return the brief's receipt; explicit invocation only |
| `connect setup` · `connect doctor` · `connect remove` | `connect_doctor` (doctor only) | agent registration/health; setup and remove are CLI-only, see below |
| — | `read_pack` · `get_pack_image` · `read_delta` | bounded pack text, indexed pack images, and changes since the session's cursor |
| `mcp [root] [--toolset core\|full]` | `flux_verbs` · `flux_verb` | stdio server; discover schemas / invoke tools outside the compact default list |
| `new <dir> [--title T] [--author A]` | — | scaffold a new project |
| `list` · `reindex` | `list_project` · `reindex` | overview / rebuild `project.json.figures[]` |
| `compose-figure <plots…> [--rows N\|--cols N] [--id slug] [--gap N]` | `compose_figure` | **flagship:** N plots → one labeled, gridded, captioned figure |
| `create-figure [--id slug] [--family f --number n --nickname N]` | `create_figure` | blank figure (default: appended to the main **figure** family; the display name derives from family + number) |
| `set-figure-family <figId> [--family figure\|supplementary\|extended-data\|<custom>] [--number n] [--nickname N \| --clear-nickname]` | `set_figure_family` | structured identity — `--number` inserts at that position and shifts the rest (refs stay valid; numbers are always contiguous 1..N) |
| `define-figure-family --id slug --display-name N [--ref-template "Mov. {num}{panel}"] [--caption-template "Movie {num} \| "]` · `remove-figure-family <id>` | `define_figure_family` · `remove_figure_family` | define/update a custom family / drop one (members move to the figure family) |
| `arrange <figId> [--rows N\|--cols N]` · `auto-label <figId>` | `arrange_figure` · `auto_label` | grid panels / letter panels a,b,c… (panels missing a label get one created first, so import-plots → arrange → auto-label just works) |
| `add-fig-text <figId> "text" [--x --y --size-pt n] [--panel-label]` | `add_fig_text` | add a text element; `--panel-label` = a semantic panel label auto-label letters |
| `toggle-text-run-style <elId> <from> <to> <bold\|italic\|underline>` · `toggle-text-run-script <elId> <from> <to> <super\|sub>` · `set-text-run-color <elId> <from> <to> <#hex\|inherit>` | `toggle_text_run_style` · `toggle_text_run_script` · `set_text_run_color` | format a character RANGE of one text element (0-based offsets into its text, `to` exclusive) — what selecting letters in the editor does; `toggle-text-style <bold\|italic\|underline> <ids…>` still styles whole elements |
| `restyle <figId> <partId> [--stroke c] [--fill c] …` | `restyle_part` | restyle a plot or 3D part by **stable id** (`restyle-part` is an alias) (survives regeneration) |
| `set-series-color <figureId\|deckId/slideId> <seriesId> <#rrggbb\|--clear> [--element id]` | `set_series_color` | one colour for a WHOLE plot series — line stroke, marker faces + edges, bar / band fills, error bars and its legend swatch, one override per part (survives regeneration); `--clear` restores the generated colours; a colour-mapped series is refused (use `set-plot-color-scale`); `restyle` of a series' whole line / points also repaints its legend swatch |
| `get-plot-data <figureId\|deckId/slideId> [elementId] [--series id --fields series,colorScales,axes,overlays,guides,style,lut --offset n --limit n]` | `get_plot_data` | a plot's DATA from its fluxplot manifest: series with exact x/y, per-point ids and colour; hexmatrix bins, glowbar / fluxbox statistics, distributions, field values, image channels, bands; colour scales (tables only with `lut`); axis domains and scales; overlays with a bracket's test / p / effect size. Arrays longer than `--limit` (default 1000) are windowed from `--offset` and listed in `pages` with their true length — read data precisely instead of from a PNG |
| `set-style <ids…> [--fill] [--stroke] [--fill-opacity 0–1] [--stroke-opacity 0–1] …` | `set_style` | element-level style; the channel alphas are independent of `--opacity`, which multiplies both |
| `delete-element <ids…>` · `delete-figure <figId>` · `duplicate-figure <figId>` | `delete_elements` · `delete_figure` · `duplicate_figure` | remove elements / remove or copy a whole figure |
| `align <figId> <edge> [--ids a,b,c]` · `group <ids…>` · `ungroup <ids…>` | `align_figure` · `group_elements` · `ungroup_elements` | align (left/right/top/bottom/centerH/centerV) / group / ungroup |
| `cascade <figId> <property> <ids…> [--delta n\|--factor n] [--dl --dc --dh] [--order selection\|layer\|x\|y] [--reverse] [--first-fixed]` | `cascade` | stepped delta across elements — rank k gets `value + delta·step` (step = k with `--first-fixed`, else k+1; `--factor` = ×factor^step); property ∈ x/y/rotation/width/height/opacity/strokeWidth/cornerRadius/fontSize(pt)/fill/stroke/color (colors step in OKLCh via `--dl/--dc/--dh`); a group is ONE rigid rank |
| `set-z <figId> <front\|back\|forward\|backward> --ids a,b,c` · `set-figure-layout <figId> [--x --y --width --height --background --name]` | `set_z` · `set_figure_layout` | stacking order / figure frame (`--name` legacy seam: a designation like "Figure S3" routes to family+number, anything else becomes the nickname — prefer `set-figure-family`) |
| `render-figure <id> [--png] [--out f] [--scale n]` | `get_figure_image {id}` · `render_figure {id}` (SVG) | render to SVG/**PNG** — the **look** step (warns when panels are stale vs `plots/`) |
| `render-canvas [canvasId] [--png] [--out f]` | `get_canvas_image` | render the WHOLE canvas (all figures at their x/y) — catches overlap/layout problems per-figure renders can't |
| `sync-figure [figId]` | `sync_figure` | refresh `fig/assets` copies from regenerated `plots/` sources IN PLACE (captions/restyles survive); a changed intrinsic plot size resizes the element true-size + grows the figure frame — re-`arrange` if the grid should reflow |
| `caption <id>` · `set-caption <id> <md> [--panel a]` | `get_caption` · `set_caption` | read / write the caption; the `Lead. **a**, … **b**, …` convention is DISTRIBUTED into per-panel blocks; `--panel` writes one panel; `--panel __ps__` writes unlabelled closing prose |
| `normalize-embeds` | `normalize_embeds` | clear legacy alt-text captions from embed lines (canonical embeds are `![](…){#fig-id}`) |
| `manuscript [--doc r]` · `set-manuscript [--doc r] <text\|--file f>` | `get_manuscript` · `set_manuscript` | read / overwrite a `.qmd` |
| `docs` · `new-doc <name> [--folder DIR]` · `delete-doc <path>` | `list_documents` · `create_document` · `delete_document` | list / add / delete documents (delete removes the `.qmd` + its comments sidecar and the manifest forgets it; legacy main manuscripts and standard Context docs are protected; figures and references it used are untouched) |
| `new-doc-folder <parent> <name>` · `move-doc <path> <folder>` | `create_document_folder` · `move_document` | create nested folders / move documents with comments and relative links; existing destination files are refused |
| `ref <figId> [--doc r]` | `insert_figure_ref` | append `@fig-<label>` to a doc |
| `insert-slide-embed <deck> <slide> [--doc r] [--width 75%] [--caption "…"] [--anchor "unique text"]` | `insert_slide_embed` | insert a linked slide block, generate its step-0 SVG, and return IDs + Markdown. Anchor must occur exactly once; omitted anchor appends. HTML plays manually; PDF/Word show step 0 |
| `add-reference . <bibtex\|--file f>` · `cite-doi <doi>` | `add_reference` · `cite_doi` | grow `references/library.bib` |
| `zotero-sync [--bib f] [--data-dir d] [--attach copy\|link] [--defer-fulltext] [--force] [--save]` | `zotero_sync` | pull new references + PDFs from the connected Zotero Better-BibTeX auto-export into FluxLib (one-way, idempotent; an UNCHANGED export is skipped from a stat alone — `--force` re-scans and also picks up attach backfill; `--defer-fulltext` links pointers without reading the PDFs — text backfills lazily; `--save` persists overrides as the machine settings) |
| `comments [--doc r] [--all]` · `resolve-comment <id\|quote> [--doc r] [--note "…"]` | `list_comments` · `resolve_comment` | project-wide list/unique resolve by default; `--doc` targets one document (see REVIEW.md) |
| `add-comment --quote "…" --body "…" [--doc r] [--at n]` | `add_comment` | open a NEW thread — ask the human a question in their margin |
| `inbox [query] [--kind annotation\|comment] [--surface s] [--doc d] [--figure f] [--deck d] [--tag a,b] [--status s, …\|all] [--archived] [--since ISO] [--text t] [--holder name] [--claimed me\|others\|none\|any] [--mine] [--packets] [--json]` | `list_inbox` | Unified annotations and comments; `packets:true` adds current target state and up to six inline images. |
| `wait-inbox [query] [filters] [--timeout seconds] [--cursor c] [--mode queue\|annotations\|filter]` | `wait_for_inbox` | Opt-in wait for routed items; returns `{items,cursor,stopped,revoked}`. |
| `claim <id> [--note text] [--force]` | `claim_item` | First live claimant wins. Force only on explicit instruction. |
| `release <id>` | `release_item` | Release your claim. |
| `reply <id> <text…> [--needs-input]` | `reply_item` | Reply in the thread; flag a question for the user. |
| `resolve <id\|unique quote> [--note text]` | `resolve_item` | Resolve after completing the work. |
| `archive <id>` · `unarchive <id>` | `archive_item` · `unarchive_item` | Hide or restore items when asked. |
| `inspect <TargetRef-json\|kind:ids>` | `get_target` | Saved target state without rendering. Example: `part:fig-2/el-9#control`. |
| — | `get_inbox_image` | Fetch a snapshot by id; PNG, long edge ≤1600 px. In core mode use `flux_verb {verb:"get_inbox_image",args:{id:"…"}}`. |
| `context-init` | `ensure_context` | ensure the project's `Context/` layer exists |
| `log <text…> [--title "…"] [--file f] [--agent a] [--surface s] [--checkpoint]` | `write_log` | append a dated entry to the **Log** (`Context/NOTEBOOK.md`) only when asked; automatic agent · surface · host:cwd byline, manuscript lock, newest last |
| `read-log [--tail n] [--since-checkpoint] [--titles] [--json]` | `read_log` | read entries as Markdown (`--json` for parsed objects); checkpoints include the summary and later entries, titles omit bodies, history is never deleted |
| `compile [--doc path.qmd] [--to pdf\|html\|docx] [--zotero-fields] [--zotero-library a.docx,b.docx]` | `compile` | render via Quarto (needs `quarto`); reports the output path + figures/citations resolution (unresolved `@keys` named). `--zotero-fields` writes docx citations as live Zotero fields (refreshable/restylable in Word); `--zotero-library` takes .docx files already written with Zotero, binding citations to the same works to that library |
| `validate [file]` · `validate-plot <svg>` | `validate_project` · `validate_plot` | check writes + lint (EMPTY figures, figures embedded in no doc, overlapping frames) / check a semantic plot (manifest ids + geometry — rejects log-zero bar anchors) |
| `rerun-plot <recipe.json> [--key v…] [--only [name]]` | `rerun_plot` | **regenerate** a plot from its recipe; `--only` reruns just this recipe's plot from a figure-level script (sibling files untouched) |
| `list-dissections [plot]` | `list_dissections` | a plot's companion material in `plots/_dissections/<plot>/` (groups + files); no arg = every plot that has a dissection folder. Writing needs no verb — drop files in the folder |
| `version` · `config` | `config_paths` | this build's version/commit (bundle vs source) / machine paths + build info |
| `search <query…>` · `search-text <query…>` | `search_references` · `search_fulltext` | library metadata / stored PDF text; LIBRARY.md covers query fields and research tools |
| `lib-add <doi\|bibtex…> [--file f] [--attach-files]` | `add_to_library` | add exactly one DOI, BibTeX text or file input to FluxLib; file imports support BibTeX/RIS and attachments |
| `assign-pdfs [--dry-run]` | `assign_pdfs` | identify PDFs in FluxLib's pdfs_to_assign inbox from their contents; uncertain matches remain unresolved |
| `snip-paper <key> --page N [--rect x1,y1,x2,y2]` · `cite <key>` | `snip_paper` · `get_citation` | PDF-region PNG with provenance / short formatted citation |
| — | `get_reading_context` · `get_paper_text` | the Reader's captured selection/page/Highlights / a stored paper's text; use `flux_verb` in core mode |
| — | `search_world` · `semantic_search` · `similar_papers` · `citing_works` | discovery beyond FluxLib; OpenAlex and optional Semantic Scholar sources, see schemas |
| `fetch-pdfs [--key K]` · `ingest-pdf <file> --key K` | `fetch_pdfs` · `ingest_pdf` | download OA PDFs / file a hand-downloaded PDF into `items/<citekey>/` |
| `highlights [search q] [--key K] [--md]` · `add-highlight --key K --page N --quote "…"` | `list_highlights`/`search_highlights` · `add_highlight` | read / add FluxReader highlights & notes |
| — | `get_app_context` · `dispatch_command` · `act_on_selection` | the **live bridge** (app open only) |
| `view --png --out <file> [--max-edge n] [--root R]` | `get_view {maxEdge?}` | capture the open project's Flux window as PNG plus current context; maxEdge defaults to 1600, clamped to 256–1600; requires viewing enabled in Settings |

### Figure 3D models

| Verb (CLI) | MCP tool | What it does |
|---|---|---|
| `add-model <figureId> <source.glb> [--x n --y n --width n --height n --name N --view '<json>']` | `add_model` | Copy a GLB and optional raw sidecars into the figure; returns element/asset IDs, parts, warnings and a poster result. |
| `set-model-view <elementId> [--figure id --preset front\|back\|right\|left\|top\|bottom\|home --azimuth n --elevation n --roll n --zoom n --pan-x n --pan-y n --projection orthographic\|perspective --fov n --colors source\|uniform --color c --lighting studio\|unlit]` | `set_model_view` | Patch the saved model view. Explicit properties apply after the preset. Repeat `--state name=weight`, or use `--frame n` for a sequence; these forms are exclusive. |
| `set-model-field <elementId> <fieldId> [--cmap name --min n --max n \| --reset]` | `set_model_field` | Remap a value field's colormap and range (switches the model to source colours; explicit part fills survive). `--reset` drops the remapping. |
| `restyle-part <figureId> <partId> [--element id --fill c --opacity n --hidden \| --show]` | `restyle_part` | Alias of `restyle`, using the same stable mesh/furniture/group IDs. A mesh fill on a model in uniform colours switches it to source colours in the same edit, so the fill shows. |
| `model-info <source.glb> [--morph-with other.glb]` | `model_info` | Read-only file inspection: stats, bounds, topology, names, fields, warnings/refusal and optional morph compatibility; no project required. Fails for a missing file or a path that is not `.glb`. |
| `render-model-posters [--figure id \| --deck id --slide id] [--prune]` | `render_model_posters` | Batch-render saved Figure views, or a deck's Design stills and every build step's still, into the project cache. Pruning protects every live figure view and deck step still and all entries younger than 14 days, and also bounds the shared machine cache (14 days, then least-recently-used down to 1 GiB). |

Live `dispatch_command` also takes `set_model_view` and `set_model_field` (camelCase
parameters, `target` or the current selection) as one Undo step. Posters, `--no-poster`,
`--state` rules and the deck refusal: `PROJECT-AND-FIGURES.md` → "3D model panels".

### Slides (Flux Slide — see `SLIDES.md`)

| Verb (CLI) | MCP tool | What it does |
|---|---|---|
| `decks` · `new-deck [--title T] [--theme T]` | `list_decks` · `create_deck` | list / create a deck |
| `add-slide <deck> [--name N] [--layout L]` · `delete-slide <deck> <s> [--force]` · `duplicate-slide <deck> <s>` | `add_slide` · `delete_slide` · `duplicate_slide` | slide structure |
| `reorder-slides <deck> --order a,b,c` · `set-slide <deck> <s> [--notes\|--camera-x/-y/-zoom\|--layout\|--background]` | `reorder_slides` · `set_slide` | reorder / patch a slide (notes, camera, …) |
| `set-theme <deck> <theme>` | `set_deck_theme` | flux-dark\|flux-light\|flux-paper\|flux-midnight\|flux-slate\|flux-sepia\|flux-contrast |
| `add-text <deck> <s> "…"` · `add-figure <deck> <s> <figId>` | `add_slide_text` · `add_slide_figure` | add content (add-figure COPIES a project figure in — panels stay addressable; slide text is the figure text element: no math/rich-text slide elements) |
| `add-slide-model <deck> <s> <source.glb> [--x n --y n --width n --height n --name N --no-poster]` | `add_slide_model` | Import a project-owned GLB and sidecars; returns element/asset IDs and warnings. |
| `add-turntable <deck> <s> <beat> <element> [--turns n --direction cw\|ccw --duration ms --start ms]` | `add_turntable` | Add a linear, unwrapped model orbit Change; defaults to one clockwise turn over 6000 ms. |
| `add-video <deck> <s> plots/_videos/clip.mov` | `add_slide_video` | import MP4/MOV, preserving original; optional `--x`, `--y`, `--width`, `--height`, `--muted`, `--loop` |
| `set-video-track <deck> <s> <beat> <el> start` | `set_video_track` | playback command (`start`, `pause`, `stop`), independent of appearance; `--start ms` offset, after Design |
| `set-video-settings <deck> <s> <el> --muted true --loop false` | `set_video_settings` | set clip audio/loop options |
| `add-beat <deck> <s> [--label L]` · `set-animation <deck> <s> <beat> --target E [--preset P …]` | `add_beat` · `set_animation` | build timeline + appearance tracks (drawOn/writeOn/fades, trim windows) |
| `set-plot-view <figureId\|deckId/slideId> <elementId> [--x-min N --x-max N --y-min N --y-max N --x-scale linear\|log --y-scale linear\|log --y2-min N --y2-max N --y2-scale linear\|log --reset] [--beat ID]` | `set_plot_view` | save a data-unit Axis view (lines, points, bars, cells and hexagons re-project; the viewed axis is re-ticked; `--y2-*` / `--x2-*` address a twin value axis); a deck beat writes a Change, reset restores generated axes |
| `set-plot-color-scale <figureId\|deckId/slideId> <elementId> [--scale ID --cmap NAME --reversed --norm linear\|log\|symlog\|power\|twoslope\|centered --vmin N --vmax N --center N --gamma N --linthresh N --linscale N --extend neither\|min\|max\|both --reset] [--beat ID] [--regenerate]` · `get-plot-color-scales <figureId\|deckId/slideId> <elementId> [--beat ID]` | `set_plot_color_scale` · `get_plot_color_scales` | recolour a plot's colour scale LIVE in data units (colormap, limits, norm, extend); a deck beat writes a Change the colours tween through; `--regenerate` writes the complete `__fluxplot__` control and re-runs the recipe; get lists scales, editability and the live view |
| `set-transform <deck> <s> <beat> E [--curve grammar --arc -1..1] […]` · `apply-anim-template <deck> <s>` · `group-tracks` / `ungroup-tracks` | `set_transform` · `apply_anim_template` · `group_tracks` / `ungroup_tracks` | TRANSFORM tracks (element tweens to a changed version of itself; plot-content Become) / role-matched templates / animator lanes |
| `anim-style create <deck> --name L --family F --preset P [--curve grammar --params json --influence json --arc -1..1 --stagger json]` · `anim-style set <deck> <id> [--curve grammar --params json --influence json --arc -1..1 --stagger json]` · `anim-style delete <deck> <id>` · `anim-style list <deck>` | `anim_style` | deck-level linked effect settings; deletion preserves linked tracks' resolved settings |
| `animate-like <deck> <s> --from t1 --to t2,t3 [--beat beatId]` · `set-track <deck> <s> <t> [--style id\|--no-style] [--anchor t1:end:0\|--no-anchor] [--start ms --duration ms --curve grammar] [--stagger-each ms\|--stagger-total ms] [--stagger-curve curve --stagger-from random --stagger-by index\|x\|y\|value\|count\|data-index --seed n]` | `animate_like` · `set_track` | link effects by family; follow same-step timing; resolved start is reported with an anchored marker |
| `align-tracks <deck> <s> --tracks t1,t2 --edge start\|end --to ms\|t3[:start\|end] [--beat id\|index] [--resize]` · `inherit-track <deck> <s> --from t1 --to t2,t3 [--beat id\|index] [--include-start]` | `align_tracks` · `inherit_track` | the Animator's Alt+A / Alt+D (land resolved starts or ends on a time or another effect's edge; `--resize` keeps the opposite edge; a moved start detaches an anchor) and Ctrl+Alt-drag Inherit (exact animation parameters: a linked source links the targets; otherwise duration, curve, stagger, and same-phase preset/params/arc copy; start only with `--include-start`) |
| `ghost-transform <deck> <s> <beat> <source> [--count 3 --original stay\|disappear\|transform --states '<json array>']` | `ghost_transform` | create independent copies that begin at the source's prior-step state and transform to separate destinations; returns copy/track IDs for later edits |
| `become <deck> <s> <beat> <source> --target E [--part a,b --source-part c,d --mode consume\|handoff --pair auto\|spatial\|order\|data\|tile --reveal flip\|draw --method shatter\|dissolve\|collapse\|drain]` | `become` | Become a live destination; `--to E` (repeatable) or `--members '[{"element":E,"parts":[…]},…]'` instead of `--target` names a destination SET (objects and parts of any plots, always a hand-off); `--asset ID [--force]` instead performs a data-only Become; all forms accept `--start`, `--duration`, `--easing` |
| `appear-from <deck> <s> <beat> --dest E --from S [--part a,b --source-part c,d --pair P --reveal flip\|draw --method M --start ms --duration ms --easing E]` | `appear_from` | Appear from… authors the same source-owned hand-off; `--members <json>` instead of `--dest` reveals a destination set |
| `swap-become <deck> <s> <track>` | `swap_become` | reverse a hand-off Become, preserving timing, style and follower links |
| `set-beat <deck> <s> <beat> [--label L --advance click\|with-prev\|auto --auto-delay ms]` | `set_beat` | edit step label and advance timing |
| `reorder-beats <deck> <s> --order b0,b2,b1` | `reorder_beats` | reorder steps; the resting step stays first |
| `move-track <deck> <s> <track> <toBeat> [--at lane]` | `move_track` | move an effect to another step; cross-step anchors detach at their resolved time |
| `duplicate-track <deck> <s> <track>` | `duplicate_track` | duplicate an effect with a fresh id immediately after it |
| `reorder-tracks <deck> <s> <beat> --order t2,t1` | `reorder_tracks` | set lane order without changing timing |
| `set-track-enabled <deck> <s> <track> [--enabled true\|false]` | `set_track_enabled` | enable/disable an effect while preserving its settings |
| `set-part-visibility <deck> <element> <part> [--mode show\|animate\|mask]` | `set_part_visibility` | retained headless/back-compat resting visibility control; no GUI tri-state |
| `set-part-style <deck> <element> <part> --patch '<json>'` | `set_part_style` | merge part-style overrides; null deletes a key |
| `validate-deck [deck]` · `export-deck <deck> [--out F]` | `validate_deck` · `export_deck` | schema-check / export one offline `.html` |
| `export-slide-video <deck> <slide> [--out F]` | `export_slide_video` | single-slide MP4; `--step-delay`, `--start-hold`, `--end-hold` in milliseconds; `--height 720\|1080\|2160`, `--fps 30\|60` |

`--curve` accepts the grammar and catalog names in [SLIDES.md](SLIDES.md):
`spring(0.35[, v=2])`, `spring(k=170,c=26,m=1)`, `bezier(x1,y1,x2,y2)` /
`cubic-bezier(...)`, `steps(n[,start|end])`, or `standard`, `smooth`, `enter`, `exit`,
`linear`, `gentle`, `overshoot`, `anticipate`, `anticipate + overshoot`, `settle`,
`snappy`, `bouncy`, `playful`, `steps`, `hold`. Legacy `--easing` remains supported.

## MCP server (richer: typed verbs + inline figure PNGs)

Start with an optional default project (connect can change it):

```bash
{{FLUX_MCP}} /path/to/project
```

Register supported agents with `connect setup` (below). Prefer MCP when you want to **see** a figure
(`get_figure_image` returns the PNG inline) or act on the user's live selection.

## Provenance & locks

- Every write appends a line to `.meta/journal.ndjson` (`ts`, `client`, `action`). Read it to
  see what changed since you last looked (`{action, client}` per line).
- Writes take advisory locks (`project` for figures, `manuscript` for prose/comments/notebook
  log entries). If you
  get `deferred: "<name>" is locked …`, the user is mid-edit in the app — **wait a moment and
  retry**. The operation owns renewal/release; do not remove a lock or force a write.

## MCP connection and paths

`flux mcp [root] [--toolset core|full]` starts the stdio server. It can start without a
project. A root argument, `FLUX_PROJECT`, or the nearest project within eight cwd
levels supplies a default root; this alone does not connect or load context.
Call `connect {target:"/path/to/project"}` only when the user asks for flux-connect.
Use `target:"global"` for global context; it preserves any existing project binding. A project tool accepts an optional
`project` override; relative overrides resolve against the bound project and do not
change it. With no binding, pass an absolute project path.

CLI filesystem inputs resolve relative to the shell cwd. MCP filesystem inputs resolve
relative to the project root. Absolute paths are honoured. Machine/file tools work
unbound with absolute paths; relative paths require a project default. Document and
folder identifiers remain project-relative model identifiers on both surfaces.

The default `core` toolset is compact. `flux_verbs` lists every verb and tool in one
line each; `flux_verbs {query}` returns the matches with their schemas; `flux_verb
{verb, args}` runs any of them with the same validation and result as its dedicated
tool, including tools the core list does not show. Select `--toolset full` or `FLUX_MCP_TOOLSET=full` to
expose all dedicated tools. The MCP `connect` prompt provides a skill-free entry.


## Agent installation and health

Setup is a user-authorized CLI operation, outside the MCP verb registry:

```sh
"{{FLUX_CLI}}" connect setup --dry-run
"{{FLUX_CLI}}" connect setup --agents claude,codex
"{{FLUX_CLI}}" connect doctor --json
"{{FLUX_CLI}}" connect remove --agents codex --yes
```

Setup preserves unmanaged skills and unrelated registrations, and backs up changes.
Use `--yes` to confirm a replacement, `--use-this-install` to select the launcher
owner, or `--create-local-bin` for convenience shims. Restart agent sessions afterward.
Codex users review the installed refresh hook in `/hooks`. The read-only core MCP
`connect_doctor` returns the same per-check diagnostics; it cannot change agent config.
Personal UserContext skills publish only to connected vendors, with collisions and
edited copies left intact. The flux-connect skill itself requires explicit invocation.
