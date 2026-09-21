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
import { writable } from "svelte/store";

export interface Flushable {
  paneId?: string;
  id: string; // "paper" | "paper-comments" | "figure" | "slide"
  isReady?(): boolean;
  isDirty(): boolean;
  flush(): Promise<void>;
}

const registry = new Map<string, Flushable>();
const registrationEpochs = new Map<string, number>();
let registrationEpoch = 0;
/** Availability changes need to publish context even when the model is unchanged. */
export const flushOwnerRevision = writable(0);
export function notifyFlushOwnerReady(id: string): void {
  if (registry.has(id)) flushOwnerRevision.update(n => n + 1);
}

// Dev-only: let gates assert the registry's ids (dual-paper: each pane must
// hold its own "paper-<paneId>" entry — a shared id EVICTS the other pane's
// flushable and its unsaved work is never flushed on quit).
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __fluxFlushables?: () => string[] }).__fluxFlushables = () => [...registry.keys()];
}

export function registerFlushable(f: Flushable): () => void {
  registry.set(f.id, f);
  const epoch = ++registrationEpoch;
  registrationEpochs.set(f.id, epoch);
  notifyFlushOwnerReady(f.id);
  return () => {
    if (registry.get(f.id) === f && registrationEpochs.get(f.id) === epoch) {
      registry.delete(f.id); registrationEpochs.delete(f.id);
      flushOwnerRevision.update(n => n + 1);
    }
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
      return true; // unknown state cannot be safely evicted
    }
  }
  return false;
}

export function anyDirty(): boolean {
  for (const f of registry.values()) {
    try {
      if (f.isDirty()) return true;
    } catch {
      return true; // unknown is unsafe
    }
  }
  return false;
}

export interface FlushResult { ok: boolean; failed: string[] }

export function flushOwnerIdentity(id: string): object | undefined { return registry.get(id); }
export function hasFlushOwner(id: string): boolean {
  const owner = registry.get(id);
  try { return !!owner && (owner.isReady?.() ?? true); } catch { return false; }
}

export function flushPaneChecked(paneId: string): Promise<FlushResult> {
  return flushEntries(f => f.paneId === paneId || f.id === `paper-${paneId}` || f.id === `paper-comments-${paneId}`);
}

async function flushEntries(matches: (f: Flushable) => boolean): Promise<FlushResult> {
  const entries = [...registry.values()].filter(matches);
  const epochs = new Map(entries.map(f => [f.id, registrationEpochs.get(f.id)]));
  const failed: string[] = [];
  await Promise.all(
    entries.map(async (f) => {
      try {
        await f.flush();
        // Autosave surfaces failures through its status store instead of
        // rejecting. Dirtiness after a flush therefore also means unsaved.
        if (f.isDirty()) failed.push(f.id);
      } catch {
        failed.push(f.id); // the autosave controller already toasted the detail
      }
    }),
  );
  for (const f of entries) {
    try { if (f.isDirty() && !failed.includes(f.id)) failed.push(f.id); } catch { if (!failed.includes(f.id)) failed.push(f.id); }
  }
  // Mounting/replacing an editor while another save is pending cannot make
  // that new buffer part of the completed flush. Abort the transition so the
  // user can retry with the current owners; other panes remain interactive.
  const current = [...registry.values()].filter(matches);
  const changed = new Set<string>();
  for (const f of entries) if (registry.get(f.id) !== f || registrationEpochs.get(f.id) !== epochs.get(f.id)) changed.add(f.id);
  for (const f of current) if (!epochs.has(f.id)) changed.add(f.id);
  for (const id of changed) if (!failed.includes(id)) failed.push(id);
  return { ok: failed.length === 0, failed };
}

export function flushAll(): Promise<{ ok: boolean; failed: string[] }> {
  return flushEntries(() => true);
}

/** A handoff must check the result before discarding the outgoing editor. */
export function flushByIdChecked(prefix: string): Promise<{ ok: boolean; failed: string[] }> {
  return flushEntries(f => f.id === prefix || f.id.startsWith(prefix + "-"));
}

/** W14 (AGT-10): flush a single subsystem now (matches its id + any sub-id, like
 *  isDirtyById). Used after a live-bridge edit so a subsequent disk read — an agent's
 *  get_figure_image right after dispatch_command — sees the change instead of the
 *  pre-edit bytes the 700ms autosave hasn't written yet. Reuses the mode's autosave
 *  controller (so W7 conflict handling still applies); a no-op if nothing is registered. */
export async function flushById(prefix: string): Promise<void> {
  await flushByIdChecked(prefix);
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
  fb?.onFlushRequest?.((request) => {
    void flushAll().then((r) => {
      if (!r.ok) pushToast("error", "Some changes couldn't be saved on exit", { detail: r.failed.join(", ") });
      fb.flushDone?.({ requestId: request.requestId, status: r.ok ? 'saved' : 'blocked', ...(r.ok ? {} : { reason: `Unsaved owners: ${r.failed.join(', ')}` }) });
    }).catch((e) => {
      fb.flushDone?.({ requestId: request.requestId, status: 'blocked', reason: String(e) });
    });
  });
}
