# 3D slide data and export adapters

Deck assets retain GLB metadata. The live deck loader reads scene sidecars separately and never inserts GLB bytes into `assetData`. Figure-derived models stay referenced by ID; deck-to-Figure conversion uses verified native copies. Missing model files retain a placeholder on read and prevent a GUI save until restored or removed. Save judges only the models the slides still use (`slideAssetIds`): a deleted model's GLB entry stays in the editor for Undo, and once its file is gone the saved registry stops naming it.

Portable payloads carry raw base64 GLBs in `models`, scene metadata in `modelManifests`, and step-0 still references in `modelPosters`; `assets` holds every step's still (Design appearance at that step's placement and mesh-part visibility, keyed with its `partOpacity`), which offline pre-ready posters look up by the same key. Image assets contain only image data. Content-change target models are collected even when not directly placed. HTML and MP4 include the separate model runtime only when needed; its source hash participates in export-asset freshness and CSP generation.

PDF and PowerPoint use Design-state stills with furniture, shown and placed as each page's build step leaves the model and with that step's mesh-part and furniture visibility (PowerPoint build pages included), and report that 3D animation is exported as a still whenever a slide carries a model. Static payload gathering sets `modelData: "omit"` and prepares posters through a native or service-worker adapter. Ordinary deck saves never persist poster or GLB data URLs.

Slide presets are an explicit portable-byte boundary. Their GLBs are embedded when saving the preset and prepared through the native importer before insertion. A single deck mutation installs the resulting immutable asset metadata and slide; receipt adoption follows that mutation. Temporary preset bytes never become authoring asset data or save-journal entries.

Registered checks: `verify-model3d-deck-assets.ts` and `verify-model3d-slide-export.ts`, through `node scripts/run-verifies.mjs`. Playback and native capture qualification belong to the Stage 2 integration gates.

CLI/MCP project-owned media paths pass through `flux-core/projectSource.ts`: an already-resolved in-project absolute path becomes the same canonical relative path as direct input. Platform separators become `/` there (a win32 input arrives as `C:\proj\…`), and so do root-relative paths handed to `boundedModelFile`; only NUL is refused on the raw input. A symlinked `--root` also accepts the realpath spelling of the same file (directories only are resolved). Both lexical escapes and symlink escapes are refused before the native media importer runs.

Saved 3D Design values can also be edited with `set-model-view <element> --deck <deck> --slide <slide>` and `set-model-field <element> <field> --deck <deck> --slide <slide>`. Use `render-model-posters --deck <deck>` to refresh Design stills (optionally `--slide <slide>`); timed changes remain ordinary animation tracks. Do not combine Figure and deck selectors.

Paper slide widgets use the document's shared worker service with immutable file metadata; they do not inline GLB bytes or create main-thread WebGL contexts. Visible occurrences have independent playback. Removing or scrolling away one occurrence releases its host without invalidating another occurrence's pending load. Repository invalidation retires the captured source generation.

Portable Paper HTML and Quarto exports explicitly gather model bytes, deduplicate them across all included slides, and inject one conditional model runtime. The interactive Paper preview (which re-renders after every edit) reuses a slide's portable snapshot while its metadata snapshot signature (deck content, prepared GLB receipts, gathered image/plot bytes) is unchanged, holding one base64 copy per prepared GLB; exports always gather and validate fresh bytes. Two-dimensional documents carry no model runtime; their shared fonts/player asset file also excludes the separate model-runtime string. The same shared player keeps bitmap and vector furniture publication together. Static Word/PDF output continues to use the step-0 still.

Packaged CLI/MCP Paper exports load the player and shared model runtime from `dist/slide-export-assets.json`. They do not need the source checkout, generated browser JSON, or esbuild at runtime. Rebuild Flux if an older sidecar lacks the Paper runtime.

`group:model3d-embed` checks live metadata-only loading, source lifetimes, shared payloads/CSP, real Paper widget animation and typing, offscreen disposal, and actual Quarto HTML playback offline. Its screenshots and typing samples are under `test-results/model3d/embeds/`. Run `group:paper-gate` for the surrounding editor regressions. These browser checks do not qualify native GPU frame budgets.

## Ghost and content changes

For one object with named shape states, start with a **Change** of its Shape weights.
Both shapes stay in one model file, and the weights interpolate through that step.
Use Become or a gallery content change when the shapes are saved as separate assets.

Select a 3D model in Animate, then use **Transform → Ghost** to create independent
copies sharing its immutable mesh asset. Each copy can have its own camera, shape
weights and style. Hidden, unborn and offscreen copies release their canvas backing
storage; active copies share the renderer context and geometry buffers.

