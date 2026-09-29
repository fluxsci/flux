# 3D poster worker

`flux-core/model3dPosters.ts` exports `renderModelPosterBatch(requests, options)`.
Each request supplies the pure `posterKey` and a `RenderSpec`; callers supply
`modelBytes(assetId, signal)` and the permitted cache output directory. The worker
renders only the transparent mesh layer. Shared SVG furniture is composed by the
caller.

The module does not open a project, acquire a lease, resolve machine preferences,
or render implicitly. Mutating commands choose the project derived cache;
explicit read-only image requests choose the machine cache. Connect/collect must
not call it. Empty batches do not spawn a worker. A maximum of 64 requests shares
one process/context and each model is loaded once.

The dedicated `FLUX_MODEL3D_POSTER_WORKER=1` entry dispatch runs before editor
startup. Its job, profile, HTML and output files live in one temporary directory.
The page embeds the generated runtime and model bytes under exact SHA256 script
hashes; Electron additionally denies every request except that page and data/blob
URLs, permissions, window creation and navigation. Models are never fetched.

Cancellation and the whole-batch deadline cover source byte reads, preparation,
rendering and publication. Byte providers receive the batch AbortSignal and should
honor it. Cancellation during native work waits for process exit before scratch
cleanup, escalating to a process-group kill after 3 seconds. Every completed image
is validated against its requested dimensions before any batch publication; each
cache file uses a fsynced temporary file and atomic rename, followed by directory
fsync. Cache entries are individually atomic; cancellation during the publication
loop can leave already complete, valid content-addressed entries.

Build `dist/flux-model3d-runtime.js` with the model3d runtime generator before use.
Packaged builds unpack that runtime and the dedicated worker. Linux's default
poster mode is headless with no DISPLAY/WAYLAND_DISPLAY and explicitly selects
ANGLE SwiftShader. The x11 qualification path uses the normal display backend;
`SOFTGPU=1` explicitly selects SwiftShader there. No path passes `--disable-gpu`.
Environment overrides `FLUX_MODEL3D_APP_ROOT` and `FLUX_MODEL3D_ELECTRON` support
packaging and isolated qualification; `FLUX_MODEL3D_DISABLE=1` refuses rendering
so callers can retain posters or show the shared placeholder.

The registered `verify-model3d-poster-worker.cjs` gate qualifies real headless and
x11 rendering, transparent pixel coverage, different views, repeat determinism, fresh browser/native pixel parity,
cancellation before and during work, stalled byte reads, deadline termination,
job path guards, exact CSP hashes, and actual native request blocking. Its metrics distinguish
spawn-to-ready time, runtime preparation, render CPU submission, and PNG encoding
including GPU readback; submission time is not an isolated shader-compile metric.
