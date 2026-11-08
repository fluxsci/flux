# Changelog

Releases are tagged `vX.Y.Z` (equal to `package.json`'s version) and shipped as a GitHub
Release that the one supported installer picks up:

```bash
curl -fsSL https://fluxsci.github.io/install.sh | bash
```

## 0.3.0 — unreleased

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
- Further Paper work from this release's overnight pass is listed at the end of this section once
  it lands: a Manuscript Check pane (`flux check`), superscript/subscript everywhere, honest word
  counts per section and journal limit, and a safe title/author editor.

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

### Under the hood

- Hundreds of new and extended verification gates (pure, UI, scale, native), the figure raster
  worker and scene raster fidelity oracles, and the hosted-CI runner profile that keeps the suite
  green on GitHub's machines.

## 0.2.0 — 2026-10-04

The first release installed by `install.sh`: Paper, Figure, Slide, Reader and Library over one
project format, flux-connect for Claude Code and Codex, the unified Inbox, Ask, background runs,
3D models, journal-style Word export, the browser capture extension, Zotero sync and FluxLib.
