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
// Typing touches the lock on every keystroke; each held=true call is a lease
// renew on disk in main. The heartbeat already renews held leases, so a
// streak re-sends at most this often (which also retries a refused acquire).
const RESEND_MS = 2_000;

const held = new Map<string, number>(); // name → when lockSet(true) was last sent
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mark activity on `name` ("project" | "manuscript" | "slides"): hold the lock
 *  now and schedule release GRACE_MS from now. */
export function touchActivityLock(name: string): void {
  const fb = fileBridge();
  if (!fb?.lockSet) return;
  const now = Date.now();
  if (now - (held.get(name) ?? -Infinity) >= RESEND_MS) {
    held.set(name, now);
    void fb.lockSet(name, true);
  }
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
