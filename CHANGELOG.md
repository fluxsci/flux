# Changelog

Releases are tagged `vX.Y.Z` (equal to `package.json`'s version) and shipped as a GitHub
Release that the one supported installer picks up:

```bash
curl -fsSL https://fluxsci.github.io/install.sh | bash
```

## Unreleased

### Flux AI

- **The Inbox's thread reads cleaner.** The note is set in a reading column. Its picture sits
  on a mat at no more than the size it was taken, with a caption, and opens large over the
  whole Inbox (fitted, then actual size). **Points at** lists each thing a note is about
  once, with the marks that name it, instead of one line per mark; a row takes you there. A
  margin comment quotes its passage in full. The heading names the surface once
  ("FIGURE  Protein Structure", not "figure · figure …"), and replies are set in one voice.
- The Inbox's action buttons keep their bottom edge (the reply box was painted over it).
- **The Flux AI mark is a living network, and it is everywhere.** Ten points of the Flux
  logo's spiral, woven into a closed mesh (every point sits on a loop). Points fire, and the
  firing travels down a link as a soft glow that leaves the link warm for a moment; colour
  passes from point to point. One mark now stands for Flux AI throughout: on the agent
  surfaces, as each agent's own avatar (the same network in that agent's colouring), in the
  title bar in place of the "AI" label, and on the Reader's Annotate action.
- **The mark reports what agents are doing.** When an agent claims an item a wave crosses the
  network and leaves it blue, and that agent holds one point in its own colour (two agents, two
  points). An agent's question turns it gold with a heartbeat. A finish is one green lap. A
  failure is three red flickers, then quiet. Sending something to Flux AI is one pulse inward.
  Its rhythm follows the work: slow while an agent thinks, quick while it writes, one sharp
  pulse for each tool it uses.
- **It never competes with your hands.** While you type, click, scroll or drag, the mark holds
  completely still, and comes back to life a moment after you stop. Typing next to it measures
  the same as typing with no mark at all.
- **Annotate and Ask are "Flux AI".** Their headers read **Flux AI │ Annotate │ where** and
  **Flux AI │ Ask │ where**, with the seed of the Flux logo in the top-left corner, always
  turning. Its colour is the state: blue when what you send goes straight to an agent that is
  listening or while an agent answers, green when an answer is done, red on a failure, and the
  logo's own colours otherwise.
- **Arrows point properly.** An arrow's number now sits at its tail, where you began the drag,
  and its head is a sharp dart at the tip, so the number no longer covers the point or the
  thing it points at. Saved pictures are drawn the same way.
- **Annotate's tools are redrawn**: a key cap, an icon and a word for arrow, box, pen and undo,
  with the chosen tool marked in the annotation colour. What you type to an agent is set in the
  same serif as the note it becomes, and the buttons that send use the accent as a tint
  rather than a solid block.
- **Ask names a quoted passage once.** The quote appears in the card under the header, no
  longer also in the header and again in a chip.
- **The Inbox is refined.** Its header reads **Flux AI │ Inbox**, with the seed of the Flux logo
  turning beside it: gold while something is waiting for you, blue while a connected agent is at
  work, the logo's colours otherwise. Rows show two lines of the note instead of one clipped
  line. An attached picture is shown whole (click it for full size). The buttons that have a key
  show it. A tag under an item's status filters the Inbox to that tag. The filter help is a
  proper legend. A claimed item's dot is filled inside a ring while its agent is connected, and
  no longer pulses.

### Window

- **Settings, rebuilt.** Every setting is now one kind of row: its name, with what it does in a
  smaller line under it, and its control at the right edge, so a pane reads as two tidy columns.
  On/off settings are switches (click anywhere on the row); numbers have **−** and **+**
  beside the value and show their unit; section titles stay in view while you scroll a long
  section; the Paper margin backgrounds are tiles with a small drawing each; and the Cursor
  section is sorted into Press, Arrow (or Colours and Shape) and Handles. Shortcuts shown in
  Settings use the same key caps as the rest of Flux.
