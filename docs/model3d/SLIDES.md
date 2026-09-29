# 3D slide data and export adapters

Deck assets retain GLB metadata. The live deck loader reads scene sidecars separately and never inserts GLB bytes into `assetData`. Figure-derived models stay referenced by ID; deck-to-Figure conversion uses verified native copies. Missing model files retain a placeholder on read and prevent a GUI save until restored or removed.

Portable payloads carry raw base64 GLBs in `models`, scene metadata in `modelManifests`, and Design-state poster references in `modelPosters`. Image assets contain only image data. Content-change target models are collected even when not directly placed. HTML and MP4 include the separate model runtime only when needed; its source hash participates in export-asset freshness and CSP generation.

PDF and PowerPoint use Design-state stills with furniture and report that 3D animation is exported as a still. Static payload gathering sets `modelData: "omit"` and prepares posters through a native or service-worker adapter. Ordinary deck saves never persist poster or GLB data URLs.

Slide presets are an explicit portable-byte boundary. Their GLBs are embedded when saving the preset and prepared through the native importer before insertion. A single deck mutation installs the resulting immutable asset metadata and slide; receipt adoption follows that mutation. Temporary preset bytes never become authoring asset data or save-journal entries.

Registered checks: `verify-model3d-deck-assets.ts` and `verify-model3d-slide-export.ts`, through `node scripts/run-verifies.mjs`. Playback and native capture qualification belong to the Stage 2 integration gates.

CLI/MCP project-owned media paths pass through `flux-core/projectSource.ts`: an already-resolved in-project absolute path becomes the same canonical relative path as direct input. Both lexical escapes and symlink escapes are refused before the native media importer runs.

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
the first mismatch and the `share_topology_with` repair in the explanation. A model
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
