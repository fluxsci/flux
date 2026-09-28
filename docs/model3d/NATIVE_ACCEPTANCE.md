# Native 3D acceptance

Build the combined candidate with Node22, then run the registered native gates with
scratch HOME/XDG, `FLUX_NO_MIGRATE=1`, `FLUX_PRIVATE_DISPLAY=1`, `DISPLAY=:0` and
`--ozone-platform=x11` (the native launchers supply the argv flag). Timing qualification requires nonzero display dimensions and a visible, focused
test window. The four additional functional smoke scenarios may run without a
connected display: their receipts explicitly say `functional-offscreen` and retain
the actual display snapshot and fixed requested window bounds. That cohort proves
production UI/state/file/pixel behavior only; it does not qualify OS pointer
placement, visible desktop interaction, responsiveness, frame budgets or S8 feel. Do not
run another headful input test at the same time. The production renderer has no
`window.__flux` handles; tests use native input, actual preload/IPC and saved files.

`node scripts/run-verifies.mjs --group model3d-native-smoke` adds the following to the
Orbit/export/fallback gate:

- X-ray axon recolouring, dendrite hiding and scale-bar text styling, checked against
  saved overrides and changed mesh pixels.
- Continuous-field range and colormap controls, checked against saved fields,
  colorbar text and changed mesh pixels.
- A saved top view in the Paper figure embed, then an actual Quarto Word export with
  embedded mesh/vector furniture and a raster fallback. The manuscript's source bytes
  must be restored after export.
- A real scratch Python rerun through `uv`, followed by Source changed, explicit
  Update, preserved camera/restyles, and one-step Undo/Redo with both asset files kept.

For the Python case, `FLUXPLOT_ROOT` names the isolated `scene3d` worktree; by default
it is the sibling worktree `../scene3d`. It must be a git worktree, not the owner's
checkout. Its existing uv environment must already be installed. The gate copies the
reviewed demo generator into its scratch project and changes one soma palette value;
only the scratch copy and scratch outputs are modified. Quarto must be installed.

The original native gate keeps its existing default scenarios. The additional smoke
gate writes separate evidence under `test-results/model3d/native-smoke/`, including
screenshots, the Paper SVG, Word document/media, Python rerun log and saved-state
receipts. A failed or unavailable native run must not be described as passed based on
browser/helper checks.

The combined production smoke run on 2026-09-28 passed all 42 checks with
`native-display` qualification in each scenario (run
`2026-09-28T16-39-38-908Z-1004064`). Independent artifact review confirmed the
screenshots, saved-state preservation and actual Word media; the Word mesh bytes
match the displayed Paper mesh. This closes these functional scenarios only;
the separate native scale and S8 performance gates retain their own results.

The current trusted notebook refresh on 2026-09-28 also passed in actual VS Code
1.138.0, QMD Notebook 0.1.0 and Jupyter 2025.9.1/renderers 1.3.0 using viewer
`c740ce4ed095b0645c668e19a3d94c68bc93e838622f048604a3ad2be7c27fb9`
(767716 bytes). Controls, the selected Copy view literal applied through the live
kernel and saved manifest, static PNG output, and rerun/clear ownership were checked.
This does not claim OS clipboard transport or change the documented untrusted-output
limitation. See `test-results/model3d/notebook/current-native/REVIEW.md` and its saved
notebooks, screenshots, hashes and corrected isolated harness.

Performance qualification is separate from these functional passes. The final
production build is `38e80f8ba6033330e9630a65aa43ac0482321ad1`; subsequent
`22f4acbd9bcb1be792f202ef17ee2af11db6eabe` changes only a watcher regression and
its documentation. Fluxplot is `95625ff0f683e2747a642c71998205554cd9716e`.
Stage 1 feature coverage is complete, but these native qualifications remain open:

| Qualification | Status at Stage 1 closure |
|---|---|
| Public-project S8, original model/image/image/model comparison | UNQUALIFIED. Post-fix capture passed, but the first comparison cohort lost native focus before Figure hover; no complete ABBA result. An uninterrupted desktop window is required. |
| Eight distinct 250k-triangle models, strict frame throughput | Final-candidate rerun UNRUN. The previous valid raw p95 was 16.702000000000226 ms against 16.7 ms and remains a failure. |
| Actual QMD and Jupyter 300k first frame | Final `95625ff0` rerun UNRUN. The prior `7d2a578e` frontend passed ≤1 s; full MIME-plus-frontend lower bounds exceeded 1 s. Preparation-only improvement is verified separately below. |

