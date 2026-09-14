# Slide video clips — implementation and verification

For agents verifying this implementation; the user-facing workflow is in
[`docs/modes/slide.qmd`](../modes/slide.qmd). Implemented September 13, 2026. Put `.mp4` or `.mov` clips in `plots/_videos`,
then open **Plots & videos** in Slide mode (`Alt+I`).

## Behavior

Clips import as ordinary movable, resizable, rotatable slide objects, with an
aspect-locked poster on the editing canvas. The gallery supports individual and
pinned batch import, progress, cancellation, and actionable errors. Native
preparation preserves originals and produces a deck-local H.264/AAC MP4 and PNG
poster. Large movie bytes stay out of renderer stores during normal editing and whole-deck
duplication. Required movie/poster copies are staged natively; missing files or
metadata abort duplication before publication, and failures roll back new copies.

Appearance and playback are independent. An Appear step can reveal the poster;
a later **Start video** step starts playback. Start always restarts the clip,
Pause holds its current frame, and Stop returns to the beginning. Playback
continues while a presenter waits for the next step. The inspector supports
Mute and Loop. Preview, Present, offline HTML and inline Paper players share
these semantics, including pause/resume, navigation and teardown. Browsers that
require a fresh user gesture for audio display an actionable Play video button.

Single-slide MP4 export captures decoded clip frames at exact timeline positions
and includes synchronized audio from unmuted clips. Non-looping clips finish
before the final hold; looping clips stop at the finite export endpoint. Export
fails cleanly if a referenced movie cannot load or decode. Portable slide presets
and HTML contain their media; ordinary saved decks and static Paper snapshots
stream local files. Unplaced movies retained for Undo are omitted from exports.

Deck schema 0.5.0 migrates 0.2/0.3/0.4 decks without changing their content.
Canonical Figure schemas and save planners reject video; copying a clip into a
Figure or a deck without its assets gives an actionable message. Presets copy
both media and poster into the destination deck. CLI/MCP expose shared import,
media-track and mute/loop operations using the same construction and persistence.

## Acceptance gates

`node scripts/run-verifies.mjs --group slide-clips` runs the feature's eight
registered gates. Native gates require the production build and bundled encoder:
`npm run build` and `npm run fetch:video-encoder`.

- `verify-slide-video-model.ts`: deck migration/schema, Figure isolation,
  geometry, independent animation families, poster references, duplication,
  portable presets, and streaming/portable export payloads.
- `verify-slide-media.ts`: 21 clock and audio-plan checks, including overlapping
  commands, hidden groups, loops, manual waits and finite export endpoints.
- `verify-slide-media-browser.ts`: 23 checks against real H.264 playback,
  independent appearance/start, pause/resume, navigation, reverse seeking,
  transforms, autoplay handling and lifecycle cleanup.
- `verify-slide-video-media.ts`: native preparation/protocol contracts and
  reserved-directory behavior.
- `verify-slide-video-clips-gui.mjs`: editor checks, including drag/resize,
  dimensions/aspect, Undo/Redo, animation commands, playback, save/reopen,
  pinned batches, cancellation/errors and Figure/cross-deck boundaries.
- `verify-slide-video-media-electron.cjs`: real MP4/ProRes MOV/HEVC MOV import,
  rotation, fragmented MP4, odd dimensions, PQ/HLG HDR tone mapping, short/long
  audio alignment, native decode/seek/audio, range requests, project revocation,
  cancellation cleanup and original preservation. Also verifies shared headless
  import, failed mutation cleanup, native whole-deck duplication with no-clobber
  rollback and missing-media rejection, and a source-free packaged CLI. Portable Paper
  HTML plays in a fresh session allowing only embedded data media.
- `verify-slide-video-clips-electron.cjs`: production app with real preload,
  IPC and encoder; native input, import/edit/persist/reopen, separate On click
  Appear and Start steps in Present, Pause/Resume, and a whole-slide preset copied
  into a fresh deck with independently verified movie/poster bytes and playback.
- `verify-slide-media-export.ts`: actual 720p MP4s at 30 and 60 fps. Decodes all
  72/144 frames, verifies each source-frame mapping and presentation timestamp,
  and measures audio/silence across Start, Pause, restart and completion. Tests
  mute, cancellation, corrupt media, old-output preservation and scratch cleanup.

Fixtures in `scripts/fixtures/slide-video-clips` are original synthetic media with
reproducible generation commands. Native tests isolate user configuration and
project files. Generated evidence lives under `test-results/slide-video-clips/`
and `test-results/slide-media/`, including `clips-with-audio.mp4`,
`clips-60fps.mp4`, `portable-paper.html`, editor screenshots and native logs.

## Final results

- Production build and Svelte check: success, **0 errors / 0 warnings**.
- Full pure tier: **212/212 scripts passed**.
- Full Paper regression group: **49/49 passed**, including tables and slide embeds.
- Bundle/startup: **5/5 passed**. The document-export gate passed all 20 checks after
  installing the missing local Homebrew `librsvg` converter; HTML, Word and PDF all
  render, and offline interactive HTML has no failed requests or console errors.
- Clip editor GUI: **38/38 checks passed**. Real native editor: **23/23 passed**,
  in three consecutive full isolated runs, including trusted resize-handle input
  and persisted aspect-locked geometry. Input-to-paint p95 was **30.7 / 30.9 /
  30.8 ms**, below the unchanged 100 ms interaction budget.
- Real clip conversion, scoped copying/rollback, native/portable playback, and
  complete 30/60 fps frame/audio export gates passed. The original continuous
  MP4 native regression also passed, including all 165 decoded animation frames,
  complex motion, portrait/4K, cancellation and source-free packaged CLI startup.
- Docs: **158 checks passed**; `git diff --check` is clean.

The combined run initially passed 219/221 selected scripts. The two failed
scripts were rerun after supplying the local PDF converter and correcting the
native test's foreground-window activation. All selected scripts are accounted
for by the passing runs; no application assertion or responsiveness budget was
relaxed.

## Verification notes

Tests found and fixed two real capture defects: Chromium rounds rational frame
timestamps to microseconds, and repeated visual/media seeks could intermittently
flash a poster during a hold. Capture now rounds upward by less than one
microsecond and makes exactly one awaited decoder seek for each output frame.
Every-frame decoding verifies this at both frame rates.

Run live UI acceptance on a stable source tree. An early Paper table run was
invalidated when concurrent source/generator changes triggered Vite reloads and
replaced the fixture document. The unchanged table gate subsequently passed
without edits or relaxed assertions. A separate native resize timeout occurred
before a gesture when macOS focus left the test app. Native input now activates
the application, waits for document focus, hit-tests the visible handle, and
asserts a trusted pointerdown with the left button held before dragging.

Native platform acceptance was executed on macOS arm64 / Electron 43. Linux and
Windows runtime/installers were not exercised in this session. The earlier
continuous-video report records the separate pre-existing live-preview frame
budget limitation; no responsiveness threshold was loosened for this feature.
