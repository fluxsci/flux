# Model import boundary

Figure import prepares the source through the same `prepareModel3dImport` policy in
native Electron, Node and the development memory bridge. It returns small asset
metadata and semantic sidecars. GLB bytes are published directly to `fig/assets/`
(or `assets/` in the legacy standalone Figure format), never to an image data URL,
saved JSON or text-generation journal.

`source.sha256` records the original file; `Asset.sha256` records prepared bytes.
The manifest binds to the original receipt, including when preparation removes
textures or skin bindings. Invalid, newer or mismatched manifests leave a plain
mesh with warnings. Readable raw sidecars are preserved. Reopening uses all
placements' original receipts to keep mismatched metadata inactive.

Native reads check regular-file type and the 200 MiB limit before allocation.
Source files stay unchanged. New files use exclusive atomic publication, file and
directory fsync, and Windows sharing retries. Each publication rechecks the
requesting window's project generation and the asset directory's real identity.

An ordinary path import requires the existing project, global-library or picker
read capability. The isolated preload's `importDroppedModel3d(File, request)`
obtains the actual Chromium File path with `webUtils.getPathForFile`; constructed
Files and caller-supplied path properties do not grant filesystem access.

Each import has a receipt bound to its window, root, target and project generation.
Successful placement adopts it; cancellation discards only that receipt's created
files. Adoption and cancellation are mutually exclusive. Once cancellation starts,
the receipt can never be adopted, even if cleanup partially fails; cleanup can be
retried. Saved ownership and unreadable saved metadata both prevent deletion.
If a valid-receipt adoption arrives after the project generation changes, it
rejects and retains the files. This can leave an unreferenced asset, but prevents
late native cleanup from deleting an element already placed synchronously in the
renderer. The GUI clears its cancellation capability before requesting adoption.
Rootless native Figure projects must be saved before import.

The canonical validator generator also emits the standalone native import bundle.
Its packaging allowlist and unpack entries are required for Electron and Node
children. Regenerate with `node --import tsx scripts/gen-validators.mjs`.

Run `node scripts/run-verifies.mjs --group model3d-import` under a scratch HOME/XDG
with `FLUX_NO_MIGRATE=1`. The group covers memory/native parity, provenance,
physical defaults, refusal, cancellation, project switching and receipt races.
Figure rendering and interaction are separately covered by the GUI and native
application gates; this import check alone does not qualify those surfaces.
