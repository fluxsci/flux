# Welcome to Flux

Flux is a desktop studio for scientific work. Instead of juggling a word processor, a figure
tool, a slide app, a PDF reader, and a reference manager, Flux puts all five in one place,
working on one project. You write the paper, build the figures, keep your reading library,
annotate PDFs, and make the talk — and everything stays connected: figures you build appear in
your manuscript by reference, papers you save can be cited with a keystroke, and the same figure
can drop straight into a slide.

**Projects.** A Flux project is just a folder on your computer. Everything in it is an ordinary
file — your manuscript is a text file, your figures and slides are readable files beside it — so
nothing is ever trapped inside the app. From the Home screen you can create a new project, open
an existing folder, or jump back into a recent one.

**The mode rail.** Down the side of the window is a rail with the five modes: **Paper**,
**Figure**, **Slide**, **Reader**, and **Library**. Click one to switch. Each mode is a full
workspace, and they all look at the same project.

**Saving.** You don't save. Flux autosaves continuously, keeps write-safety guarantees behind the
scenes, and has deep undo (Ctrl+Z) in the editors. If some other program (or an AI assistant)
changes a file while you have it open, Flux notices and asks whether to reload their version or
keep yours — it never silently overwrites anyone's work.

**AI assistants.** Flux is built so an AI agent can be a real collaborator: everything you can do
in the app, an agent can do through Flux's command-line and assistant interfaces — compose
figures, edit the manuscript, fetch papers, restyle plots — while you watch the results appear
live. You can ignore this entirely, or lean on it heavily; the app works the same either way.

---

## Paper — the manuscript editor

Paper is where you write. It's a clean, fast text editor for scientific manuscripts: your
document is plain text with light formatting (headings, **bold**, math like `$E = mc^2$`,
tables), and Flux renders the pretty version live.

The two superpowers are **references** and **figures**. Type `@` and the name of a paper from
your Library to cite it — citations become neat numbered chips, and your bibliography maintains
itself. Reference a figure with `@fig-...` and it becomes a live chip too: figure numbers stay
correct automatically as you add, remove, or reorder figures, and double-clicking a chip jumps
you to the thing it points to.

- **Find:** Ctrl/Cmd+F.
- **The margin:** helper panes summon beside your text — **Alt+R** reference search, **Alt+F**
  your figures, **Alt+A** comments, **Alt+C** citation groups, **Alt+T** a terminal. Escape
  closes them and returns you to writing.
- **Export:** the Export button in the status bar produces PDF, Word, or HTML.
- For keyboard fans there are optional Vim editing modes in settings; if you don't know what that
  means, you can happily ignore it.

## Figure — the figure editor

Figure is a Figma-style canvas for building publication figures. A project has one or more
**canvases** (pages); each canvas holds **figures** (the framed panels that will appear in your
paper); each figure holds **elements** — imported plots, text, shapes, arrows, images.

The key idea: plots made with supported plotting tools stay **live** after import. Flux
understands their parts, so you can click a single line, axis, or label inside an imported plot
and restyle it (color, thickness, visibility) without re-running your analysis code — and if you
do regenerate the plot, your styling survives. Plots also import at their **true physical size**,
so what you lay out is exactly what prints.

- **Import a plot:** press **Alt+I** to browse your project's plots (or just drag a file in).
- **Tools:** single keys — **V** select, **T** text, **R** rectangle, **O** ellipse, **L** line,
  **A** arrow, **P** pen (click to place points; click your first point again to close the
  shape — a ring appears when you're close enough — or press Enter to finish an open curve;
  hold Shift for perfectly horizontal/diagonal/vertical segments, and watch for the dashed
  guides and tick marks that snap your point into alignment or equal edge lengths),
  **H** hand (pan).
- **Everyday editing:** drag to move (with smart snapping), arrow keys to nudge, Ctrl+G to group,
  **[** and **]** to send backward / bring forward, Shift+H / Shift+V to flip, Delete to remove,
  Escape to cancel whatever you're mid-way through.
- **Panels and captions:** mark a text element as a panel label with **Alt+L**; **auto-label**
  letters your panels a, b, c… in reading order; **Alt+C** opens the caption editor (captions
  travel with the figure into your manuscript). **Alt+G** snaps a messy selection into a tidy
  grid; **Alt+P** opens the X-ray, which shows the anatomy of a plot so you can pick exact parts.
- **Rulers and guides:** Shift+R.
- **Reusable designs:** style any shape, line, or path exactly how you like it — or select a
  whole **group** of shapes and labels (a badge, a labelled bracket) — then save it as a
  **preset** (press **F** for the property menu → "save as preset"). **Ctrl+P** opens your preset
  library — a personal, cross-project collection of arrows, stars, callouts — and inserts one
  with a click; group presets arrive as a group you can move as one or ungroup to break apart.
  Strokes can be dashed, and paths can carry arrowheads, from the same menus.

## Slide — the deck builder

Slide turns project content into talks. A project can hold several **decks**; each deck is a
filmstrip of slides you compose on a stage — drop in figures from Figure mode (they stay linked),
plots, images, text, and shapes.

Animation is built around **beats**: each slide can reveal or change things step by step, the way
you'd build up an argument. Plots can animate at the level of their *parts* — fade a series in,
morph one chart into another — because Flux understands plot anatomy.

- **Edit:** the filmstrip on the left picks the slide; the panel on the right manages beats and
  animation tracks; drag things on the stage to arrange them.
- **Present:** full-screen presenting with arrow keys to advance beats/slides, a typed number +
  Enter to jump to a slide, **B**/**W** to blank the screen black/white, Escape to leave.
- **Export:** a deck exports to a single self-contained file that plays in any web browser —
  animations included, no Flux needed on the presenting machine.

## Reader — the PDF reader

Reader is where you actually read the papers in your library, with annotations that stick.

Open a paper from the Library (or click its Read button) and you get a fast PDF view. Select any
text to **highlight** it, in your choice of colors, and attach a **note**. Annotations anchor to
the *text itself*, so they survive re-downloads and re-opens. Your notes for a paper can be
exported as a tidy Markdown summary.

Niceties while reading: search within the document, jump to a page by number, pop out a paper's
figures to study them side-by-side with the text, hover a citation to peek at what it cites, and
switch between a paper's main PDF and its supplementary files. There's also an assistant drawer
that lets an AI read along with you — it sees the paper and your current spot, so you can ask it
questions in context.

## Library — the reference manager

Library is your permanent collection of papers — it lives on your machine, shared by all your
projects, and each project cites its own subset from it.

**Getting papers in:** paste a DOI or a paper's web address into the box at the top, use the
browser bookmarklet to send the page you're reading, or drop PDF files into the watched inbox
folder and Flux will identify them from their contents and file them correctly (it refuses to
guess when unsure, rather than mislabeling).

**Finding papers:** the search box does simple free-text search, understands filters like
`author:smith year:2021 tag:methods`, and — with `ft:` in front — searches the **full text of
every PDF you've stored**, showing matching snippets you can click to jump into the Reader at
that exact spot.

**Working the grid:** press Enter on a highlighted row to copy its citation key (ready to paste
into your manuscript), Ctrl+click a row for details (abstract, topics, tags, similar papers, who
cites it), Ctrl+Shift+click to open the PDF. The **Get PDF** button fetches open-access copies
automatically, and a university library sign-in can be configured for paywalled ones. **Enrich**
fills in abstracts, topics, and citation counts for everything at once. Tags, read/unread status,
and collections keep large libraries organized.
