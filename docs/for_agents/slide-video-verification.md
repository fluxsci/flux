# Single-slide MP4 export — implementation and verification

For agents reproducing acceptance; the user-facing workflow is in
[`docs/modes/slide.qmd`](../modes/slide.qmd). Implemented September 13, 2026. User entry: Slide → **Video…**.

## Behavior

One selected slide exports from its initial design through every animation cue.
The defaults are 1080p/60 fps, 500 ms between manual steps, 1 s at the start and
2 s at the end. Automatic cues retain their authored delay after the first cue;
with-previous steps share a cue. The first cue begins after the start hold.
Settings persist locally. Output preserves aspect ratio, supports 720/1080/2160
pixel heights and 30/60 fps. Unmuted inserted video clips contribute synchronized
audio; slides without audible clips produce silent output. The final frame includes the
exact final pose, including zero holds and effects shorter than one frame.

GUI, CLI and MCP use the same timing and capture path. The GUI refreshes linked
sources and flushes autosave before reading saved bytes. A captured snapshot is
independent of further edits. Jobs show progress, allow cancellation, survive
editor mode changes and clean up when the owner window closes. A complete,
synced file is atomically published; cancellation and failure preserve existing
output. Missing content and authored animation issues are reported as warnings.

## Architecture

- `src/lib/slide/video.ts`: pure options, cue grouping and timestamp schedule.
- `src/lib/slide/export/videoRuntime.ts`: offline capture document; waits for
  fonts/images and seeks the existing player at each exact frame timestamp.
- `flux-core/slideVideo.ts`: gathers one slide, prepares the document, owns the
  subprocess and atomically publishes the completed file.
- `electron/slideVideoWorker.cjs`: isolated sandboxed offscreen renderer, explicit
  device scale 1, synchronous seek → compositor capture → FFmpeg pipe. Only one
  frame is in flight; encoder backpressure bounds memory. Frame/render/encoding
  deadlines prevent a broken child from hanging indefinitely.
- `electron/entry.cjs`: early dispatch for installed Electron, whose executable
  otherwise always opens package.main even when supplied another script path.
- `electron/ipc/slideVideo.cjs`: window/project-scoped save dialog and job lifetime.
  Pipe cancellation works without relying on Windows SIGTERM semantics.
- `scripts/fetch-video-encoder.mjs`: explicit build-time acquisition of the pinned
  standalone executable and upstream notices. Runtime needs no network/download,
  system FFmpeg installation or new native Node addon.

## Acceptance evidence

Run `npm run build` and `npm run fetch:video-encoder` first, then
`node scripts/verify-slide-video-electron.cjs`. The native fixture redirects HOME,
XDG_CONFIG_HOME and APPDATA before loading Flux. It uses the built app and real
preload/IPC; only the save dialog destination is replaced by a scratch path.

The final native gate passed on macOS arm64 / Electron 43:

- Native input moved a real slide object during 1080p/60 capture. Input-to-paint
  p95 was **33.8 ms**, below the unchanged 100 ms interaction budget. The job and
  its result also survive switching to Paper and back to Slide.
- All **165 decoded H.264 frames** of the 2.75-second sample have their expected
  presentation timestamp and moving-object position. Every moving frame is
  distinct; simultaneous fade and numeric-text endpoints match expectations.
  Every frame includes the complete lower slide edge.
- A 49-frame/30 fps fixture exercises a **1,200-point semantic plot morph**,
  simultaneous draw-on, a ghost born from its source's preceding endpoint,
  automatic delay and camera movement. Source deck bytes remain unchanged.
- Static portrait export produces 406×720 pixels with every pixel filled. 4K
  export produces 3840×2160. Zero holds produce a valid one-frame MP4.
- Settings fit 760/1024/1440 px windows; invalid timing is disabled and fractional
  values work. Settings persist. Renderer consoles are clean.
- Cancellation preserves an existing output byte-for-byte and removes partial
  files. Missing slide, missing encoder and a crashing encoder fail cleanly.
- An isolated packaged-style Electron app with no TypeScript sources, default
  app or node_modules exports through the production CLI and prebaked runtime.
  Electron-as-Node also discovers its unpacked worker and bundled encoder without
  environment overrides.

Artifacts are under `test-results/slide-video/`: `smooth-motion.mp4`,
`complex-motion.mp4`, `portrait.mp4`, `4k.mp4`, `packaged.mp4`, `packaged-cli.mp4`,
`settings.png`, `native.json`, `native.log` and `coverage.log`. Artifacts are
generated and ignored by Git. The timing gate is in the pure tier; `slide-video`
groups it with the player/timeline and native acceptance gates.

Integration coverage includes the full pure tier, slide/figure authoring and
source-sync regressions, ghost regressions, inline slide playback/lifecycle and
scale checks, plus the production CLI and startup checks. The document embed
test now uses the platform's actual Undo/Redo modifiers. Generated CLI context
and CLI/MCP help goldens are synchronized with the new verb.

Final outcomes: **208/208 pure scripts**, Svelte check **0 errors/0 warnings**,
native video acceptance, 28 related regression scripts (the corrected macOS
shortcut test rerun individually), bundled CLI and production startup pass.
The dense live-preview scale gate passes at **16.8 ms** frame p95, with 1,200
points/120 effects and zero animation callbacks at rest.

The normal live-preview frame gate remains above its unchanged 17 ms ceiling
on this machine: **17.5 ms** without profiling. A detached worktree of the
original commit `4bb72d8` reproduces **17.6 ms** with the same Chrome for Testing
153 and real-display settings. That isolated baseline also reported two unrelated
Harper WASM-loading errors from its symlinked dependency setup; its actual slide
motion, editing and thumbnail checks passed. Earlier profiled clock controls
were themselves above 17 ms (idle 17.2–17.4 ms, playback 17.6–17.7 ms); traced
animation callbacks cost 0.73 ms p95 / 1.85 ms maximum. No budget was loosened.
The normal-gate limitation is recorded, rather than reported as a passing gate.
It does not determine exported MP4 timing: capture explicitly seeks each frame,
and every encoded motion frame/timestamp was independently decoded and checked.

## Scope of platform verification

Native execution and packaged startup were exercised on macOS arm64. The macOS
x64 encoder was downloaded and checksum-verified. Linux and Windows targets are
configured, including platform-specific executable names and pipe cancellation,
but their native runtimes/installers were not executed in this session. The
packaged startup probe does not replace signing/notarization or installer QA.

This feature exports a single slide. Inserted MP4/MOV clips and their audio are
now supported; see [video clip acceptance](slide-video-clips-verification.md).
Multi-slide movies and separate audio-only tracks remain outside this feature.
