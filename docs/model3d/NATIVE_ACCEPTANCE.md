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

The combined production smoke run on 2026-09-28 passed all42checks with
`native-display` qualification in each scenario (run
`2026-09-28T16-39-38-908Z-1004064`). Independent artifact review confirmed the
screenshots, saved-state preservation and actual Word media; the Word mesh bytes
match the displayed Paper mesh. This closes these functional scenarios only;
the separate native scale and S8 performance gates retain their own results.
