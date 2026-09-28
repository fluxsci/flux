# Figure model display and import

In Figure mode, Import and the plot gallery accept `.glb` models alongside PNG/SVG plots.
Save a new standalone figure project before importing a model. If the mixed Import picker
first selected a GLB for an unsaved project, Flux saves the project and asks you to select
the files again: adopting the new native root intentionally clears the old picker grants.
A GLB-only selection uses a GLB-only second picker; a mixed selection keeps PNG/SVG/GLB.
Canceling the second picker leaves the saved project intact. Dropped Files need no repicker. A source `.fluxplot.json`
sidecar adds authored physical size, view, colors and vector furniture when its scene3d
contract and original-byte receipt are valid. Plain meshes use the shared model defaults.
The stored model is a prepared copy; the source receipt remains attached to the element.

The Project and Global galleries show cube/3D chips and a 3D-only filter in tile and list
views. Accent chips identify validated scene3d metadata; invalid or future metadata uses
plain-mesh styling. List checks read bounded metadata only. A rendered thumbnail also
checks the original GLB checksum and downgrades a mismatched sidecar. Ctrl/Command-click
or Preview opens a static larger preview. Previewing never imports source files.

A figure model behaves like the existing placement box: select, move, resize, rotate,
duplicate, clipboard, cross-figure drag and Undo/Redo. Resize reframes the mesh and retains
furniture point sizes. True size is intentionally unavailable for model placements.
The Inspector adds camera controls and semantic shape/field settings. Linked source changes
use an explicit [source update](SOURCE.md); they never replace a model automatically.

The mesh is a decoded PNG data URL inside the scene SVG. Furniture stays vector text and
geometry. This makes the mesh available to the existing zoom proxy. A root-and-load-generation
owned worker serves all placed and gallery models in the document. Culled placements release
live references; the bounded resident cache can retain warm geometry without a render loop.
A last-subscriber cancellation drops obsolete queued poster work. Derived physical posters
live in `fig/renders/model3d/`; editor-resolution buckets stay in bounded memory. Project
open schedules best-effort removal of unused derived posters older than fourteen days.

A matching cached poster works with WebGL disabled. Otherwise a light, selectable box
names the model and explains why its preview is unavailable. Missing source files always
produce that explicit fallback. Late project/figure switches cannot install an old import:
its exact uncommitted native receipt is discarded. Successful synchronous placement consumes
cleanup authority before asynchronous native adoption; an exceptional adoption error is shown
while the committed model files are preserved.

Run the registered GUI gate against an isolated server through `FLUX_URL`:

```sh
node scripts/run-verifies.mjs --group model3d-gui
```

Use scratch HOME/XDG directories and `FLUX_NO_MIGRATE=1`. Scene screenshots and the JSON
receipt are under `test-results/model3d/scene/`. Native import and metadata-only persistence
have separate registered `model3d-import` and `model3d-persistence` groups.
