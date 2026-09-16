# Responsiveness audit — 2026-09-16

Independent review of `perf-instant-canvas` (`8132d66`) against the redesign on
`main` (`3444ce3`), including the complete [original session report](RESPONSIVENESS_SESSION_2026-09-16.md),
preserved from `notes/Flux_Responsiveness_Session_2026-09-16.md`. The owner
approved committing and merging the reviewed work into `main` on September 16.
The remote push remains with the owner.

## Findings and decisions

The major performance mechanisms were real. Preserve the explicit cursor on
plot element wrappers, the paused-animation transform drive, culling hysteresis,
the removal of SVG figure subtrees from Paper, and a bounded zoom raster. The
initial implementation and the strength of some conclusions needed correction.

| Area | Independent finding | Result |
| --- | --- | --- |
| Cursor inheritance | The redesign's inherited cursor restyled dense SVG subtrees on hover/press. Production input and the dense cursor gate reproduce this. | Keep the cursor firewall. |
| Transform drive | Per-frame style transforms incurred layerization work; a paused animation is an appropriate browser-specific optimization behind one small shared action. | Keep the drive and lifecycle gates. Make the standalone lab portable and use identical pan motion across variants. |
| Culling | Unconditionally freezing the mount set during a long gesture left the destination empty. | Retain hysteresis inside the buffer; mount newly visible content as soon as coverage is exhausted. |
| Zoom coverage | On the original branch, a long pan followed immediately by zoom hid the live scene while the proxy's right edge was **732 px left of the canvas**. | Check current coverage before and throughout a gesture. Abort to live art on bounds/content changes. |
| Zoom appearance | The image missed grid/root font styles, could ignore Slide camera clipping, and rounded dimensions produced unequal world/screen mapping. A resting opacity of .01 also showed a stale ghost. | Inline computed scene styles and bundled fonts; share the camera clip; use actual raster dimensions independently per axis; idle opacity is zero. |
| Zoom lifecycle | Changes while a capture was pending did not reliably restart the quiet interval. Scheduled idle work survived teardown. | Cancel timers/idle requests, invalidate obsolete async results, and defer work in hidden panes or during interaction. |
| High DPI | The 3 MP limit was applied before DPR multiplication: the old helper allowed nearly 12 MP at DPR 2. Comparing zoom to a pixel-capped raster scale also retriggered identical idle captures. | Cap physical pixels and dimensions; compare refresh eligibility to the view zoom at capture. |
| SVG CSS baking | A partial regex CSS engine changed cross-sheet precedence, conditional cascade and attribute-selector matching. Pixel counterexamples differed by 3,000–6,000 pixels. | Remove the generic compiler. Bake only the uniform matplotlib stroke defaults when every sheet is eligible; preserve stylesheet conditions and invalid-inline fallback; otherwise retain all scoped CSS. |
| Clip hoisting | Bounding-box clips use different coordinates for a group than for each child. Hoisted clips also stopped following translated parts. | Limit the optimization to static geometry with user-space clips; preserve text/glyphs, definitions, transforms and residual CSS. Restore original child clips before a semantic translation. |
| Prepared plot cache | Manifest presence was used as a key instead of manifest content. Reusing SVG bytes with revised semantic groups returned obsolete targets. | Key by SVG plus complete manifest content; snapshot mutable manifest input; bound entries, nodes and source text size. |
| Paper images | Existing same-id bindings could retain obsolete art, hidden previews failed to refresh on reveal, deleted figures could remain visible, and standalone images lost bundled fonts. | Subscribe every binding to revisions, decode before swapping, embed fonts, reject obsolete async loads, isolate project changes, clear missing images and request previews near the viewport. |
| Paper cold work | A final trace caught a 131 ms idle callback preparing an entire dense figure. An idle callback does not prevent that work from blocking new input. | Prepare plots through the existing shared builder in short slices, then use the same figure serializer. A behavioral regression checks input turns before image creation, exact SVG parity and cancellation on revision changes. |
| Paper layout | Asynchronous decoding exposed a document-height jump under `width:auto;height:auto`; HTML dimension attributes alone did not reserve the preview box. The existing navigation gate caught it. | Reserve CSS width/aspect ratio from model dimensions, retaining the existing maximum display height. The navigation assertions pass unchanged. |
| Selection cleanup | Clearing every selection outside Canvas destroyed legitimate selections in another visible pane. | Clear only selections anchored in hidden keep-alive panes. |
| Dense-scene editing | The 1,600-element development gate failed at about 150 ms per nudge. A CPU profile identified redundant reactive alias/bbox publication in the shared element painter; Svelte mutation diagnostics magnified the cost. | Read the element prop directly and publish scalar center coordinates. Keep mutable-model semantics. The same gate now passes, and production native input is below 100 ms at 1,600 and 5,000 elements. |
| Flicker diagnostic | The layer-swap oracle filtered out zero-width frames before detecting blanks. CDP screencasts also sample frames; they do not capture every presentation. | Keep all frames, add planted dropout/spike tests, and withdraw the claim that remaining flicker must be outside Flux. |
| Input probe | Repeated phases could accumulate rAF loops; handler-start timing omitted input queueing. Cross-mode geometry could include hidden canvases. | Cancel the prior loop, use event timestamps, scope geometry to the selected surface, and record the proxy as well as the frozen scene. |
| Red Paper tests | A clip test waited for an offscreen lazy image before revealing it. The Slide redo test sent lowercase `z` with Shift; CodeMirror interpreted the impossible character/modifier pair as Undo. | Scroll the actual image into view before checking pixels; send the real uppercase `Z` event. All original behavioral assertions remain. |
| Content-scale control | The new menu row clamped at .05 while the existing Inspector accepted .01. | Match the Inspector range and verify typed values, undo and reset through the actual menu. |
| Menu keyboard focus | A fast field-hotkey → value sequence could discard the digits: the row was armed but focus waited for the next animation frame. | Focus after the Svelte DOM flush and menu placement, with guards against stale callbacks. The new rapid content-scale test reproduced the failure before the fix. |

