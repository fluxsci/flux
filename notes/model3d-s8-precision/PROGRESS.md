# S8 qualification precision

Scope: isolated from primary ff2f472d. Preserve existing displayed input-probe summaries,
add unrounded rawTimings to qualification, require those for S8 and execute actual
instrumentation in a pure VM regression where rounded summaries conceal >10% loss.
No native/browser workload or timing threshold changes. Parent owns baseline capture
and Paper derived-cache watcher corrections.

Dependency setup: first npm ci attempt could not write readonly ~/.npm cache and
made no owner-cache changes. Repeated with scratch HOME/XDG/npm cache and Node22;
isolated install succeeded. No real Flux/user project paths opened.

Additional parent-authorized scope: pure canvas-clip/center-hit capture oracle and
actual before/after original-artwork plus replacement-geometry verification. Same
four placements/assets; no product/derived-cache watcher edits.

Own registered model3d-s8-policy + model3d-native-policy:2/2 PASS at17-11-58-158Z-2.
Actual INSTR VM exercises25double-rAF key observations and50frame gaps per fixture;
10.001→11.0012ms must fail while legacy summaries10/11remain unchanged. New capture
and preservation oracles pass positive/negative cases. No native/browser launches.
Independent Python source/pure review requested before explicit commit.


Final frozen own run2/2 PASS17-12-21-425Z-2,27S8+22native-policy checks,
sourceChanged=false. Independent Python source review APPROVED and own2/2 PASS
17-13-11-528Z-2; changed-pathmap1/1 PASS17-13-17-754Z-2. Reviewer digest
1a428b9978dc50c248e2baebc9f43f6fcffc491421fb666281b2947fe992187f.
No remaining source blocker identified. Native S8 comparison remains unrun after
these corrections; parent integrates and executes after the separate cache watcher fix.
