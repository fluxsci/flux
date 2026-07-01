// W4 (V1 review): shared autosave controller — semantic verification (Node).
// Run: npx tsx scripts/verify-w4-autosave.ts
//
// Asserts: debounce; save-throw stays dirty with ONE silent retry then a sticky
// toast with a working Retry action; success clears error+toast; ConflictError
// never retries/toasts; schedule-during-save runs one trailing save; flush runs
// immediately and flush(force) passes force into save.

import { get } from "svelte/store";
import { createAutosave, ConflictError } from "../src/lib/autosave";
import { toasts } from "../src/lib/toast";

let failures = 0;
const ok = (m: string) => console.log("✓ " + m);
const fail = (m: string) => {
  console.error("✗ " + m);
  failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------ fail → silent retry → toast → recover
{
  let dirty = true;
  let attempts = 0;
  let failTimes = 2;
  const saves: boolean[] = [];
  const ctl = createAutosave({
    name: "test-doc",
    delay: 40,
    retryDelay: 80,
    isDirty: () => dirty,
    save: async (force) => {
      attempts++;
      saves.push(force);
      if (failTimes-- > 0) throw new Error("disk full");
      dirty = false;
    },
  });

  ctl.schedule();
  await sleep(20);
  if (attempts === 0 && get(ctl.status) === "pending") ok("debounce: no save before delay");
  else fail(`debounce broken (attempts=${attempts}, status=${get(ctl.status)})`);

  await sleep(45); // first attempt fails
  if (attempts === 1 && get(ctl.status) === "error" && dirty && get(toasts).length === 0)
    ok("first failure: stays dirty, error status, NO toast (silent retry pending)");
  else fail(`first-failure state wrong (attempts=${attempts}, status=${get(ctl.status)}, toasts=${get(toasts).length})`);

  await sleep(100); // silent retry fails → sticky toast
  const t = get(toasts).find((x) => /test-doc/.test(x.msg));
  if (attempts === 2 && t && t.ttl === 0 && t.action?.label === "Retry")
    ok("second failure: sticky toast with Retry action");
  else fail(`second-failure toast wrong (attempts=${attempts}, toast=${JSON.stringify(t)})`);

  t?.action?.run(); // user clicks Retry → third attempt succeeds
  await sleep(30);
  if (attempts === 3 && !dirty && get(ctl.status) === "idle" && get(ctl.error) === null)
    ok("retry action: save succeeds, dirty cleared, error cleared");
  else fail(`retry recovery wrong (attempts=${attempts}, dirty=${dirty}, status=${get(ctl.status)})`);
  ctl.dispose();
  toasts.set([]);
}

// ------------------------------------------------ ConflictError: no retry, no toast
{
  let attempts = 0;
  const ctl = createAutosave({
    name: "conflict-doc",
    delay: 30,
    retryDelay: 60,
    isDirty: () => true,
    save: async () => {
      attempts++;
      throw new ConflictError();
    },
  });
  ctl.schedule();
  await sleep(250);
  if (attempts === 1 && get(ctl.status) === "error" && get(toasts).length === 0)
    ok("ConflictError: exactly one attempt, no retry, no toast (banner is the affordance)");
  else fail(`conflict handling wrong (attempts=${attempts}, toasts=${get(toasts).length})`);
  ctl.dispose();
}

// ------------------------------------------------ trailing save + flush semantics
{
  // Models the corrected save pattern (W4): the save fn snapshots an edit
  // generation and clears dirty only if no edit landed during the write —
  // exactly what figbridge/slideBridge/PaperMode now do.
  let editGen = 0;
  let dirty = true;
  let persisted = -1; // the generation the "disk" has
  const log: string[] = [];
  const ctl = createAutosave({
    name: "trail-doc",
    delay: 30,
    isDirty: () => dirty,
    save: async () => {
      log.push("save-start");
      const gen = editGen;
      await sleep(80);
      persisted = gen;
      if (editGen === gen) dirty = false;
      log.push("save-end");
    },
  });
  ctl.schedule();
  await sleep(45); // save is in flight
  editGen++; // an edit lands mid-save
  dirty = true;
  ctl.schedule();
  await sleep(300);
  const runs = log.filter((l) => l === "save-start").length;
  if (runs === 2 && !dirty && persisted === editGen)
    ok("edit landing mid-save stays dirty and the trailing save persists it");
  else fail(`trailing save wrong (runs=${runs}, dirty=${dirty}, persisted=${persisted}/${editGen})`);

  // flush(force) on a CLEAN doc forces the write with force=true
  let forced: boolean | undefined;
  const ctl2 = createAutosave({
    name: "force-doc",
    delay: 500,
    isDirty: () => false,
    save: async (force) => {
      forced = force;
    },
  });
  await ctl2.flush(true);
  if (forced === true) ok("flush(true) forces a save with force=true on a clean doc");
  else fail(`flush(true) did not force (forced=${forced})`);
  await ctl2.flush();
  ctl.dispose();
  ctl2.dispose();
}

// ------------------------------------------------ flush awaits in-flight then trailing
{
  let dirty = true;
  let saves = 0;
  const ctl = createAutosave({
    name: "flush-doc",
    delay: 10,
    isDirty: () => dirty,
    save: async () => {
      saves++;
      await sleep(50);
      dirty = false;
    },
  });
  ctl.schedule();
  await sleep(20); // in flight
  await ctl.flush(); // must await the in-flight save (and skip a redundant one)
  if (!dirty && saves === 1) ok("flush awaits the in-flight save without double-writing");
  else fail(`flush semantics wrong (saves=${saves}, dirty=${dirty})`);
  ctl.dispose();
}

console.log(failures ? "W4 VERIFY: FAIL" : "W4 VERIFY: PASS");
process.exit(failures ? 1 : 0);
