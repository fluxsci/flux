# P2 native import progress

Base: model3d e8c58bc. Branch/worktree: model3d-import. No main or animation changes.

Shared API: src/lib/model3d/importData.ts exports prepareModel3dImport, parseModel3dImportMetadata, sha256ModelBytes, makeImportedModel3dElement and request/result/ownership types. Native helper exports prepareModel3d, cleanupPreparedModel3d, importLocation and readBounded. FileBridge exposes importModel3d/importDroppedModel3d/adoptModel3d/discardModel3d/model3dAvailability.

Native imports require a saved Figure root; deck activation stays deferred. An actual dropped File is resolved in isolated preload, while ordinary path imports retain the existing read guard. Import results contain metadata and a receipt, never binary GLB payloads.

Independent reviewer: contract_python. Real File transport15/15 passed; adversarial review found and corrected generation A/B/A, concurrent discard/adopt and partial-cleanup re-adoption. Final receipts and screenshots will be copied into integration test-results/model3d/p2-review. Source-binding reopen correction is separately authored in model3d-bindings and must integrate before P2 closure.

Validation commands: npm run check (0 errors/0 warnings); npm run check:headless; node scripts/run-verifies.mjs --group model3d-import. All run under /tmp/flux-model3d-env with scratch HOME/XDG and FLUX_NO_MIGRATE=1. Exact final runs appended at commit.

Final reviewed checkpoint: focused group5/5, 38 import checks, sourceChanged=false at `2026-09-28T07-35-06-567Z-16`; independent group5/5 at `07-35-20-049Z-2`. Final Svelte0errors/0warnings and headless pass. Native reviewer approved9 adversarial cases and17 actual Electron File/SOFTGPU cases. Late rejected adoption consumes cleanup authority and retains possibly placed files; rare unreferenced remnants are preferable to deleting unsaved referenced data.

Post-integration unification: importData now calls the reviewed sourceBinding helper used by reopened metadata, and canonical native bundle regenerated. No native ownership or transport changes. Combined import/persistence13-gate cohort passed; final independent check follows.
