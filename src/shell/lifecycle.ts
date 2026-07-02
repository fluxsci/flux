// W5 (V1 review) — the app-wide dirty registry + flush protocol. Every mode
// with debounced persistence registers a Flushable; the shell queries one place
// for "anything unsaved?" and flushes everything at the moments that used to
// lose data: leaving the project (goHome), window close / app quit (the main
// process sends `app:flush` and waits for the ack — W6), and reload
// (`beforeunload`, best-effort: the IPC write is enqueued synchronously and the
// fs write happens in the MAIN process, which survives the unload).
//
// Same-id re-registration REPLACES the entry (two panes showing the same mode
// share module state anyway); the disposer removes the entry only if it is
// still the current one.

import { fileBridge } from "../lib/project/types";
import { pushToast } from "../lib/toast";

export interface Flushable {
  id: string; // "paper" | "paper-comments" | "figure" | "slide"
  isDirty(): boolean;
  flush(): Promise<void>;
}

const registry = new Map<string, Flushable>();

export function registerFlushable(f: Flushable): () => void {
  registry.set(f.id, f);
  return () => {
    if (registry.get(f.id) === f) registry.delete(f.id);
  };
}

/** W16: is the mode `prefix` dirty? Matches its own flushable id and any sub-id
 *  (`paper` also covers `paper-comments`). Modes with no registered flushable
 *  (library/reader — they write discretely) are always clean → safe to evict. */
export function isDirtyById(prefix: string): boolean {
  for (const [id, f] of registry) {
    if (id !== prefix && !id.startsWith(prefix + "-")) continue;
    try {
      if (f.isDirty()) return true;
    } catch {
      /* a broken isDirty never claims dirtiness */
    }
  }
  return false;
}

export function anyDirty(): boolean {
  for (const f of registry.values()) {
    try {
      if (f.isDirty()) return true;
    } catch {
      /* a broken isDirty never blocks the answer */
    }
  }
  return false;
}

export async function flushAll(): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  await Promise.all(
    [...registry.values()].map(async (f) => {
      try {
        await f.flush();
      } catch {
        failed.push(f.id); // the autosave controller already toasted the detail
      }
    }),
  );
  return { ok: failed.length === 0, failed };
}

let installed = false;

/** Wire the consolidated flush triggers once (Shell onMount). Idempotent. */
export function installLifecycle(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // Reload / window teardown: best-effort synchronous-enqueue flush. Electron
  // will not await async work here, but the IPC message is enqueued before the
  // unload proceeds and the actual fs write runs in the main process.
  window.addEventListener("beforeunload", () => {
    void flushAll();
  });

  // W6: the main process intercepts close/quit, asks us to flush, and waits
  // for the ack (with a timeout so a wedged renderer can never brick quit).
  const fb = fileBridge();
  fb?.onFlushRequest?.((token) => {
    void flushAll()
      .then((r) => {
        if (!r.ok)
          pushToast("error", "Some changes couldn't be saved on exit", {
            detail: r.failed.join(", "),
          });
      })
      .finally(() => fb.flushDone?.(token));
  });
}
