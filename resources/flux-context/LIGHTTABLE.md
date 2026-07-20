# Lighttable — image-set triage (stock — shipped with Flux, do not edit)

**Lighttable** is a standalone sidecar app (in the Flux repo, but NOT part of Flux): a
fast grid viewer for **image sets** — a digital light table / contact sheet. Its niche is
the triage step *before* Flux: a parameter sweep, per-item outputs across conditions, or
model-comparison grids produce hundreds of images; Lighttable lets the user flip through
them instantly, compare variants, and decide what's worth promoting into a Flux project.
When the user asks for "a lighttable directory/collection of X", this is what they mean.

## The directory convention (what you produce)

```
sweep/                        ← the COLLECTION (the folder Lighttable opens)
├── smoothing-0.1/            ← a SET: one variant of the batch
│   ├── cell_007.png          ← an ITEM, keyed by filename (sans extension)
│   ├── cell_012.png
│   └── …
├── smoothing-0.5/            ← another set — SAME item filenames
│   ├── cell_007.png
│   └── …
└── smoothing-2.0/
    └── …
```

The rules that make the flip-book work:

- **One subfolder per variant (set); one image per item; items aligned by filename**
  across sets. `smoothing-0.1/cell_007.png` and `smoothing-2.0/cell_007.png` are the same
  cell — flipping sets swaps the image in place. A set missing an item shows a
  placeholder (the grid never shifts), so partial sets are fine.
- Sets are **flat** (no recursion inside a set). Loose images in the collection root form
  an "All" set. Formats: png/jpg/jpeg/webp/gif/avif/bmp/svg. Natural sort everywhere
  (zero-pad or name consistently: `cell_007`, not `cell_7`).
- **Sister collections:** sibling directories beside the collection are switchable
  in-app with one click — so a parent like `triage/2026-07-19_sweep/`,
  `triage/2026-07-20_sweep/` gives the user one-click history.

Producing one is ordinary analysis code: loop conditions × items, `savefig` into
`<collection>/<condition>/<item>.png` with identical item names per condition. Plain
matplotlib is fine here — these are triage images, not blessed figures (no fluxplot
recipe needed; promote the winners into the Flux project's `plots/` properly afterwards).

## Launching it (requires the Flux source checkout)

Lighttable runs from the repo (it is not bundled into the packaged Flux app):

```bash
cd "{{LIGHTTABLE_DIR}}"
npm start -- /path/to/collection      # build + run, opening the collection
# dev flavor: LT_OPEN=/path/to/collection npm run electron:dev   (vite on :1440)
```

(First run may need `npm install` in that directory.) If the directory doesn't exist on
this machine, say so rather than guessing — the user may only have the packaged Flux app.
Other open flows once running: drop a folder on the window, the Open picker, Recents.

## Boundaries

- Not a Flux surface: no project.json, no verbs, no MCP — just a folder of images. Never
  wire Flux code to it (deliberate decoupling; its own README in the repo is its source
  of truth).
- Don't confuse it with Flux figures: Lighttable is for *exploring many* images;
  Flux is for *composing the chosen few*.
