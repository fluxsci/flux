# Shared 3D runtime

`renderCore.ts` is the deterministic WebGL2 renderer shared by worker rendering,
inline players, notebook output and the native poster page. It imports the pure
orbit, scalar-field, scene-style and bounds contracts. Source GLB materials are
replaced with Flux materials; source geometry and colors are retained for state
and appearance changes. No animation or polling loop runs inside the renderer.

## Build and embed

`npm run build:model3d` produces `dist/flux-model3d-runtime.js` with global
`FluxModel3dRuntime` and `dist/flux-model3d-viewer.js` with global
`FluxModel3dViewer`. The ordinary build also generates both after Vite. The viewer
stamp contains the SHA-256 of its exact script bytes and the canonical
`RENDERER_VERSION` from `poster.ts`; the adjacent third-party notice contains the
pinned three.js MIT license. Both bundles are self-contained and need no network
or dynamic script execution. Bump the canonical renderer version when changes to
materials, shaders or renderer settings change cached poster pixels.

A poster page creates one core with `createRenderCore(canvas)`, awaits
`core.load(assetId, arrayBuffer)`, calls synchronous `core.render(spec)`, then
encodes the canvas. `dispose()` releases GPU resources and retained bytes.
`load()` accepts prepared or raw supported GLBs; it always runs the shared strict
preparer before GLTFLoader. A canvas cannot be reused for a second core.

The notebook entry is `await FluxModel3dViewer.mount(host, payload)`, where payload
contains `glb` (base64 or ArrayBuffer), optional manifest and dimensions. The return
value exposes `available`, `getView`, `setView`, `stats`, and `dispose`. Existing
host content is retained until the first successful draw. Failure reports
`available: false` and preserves a still preview. Mounts use unique IDs and a
version-checked document pool, including across independently embedded IIFEs.
Removal from either the document or its output shadow root disposes the view.

## Host and service lifetime

`createInlineHost` retains assets, warms shaders in `ready`, and synchronously
copies the shared WebGL canvas into each 2D view. Distinct byte sources have
separate namespaces even if their asset IDs coincide. The last host disposes the
single document context. An explicit stable `sourceKey` must identify immutable
project/payload data, not a reusable label for different bytes.

`getModel3dService` lazily owns one worker per window. Changing the project source
replaces and disposes that service. Call `retain` before rendering and `release`
when no consumer needs the asset; retained assets are never LRU-evicted.
Interactive channels are latest-wins, idle requests are FIFO and coalesce by
format and key. Every returned bitmap belongs to its caller and must be closed.
For pointer release/capture use `fullResolution: true`; slow intermediate frames
adapt to half or quarter resolution. Byte acquisition, worker RPCs, cancellation,
clone failures and disposal all have settling paths. `createServiceHost` is the
asynchronous 2D-canvas adapter for this service.

Context loss rejects rendering. On restoration the core reparses retained bytes;
await `ready()` before resuming. Hosts do not schedule their own animation loop.

## Verification and limits

Run `node scripts/run-verifies.mjs --tier pure --only model3d-render-browser`
with scratch HOME/XDG, `FLUX_NO_MIGRATE=1` and `FLUX_URL` set to the dedicated test
port. The current test owns 127.0.0.1:1443 itself; no app dev server is required.
It verifies fixtures, transparent pixels, projected markers, semantic colors,
states and morph endpoints, worker parity and lifecycle failures, real notebook
inputs, independent bundle copies, shadow-root cleanup, fallback stills, context
restoration, and offline hashed-script CSP execution.

Its drawImage timings distinguish CPU submission from a readback fence; they are
not a GPU-only timing measurement. Software and hardware runs must identify their
actual renderer. Notebook renderer source and browser probes do not substitute
for final live VS Code Jupyter/QMD acceptance. Skinning is ignored and stored mesh geometry is shown;
GLB animation playback, 3D lines and 3D points are outside this implementation.
