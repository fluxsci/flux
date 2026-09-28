# Original-byte metadata binding

2026-09-28: Isolated model3d-bindings from integrated P1 e8c58bc. Scope is the P2 reopen seam: rejected-but-preserved raw scene3d metadata must not become active when reopening a prepared GLB. No asset schema extension.

The shared pure sourceBinding.ts collects original SHA256 receipts from all referring model3d elements. One distinct receipt binds the asset, even when legacy references omit receipts. Conflicts suppress metadata deterministically, including manifests without glbSha256. No receipt preserves legacy behavior; prepared Asset.sha256 is never substituted. readScene3dSidecars accepts a binding, reports a localized issue and preserves exact raw metadata on mismatch. Native-copy preflight forwards binding. GUI load/readFigSource and standalone load/Save As use the same collection policy after assembling all figure references. The shared metadata reader and binding helper form the Node resolver API for P3; current loadFigModel remains metadata-model-only and does not claim to load sidecars.

Regression cases: duplicate equal receipts, known plus legacy, conflicting receipts and order, no original receipt, original differing from prepared checksum, mismatched metadata, optional manifest hash, conflict without manifest hash, real GUI/read-only/Node metadata reopen parity, dirty save preservation, copy forwarding, standalone Save As/reopen, and conflicts across figures. Existing persistence gate retains prior native/snapshot regressions.

First focused group10/10 passes at test-results/runs/2026-09-28T07-29-49-194Z-2. Final tests and independent reviews pending. Commands use Node22, HOME=/tmp/flux3d-bindings-home, XDG_CONFIG_HOME=/tmp/flux3d-bindings-home/config, XDG_DATA_HOME=/tmp/flux3d-bindings-home/data, FLUX_NO_MIGRATE=1, FLUX_URL=http://127.0.0.1:1442; no server required. No author import/drop regions, user projects/config, animation or main branches modified.

2026-09-28 07:32 UTC final checkpoint:
- Own focused group10/10 PASS, persistence139checks, sourceChanged=false: test-results/runs/2026-09-28T07-30-49-975Z-2. npm run check0errors0warnings; npm run check:headless clean; git diff --check clean.
- Independent source review and group approved by Python (10/10 at07-31-36-980Z-2) and root (10/10 at07-31-44-197Z-16). No blocking finding. P3/P5 future headless semantic resolution must use this shared collector/reader; no current semantic loader was omitted.
- Explicit source-binding exports: Model3dSourceBinding, collectModel3dSourceBindings(elements), scene3dSourceBindingIssue(manifest,binding?). readScene3dSidecars and prepareModelCopy accept optional binding. No generated artifact or schema changed. Root will run full pure with integrated P2.