**Transform → Become** and **Appear → Appear from** show **Vertex morph** when the
picked models have corresponding topology. Otherwise they show **Crossfade**, with
the first mismatch and the `share_topology_with` repair in the explanation. Compilation
raises an issue only when topology metadata is unavailable; an evaluated crossfade is a
designed result. Mesh-part Become sources are refused, since WebGL leaves have no DOM to
fly; furniture parts and whole models hand off, including within groups. A Become into
mesh parts has no outline to fly to, so it compiles as a `crossfade` hand-off: nothing
flies, the source fades out in place while the parts fade in through the per-part opacity
channel on the same curve (raw = 1 is the landing), and a model cannot become one of its
own parts. A model
destination defaults to a handoff: both document objects remain, while source and
destination visibility transfer during playback. **Consume instead** is an explicit
one-step Undo action which removes the destination and keeps its content on the
source identity. Model-to-shape and shape-to-model Consume remain supported; live
model storage transfers at the raw halfway type change, while a decoded still
completes the fading endpoint. Whole model/video poster handoffs are supported;
video Consume and video Ghost remain unavailable.

Use **Model from gallery…** in the animation Destination controls to change only the
mesh content, without placing a second object. The gallery starts with its 3D filter
selected. Canceling or changing the destination before import completes discards its
unadopted receipt. Saved content targets preserve the original GLB source receipt;
`become --asset` and `set-transform --to-asset` follow the same policy. A bare immutable
asset without a known source clears the previous content's source fields.

`node scripts/run-verifies.mjs --group slide-model3d-morph` exercises pure authoring,
file commands, actual browser rendering and the editor UI. Browser receipt-cancellation
checks use the memory bridge; they do not claim production Electron import coverage.
Native MP4 qualification is recorded separately.

## Animate model parts

Open a semantic 3D model in X-ray, select a mesh or furniture row, and use
**Animate selected → Appear, Emphasize, or Disappear**. Each action creates ordinary
animation tracks and one Undo entry. Series and other containers resolve to their
named leaves. Mesh opacity multiplies its authored opacity; unselected meshes retain
their colors and visibility. Labels, axes, legends and colorbars use the same timing
through vector furniture. Mixed mesh/furniture stagger follows one semantic order.

Design retains the saved model appearance. **Edit after step** shows the settled
mesh and furniture animation state; **Show hidden** keeps hidden parts visible at
quarter opacity for editing. Turn it off for the normal hidden result. Derived part
opacity is never stored as model data. Playback, HTML and capture use the shared
player; plain models without accepted scene3d metadata report missing semantic targets
rather than inventing a part hierarchy. The Animator lists the accepted parts at each
content-change pre-state. Saved Node commands read the same source-bound sidecars,
including model assets referenced only by future Change tracks.

`node scripts/run-verifies.mjs --group slide-model3d-parts` covers pure/container
resolution, saved file commands, actual player pixels and the real X-ray authoring
flow with Undo/Redo and reopen. Per-part mesh transparency retains the documented
interpenetrating-transparent-surface limitation.

Portable HTML and Paper payloads embed the accepted prepared GLB bytes only after
checking their saved SHA-256 receipt. A changed or oversized stored file refuses
export; source paths and build provenance are removed from the portable copy.
Native and Node readers enforce the size bound before allocating the file.
Static SVG/PDF/PowerPoint writers use the same complete model state for mesh and
furniture. An original model keeps its Design orbit, look and shape; its placement
and part visibility follow the selected build step, so a part hidden at that step is
absent (the Node poster worker, the GUI poster service and the offline pre-ready poster
all key and render the step's `partOpacity`). An identity consumed from a shape into 3D
uses that evaluated model endpoint and its matching still. Cache-only readers (Connect
sheets, CLI Paper renders) need the step's own still: the app persists it when it renders
one, and `render-model-posters --deck` warms Design stills only.

Slide scale checks use two distinct, compatible 250,000-triangle meshes and eight independently posed ghost copies. `verify-scale-slide.mjs` keeps the existing 2D budgets and adds real Present playback, changed-pixel checks, zero RAF/render calls during each measured rest window, shared pair/context counts and disposal. The observer records only application-owned RAF callbacks and actual mesh-canvas publication; it schedules no animation heartbeat.

`verify-slide-model3d-scale-electron.cjs` runs the same scenario through the production Electron/preload path with a canonical scratch project and delivered native keys, ending with one delivered Escape that must leave the fullscreen Present and dispose the inline pool. It requires positive hardware renderer identity and enabled WebGL2, a nonzero display, uninterrupted visible focus, at least 80 actual published frames per measured beat and raw p95 frame gaps ≤17ms. The first complete bitmap/furniture callback must finish within 100ms of the delivered cue, and the last publication must cover the full authored duration. No rounding, warmup trimming or software fallback can satisfy that gate. Run it via the registered runner with scratch HOME/XDG, `FLUX_NO_MIGRATE=1`, `FLUX_PRIVATE_DISPLAY=1 DISPLAY=:0` and the X11 Electron option. `group:model3d-slide-scale` combines the pure oracle, browser and native checks.

Evidence lives under `test-results/model3d/slides-scale/{browser,native}`. Browser SwiftShader results qualify behavior and retain raw timings; they do not establish the GPU frame budget. A zero-sized display is recorded as a capability blocker, never a passing skip.
