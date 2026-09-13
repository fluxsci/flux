# Inline slides — implementation and verification

Implemented and verified on Linux, 2026-09-13. The approved scope is in
[`INLINE_SLIDES_IMPLEMENTATION_PLAN.md`](INLINE_SLIDES_IMPLEMENTATION_PLAN.md).

## Delivered behavior

- Paper's **Insert slide…** command and **/slide** open a searchable deck picker,
  then a virtualized slide grid with fully built thumbnails. Insertion is one undoable edit.
- Each inline occurrence opens at step 0. Artwork clicks, Next, Back, Reset and local keyboard
  controls operate one authored beat at a time, including `auto` and `with-prev` beats.
  Clicking during a transition settles it; the final step stops. Present retains its existing timing.
- Captions and sizing belong to the document. Playback is transient and independent between
  occurrences; prose edits, resizing, viewport disposal and preview refresh preserve it.
  Reopening a document resets it. Open in Slide hands off to the source deck and slide.
- Saved source changes refresh referenced slides. Closed decks use the shared source acceptance
  policy without borrowing authoring caches, baselines or history. Missing references show a
  local error and replacement action. Referenced slide/deck deletion reports affected documents.
- Preview and exported HTML use the same compact player. HTML is self-contained and works
  offline; PDF and Word contain the step-0 SVG poster, with Word's existing raster fallback.
  Includes and nested ordinary/Context documents use the same reference and export rules.
- CLI/MCP expose `insert_slide_embed` (`insert-slide-embed`), selected-document `compile --doc`,
  and an explicit forced slide deletion override. Generated help, agent references and user
  guides were updated.

## Automated evidence

| Check | Result |
| --- | --- |
| `npm run check` | 0 errors, 0 warnings |
| `npm run build` | Production renderer, extension, slide assets, CLI and MCP built |
| Pure tier | All 207 scripts passed across the final run and focused path-map rerun; see note below |
| Full `paper-gate` | 49/49 scripts passed in 263.3 s |
| Bundle/startup tiers | 5/5 scripts passed, including actual slide exports |
| `verify-slide-embed-core.ts` | 46 checks passed |
| `verify-paper-slide-embeds.mjs` | 14 checks passed after adding a loaded-thumbnail assertion |
| `verify-slide-embed-lifecycle.mjs` | 9 checks passed |
| `verify-scale-paper-slide-embeds.mjs` | 6 checks passed |
| `verify-slide-embed-export.mjs` | 20 checks passed |
| `verify-slide-embed-electron.cjs` | 7 checks passed against the built app and real preload |
| Existing slide tenancy GUI | Passed |
| Existing slide source-sync GUI | 32 assertions passed |
| Existing slide authoring GUI | 27 checks passed |
| Existing ghost authoring GUI | 38 checks passed |
| Registry parity | All 114 verbs passed; goldens regenerated |
| `git diff --check` | Clean |

The final pure run passed 206/207 scripts. Its only failure was the path-map test's old expected
selection, which omitted the newly required inline-slide group. Updating the exact expectations
and adding assertions that player changes select both inline playback and scale gates produced
**73 passing path-map checks**. No performance threshold or product assertion was relaxed.
The complete Paper run also includes the new core/editor/lifecycle checks; the additional editor
rerun verifies that the thumbnail has actually loaded before taking its screenshot.

The pure tier covers the existing player, timeline, morph/ghost browser logic, source policy,
document discovery, export preparation and CSP/security checks. New tests additionally exercise:

- Protected-context parsing and round trips, scoped payloads, safe source paths, independent DOM
  IDs and playback, no global plot-cache writes, disposal and idle frame cancellation.
- Closed source acceptance and physical dimensions, failed-source retention, stable source
  revision reuse, poster regeneration, duplicate anchors, deletion dependencies with live buffers,
  safe CLI insertion and exact temporary-source restoration.
- Cancellation before writes, protection of concurrent edits and deferred Paper autosaves while
  Quarto reads temporary source files.
- Real keyboard/pointer input, Undo/Redo, width updates retaining DOM identity, replaced/missing
  sources, retained beat identity, removed beats, viewport cleanup and preview restoration.
- Actual Quarto rendering of a nested document with includes to HTML, PDF and Word; payload
  deduplication, speaker-note exclusion, Word SVG/PNG relationships and unchanged source bytes.
- Offline HTML with network disabled, independent playback, actual step-0/1/2 painted pixels,
  JavaScript-disabled fallback and browser Back navigation. Runtime executes under the exact
  generated CSP hash; Electron's print window remains JavaScript-disabled.

## Performance and visual inspection

The final scale fixture has **20,000 lines, 100 slide references to five distinct slides, and a
1,000-slide deck**. It uses ordinary separated paragraphs, matching the existing Paper scale
convention. Measured synchronous document load was **59 ms**. All **15 real typing-to-frame
samples** were below 100 ms; the maximum was **16.6 ms**. At most three players were mounted,
typing retained the visible player's DOM, fewer than 30 picker cards were mounted, and the final
search keystroke painted its result within 100 ms. These are fixture measurements on this Linux
machine, not universal latency guarantees.

Visually inspected the loaded picker, inline editor, offline HTML, and static exported pages.
The animated fixture's step 0 shows its title and axes, with the later blue rectangle and plot dot
absent. At step 1 the rectangle appears; at step 2 the dot appears. The picker thumbnail shows
the fully built slide. Word's actual `.docx` was opened through LibreOffice's headless renderer
and its resulting PDF page was inspected; both embedded slides retain the correct step-0 state.
The native Electron PDF was also rasterized and inspected.

Artifacts generated by the gates (ignored by Git):

- `test-results/out/inline-slide-picker.png`, `inline-slide-document.png`,
  `inline-slide-preview.png`, `inline-slide-offline-html.png`, `inline-slide-static-poster.png`.
- `test-results/inline-slide-export/paper/nested/report.{html,pdf,docx}`.
- `test-results/inline-slide-export/review/word-rendered.pdf` and `word-page-1.png`.
- `test-results/inline-slide-native/native-inline-slide.png` and `native-slide.pdf`.

## Reproduction and environment

Use Node 22 and the existing dev server on :1420 (check before starting another). Standard npm
predev/precheck/prebuild hooks generate the compact runtime and matching CSP hash. Native tests
use a scratch project, a scratch FluxConfig/FluxLib and isolated `XDG_CONFIG_HOME`; they do not
change `HOME` or exercise the user's projects. Quarto tests isolate `XDG_CACHE_HOME`; the fixture
chooses installed `pdflatex` with automatic TeX installation disabled.

```sh
npm run check
npm run build
XDG_CACHE_HOME=/tmp/flux-inline-quarto-cache node scripts/run-verifies.mjs --tier pure
node scripts/run-verifies.mjs --group paper-gate
node scripts/run-verifies.mjs --group inline-slides
node scripts/run-verifies.mjs --tier bundle,startup
node scripts/verify-slide-embed-electron.cjs
```

Run the scale gate without competing browser/native verification jobs. Session logs are under
`/tmp/flux-inline-{check,build,pure-final,paper-final,bundle,editor-final,scale-final,native-final,existing-slide}.log`.

Validation used Chromium, Linux Electron, Quarto and LibreOffice; native macOS/Windows apps and
Microsoft Word were not executed here. Existing format/path abstractions and the established
Word raster-fallback implementation are retained. The approved feature boundaries remain:
one existing project slide per embed; no full-deck embeds, external deck import, cross-project
linking, autoplay, inline slide authoring, or separately selected print step.
