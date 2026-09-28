# Snapshot quiet correction

Base e7b105fb, isolated branch/worktree model3d-snapshot-quiet. Source-cause evidence
is primary test-results/model3d/scale/s8-hover-trace/{REVIEW.md,analysis.json}:
both model/image hover phases ran the exact Canvas idle serialization callback,
SVG load and raster/readback while pointer input remained active.

Four Canvas lines defer only pending snapshots on canvas pointer movement, using
the existing quiet timer and generation cancellation. Existing valid bitmap and
scene content key are preserved; no keepSceneHot/compositor promotion, polling,
RAF or budget change. New real-input gate inspects SVG Blob creation/rasterization,
stale held decode, final mesh pixels and proxy zoom. Own dependency directory is a
private copy (no shared Vite cache); encoders link to reviewed integration cache.

First author invocation18-05-57 failed before acceptance because dynamic import
could not be fetched after cold setup. Reset only this tree's copied Vite caches,
started its server1452 explicitly, and reran. No product assertion was reached in
that attempt. Corrected own registered gate PASS18-06-47-343Z-1497437,16.7 seconds;
functional browser evidence, not native S8 qualification. Independent n1 source
review approves product/test/manifest; final focused group and type checks pending.

Final author group4/4 PASS18-18-08-934Z-2: new14checks, existingzoom11,
modelGUI41, changed-pathmap; sourceChanged=false. npmcheck0/0 and
check:headlessPASS. Existing broad Canvas pathMap expected rows updated additively.

Intermediate18-09/18-13/18-17 runs missed the second held-decode setup. Temporary
scheduling traces at18-15-48 proved gen79 was correctly queued at8908.8ms but
Chromium delivered its no-timeout idle callback only at13958.2ms when the failure
screenshot produced a frame. No lost content key or product scheduling bug was
found. Diagnostic source and receipt retained under snapshot-quiet/idle-diagnostic;
all diagnostic source instrumentation removed. The final held-decode setup waits
for actual idle registration, then supplies one explicit test-only screenshot/frame
before the unchanged5s hold guard. The first sustained hover→quiet stage remains
unforced. Independent review accepts this setup, final execution pending.

Independent n1 final4/4 PASS18-19-30-808Z-2, sourceChanged=false,
digest3ad3895f…: new14/zoom11/modelGUI41/pathmap. Product, test, manifest, guide
and actual quiet/active-proxy screenshots independently approved. Root owns
native S8 requalification after integration; no native performance pass claimed here.
