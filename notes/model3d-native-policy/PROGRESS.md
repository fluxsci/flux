# Native qualification policy

Parent-authorized isolated follow-up from4cabc64. Only test harness policy changes: P3 early nonzero display guard and explicit input-probe --qualify mode. No product window flags or latency thresholds changed. Native execution intentionally not attempted while DISPLAY0 is0×0; pure behavior/source review required before checkpoint. Earlier failed timing receipts remain preserved in model3d-qa/test-results/model3d/native/combined-attempt{1,2}-hardware.

2026-09-28 15:45 UTC — Frozen source candidate: registered policy gate1/1 PASS15-44-55-999Z-2 (9checks); changed-pathmap1/1 PASS15-44-56-546Z-2. Native not run because display is still unusable. No budgets or product throttling flags changed.

2026-09-28 15:47 UTC — Parent independently source-reviewed and APPROVED; its registered model3d-native-policy1/1 PASS15-46-46-093Z-2. Own9checks and pathmap remain green. Explicit checkpoint commit follows; native remains intentionally unrun on unusable display.

2026-09-28 16:13 UTC — Shared contained-window helper added at root request after the display briefly returned1470×923. Root combined P3 adaptive-window run passed; display subsequently returned0×0. This helper is pure test infrastructure; no native run in this branch. Callers must record actual displays before the guard.