## Evidence and reproduction

New registered tests:

- `verify-render-optimizations.mjs`: browser pixel comparisons against pristine
  SVG rendering, including multiple stylesheets, selector interactions, clip
  units, moved parts, overlapping clips, fonts/grid/gradients and hidden art;
  actual Paper binding revisions, hidden/revealed/offscreen states and deletion.
- `verify-canvas-coverage.mjs`: real wheel sequences on the shared Canvas, long
  pan coverage, immediate zoom, mid-zoom edits, grid changes, selection ownership,
  physical DPR=2 allocation and stable capped-image reuse.
- `verify-frame-oracle.ts`: known blank frames, consecutive/boundary dropouts,
  partial content loss and geometry spikes must be detected.
- `verify-plot-style-bake.ts` expanded to cover the conservative CSS/clip contract
  and manifest-content invalidation. The Slide camera gate now exercises the
  actual zoom image and switching the presentation while zooming.

The pixel gate was also run against an isolated original `8132d66` checkout.
It detected the CSS, object-bounding-box clip, translated clip, snapshot
font/style/geometry, physical-pixel-budget and Paper revision/deletion failures.
The continuous-pan reproduction separately demonstrated the original blanking.
The new tests therefore distinguish the bad implementation from the corrected
one; they are not merely confirming source patterns.

Production builds and native test fixtures use `/tmp/flux-audit-final`; the
user's project and running build are preserved. The original and main builds
were retained separately. Browser tests use the existing server on :1420.
Full logs and screenshots are in `test-results/` and `/tmp/flux-audit-*.log`.

## Measurement boundaries

The real-project input probe copies
`~/fluxsci.github.io/examples/neural-populations` and uses real Electron input.
It visits Paper before Figure, so hidden-editor effects are represented. These
Linux headless runs reported **software rendering**, not the physical NVIDIA /
GNOME display path. They establish application costs and sampled frame cadence,
not physical-display flicker or MacBook performance.

Cached-image zoom and live-rendering fallback are different workloads. After an
edit, during capture, outside cached coverage, or above 20,000 mounted scene
nodes, correctness requires the live path. Neither a quiet snapshot nor an idle
callback makes its serialization/decode free. Keep reporting cold work, idle
outliers, missed input and frame distributions alongside steady-state averages.
The ≤100 ms direct-input budget remains in force; a previous build missing it
would not excuse a miss in this branch.

## Measured results

The same copied real project was exercised on main, Claude's original commit,
and the audited build. These are single matched runs, not a hardware benchmark.
Times below are p95 frame gaps unless stated otherwise.

| Workload | Main `3444ce3` | Claude `8132d66` | Audited build |
| --- | ---: | ---: | ---: |
| Figure hover | 183.3 ms | 16.8 ms | 16.7 ms |
| Figure plot selection | 1000 ms | 16.8 ms | 16.7 ms |
| Figure pan | 183.3 ms | 16.8 ms | 16.7 ms |
| Figure rapid zoom | 50 ms | 16.7 ms | 16.8 ms |
| Paper scrolling | 49.9 ms | 16.7 ms | 16.8 ms |

Main stalled and delivered fewer events/samples; do not convert these numbers
into precise speedup ratios. The final combined Paper → Figure → Slides run
measured Figure click-to-paint p95 **33.0 ms**, Slide click-to-paint **32.1 ms**,
and Paper key-to-paint **32.3 ms**. Both canvases delivered all 72 pan wheel
events and all 60 zoom wheel events. Figure hover delivered 37 of 40 moves,
with a maximum sampled frame gap of 66.8 ms; this was not a zero-outlier run.
Idle snapshot work still produced 63 ms / 52 ms long tasks in Figure / Slides.

