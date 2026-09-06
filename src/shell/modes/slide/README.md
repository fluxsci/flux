# Flux Slides authoring

A slide uses the Figure `Element` union and the shared Canvas/Inspector through
`src/lib/slide/deckProject.ts`. The deck owns element identities, plot assets,
steps (`beats`), and animation tracks. User documentation lives in
`docs/modes/slide.qmd`; architecture and verification policy live in
`docs/AGENT_ENGINEERING_GUIDE-RUNNING.md`.

## Editing and playback

`SlideMode.svelte` projects the deck into the shared editor. Design edits base
objects. **Edit after step** records sparse Change destinations against the
compiled state before that step. Scrubbing and playback inspect the scene
without authoring changes. `store.ts` owns this boundary and the edit destination.

`AnimatePanel.svelte` contains a step list, the selected step's timing lanes, a
transport, and an Inspector. `animator/BeatRail.svelte` owns lane selection and
timing gestures; `PropertiesPane.svelte` exposes timing, easing, presets, and
source/destination checkouts. Shared `trackActions.ts` handles structural actions.

`src/lib/slide/compile.ts` produces the deterministic timeline shared by the
editor, thumbnails, live player, and standalone HTML export. Compile and bind
scene data once; playback samples existing elements without rebuilding content.

## Ghost transforms

`GhostTransformDialog.svelte` selects a copy count and original behavior.
`ops.addGhostTransform` creates ordinary result Elements and whole-object Change
birth tracks carrying `ghostFrom`. `ghost.ts` resolves each source at the end of
the preceding step, including previous Changes and source asset identity.
Canonical result Elements retain a fallback if the source disappears.

`GhostCopyControls.svelte` and `animator/ghostEditing.ts` keep overlapping copies
individually reachable. Each copy has an independent destination and timing.
Unborn copies are excluded from Canvas painting and hit testing; selecting one
in Design offers **Edit destination** rather than changing its fallback.
Deleting a birth removes its result and that result's later effects in one Undo.

A plot's Auto animate uses manifest build hints. For a ghost plot, those phases
are private to the result and follow its birth step.

## Verification

```sh
npm run check
node scripts/run-verifies.mjs --group slide-ghosts
node scripts/run-verifies.mjs --tier pure,ui --only slide
```

The GUI gate uses real controls and Canvas gestures. The offline browser gate
checks forward/reverse playback, source state, delayed birth, and absence of
content allocation during movement. Keep the 100ms interaction budget and the
existing normal/dense slide performance gates unchanged.
