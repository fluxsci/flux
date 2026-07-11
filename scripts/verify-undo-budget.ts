#!/usr/bin/env -S npx tsx
// WS-5.5 (fortify plan) — undo history byte-budget: 200 deep copies of a
// many-figure project is a MEMORY risk (CPU was measured fine at ≤0.8ms/clone),
// so past/future carry a per-entry byte size and evict oldest-first past 64MB.
// Asserts: the budget holds under many large gestures, eviction drops OLDEST
// (undo bottoms out at a retained state, newest survive), retained states
// round-trip undo→redo losslessly, a single over-budget snapshot still keeps
// one undo level, and rollback/reset keep the accounting exact.
//   npx tsx scripts/verify-undo-budget.ts

import "./lib/cssStub.mjs";

const store = await import("../src/lib/store");
const { get } = await import("svelte/store");
type Project = import("../src/lib/types").Project;

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const MB = 1024 * 1024;

function seed(): Project {
  return {
    version: 2,
    name: "budget",
    canvases: [{ id: "c1", name: "Canvas 1" }],
    figures: [
      {
        id: "f1",
        canvasId: "c1",
        name: "state-0",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        elements: [],
      },
    ],
    assets: [],
    palette: [],
  } as unknown as Project;
}

store.loadProject(seed(), null);
const stats0 = store.historyStats();
assert(stats0.past === 0 && stats0.pastBytes === 0, "fresh load: empty history, zero bytes");
assert(stats0.budget === 64 * MB, `budget is 64MB (${stats0.budget})`);

// ---- many ~2MB gestures: budget holds, eviction is oldest-first ---------------
const PAYLOAD = "x".repeat(2 * MB); // ≈2MB per snapshot via the ballast figure name
const GESTURES = 50; // ≈100MB if unevicted — must evict down to ≤64MB
for (let i = 1; i <= GESTURES; i++) {
  store.commit((p) => {
    p.figures[0].name = `state-${i}`;
    p.figures[0].meta = PAYLOAD; // ballast rides INSIDE the snapshot
  });
}
const s1 = store.historyStats();
assert(s1.pastBytes <= s1.budget, `pastBytes ${Math.round(s1.pastBytes / MB)}MB ≤ 64MB after ${GESTURES} ~2MB gestures`);
assert(s1.past < GESTURES, `evicted: ${s1.past}/${GESTURES} entries retained`);
assert(s1.past >= 25, `retention is sane (${s1.past} entries ≈ budget/2MB)`);

// ---- undo bottoms out at the retained FLOOR (oldest evicted, newest kept) -----
const retained = s1.past;
let undos = 0;
while (store.historyStats().past > 0) {
  store.undo();
  undos++;
  if (undos > GESTURES + 5) break; // safety
}
const nameAtFloor = (get(store.project) as Project).figures[0].name;
assert(undos === retained, `undo bottomed out after exactly the retained count (${undos}/${retained})`);
assert(
  nameAtFloor === `state-${GESTURES - retained}`,
  `floor state is the OLDEST retained (${nameAtFloor} = state-${GESTURES - retained})`,
);

// ---- redo round-trips the retained window losslessly ---------------------------
for (let i = 0; i < retained; i++) store.redo();
const nameAtTip = (get(store.project) as Project).figures[0].name;
assert(nameAtTip === `state-${GESTURES}`, `redo restored the tip losslessly (${nameAtTip})`);
const s2 = store.historyStats();
assert(s2.pastBytes <= s2.budget, "budget still holds after the full undo/redo sweep");
assert(s2.future === 0, "future drained by the redo sweep");

// ---- a single OVER-budget snapshot keeps one undo level -------------------------
store.commit((p) => {
  p.figures[0].name = "giant";
  p.figures[0].meta = "y".repeat(70 * MB); // one snapshot alone exceeds 64MB
});
store.commit((p) => {
  p.figures[0].name = "after-giant";
  p.figures[0].meta = "z";
});
const s3 = store.historyStats();
// The gesture capturing the giant PRE-state ("after-giant"'s beginGesture) may
// itself exceed the budget — but must never evict itself to zero.
assert(s3.past >= 1, `over-budget snapshot never evicts to zero (${s3.past} retained)`);
store.undo();
assert((get(store.project) as Project).figures[0].name === "giant", "one undo level survives an over-budget snapshot");

// ---- rollback + reset keep the accounting exact --------------------------------
store.loadProject(seed(), null);
store.commit((p) => (p.figures[0].name = "a"));
store.beginGesture();
store.mutate((p) => (p.figures[0].name = "live-drag"));
store.rollbackGesture();
assert((get(store.project) as Project).figures[0].name === "a", "rollbackGesture restored the pre-state");
const s4 = store.historyStats();
assert(s4.future === 0 && s4.futureBytes === 0, "rollback cleared future + its bytes");
store.resetHistory();
const s5 = store.historyStats();
assert(
  s5.past === 0 && s5.future === 0 && s5.pastBytes === 0 && s5.futureBytes === 0,
  "resetHistory zeroes entries AND byte counters",
);

console.log(failures ? `\nUNDO BUDGET: FAIL (${failures})` : "\nUNDO BUDGET: PASS");
process.exit(failures ? 1 : 0);