The final production native Figure gate measured **46.3 ms** at 1,600 elements and
**85.1 ms** in a 5,000-element project (3,761 mounted, 48 layer rows). An earlier
post-fix run also passed at 51.4 / 88.7 ms. This gate
times handler-to-two-rAF paint; the real-project input probe above starts from
the event timestamp and includes queueing. Development diagnostics remained
more expensive: 1,600-element nudge p95 100.1 ms (3.0× control, under its unchanged
4× gate), 5,000-element edit 131.2 ms. Production measurements, not a waiver of
the 100 ms policy, supply the native acceptance evidence.

The cold Paper trace before slicing had a **131 ms** preparation task, a 59 ms
SVG-image decode task and a 116.6 ms maximum frame gap. After slicing, the same
trace had **no tasks over 50 ms**, p95 16.7 ms and maximum gap 50 ms. A separate
untraced combined run also had no Paper scrolling long tasks. Cold work was
moved into interruptible slices, not removed from the total CPU cost.

The portable 12,000-path compositor lab measured **59 layerization updates /
241.4 ms** with direct style transforms versus **1 update / 5.8 ms** with the
paused-animation drive over the same 60-frame pan. The corrected swap lab
sampled 33 / 66 / 67 / 83 frames across its four scenarios on a private Xvfb
display, with no detected blanks or geometry spikes. Its fixture now keeps all
four corner markers onscreen, and it uses capture timestamps. Headless Electron
startup for that standalone lab crashed; the isolated Xvfb execution succeeded.
Neither result proves every physical frame is correct.

Cached zoom and live fallback must also be reported separately. The warm-image
gate verifies that the proxy actually runs and meets its unchanged per-tick
budget. The final sequential real-project zoom used substantially more CPU
than Claude's unsafe cached path (about 1005 vs 125 ms across the phase), while
maintaining 16.8 ms p95 frame gaps. Coverage/content checks can require live art;
removing them to reproduce the cheaper number would restore the blanking bug.

## Validation ledger

- `npm run check`: **0 errors, 0 warnings**.
- Full production build: passed in the isolated staged copy; the owner's
  running dev server and original `dist/` were preserved.
- Full pure tier: **231/231 scripts passed**, followed by targeted reruns for
  the final CSS guards and documentation/routing edits.
- Final full Paper regression group: **50/50 scripts passed** after the preview
  preparation and layout fixes, with navigation assertions unchanged.
- The 297-script affected sweep initially passed 292. Its five failures were
  investigated and resolved: two Quarto cache permissions (use a writable
  `XDG_CACHE_HOME`), an obsolete culling source assertion, stale routing
  expectations, and the actual dense-scene reactive-performance defect.
  Each failed gate subsequently passed; no timing threshold was relaxed.
- All nine scale scripts were exercised. Eight passed the full scale sweep;
  Figure passed after the reactive fix. Coverage includes Library, Reader,
  Paper, full-text search, Slides, dense Slides, lazy assets and inline slides.
- New renderer regressions: **24 browser checks**, **11 canvas coverage checks**,
  **64 pure CSS/clip/cache checks**, and **12 frame-oracle checks**. The real
  Slide camera gate has **16 checks**, including the active raster path.
- Native Figure tests also exercised palettes, undo, frame resizing and real
  SVG/PNG/PDF exports. Native Slide stash tests exercised persistence, reopen,
  input and playback. Export parity and asset/preservation gates passed in the
  wider sweep.

Reproduction (from the repository with the existing :1420 server):

```sh
XDG_CACHE_HOME=/tmp/flux-audit-cache node scripts/run-verifies.mjs --tier pure
XDG_CACHE_HOME=/tmp/flux-audit-cache node scripts/run-verifies.mjs --group paper-gate
node scripts/run-verifies.mjs --tier scale
node scripts/verify-render-optimizations.mjs
node scripts/verify-canvas-coverage.mjs
node scripts/perf/layerize-lab.mjs base
node scripts/perf/layerize-lab.mjs waapiKeyframesStyle
```

Production real-project probes use `scripts/perf/input-probe.cjs` in the staged
build with `--surface=all --phases=hover,clicksPlot,dragPlot,idle,panSmall,zoomFast,scrollV,typing`.
Native acceptance uses `verify-figure-polish-electron.cjs` and
`verify-slide-stash-electron.cjs` with scratch projects/configuration and a
private virtual display. Artifacts and the consolidated acceptance record are
under `test-results/responsiveness-audit/` (local, ignored artifacts). The source,
regression tests, original session report and this audit are included in the
reviewed changes approved for integration into `main`.
