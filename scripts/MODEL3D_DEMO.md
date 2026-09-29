# Flux 3D review demo

Run from the reviewed Flux worktree with Node 22. The destination must be a new or empty directory under `/tmp`, with an existing real parent directory; existing projects and symlink destinations are refused. The complete project is built in a private staging directory, then published atomically after checking that the destination is still unchanged and empty. The generator creates its own scratch HOME/XDG and disables migration.

```sh
PATH="$HOME/.local/node22/bin:$PATH" node --import tsx scripts/create-model3d-demo.ts --out /tmp/flux-3d-review-demo
```

This uses the checked-in, hash-verified outputs of the public `scene3d/examples/scene3d_demo.py`, recorded at the fluxplot commit in `scripts/fixtures/model3d/demo/PROVENANCE.json`. To exercise the current committed Python library instead, append `--fluxplot-root /path/to/scene3d-worktree`; it needs that checkout's existing `.venv` and `uv`. The invocation uses offline `uv run --no-project`, does not sync the checkout, and copies the example into the scratch project. `--posters` additionally generates derived posters using the built Flux runtime and Electron; absent GPU support is reported in the printed receipt. Without it, opening Flux generates posters normally.

The project contains:

- **Figure 1:** named neuron soma/axon/dendrites and scale bar; cortex `inflated`/`bent` shapes (starting at inflated 0.35); continuous height values with vector colorbar.
- **Figure 2:** corresponding pial/inflated cortex meshes, verified through `model-info --morph-with`.
- **Figure 3:** an eight-frame shape sequence, saved at Frame 2.5.
- **Paper:** references to all three saved Figures.
- **Plots:** six GLB/manifest/recipe triplets, hash receipts and the unchanged Python example.

**Slides:** choose **Flux 3D · motion review**. Five slides demonstrate Turntable, Shape change, Ghost, crossfade Become and a same-topology vertex morph. Advance once from Design on each slide; each has one named motion step. The Paper also includes the Turntable slide as a live embed. `DEMO.json.deck.examples` records slide, step and model IDs.

## Open with disposable state

Build the reviewed Flux worktree first (`npm run build`). Then launch its real Electron entry using the generator's environment receipt, from that same worktree:

```sh
node - /tmp/flux-3d-review-demo <<'JS'
const fs = require('node:fs'), {spawn} = require('node:child_process');
const root = process.argv[2], saved = JSON.parse(fs.readFileSync(root + '/DEMO-ENV.json'));
const env = {...process.env, ...saved, FLUX_NO_MIGRATE:'1', FLUX_PRIVATE_DISPLAY:'1', DISPLAY:':0'};
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.WAYLAND_DISPLAY;
const child = spawn(require('electron'), ['electron/entry.cjs', root, '--ozone-platform=x11'], {env, stdio:'inherit'});
child.on('exit', code => { process.exitCode = code ?? 1; });
JS
```

Open Figure 1, double-click the neuron, orbit and press Enter; one Undo should restore its prior camera. Change the cortex Shape slider and field range, then export PDF and TIFF600. Figure 2 supplies the corresponding pair used by the vertex-morph slide. `DEMO.json` records exact element/asset IDs for `set-model-view` and `restyle-part`; the source files remain in `plots/`.

For the Python source loop, edit only the copied `plots/scene3d_demo.py` (for example the axon palette), then run it with the scene3d environment and `--out /tmp/flux-3d-review-demo/plots`. The example intentionally emits valid **non-rerunnable** recipe descriptors (`recipe=False`); use this explicit script command, not the recipe Run button. Flux's explicit Update from source should retain authored camera/style changes. For a notebook, import `neuron_scene` from that copied script and display its return value; use `scene.show(static=True)` for a PNG-only output when scripts are unavailable or the notebook is untrusted.

## Verify or refresh inputs

```sh
FLUX_NO_MIGRATE=1 node scripts/run-verifies.mjs --group model3d-demo
node --import tsx scripts/gen-model3d-demo-fixtures.ts /path/to/scene3d-worktree
```

The pure gate requires no Python or renderer. It also substitutes destination/parent aliases and concurrent files at the final publication boundary, and checks failed-build cleanup. It checks canonical reopen, source/asset hashes, named parts, shape defaults, Frame, field overrides, morph topology, preserved source sidecars and refusal paths. Refresh inputs only from a committed isolated fluxplot checkout; never edit the generated GLB/JSON/recipe receipts by hand. The generator's scratch project and environment are disposable; retain them while reviewing and remove only the exact paths it printed when finished.
