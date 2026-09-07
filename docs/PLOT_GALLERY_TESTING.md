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

- The original `verify-figure-controls-gui.mjs` failed at “Figure: rail resizes live”
  because its unscoped selector found Paper's hidden sidebar handle, which shares
  Figure's accessible label. The Linux follow-up on 2026-09-07 confirmed the visible
  Figure handle changes the width from 200 to 251px and Escape restores 200px.
  The gate now scopes handles to their editor and checks the pointer hit target;
  the complete Figure/Slide controls gate passes without application changes.
- One pure sweep concurrent with the Paper browser suite missed the unrelated
  slide trim animation's sample-count assertion (four distinct values). The final
  isolated full pure sweep passed all 203 scripts without changing that gate.
- The native gallery gate initially failed because the new navigation deny handler
  blocked its first load. Allowing exactly the inert gallery document corrected it;
  the same gate verifies external navigation remains denied. Old folder-emoji and
  importer-call source probes were updated to the explicit folder type and guarded
  shared call respectively; batch behavior/placement checks remain intact.
- Initial native verification was on macOS. Position and size changes were exercised through
  the real window; physically dragging between two monitors and installer packaging
  were not part of the automated run. Browser verification used Chrome for Testing
  152 (early checks also used Brave). Native config/projects are disposable; optional
  contextual-correction model setup is absent in that fixture.
- Linux follow-up found the pinned grid retained its old column count while the opener
  was backgrounded (still stale after two seconds; focusing the opener repaired it).
  List size observation now belongs to the current window and reconnects on pin/dock.
  The browser gate checks narrow and wide reflow; all 17 native checks pass on Linux
  Electron/X11, including resizing while the opener is hidden. The corrected browser run
  mounted 14 cards for 5,000 plots,
  read 21 previews, and painted search/scroll in 27.7/33.0ms under the unchanged 100ms limit.
- Preview caching is local to the gallery. **Refresh** reloads changed sources;
  oversized or unreadable preview files remain selectable with an unavailable-preview
  label. Search is capped at 20,000 files/20 folder levels; direct folder browsing
  still exposes that folder's complete image list.
