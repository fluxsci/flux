# Changelog

Releases are tagged `vX.Y.Z` (equal to `package.json`'s version) and shipped as a GitHub
Release that the one supported installer picks up:

```bash
curl -fsSL https://fluxsci.github.io/install.sh | bash
```

## Unreleased

## 0.3.0 — 2026-11-08

### Working with agents

- **Ask (Ctrl+Shift+J) reads as correspondence.** The panel opens beside what you selected (the
  selection stays outlined), adopts its instant placeholder's exact footprint, and keeps its place
  while the answer streams. Answers render as real Markdown — headings, lists, fenced code with
  Copy, tables, links — in the manuscript's serif; your questions sit on the right. The agent's
  working notes fold into one line ("Read 3 files · get_figure_image") that opens into each step,
  with the pictures it looked at inline; thinking folds the same way. A status line says what the
  agent is doing and for how long; a faint line under the answer reports tools, tokens, cost and
  time. Esc stops a busy run before it closes; Copy, Keep (with an Open action) and Resume in
  terminal appear once there is an answer, and **Do it ▸** hands the question and answer to a
  background agent on the same anchor; errors offer AI status or Retry.
- **The Inbox (Alt+Q) is a conversation.** Rows show a surface icon or a real thumbnail and say in
  words where they point; "Needs input" is gold, and so is the titlebar badge while an agent waits
  on you. The detail pane shows your note with its marked picture, replies rendered as Markdown
  with the agent's mark in the gutter, "Waiting for you" on the question that needs an answer, one
  action bar, and a copyable short id. Background runs appear as a live card in the thread with
  everything the agent says and does (streamed prose was dropped before). `?` lists the filter grammar.
- **Annotate (Ctrl+Shift+M) is a still you draw on.** The frozen view is framed and labelled; a
  capsule carries the tools; chips name targets in words and light up their marks when hovered;
  the To: pill shows the chosen agent and whether it is watching; Attach view is a switch; a toast
  says where the note went with an Open action.
- One shared vocabulary under all three: the Flux seed marks the agent (it turns only while a run
  is busy), one surface header, one composer, inert Markdown for agent text (model HTML never
  becomes markup), and fades that survive a reduced-motion desktop.

### Paper

- Journal submission export for **Nature, Science, Cell and bioRxiv**: Word and PDF, venue rules
  (title page, citations, reference lists, section order, legends, line numbers, page setup), a
  venue-aware Journal Check, stages in the export dialog and an export summary. The export assets
  now ship in packaged builds.
- Typing no longer relays out the whole shell: the editor host is a relayout boundary.
- Spelling: a hover menu, every fix learned into the project's language profile, language profiles
  refresh across windows, and a scientific vocabulary of single words Harper can match.
- **Manuscript Check (Alt+K) and `flux check`.** Deterministic pre-submission checks in one pure
  platform with six rule packs: references and citations (undefined cross-refs with did-you-mean
  fixes, missing panels, unknown embeds, duplicate labels, citekeys missing from the bib, duplicate
  or incomplete references), display items (figures and tables cited out of order or never cited,
  unnamed panels, empty captions), placeholders (TODO, `[??]`, `[citation needed]`, "n = XX", lorem
  ipsum), abbreviations (used before defined, defined twice, defined but unused, never defined),
  consistent terms (compound and British/American variants, "et al" without its period) and open
  margin comments. Findings jump to their range; a fix is one undoable edit, refused if the text has
  changed since the check. The pane runs in a worker on summon, after typing settles and on Check now;
  the CLI/MCP twin produces byte-identical findings. One citation scanner now serves the editor,
  flux-core and FluxLib (code, math and front matter are masked everywhere).
- **Superscript and subscript everywhere.** `CO~2~`, `10^-3^`, `Ca^2+^` render in the editor (markers
  hidden off-caret), the Preview and house HTML, captions and table cells; spelling skips them and the
  unit after a quantity. **Ctrl+.** / **Ctrl+,** wrap and unwrap; x² / x₂ sit on the selection toolbar.
  Word export was already right through Pandoc and is now gated.
- **Document properties replace the title pill's form, and saving no longer destroys metadata.** The
  old Save rebuilt `author:` as names only and re-dumped the YAML block, deleting affiliations,
  corresponding/equal-contribution/lead-contact flags, emails, ORCIDs and every comment — the exact
  fields the journal export reads. Front-matter edits are now byte-minimal and proven against a
  re-read of the YAML; the sheet edits authors (name, email, ORCID with checksum, roles, affiliation
  chips) and affiliations (institution, department, city, country) with reordering.
- **A reference-style (CSL) picker** in Export → References for house-style Word exports: Pandoc
  default, the shipped Nature/Science/Cell styles, or any `.csl` file; one `csl:` line is written.
  The in-app PDF/HTML still use Flux's own reference formatter (the dialog says so).
- **Word counts the way journals count them.** One counter for the status bar, Statistics, Journal
  Check, the export summary and flux-connect: citations count zero, cross-references count as the
  words they print, code/math/markup/embeds are not words, captions are legend words. Per-section
  counts in the outline, "N selected" after typing settles, a popover with bars against the venue's
  limits and an optional `word-target:` in the front matter.
- **The find bar** stays clear of the title pill and shows "3 of 17".

### Figure

- **The performance endgame.** A per-figure atlas keeps only the active figure's plots live and
  pictures the rest through a dedicated raster service (fonts and embedded images matched to
  Chromium's look); detail pictures sharpen a pictured figure as you zoom; plot restyles (colour
  scales, overrides, part hides) happen in place on fixed and elastic plots instead of re-cloning;
  edit tails and open time went on a diet. On a 13-figure, 75k-node project: a plot drag from
  30 fps to 60, post-edit idle work 512 → 104 ms, zoom 438 → 115 ms, figure switching ~30 ms.
- **Elastic plot relayout** (fluxplot ≥ 0.4): resize a plot as if its figsize changed — ticks
  re-solve, legends re-wrap, glyphs keep their point sizes — with Layout controls in the Inspector,
  Arrange Match, CLI/MCP verbs and a matplotlib oracle behind the gates.
- X-ray rows say what they are (axis, panel, series, colorbar), with previews, override state,
  grouped search and family navigation; the Plots rail and gallery share justified rows, tiles
  and Dissections; Align & Arrange lays a plot out by its visible outline; plot views move
  reference lines with their axis; Alt+/ opens the folder navigator anywhere.
- Smoothness at fractional device scales (1.25×): the layout box on the device grid, no soft frames.

### Slide

- The manim study, four releases: a measured pace with authored curves on every track; plot
  choreography (scaffold first, staggered children, draw along x with a lead dot); drawing with
  pen touch-down, border-then-fill and exact reach; convex and ring morphs, compound holes,
  crossing-free set pairing, plus-lighter crossfades; the fade-free vocabulary (scaleIn/scaleOut,
  pulse, encircle, lead highlight, dim); data hand-offs with count-up digit slots and bars that
  grow from their own zero line; glyph-matched text morphs with glide lanes, roll and flying
  letters; attached connectors and labels that follow their anchors; arcs and rigid turns; animated
  Back, Restore, text halo, piece lag, radial stagger, Focus/Unfocus and Turntable pace; a stage that
  stays crisp after resize and zoom; video frames encoded as tagged BT.709.
- Clean starts and landings everywhere (the settle system), with a corpus gate over every preset.

### Reader and Library

- **Show in folder** reveals a paper's PDF or supplement in the file manager.

### Across the app

- Every hotkey is a key cap: mono letter, hairline with a heavier bottom edge, barely rounded,
  in the colour of the surface it sits on (accent in the figure menu and toolbar, phosphor in the
  X-ray, muted in footers). One rule in the stylesheet; the same look in the Inbox, Annotate,
  the figure properties menu, the X-ray, the Inspector, the Animator, the toolbar and Help.

### Under the hood

- Hundreds of new and extended verification gates (pure, UI, scale, native), the figure raster
  worker and scene raster fidelity oracles.
- CI on hosted runners is green again: wall-clock perf pins declare their host scale
  (`FLUX_PERF_SCALE`, measured from the runner's own readings), one deadline per gate (a legacy
  timeouts map had been silently shadowing contracts), and three real bugs the red CI exposed are
  fixed — a slide player's first seek before its idle warm-up flew glyph boxes instead of letter
  outlines (exports, video, embeds), `connect doctor` reported `C:\C:\…` install paths on Windows,
  and a rewind gate compared frames from different camera rasters.

## 0.2.0 — 2026-10-04

The first release installed by `install.sh`: Paper, Figure, Slide, Reader and Library over one
project format, flux-connect for Claude Code and Codex, the unified Inbox, Ask, background runs,
3D models, journal-style Word export, the browser capture extension, Zotero sync and FluxLib.
