# Paper folders and sidebar verification — 2026-09-06

## Compatibility contract

- New projects use `documentRoot: "paper"` and start with `paper/notes.qmd`.
  No `main.qmd` filename or protected main role is required. The existing
  `manuscript.path` field remains a default for headless commands; deletion
  selects another ordinary document or clears it when none remain.
- Existing manifests and `manuscript/` folders are preserved. Legacy main
  documents retain their protection and historical `comments.json` sidecar.
  New-project comments use document-named sidecars, independent of defaults.
- Discovery is recursive under Paper, legacy Manuscript and Context. Ordinary empty
  folders remain visible. Generated Quarto support/cache trees, unused legacy
  `sections/` scaffolds, Context archives and sync-conflict copies are excluded.
  Explicitly created folders carry `.flux-folder` so they remain visible even
  when empty or named like render output. Existing ordinary folders need no marker.
  Only the three standard Context documents are protected; custom ones can move
  and be deleted.
- Moves preserve comments, manifest registrations and relative Markdown/Quarto
  links. Common YAML file paths, including bibliography arrays, are rebased.
  Code blocks remain unchanged. New files publish without replacing an existing
  destination, including a concurrently created one. IO failures roll back
  completed writes. The GUI flushes edits before moving and changes the active
  path before subsequent autosave; moves currently require a single Paper pane
  because incoming links may change other documents too.
- New nested documents point at the project bibliography; figure insertion
  derives the render path from the active document's depth.

## Initial folder/sidebar verification

- `npm run check`: 0 errors, 0 warnings.
- Production build: passed, including CLI/MCP bundles and generated assets.
- Bundle/startup tier: 4/4 passed. Documentation gate: 156 checks passed.
- Full pure tier: 201/201 passed. Legacy-specific preservation tests now use
  an explicit disposable legacy-layout fixture instead of assuming new
  scaffolds still produce `manuscript/main.qmd`.
- `verify-paper-files.ts`: 39 checks, including real filesystem operations,
  GUI/headless discovery parity, CLI argument execution, actual Electron file
  handler behavior, collision races, rollback, relative links, standard/custom
  Context policy, deleting all documents, and creating a new default afterward.
- `verify-paper-files-gui.mjs`: 24 checks against the mounted app, including
  nested folder creation, figure insertion, pending autosave during a move,
  continued saving at the new location, both visibility toggles, split resizing,
  collapse behavior and an empty ordinary-document collection.
- The 5,000-document fixture mounts fewer than 100 document rows. Collapse and
  expansion painted within 33.4 ms at the slowest of eight interactions against
  the unchanged 100 ms budget; scrolling reached the final document with the
  same bounded DOM. Browser: `/usr/bin/google-chrome`, headless, 1440 × 900.
- Full Paper gate: 43/43 passed in the final clean sweep (236 seconds). Earlier sweeps had one
  table-autocomplete failure (passed independently and in the following full
  sweep) and one new large-tree fixture failure during active HMR (passed on
  a stable app). Neither gate nor its budget was loosened.

No existing scientific project was migrated or edited. Browser tests use the
in-memory fixture; filesystem and IPC tests use disposable temporary projects.
Installed-package behavior on other operating systems was not tested.

## Generated-folder correction — 2026-09-06

- Added regression fixtures for Quarto resource/cache trees in Documents and Context,
  including leftover output after source renaming and Markdown bundled inside libraries.
  Four assertions failed against the original scanner before the correction.
- `verify-paper-files.ts`: 50 checks passed. Discovery skips generated subtrees before
  descending, preserves existing ordinary and authored folders, hides unused `sections/`,
  and preserves explicitly created empty folders. Hidden output remains on disk.
- `verify-paper-files-gui.mjs`: 29 checks passed, including actual browser filtering,
  folder-marker persistence and explicitly adopting the unused `sections/` scaffold.
  The focused run's 5,000-document collapse/expand maximum was 33.4 ms.
  Visually inspected `test-results/out/paper-generated-folders-hidden.png`.
- `npm run check`: 0 errors, 0 warnings. Production build passed. Full pure tier:
  201/201; bundle/startup: 4/4; full Paper gate: 43/43 in 235.4 seconds.
- The first browser launch found the previously running dev server had stopped;
  browser verification then passed on an owned temporary server at :1420.
  Existing scientific projects were not edited.

## Sidebar sizing correction — 2026-09-06

- Reproduced the owner's screenshot: a hard 420px drag ceiling and an Outline
  flex basis fixed at 224px, even though its parent advertised full width.
- `verify-paper-sidebar-layout.mjs` adds 17 checks to the Paper gate. It uses 49
  long nested headings, real pointer drags to 600px and 960px, window widths of
  1100/1440/1800px, outline-only mode, reopening, double-click reset and pointer
  cancellation. The focused run passed with resize-to-paint at most 33.4 ms.
- Visually inspected screenshots in `test-results/out/`: `paper-sidebar-wide.png`,
  `paper-sidebar-outline-only.png`, `paper-sidebar-narrow.png`, and
  `paper-sidebar-extra-wide.png`. The outline spans the available width, long labels
  truncate within their rows, and shrinking the window preserves editor space.
- The new double-click probe initially used Puppeteer's obsolete `clickCount`
  option and emitted only one click. Verified actual event delivery, corrected
  the probe to `count: 2`, and confirmed the reset with a real double-click.
- Final validation: type checks 0 errors/0 warnings, production build passed,
  pure 201/201, bundle/startup 4/4, and full Paper gate 44/44 in 242.5 seconds.
  Final screenshots were generated by that clean sweep; no scientific project
  was edited, and the owned temporary dev server was stopped afterward.
