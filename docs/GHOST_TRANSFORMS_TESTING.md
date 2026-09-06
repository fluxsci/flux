# Trying Ghost transforms

Work is on `codex/figures-slides-overhaul`. Quit an older running Flux instance,
then run `npm run electron:build` from the repository to launch this branch.

## Make your first split

1. In Slides, select an object and turn on **Animate**.
2. Select a build step (or add one), then choose **Ghost transform…**.
3. Choose **1–32 copies** and what the original should do: **Stay**,
   **Disappear**, or **Transform**.
4. Click **Create ghosts**. Flux selects Ghost 1 at its destination. Move,
   resize, rotate, or otherwise edit it with the usual Canvas and Inspector.
5. Use the **Selected ghost** picker or previous/next buttons to edit each
   overlapping copy. **Select original** returns to the original;
   **Add copy** creates another destination at the source.
6. Play the step. Each copy begins at the original's state before this step
   and travels to its own destination. Adjust individual timing lanes as usual.

Copies have normal opacity; “ghost” means a newly spawned copy. They persist
and can receive more animations in later steps. They do not appear in Design
or before their birth step. Selecting an unborn copy offers **Edit destination**.

Try moving the original in an earlier step, then replay the split: the copies'
starting state follows it. Choosing **Transform** gives the original its own
endpoint during the split. Choosing **Stay** adds no original-object animation.

## Example project

A new project is prepared at `test-results/ghost-transform-playground`, separate
from the previous figures/slides playground. Open it in Flux and select the
**Ghost transforms · one to many** deck. Its three slides demonstrate Stay, Disappear, and
Transform using one arrow that splits into three arrows pointing at new data.

Create another fresh copy with:

```sh
npx tsx scripts/create-ghost-playground.ts /path/to/a/new-directory
```

The generator refuses to overwrite an existing project. A standalone HTML
preview is also provided at `exports/ghost-transform-lab.html` in the example project.

Try deleting a ghost birth lane and Undo: the copy and its later effects return
together. Duplicate the slide and edit the duplicate's copies independently.
Export to HTML and compare forward and backward navigation with Present mode.

## Format and automation

Decks now use schema 0.4. Existing 0.2/0.3 decks migrate without changing their
content or identities. Old Flux builds refuse the new format.

CLI and MCP expose the same operation: `ghost-transform` / `ghost_transform`.
See `resources/flux-context/SLIDES.md` for arguments and endpoint examples.

Run the focused verification group with:

```sh
node scripts/run-verifies.mjs --group slide-ghosts
```

## Verification results — 2026-09-05

- Code check: **0 errors, 0 warnings**; production build successful.
- All **198 core scripts** passed across the full suite and focused reruns.
  The full run caught an undefined dialog font token; that reference was
  corrected and both token gates rerun successfully.
- **38 Ghost GUI assertions**, **87 real-browser arrow assertions**, and
  **111** additional ghost runtime, export, structure, and CLI assertions pass.
- Existing Slides UI: **11/11 scripts**; transform, beat display, shared Figure
  primitives, groups/layers, and line-pivot UI gates also pass.
- Production bundle/startup: **4/4 scripts**. Existing normal/dense Slides
  performance gates pass without changing their budgets.
- Manual app walkthrough: create three arrow copies, drag each overlapping
  copy independently, rotate, play, and return to Design. Standalone example
  playback was visually checked after the arrow-rendering fix.

Measured on this Mac: creating 3/8/32 ghosts painted in **30–41ms**;
copy selection, properties editing, and scrubbing painted in **24–32ms**.
Normal/dense playback frame spacing was **10.0/10.4ms p95**. The dense fixture
retained two outliers (**83.4ms** at startup and **43.6ms** during playback);
the normal fixture had none above 25ms. Both had zero animation callbacks at
rest and one thumbnail redraw per edit.

The arrow test also fixed an existing chained-transform issue: a later
stroke-width change could leave the shaft at an earlier position while moving
the arrowhead. Cached bindings now restore the complete geometry, including
for ordinary transforms.
