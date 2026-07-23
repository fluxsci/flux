# Flux Slide — the Animator ("data in motion")

Flux Slide is figure-first — literally: **a slide IS a figure** (slide-migration
2026-07). Its elements are the figure `Element` union (text, image,
rect/ellipse/line/path, and **plots**), edited by the FIGURE editor operating on
the projected deck (see `src/lib/slide/deckProject.ts`); a plot is not a
picture — it's a live **semantic scene graph**. The Animator turns that scene graph into a *talk*: hide everything,
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
* **stagger.by** — `index | x | y | series | dom`. `x`/`y` read each
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

## The GUI (`AnimatePanel.svelte` + `animator/*`)

A bottom dock (the animation-rework Animator, 2026-07 — there is NO parts tree
and NO `S | A | M` tri-state anymore; the X-ray's `x` hide is the one static
mask, and everything else is tracks):

* **BeatRail** — collapsed beat chips + exactly ONE expanded beat whose tracks
  render as lanes on a per-beat ms ruler (drag = retime, right edge = duration,
  drag across beats moves — Alt copies; marquee select; Ctrl+wheel zooms time).
  Appearance lanes are preset-colored bars; **transform** lanes render
  `t₁ ─ label ─ t₂` with clickable endpoint checkouts; track groups collapse.
* **PropertiesPane** — the selected track's preset / start / duration / stagger
  (by + from) / easing / influence, trim-path controls, the t₁|t₂ segment, and
  the data-morph dropdown.
* **Chords** (selection-driven, animator open): **⌃⇧A** appearance, **⌃⇧D**
  disappearance, **⌃⇧T** transform (checks out t₂ for on-canvas editing; Esc
  exits), **⌃⇧C** cascade across ≥2 selected tracks.
* Toolbar: **✨ Auto-animate** (the build from the plot's hints, above),
  **+ Beat**, **🎥 Zoom / ⤢ Reset** camera, **⇄ Morph ▾**, **▶ Preview**,
  **☆ Library** (machine-global animation presets + templates).

Text is editable in place — double-click a text element on the stage (slide
text IS the figure `text` element; bullets/math were retired in the migration).

## Verifying

Headless, no browser needed (linkedom + the real renderer/player):

```
npx tsx scripts/verify-slide-scatter-showcase.ts   # the north-star, end to end on the real plot
npx tsx scripts/verify-slide-autobuild.ts          # autoAnimatePlot vs the real scatter manifest
npx tsx scripts/verify-slide-player.ts             # parts targeting, spatial stagger, drawOn drill
npx tsx scripts/verify-slide-export-core.ts        # standalone-HTML export (parts + stagger)
npx tsx scripts/verify-slide-export-parity.ts      # GUI vs headless export parity
```

`scripts/lib/driver.mjs` drives the live app headless (`?fixture=demo`,
`window.__flux`) for screenshot verification.
