# Manuscript authoring (stock — shipped with Flux, do not edit)

## Documents are Quarto `.qmd`

Documents live under `paper/` in new projects (starting with deletable `notes.qmd`) or
legacy `manuscript/`, with arbitrary nested folders. No `main.qmd` filename is required.
They are plain Quarto markdown with YAML front-matter (title, `bibliography: ../references/library.bib`).
**The `.qmd` is the source of truth** — edit it directly, or via the verbs:

```bash
"{{FLUX_CLI}}" manuscript                 # read the default document (--doc for others)
"{{FLUX_CLI}}" set-manuscript --file draft.md   # overwrite (holds the manuscript lock + journals)
"{{FLUX_CLI}}" docs                       # list documents
"{{FLUX_CLI}}" new-doc "Supplement"       # add one
```

When the app is open, an external `.qmd` write **live-reloads** if the user's editor is clean;
if they have unsaved edits it shows a non-destructive "reload / keep mine" banner (never
clobbers their work). For big rewrites of hand-edited prose, prefer proposing the change.

## Cross-references and citations (literal Quarto text in the `.qmd`)

- **Figures:** write `@fig-<label>` (panel: `@fig-<label>-a`). Append one with
  `ref growth` → adds `See @fig-growth.`. Display names ("Figure 3") come from the figure
  family and number; stable reference keys are independent of document/canvas order. Panel refs survive `compile` too: they're translated to literal
  "Figure 3a" text at render time (bare Quarto only knows whole-figure refs).
- **Citations:** write `[@citekey]`. Grow the library with
  `cite-doi 10.1038/nature12373` (fetches BibTeX — it echoes the fetched
  author/title/year in full; CHECK it, registries serve junk metadata on automated deposits)
  or `add-reference . <bibtex>` / `add-reference . --file refs.bib`. Citekeys are stable join keys.
- **Embedding a figure** in the prose (an actual image): `![](../fig/renders/<id>.svg){#fig-<id>}`
  — **leave the alt empty.** The caption comes from the figure model (with a readable projection at
  `fig/captions/<id>.md`, both updated by `set-caption`) and renders live under the figure; Quarto exports get it injected at
  compile time. Never paste caption text into the `![…]` alt slot (the app clears it anyway;
  `normalize-embeds` fixes legacy docs). In the editor the embed line shows as a compact chip
  carrying the figure's NAME — name figures well (`set-figure-family <id> --nickname "Growth response"`).
- **Section IDs:** standard Quarto header attributes (`## Results {#sec-results}`) are fine —
  the editor hides the `{#…}` tail unless the caret is on the heading.
- **Inline slides:** `insert-slide-embed <deck> <slide> --doc paper/report.qmd` inserts a
  linked block with a generated step-0 SVG. Optional `--width`, `--caption`, and a unique
  `--anchor` use the same document syntax as the picker. HTML advances one authored beat
  per click; PDF/Word show step 0. Source IDs survive deck renames/reordering. Do not copy
  speaker notes into the caption or use figure-reference normalization on `.flux-slide` blocks.
- **Compile:** `compile --doc paper/report.qmd --to pdf|html|docx` (needs `quarto` on PATH).

## Context documents

`Context/ProjectContext.qmd`, `Context/NOTEBOOK.md` and `Context/RULES.md` open in Paper
and support margin comments. ProjectContext is the user's must-read hub, Rules hold
standing instructions, and the notebook holds an append-only Log. Propose changes to
ProjectContext/Rules; write Log entries only when asked, using `log` / `write_log`
instead of replacing the notebook. Read CONNECT.md for the Log contract and REVIEW.md
before handling any comment thread.

## Compile and check the deliverable

`compile` selects the default document or an explicit `--doc`; check that choice
before rendering. It prepares figure renders and model captions, resolves panel
references and citations, and reports the output path and unresolved keys. Inspect
both that report and the actual HTML/PDF/Word output. A successful command is not
proof every figure or citation appeared.

Use `render-figures` to materialize `fig/renders/` for a bare Quarto workflow;
prefer `compile` when the document uses Flux panel references or inline slides.
Quarto must be installed, with the requested format's prerequisites (for example
TeX for PDF). Missing prerequisites are a reported gap, not a completed export.

For Word, `--zotero-fields` produces editable Zotero citation fields. Supply
`--zotero-library <existing.docx>` to bind matching works to the library already used
in that document. Check the citation-resolution report; do not promise all text
constructs become live fields. Figure captions stay on the figure model.

Use `validate` after authoring to check project structure, empty figures, figures
not embedded in any document, and overlapping canvas frames. Read
PROJECT-AND-FIGURES.md for figure identity and caption ownership, LIBRARY.md for
reference acquisition, and SLIDES.md for the source deck of an inline slide.
