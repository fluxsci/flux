// W4 (V1 review) — the one debounced-autosave controller every mode uses
// (deck / manuscript / figures / comments), replacing four hand-rolled
// setTimeout patterns with shared, *error-surfacing* semantics:
//
//   schedule() —— delay ——> save()
//     save throws        → stay dirty, one SILENT retry after retryDelay,
//                          then a sticky error toast with a Retry action
//     save is a Conflict → stay dirty, NO retry/toast — the caller's banner
//                          (diverged-on-disk affordance, W7) is the surface
//     save succeeds      → clear error/toast; back to idle
//
// The `save` callback MUST clear its own dirty flag only on success (all
// existing save fns already behave this way). `flush()` runs a pending save
// immediately (awaiting any in-flight one first); `flush(true)` forces the
// write even over a conflict (the user chose Overwrite).

import { writable, type Readable } from "svelte/store";
import { pushToast, dismissToast, errMsg } from "./toast";

export type AutosaveStatus = "idle" | "pending" | "saving" | "error";

/** SHL-12: a global counter bumped on every controller status change, so the shell's dirty
 *  indicator can re-evaluate `anyDirty()` reactively (the flush registry is otherwise poll-only). */
export const dirtyPulse = writable(0);

/** Thrown by a save fn when the file changed on disk since it was loaded (W7).
 *  The controller stays dirty but does not retry or toast — the mode shows its
 *  own Reload / Keep mine / Overwrite affordance. */
export class ConflictError extends Error {
  constructor(msg = "changed on disk since load") {
    super(msg);
    this.name = "ConflictError";
  }
}

export interface AutosaveController {
  /** (Re)start the debounce — call on every edit. */
  schedule(): void;
  /** Clear the debounce and save now if dirty (awaits an in-flight save first).
   *  `force` bypasses the conflict check (Overwrite). */
  flush(force?: boolean): Promise<void>;
  /** Stop future scheduling (teardown). An explicit flush() still works. */
  dispose(): void;
  status: Readable<AutosaveStatus>;
  error: Readable<string | null>;
}

export function createAutosave(opts: {
  name: string; // human-facing: "manuscript" | "figures" | "deck" | "comments"
  delay: number;
  isDirty(): boolean;
  save(force: boolean): Promise<void>;
  retryDelay?: number; // default 5000
}): AutosaveController {
  const status = writable<AutosaveStatus>("idle");
  const error = writable<string | null>(null);
  const setStatus = (s: AutosaveStatus) => {
    status.set(s);
    dirtyPulse.update((n) => n + 1); // SHL-12: nudge the shell dirty indicator
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;
  let trailing = false; // schedule() arrived during a save → run once more
  let disposed = false;
  let failedOnce = false;
  let toastId: number | undefined;

  function clearTimers() {
    if (timer) clearTimeout(timer);
    if (retryTimer) clearTimeout(retryTimer);
    timer = retryTimer = undefined;
  }

  async function run(force: boolean): Promise<void> {
    if (inflight) {
      trailing = true;
      return inflight;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!force && !opts.isDirty()) {
      setStatus("idle");
      return;
    }
    setStatus("saving");
    inflight = (async () => {
      try {
        await opts.save(force);
        failedOnce = false;
        error.set(null);
        if (toastId !== undefined) {
          dismissToast(toastId);
          toastId = undefined;
        }
        setStatus(opts.isDirty() ? "pending" : "idle");
      } catch (e) {
        error.set(errMsg(e));
        setStatus("error");
        if (!(e instanceof ConflictError)) {
          if (!failedOnce) {
            failedOnce = true;
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => void run(false), opts.retryDelay ?? 5000);
          } else {
            toastId = pushToast("error", `Couldn't save ${opts.name}`, {
              detail: errMsg(e),
              action: { label: "Retry", run: () => void run(false) },
            });
          }
        }
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
      if (trailing) {
        trailing = false;
        if (!disposed) schedule();
      }
    }
  }

  function schedule(): void {
    if (disposed) return;
    setStatus("pending");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(false), opts.delay);
  }

  async function flush(force = false): Promise<void> {
    clearTimers();
    if (inflight) await inflight.catch(() => {});
    if (force || opts.isDirty()) await run(force);
  }

  function dispose(): void {
    disposed = true;
    clearTimers();
  }

  return { schedule, flush, dispose, status, error };
}
