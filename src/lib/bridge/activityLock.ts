// W3 — GUI "human is actively editing" advisory locks. Touching a lock holds it
// and auto-releases 10s after the last touch (the grace window), so an agent's
// concurrent file write defers while the human is mid-edit — but an idle-open
// app never locks agents out. Main heartbeat-restamps held locks every 10s so
// a long editing streak can't falsely expire past the 30s TTL, and releases
// everything on quit/project-switch.
//
// Deliberately NOT session-scoped: coexistence is completed by the watch→reload
// matrix (clean editors absorb agent writes) + the save-time conflict baseline
// (dirty editors surface a merge affordance instead of clobbering).

import { fileBridge } from "../project/types";

const GRACE_MS = 10_000;

const held = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mark activity on `name` ("project" | "manuscript" | "slides"): hold the lock
 *  now (restamping if already held) and schedule release GRACE_MS from now. */
export function touchActivityLock(name: string): void {
  const fb = fileBridge();
  if (!fb?.lockSet) return;
  if (!held.has(name)) held.add(name);
  void fb.lockSet(name, true); // main restamps `ts` on every call
  const t = timers.get(name);
  if (t) clearTimeout(t);
  timers.set(
    name,
    setTimeout(() => {
      held.delete(name);
      timers.delete(name);
      void fileBridge()?.lockSet?.(name, false);
    }, GRACE_MS),
  );
}

/** Release immediately (mode teardown / project close). */
export function releaseActivityLock(name: string): void {
  const t = timers.get(name);
  if (t) clearTimeout(t);
  timers.delete(name);
  if (!held.delete(name)) return;
  void fileBridge()?.lockSet?.(name, false);
}