- **The gear works on the Home screen.** It used to do nothing until a project was open.
- **The keyboard reference (press ?) is searchable, complete and easier to read.** The caret
  starts in a search field: type a word (*crystallize*, *zoom*, *cite*) or a chord as you would
  press it (*alt+t*) and every mode is searched at once, with the number of matches beside each
  mode's name. Each chord is drawn key by key and named for your platform (**⌘ ⇧ M** on a Mac,
  **Ctrl Shift M** elsewhere); mouse gestures are written as words. It now lists some 300
  shortcuts where it had about 120, including the keys of the X-ray, the Plots view, the
  animator, presenting, tables and the margin panes, and several rows that were wrong or stale
  are corrected. **Esc** clears the search before it closes the reference.
- **The Docs button opens the guide where you are.** It goes to fluxsci.org/docs at the page for
  the mode you are in (Figure, Slide, Paper, Library, Reader; the start page from Home), and
  its tooltip says which. Settings and the keyboard reference each have a **Guide** link to
  their own page, at the open section. With no network connection, the copy of the guide inside
  the app opens instead.
- **Bring to front / send to back with Ctrl+Shift+] and Ctrl+Shift+[ works.** On a US keyboard
  the chord did nothing.
- **Notices are redrawn.** Each has a mark for its kind (done, problem, information), a
  failure's reason wraps over several lines instead of being cut at one, and its buttons look
  like buttons.
- **The mode icons sit in the middle of the title bar**, in a rounded strip of their own that
  floats just above the bar, with the blue underline marking the active mode. They stay in the
  exact middle of the window at any width.

### Figure and Slide

- **The folder navigator (Alt+/) opens beside the Plots rail** instead of taking the place of
  Dissections, so you can pick a folder and still see the dissections of the plot you clicked.
  The caret starts in its search: matches are marked in the names, **↑** / **↓** move the
  highlight without leaving the search, and **Enter** shows that folder. Folders have guide
  lines, an open or closed icon and a crisp fold; **Alt-click** on a folder's arrow folds the
  whole branch. New folders appear by themselves. If you prefer it in the lower pane, the button
  in its header docks it there, as does **Settings → Figure → Plot gallery → Folders open**.
- **The Dissect viewer (D), rebuilt.**
  - **It opens on the plot's first picture**, large, with the strip under it; **G** shows all
    files as a grid and returns. **Esc** closes it from there.
  - **Names you can read.** Folders and files named after the plot lose that shared front in
    the strip and the headings (*rem-sorted*, *source_data*); a table says which group it is
    from; a picture has its name under it; a group's name no longer runs over the next group.
  - **Flip through a plot's files.** An open file has a strip of every file under it, the
    open one marked, each group named where it starts. **←** / **→** flip, **↑** / **↓** step a
    whole group, **Home** / **End** and **1–9** jump, and a click opens: twenty per-subject
    panels without going back to the grid. A bar above the file says where you are.
  - **Tables read the way you would write them.** Long numbers are rounded (6.596349872904714
    → 6.596), very small ones are powers of ten (3.88 × 10⁻⁵), short ones are left as written,
    and the file's own text is in each cell's tooltip and one click away (**As written**).
    p-value columns carry \*, \*\*, \*\*\*. The table cards in the grid and the sidebar use the
    same formatting.
  - **Test results as sentences.** A statistics table is also read out above the table, one
    line per test (*t(11) = 6.596, p = 3.9 × 10⁻⁵ (Holm 7.8 × 10⁻⁵), Hedges' g_z = 1.771
    [0.922, 2.86], n = 12*), with **Copy** for your results section.
  - **Notes are a page**: one readable column in the manuscript's type, instead of a
    full-width monospace box.
  - The header, tabs, buttons and key hints are redrawn in the same style as the rest of Flux.
  - **D works on a slide.** It used to do nothing visible there and leave the keyboard dead
    until you left the mode.
- **Figure-Meta (Alt+M), rebuilt.** One slim header instead of a tall banner; three clear
  columns: which figure, how it will print, what you write. The preview is a page proof: the
  figure and its caption on paper, in the manuscript's type. The list shows how many words
  each figure's caption has (a ring when it has none), and **↑** / **↓** in the search move
  through the figures, with **Enter** going to the first field. The fields count the caption's
  words as you type. The bar at the bottom says plainly whether your words are saved. The
  preview's controls are redrawn to match. Filtering the list now returns it to its top.
- **Figure-Meta: the captions have the right column to themselves, and the name is a panel
  under the preview.** No Captions / Name tabs. A slim bar under the preview says what the
  figure is called; click it or press **Alt+N** and it opens into one row (title, family,
  number, new family, save), with how the name will read and the permanent reference. It
  remembers whether you left it open. The dialog now takes the keyboard as it opens (its keys
  were dead until you clicked in it), and editing a caption with the name showing no longer
  puts a phantom "name change" ahead of it in the undo history.
- **Crystallize (Shift+A).** Select objects you placed by hand and press **Shift+A**: Flux reads
  them as the row, column or grid they are closest to and snaps them into it, aligned and evenly
  spaced, as one Undo step. Three in a row with a fourth under the first become a 2 × 2. A small
  button at the selection's bottom-right corner offers the same and previews the result on hover;
  afterwards the pink gap guides appear by themselves, with no panel opened. Gaps that already
  agree are kept exactly; hand-placed ones settle on a whole number. Agents:
  `flux arrange <figure> --mode auto`.
- **Crystallize lines plots up on their axes.** When the selection is all Fluxplots, a row
  shares one line through its X axes and a column one through its Y axes, instead of box
  edges that tick labels and titles push around. The pink gap guides appear all the same, and
  the hover preview draws the shared axis line. **Shift+Alt+A** or **Alt-click** uses bounding
  boxes instead. Agents get the same by default; `--on boxes` and `--on axes` choose.
- **Align & Arrange, rebuilt.** The panel is redrawn in the property menu's vocabulary: every
  control is a key cap, an icon and a word, each in its own place, so a key can never sit on a
  label. The pane that owns the keyboard has its caps lit and the other shows the **Space** cap
  that hands the keys over. Layouts have their own keys (**R** row, **C** column, **G** grid) with
  **−**/**+** stepping the rows; **Shift+H**/**Shift+V** even out horizontal/vertical spacing; "align to" is a
  three-way switch (Selection, Object, Figure); a link button joins the two grid gaps; and the
  foot of the panel names whatever is under the pointer. The earlier keys (**A** row/column,
  **D**/**F** rows) still work.

### Title bar

- **New mode icons.** Each of the five modes now has its own outline and its own accent colour, so
  you can tell them apart at a glance: Figure is a plot being placed by the pointer (dark blue, with
  Flux's pink cursor), Slide is a slide flying in (green), Paper is the text caret between lines of
  words (blue), Library is a shelf of books with one leaning (violet), and Reader is a loose pile of
  printed papers with one line highlighted (yellow).
- **The modes are now ordered Figure, Slide, Paper, Library, Reader**, and **Ctrl+1**–**Ctrl+5**
  follow that order: **Ctrl+2** is now Slide and **Ctrl+3** is Paper (they were the other way round).

### Slides

- **A Become can keep its source.** Press **K** while picking what something becomes (or set
  **Source** to **stays** in the Animation inspector) and the source stays on the slide while a copy
  of it flies off and becomes the destination. Six fitted curves can each send a copy into its bar of
  a half-time chart while the curves stay in their plot. Pairing, Reveal, Method, Piece lag, timing
  and arcs all apply to the copies; they grow out of the source as they leave it, so nothing looks
  doubled on the first frames. The timeline lane reads “… sends copies to …”. Agents:
  `flux become … --keep-source` and `flux appear-from … --keep-source`.
- **Fixed: a part that appeared earlier on a slide blinked when it started to Become something.** With
  a plot's parts faded or drawn in on one step and turned into parts of another plot on a later step
  (a ring of sectors becoming rows of a raincloud plot), each part vanished for a moment at the start
  of its flight and faded back in. The same cause could also start a flight a little displaced when
  the plot itself had risen in, or land it beside a plot that had risen in. All gone: a flight now
  starts on exactly what you were looking at and lands on exactly what stays.
- **A large cloud of markers that Becomes a line or a shape lands smoothly.** Above 400 markers the
  markers themselves fly and fade as they arrive; what they land on used to appear all at once on the
  last frame. It now fades in under them.
- **Fixed: dragging a plot from the Plots rail onto a slide always placed it on the first slide.** It
  lands on the slide you are looking at. Dropping a file onto the stage had the same fault.
- **Rename a deck where it is listed:** double-click its name in the deck list, as you rename a canvas
  in Figure.

### Figure editor

- **X-ray colour swatches show their whole outline.** The left edge of every swatch's ring was cut off.

- **Large images no longer slow the editor.** A placed image is drawn at the resolution your screen
  needs instead of at its full size, and sharpens to its own pixels when you zoom in. A figure with
  several very large PNGs (tens of megapixels each) used to pause for half a second or more after
  every zoom, drag or nudge; it no longer does. Exports, saves and the paper still use the original
  image, untouched.
- **Projects with data-heavy plots open several times faster**, and stay responsive while plots are
  regenerated in `plots/`: Flux now checks whether a linked plot source changed without re-reading
  every source file.
- **Fixed: "Some figure sources could not update … IPC payload exceeds 256 MiB limit"** on opening a
  project whose regenerated plots carry large data. The pending updates are applied the next time
  the project opens.
- Exporting a figure, and the live preview in Figure-Meta, no longer copy every plot's data first.

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

- **Comments open on their text.** Rest the pointer on commented text and its thread opens in
  a card right there: read it, reply, edit what you wrote, resolve or delete it, or open it in
  the margin's Comments pane. A click keeps the card open; typing in the manuscript sends it
  away. A new comment is written in the same card, on the selection, instead of in the margin.
- **A comment is yours unless you send it to Flux AI.** The selection toolbar has two
  buttons: **Comment** (**Ctrl+Alt+M**) leaves a note that agents are not shown and that stays
  out of the Inbox, and the Flux AI mark (**Ctrl+Shift+Alt+M**) sends the comment to the
  Inbox. A switch on every comment moves it either way later. Comments made before this
  release stay in the Inbox, as they were.
- **Commented text is blue**, no longer the gold that elsewhere means "an agent is waiting for
  you". The colour is yours to choose in **Settings → Paper → Comments**.
- **Comment tags.** Attach labels such as `#needs-reference` to a comment, give each a colour
  (a comment is highlighted in its first tag's colour), and filter the Comments pane by tag
  or by **Flux AI**. There are no tags until you make one.
- Your own messages in a comment thread can be edited; an edited message says so.
- Resolved threads in the Comments pane are shortened to three lines until you click them, so
  open comments are not pushed out of sight.
- **The `@@` and `/figure` pickers are the margin's Figures card.** The same paper card with its
  title in the outline, the same ink, the same controls. Figures are small cells, four to a
  row. Citing panels happens on the card's own stage (scroll to zoom, drag to pan), with the
  caption under it and the panels as the same square letter keys; **Insert** is now a button as
  well as **Enter**, and says exactly what it will write. Thumbnails that are still being drawn
  are hatched instead of showing a broken-picture box.
- The Figures card no longer shows the caption's Markdown asterisks.
- **The margin's panes are rebuilt.** Each is a clean paper card with its name set into a real
  break in its outline (it no longer sits half on the card and half on the margin) and a close
  button in the outline on the right. Inside, all eight panes share one set of fields, buttons,
  lists and key hints. Reference Search shows each paper on two readable lines (authors, journal
  and year, then the full title) instead of four truncated columns, opens instantly on any size
  of library, and **Enter** cites the row you are on (mark several with **Space** to cite them
  as one group). Statistics is a ledger with a bar per section. Manuscript Check folds its
  groups. Figures no longer shows broken-picture boxes while a figure is being drawn.
- Manuscript Check's pane has its green title and outline (it was drawn in black with no
  outline).
- **The left sidebar is rebuilt.** Files and Outline are switches with a rail under the ones
  that are showing. The file tree has section headings, folder icons that open and close,
  guide lines for nesting, a filter field, and arrow-key navigation (**↑ ↓ ← →**, Home, End).
  The Outline has the same guide lines and arrow keys and bolder top-level sections. The
  open document and the section your caret is in share one mark: a blue tint with a rail
  (the Outline used a solid blue block). Opening a folder or a section unfolds its rows
  with a short fade.
- Folded Outline sections are remembered per document and by heading. One shared list of
  positions used to fold the same position in every document, and moved to a different
  section when a heading was added above.
- **Export, redone.** The export dialog is a titled sheet: format tiles, the journal style with
  what it does shown as a list, and a bar at the bottom that says where the file will go and
  what will make it. After you press Export, one **receipt** above the status bar follows the
  export: the stage it is in, the engine's latest line, the seconds so far and Cancel; then
  **Exported**, the file's name, **Open** and **Reveal**. A failure stays there with its
  reason, and **Details** opens the engine's log to read or copy. It replaces a progress box
  that sat on the margin's corner, an "Exported ✓" pill and a notice repeating it.
- Word exports no longer lose their progress display while figures are converted and the
  file is written; an export that could not start now says why instead of doing nothing; the
  output path no longer shows a stray trailing slash.
- The journal export summary is restyled to match, and its section headings and counts are
  readable (they were pale grey on cream).
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

- The Reader's sidebars are rebuilt: four tabs that fit the rail and are underlined when chosen;
  search results in running text with the matched letters marked; reference and library cards
  that lead with the title, then who and when, then what you can do; a Highlights list that
  counts its entries, reads in the page's order and shows each note under its passage. Export
  notes has its own row instead of crowding the tabs.
- Search in a PDF marks the right letters. The Search pane cut each result at offsets from the
  PDF's original text while showing its normalized text, so past the first ligature or
  hyphenated line break the marked letters drifted ("rns of c" for "cortical").
- The selection menu appears every time. It went missing on a page with search hits (the
  search rewrites that page's text nodes), when the drag ended outside the page, and when a new
  selection began inside the old one (the browser took that as dragging the text). It is
  redrawn too: five square swatches, then **Annotate** and **Ask**, placed by the selection
  and kept inside the page area. **Escape** closes it.
- Clicking a search result selects that very hit. The page used to select the hit after it
  (the list hid the difference), and a result far down a long list was approached one hit at
  a time and abandoned after 200 steps. The jump is now one step, to any hit. A search begun
  in the middle of a paper starts there, and the counter and the list say so; the open result
  stays in view as you step. Long result lists are compact rows tagged with their page, and
  the query stays in place while they scroll.
- A highlight's popover is the selection menu with a note: the same swatches, **Annotate** and
  **Ask**, the passage on a rail of its colour, and Save shown with its key.
- A highlighted passage that runs over a line end is quoted with the space you read there,
  in the list, in exported notes and in what Ask and Annotate send. Highlights saved before
  this keep their place. Notes exported from the Reader follow the page's reading order.
- The Reader toolbar is drawn rather than typed: stroke icons for back, zoom, fit and the PDF
  menu, zoom as one out / value / in control, every control the same height.
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
