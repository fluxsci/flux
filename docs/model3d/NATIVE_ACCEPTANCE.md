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
| `model3d-native-scale` | Eight distinct 250k-triangle models: one worker/context, bounded source residency, no idle work, raw frame-gap p95 ≤16.7 ms, input→publication ≤100 ms. Includes `model3d-s8`. | Physical scanout |
| `model3d-s8` | The pinned public neural-populations example with four model boxes versus a matched image baseline: ABBA pan/zoom/hover and Paper typing must not regress raw p95 by more than 10% | — |

The Python scenario needs `FLUXPLOT_ROOT` naming an isolated fluxplot `scene3d` git worktree
with its uv environment installed (default: the sibling `../scene3d`), plus Quarto; only
scratch copies are modified. `MODEL3D_S8_PUBLIC_CACHE`, if set, must be inside the per-attempt
scratch temp directory; omit it for a fresh pinned download, and never substitute a local copy
of the example. Budgets compare raw, unrounded samples with no tolerance floor: never round a
failed raw budget into a pass, and never relabel a failed cohort after a later fix or an
adjacent functional pass.
