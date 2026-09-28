# Derived Figure cache watcher correction

Base: `10b49261`, branch/worktree `model3d-cache-watch`. Parent owns global ledger and handoff.

Instrumented S8 receipt preserved under model3d-demo/test-results/model3d/s8-review/instrumented-pre-capture: idle2689.3→3190.3ms; Paper figureRefs refresh→CodeMirror requestMeasure2998.6ms, MutationObserver follow-up3001.2ms. Model renders8→8, workerRAF0. This proves the late callbacks are Paper refresh work; actual native rerun is still required to close S8.

Real chokidar+createFileCore proof (`test-results/model3d/cache-watch/before.json`) shows first cache mkdir emits `addDir fig/renders/model3d`, selfWrite=false; the original native classifier routes it to `fig`. New pure gate retains an unpruned control plus actual production classifier/prune closures. It covers cache parent/subtree creation, native poster write, external 2D/3D cache writes/deletion, no cache descriptors, and real subsequent canonical/source notifications. Source changes are limited to an exact derived path predicate plus native watcher pruning/classifier wiring. No renderer/Paper edits, no artificial settling wait.

Gate: `PATH=~/.local/node22/bin:$PATH FLUX_NO_MIGRATE=1 node scripts/run-verifies.mjs --group model3d-cache-watch` with scratch HOME/XDG. Additional changed-pathmap gate. Parent will run affected Paper suite and instrumented native S8 after integration/build; these are not claimed by the pure receipt.

Author initial focused gate: PASS1/1,21 assertions, run2026-09-28T17-09-27-660Z-2. Final group and independent review pending.

Frozen author qualification: model3d-cache-watch group6/6 PASS2026-09-28T17-10-28-151Z-2; changed-pathmap1/1 PASS17-10-38-091Z-2; both sourceChanged=false. Native source no-undef is in the focused group; node syntax and git diff --check clean. Independent review requested. Earlier mixed --group/--only selection selected no scripts (exit2); corrected commands above are the qualification.

Independent Python review APPROVED: same frozen source digest9a1626e95061fa2efe920d8f7a3e8b709990fb2af9cc4d7c6870ff6c6e93337a, registered6/6 PASS17-11-15-460Z-2 and changed-pathmap1/1 PASS17-11-31-981Z-2, sourceChanged=false. Own poster delivery already uses direct subscriptions/imageRevision; external cache-only arrival is read on the next ordinary refresh, not a canonical document edit notification.