The latest post-fix registered S8 attempt
`2026-09-28T18-29-06-938Z-1589243` passed the 20-check hardware capture and its
26-key Paper phase, then refused Figure hover at the native focus guard. It did
not record the OS focus owner at that transition, so the cause of that particular
transition cannot be reconstructed. A separately reviewed read-only diagnostic
reproduced focus loss while the test window stayed visible: native and renderer
focus became false, and the OS active window changed outside the test process.
Metadata-only XRes/process lookup identified that diagnostic focus target as
`gnome-shell`; it does not establish why the shell took focus. A later unlocked
screen query does not reconstruct the earlier event.

The observer forwarded the original qualification policy and did not refocus,
disable throttling or inspect another window's contents. Its synchronous logging
can perturb timing, so it is diagnostic evidence only. Qualified native reruns
remain pending an uninterrupted desktop reservation. See
`test-results/model3d/scale/s8-focus-diagnostic/`.

The strict frame requirement remains raw p95 ≤16.7 ms; no rounding, tolerance floor
or display-rate exception is applied. The previous cohort measured
16.702000000000226 ms, and a same-display empty-Figure demand-rAF control measured
16.702 ms. That control is diagnostic evidence, not a passing scale result. The
harness observes the first animation frame following matching mesh/furniture
publication; this is a paint opportunity, not physical GPU scanout.

S8 retains trusted native input, focus/visibility, canvas-relative containment of
all original artwork and four new models, exact image replacement, zero idle work,
and the original raw ≤10% model-versus-image comparison. Two demonstrated causes
have been corrected without changing those limits:

- First publication of derived `fig/renders` directories no longer triggers a
  canonical Figure reload and unnecessary Paper CodeMirror measurements. Actual
  chokidar/IPC regressions retain canonical asset/canvas and linked-source
  notifications. Subsequent native capture passed unchanged 500 ms idle assertions.
- Canvas pointer activity defers optional zoom-snapshot serialization until the
  existing 1,500 ms quiet interval. Trace evidence attributed SVG load/raster/readback
  stalls to this work in both model and image variants. Valid bitmaps are retained;
  active Orbit/scrub previews are excluded. There is no new rAF loop, timeout-driven
  idle callback, artificial input delay or compositor promotion.

The latter correction has author 4/4 and independent 4/4 regression coverage, plus a
separate 17/17 follow-up with actual changed Orbit view and trusted ordinary hover.
Before the preview guard, the regression caught 52 extra quiet timers and one idle
callback; afterward timers, idle callbacks, SVG captures and worker renders remain
unchanged. The held-decode functional setup supplies one test-only screenshot/frame
after real idle registration because headless Chromium may otherwise defer its
no-timeout idle callback. Initial hover→quiet assertions and native S8 remain
unforced. See `test-results/model3d/snapshot-quiet-review/`.

Safe Python preparation now builds the GLB/manifest once per MIME call and skips an
unused Matplotlib autoscale scan before explicit camera limits. Same-process ABBA
measured 1,165.66/1,137.15 ms before and 878.72/866.88 ms after, with byte-identical full
PNG and HTML outputs. These preparation measurements are separate from the final
native notebook first-frame measurements. A faster scratch Agg prototype was
rejected because it thickened thin branches and changed translucent edge/overlap
rendering. See `test-results/model3d/notebook/perf-review/`.

The prior actual 300k notebook run on `7d2a578e` measured QMD/Jupyter frontend
activation→double-rAF paint opportunity at 517.6/569.3 ms. Python MIME preparation
was 1106.58/1103.56 ms, giving total lower bounds 1624.18/1672.86 ms. Thus frontend
activation met 1 s but the whole path did not. Kernel-dispatch→frame was 3005/2574 ms
and includes transport/probe overhead. No final `95625ff0` native first-frame result
is claimed; the exact-output preparation improvement must not be combined with
old frontend samples and presented as a newly measured total.

The final affected Paper suite passed 68/68 on `38e80f8b`, run
`2026-09-28T18-40-47-722Z-1761478`, sourceChanged=false. This closes affected
functional regressions, not the outstanding native performance qualifications.
The corrected full pure tier passed 335/335 (18-47-03-582Z-16), and final
bundle/startup passed 6/6 (18-49-21-207Z-16), both sourceChanged=false on `22f4acbd`.
Final browser regressions passed 9/9; none substitutes for the open native runs.

Current evidence lives under `test-results/model3d/scale/s8/`,
`scale/pre-snapshot-requalification-20260928T182800Z/native/` and
`test-results/model3d/notebook/300k/` (the older Python qualification described above). Earlier failed/unqualified cohorts remain
archived under `scale/pre-snapshot-requalification-20260928T182800Z` and the
individual diagnostic directories. No failed cohort is relabeled as a pass by a
later source fix or an adjacent functional test.

Stage 2 Slides integration remains explicitly paused by the owner. These results
cover the implemented Figure/notebook/agent scope and do not establish slide
playback, ghosts/Become, animation targets or deck conversion acceptance. Overall
plan status remains PARTIAL.
