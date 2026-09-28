# Linked 3D sources and Regenerate

A model stores prepared geometry under its immutable asset ID. Its source link records
original GLB bytes separately. Source checks run after idle work and filesystem events;
unchanged native file identities reuse a SHA256 receipt. GLB hashing streams bounded
chunks outside the renderer. The imported `manifestRef.hash` is the accepted raw metadata
receipt, so later saved JSON formatting cannot manufacture a source change; legacy
placements without it compare their stored raw sidecar. A missing original GLB receipt
shows Unknown until an explicit Update records one, never substitutes prepared-byte SHA.
Changed geometry or raw scene metadata raises **Source
changed** in the Inspector and a dot in Layers. Watching never replaces a model.

Choose **Update from source** to accept the new source in one Undo step. Flux creates a
new prepared asset and keeps the previous asset file. The placement, camera, lighting,
colours and opacity stay as edited. Overrides and field settings survive for part IDs
that still exist; shape weights survive for GLB target names that still exist. Missing
parts and a bounds change greater than 25% produce a warning. Bounds-relative zoom
preserves the camera setting; inspect the framing when that warning appears.

The 25% warning compares each span with its old span and compares the center shift with
the old bounding-box diagonal. A collapsed span uses that diagonal. Source size, topology
and names may change; this is an explicit replacement, not a topology-preserving morph.
Invalid or future metadata retains readable raw bytes and imports the new geometry as a
plain mesh with a warning. Undo restores the prior asset, metadata and styles together.

Project links use portable project-relative paths. Exact external GLB, manifest and recipe
read/watch grants remain bound to the window and project. They do not grant writes,
directory browsing or recipe execution. Missing sources leave the saved mesh intact.
Frozen links are not watched or updated. A project/target switch during preparation
rejects the result and discards only that request's uninstalled files. Unrelated camera
or placement edits made during preparation are retained.

For recipe-backed models, open X-ray and choose **Regenerate**. The existing trusted
recipe runner receives `FLUX_PARAMS` and `FLUXPLOT_ONLY`; `fp.params()` is unchanged.
The completed recipe's `outputs.glb` and optional `outputs.manifest` identify the new
files, including when the script changes their names. Only paths and small metadata
cross the recipe IPC. The same explicit Update operation installs successful output.
A failed or canceled recipe never installs an earlier GLB. SVG recipes keep their
existing behavior. Recipes still require the existing execution authorization.

Run `node scripts/run-verifies.mjs --group model3d-source` with scratch HOME/XDG and
`FLUX_NO_MIGRATE=1`; set `FLUX_URL` to the isolated server. This includes actual native
read/watch guards, streaming hash races, real recipe child-process dispatch, public
fluxplot fixtures, and Figure source/update/Undo/reopen/Regenerate interactions.
