# Native 3D acceptance

How to run the production-Electron 3D gates, and what each cohort does and does not prove.
Dated results and receipts belong in the 3D work ledger, not in this file.

Build the production candidate with Node 22, then run the groups through
`node scripts/run-verifies.mjs --group <name>` with scratch HOME/XDG, `FLUX_NO_MIGRATE=1`,
`FLUX_PRIVATE_DISPLAY=1` and `DISPLAY=:0`; the native launchers pass the real
`--ozone-platform=x11` argv. The production renderer has no `window.__flux` handles: the gates
use native input, the actual preload/IPC and saved files. Timing cohorts need a nonzero display
and a visible, focused test window, so never run two headful input tests at once. A window
that loses focus invalidates the cohort; it is neither a pass nor evidence of a renderer stall.

| Group | Proves | Does not prove |
|---|---|---|
| `model3d-native` | Orbit with one-step Undo/Redo, views, projection, saved-view reload; PNG/TIFF/SVG/PDF exports (exact PDF MediaBox, extractable vector labels); GPU, `SOFTGPU`, disabled and cached-poster paths; context loss; input→publication p95 ≤100 ms. Includes `model3d-native-smoke`. | GPU scanout (it observes the next animation frame after publication); large-geometry scale |
| `model3d-native-smoke` | X-ray part recolour/hide/text style and field range/colormap against saved state and mesh pixels; the saved view in a Paper embed and a real Quarto Word export; a scratch `uv` fluxplot rerun → **Source changed** → Update → Undo/Redo | Timing. Allowed at a 0×0 display as `functional-offscreen` (the receipt says so), which also excludes OS pointer placement and visible interaction |
| `model3d-verbs-native` | Production CLI/MCP 3D verbs: real headless poster-worker spawns, warm-cache reuse, and `get_figure_image` over the compact MCP server without project writes | Visible input latency |
| `model3d-native-scale` | Eight distinct 250k-triangle models: one worker/context, bounded source residency, no idle work, raw frame-gap p95 ≤17 ms and the dropped-refresh bound below; input→publication and next frame ≤100 ms. Includes `model3d-s8`. | Physical scanout |
| `model3d-s8` | The pinned public neural-populations example with four model boxes versus a matched image baseline: ABBA pan/zoom/hover and Paper typing raw p95 ≤max(image p95 ×1.1, image p95 + one measured idle refresh) | — |

The Python scenario needs explicit `FLUXPLOT_ROOT` naming an isolated fluxplot git worktree
with scene3d support and its uv environment installed, plus uv and Quarto. The runner reports
a missing prerequisite as blocked before launching Electron; only scratch copies are modified.
`MODEL3D_S8_PUBLIC_CACHE`, if set, must be inside the per-attempt
scratch temp directory; omit it for a fresh pinned download, and never substitute a local copy
of the example.

The owner-approved R1 frame budget uses the same run's median idle rAF gap: a steady Orbit
gap greater than 1.5 times that median counts as a dropped refresh. At most
`max(1, floor(steady gap count × 0.02))` such gaps are allowed, in addition to raw p95 ≤17 ms.
The idle control runs after the zero-work-at-rest observation and before measured Orbit;
its finite measurement loop is separate from the publication-driven Orbit observer.
The existing six-gap warmup and all-gap report remain explicit. R2 pools the four S8 idle
controls to determine the one-refresh allowance in the table; every ABBA cohort must supply
its own control and raw nonempty phase samples.

The eight-model harness starts at ordinary 100% zoom, uses normal toolbar zoom-out only if
the actual clipped canvas is smaller than the grid, and centers with native pan. Every model
must remain fully visible and hittable; the measured zoom and geometry are recorded. S8
keeps the original artwork and exact matched replacement geometry, and its typing oracle
retains the Paper editor selected by the native click even when other CodeMirror editors exist.

Budgets compare raw, unrounded samples. Never round a failed raw budget into a pass, or
relabel a historical failed cohort after a budget decision, later fix or adjacent functional pass.
