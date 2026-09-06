# Paper folders and sidebar verification — 2026-09-06

## Compatibility contract

- New projects use `documentRoot: "paper"` and start with `paper/notes.qmd`.
  No `main.qmd` filename or protected main role is required. The existing
  `manuscript.path` field remains a default for headless commands; deletion
  selects another ordinary document or clears it when none remain.
- Existing manifests and `manuscript/` folders are preserved. Legacy main
  documents retain their protection and historical `comments.json` sidecar.
  New-project comments use document-named sidecars, independent of defaults.
- Discovery is recursive under Paper, legacy Manuscript and Context. Empty
  folders remain visible. Context archives and sync-conflict copies are excluded.
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

## Verification

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
