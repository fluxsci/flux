# Plot gallery verification — 2026-09-07

Alt+I defaults to a gallery of SVG/PNG previews. Display choices persist locally;
folder navigation, whole-project ordinary search, reserved collection scopes and
cross-folder picks work both in the dialog and in the pinned window. The utility
shares the opener's authoring store and existing import pipeline, has no file
bridge of its own, and closes with its owner. The lighttable application is unchanged.

## Results

- `npm run check`: 0 errors, 0 warnings. Production build passes.
- Pure tier: final isolated sweep **203/203**.
- Paper gate against :1420: **44/44**.
- Bundle/startup: **4/4**, with unchanged budgets.
- `verify-plot-gallery.mjs`: default previews, preserved picks/folder on pin,
  root/other-folder navigation, global ordinary search, reserved scopes, small-window
  fit, preview size/spacing persistence, repeated insertion, parent shortcuts, docking,
  native-close recovery, active-figure changes, refusal after delayed file reads,
  and keyboard focus across virtualized rows pass. The app console is clean.
- `verify-plot-gallery-electron.cjs`: **15 checks** pass against the production
  file renderer with actual Electron/preload and isolated disk/config fixtures.
  Covers separate native movement/resizing, no child file bridge, navigation,
  repeat insertion, physical dimensions, parent keyboard edits saved to disk,
  one-step batch Undo, external-navigation denial, native close and owner teardown.
- Existing importer multi-select/reserved-folder, Slide import/data morph, Slide
  tenancy, Figure editing/Properties, and menu smoke checks pass. Design tokens,
  documentation, IPC contract and main-process identifier checks pass.

The 5,000-image browser fixture mounted **14 gallery cards**. Including initial
folder navigation it performed 21 preview reads; the queue allows four concurrent
reads. Search painted in **26.7 ms**, scrolling in **32.8 ms**, against the unchanged
100 ms limit. Screenshots and raw logs are generated under `test-results/`.

## Caveats and failure evidence

- `verify-figure-controls-gui.mjs` fails at its existing “Figure: rail resizes live”
  assertion: `{sidebarW:200, inspectorW:248}` stays unchanged. This was reproduced
  before the importer edits in Brave and afterwards in stock Chrome. The relevant
  rail implementation was not changed by this work.
- One pure sweep concurrent with the Paper browser suite missed the unrelated
  slide trim animation's sample-count assertion (four distinct values). The final
  isolated full pure sweep passed all 203 scripts without changing that gate.
- The native gallery gate initially failed because the new navigation deny handler
  blocked its first load. Allowing exactly the inert gallery document corrected it;
  the same gate verifies external navigation remains denied. Old folder-emoji and
  importer-call source probes were updated to the explicit folder type and guarded
  shared call respectively; batch behavior/placement checks remain intact.
- Native verification was on macOS. Position and size changes were exercised through
  the real window; physically dragging between two monitors and installer packaging
  were not part of the automated run. Browser verification used Chrome for Testing
  152 (early checks also used Brave). Native config/projects are disposable; optional
  contextual-correction model setup is absent in that fixture.
- Preview caching is local to the gallery. **Refresh** reloads changed sources;
  oversized or unreadable preview files remain selectable with an unavailable-preview
  label. Search is capped at 20,000 files/20 folder levels; direct folder browsing
  still exposes that folder's complete image list.
