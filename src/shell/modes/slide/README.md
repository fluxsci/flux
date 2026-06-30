# Flux Slide — the Animator ("data in motion")

Flux Slide is figure-first: a slide is a stage of **elements** (text, math, image,
rect/line, and **plots**), and a plot is not a picture — it's a live **semantic
scene graph**. The Animator turns that scene graph into a *talk*: hide everything,
then reveal it the way the data should be read — axes draw on, points stagger in
left→right, the fit line draws itself as they land. PowerPoint meets 3blue1brown.

## The model (how a build is stored)

```
Deck → Slide → beats[] → tracks[]
                 │          └─ { target, part?, selector?, preset, start, duration, easing, stagger?, params? }
                 └─ beat 0 is the resting state ("Start"); each later beat is one "advance"
```

* **target** — a slide element id (or `@camera`).
* **part** — a node in the plot's parts tree (`axis.x.spine`, `setosa.points`,
  `fit.line`). A *group* part (`setosa.points`) expands to its leaf members at play
  time via `resolveTargets`; the player queries `[id="${target}__${part}"]`.
* **preset** — `drawOn` (stroke a path on), `fade`, `stagger` (reveal members in
  sequence), `growBaseline`, `writeOn`, `popIn`, `fadeRise`, `morph`, `camera`.
* **stagger.by** — `index | x | y | series | blocks | dom`. `x`/`y` read each
  member's `data-x`/`data-y` so points reveal in *data* order, not DOM order.

The player has two faces over the same specs: `createPlayer` (live sequencer for
Present/Preview) and `applyStatic(specs, beat)` (the per-beat resting state that
powers the editor scrub, thumbnails, and export — fully reversible).

## The one-click magic: `autoAnimatePlot`

A FluxPlot ships its own build hints (`manifest.build.order` + `build.presets`).
`applyAutoAnimation(deck, slideId, elId, manifest)` walks them into a 4-phase
sequence — **Axes → Gridlines → Data → Legend** — with no manual authoring:
containers decompose (spine/ticks draw-on while labels fade), points stagger by
`x`, and the line/area start partway through that stagger so they resolve *as the
points finish*. That is the north-star scatter reveal, from one ✨ button.

## The GUI (`AnimatePanel.svelte`)

A bottom dock that is an **X-ray tree × a beat timeline**:

* **✨ Auto-animate** — the whole build from the plot's hints (above).
* **PARTS X-ray** — every part with a tri-state `S | A | M`:
  **S**how from start · **A**nimate in · **M**ask (hidden). Click a part on the
  *stage* to focus its row (and its track).
* **Beat timeline** — one column per beat; each track is a color-coded chip
  (blue `drawOn`, green `fade`, red `stagger`). Select a chip to edit preset /
  start / duration / easing / stagger in the strip below; `+ Beat` / delete here.
* **🎥 Zoom / ⤢ Reset** — camera moves (zoom to the selection, pull back).
* **⇄ Morph ▾** — morph this plot's data into another plot on the slide.
* **▶ Preview** — play the build on the stage; scrub by clicking beats.

Text is editable in place — double-click a text/bullets/math element on the stage.

## Verifying

Headless, no browser needed (linkedom + the real renderer/player):

```
npx tsx scripts/verify-slide-scatter-showcase.ts   # the north-star, end to end on the real plot
npx tsx scripts/verify-slide-autobuild.ts          # autoAnimatePlot vs the real scatter manifest
npx tsx scripts/verify-slide-player.ts             # parts targeting, spatial stagger, drawOn drill
npx tsx scripts/verify-slide-export.ts             # standalone-HTML export parity (parts + stagger)
```

`scripts/lib/driver.mjs` drives the live app headless (`?fixture=demo`,
`window.__flux`) for screenshot verification.
