import { writable } from "svelte/store";
export interface NoteDraftState { text: string; saved: string; pending: boolean; error: string }
/** One serialized writer per file. A flush drains edits made DURING an earlier write. */
export function createNoteDraft(initial: string, persist: (text: string, expected: string | null) => Promise<void>) {
  let state: NoteDraftState = { text: initial, saved: initial, pending: false, error: "" };
  const store = writable(state);
  let operation: Promise<void> | null = null;
  let restoration: Promise<void> | null = null;
  const publish = (patch: Partial<NoteDraftState>) => { state = { ...state, ...patch }; store.set(state); };
  function write(text: string, expected: string | null): Promise<void> {
    // Start persist in a microtask so operation is assigned before a synchronous rejection.
    operation = Promise.resolve().then(() => persist(text, expected)).then(
      () => publish({ saved: text, error: "" }),
      error => { publish({ error: String(error instanceof Error ? error.message : error) }); throw error; },
    ).finally(() => { operation = null; publish({ pending: false }); });
    // Subscribers may request a shell flush synchronously when pending changes.
    // Publish only after installing the writer they must join.
    publish({ pending: true, error: "" });
    return operation;
  }
  async function flush(): Promise<void> {
    for (;;) {
      if (operation) { await operation; continue; }
      if (state.text === state.saved) return;
      await write(state.text, state.saved);
    }
  }
  return {
    subscribe: store.subscribe,
    current: () => state,
    edit(text: string) { publish({ text }); },
    conflict(message: string) { publish({ error: message }); },
    reload(text: string) { if (operation) throw new Error("Wait for the pending note save before reloading"); publish({ text, saved: text, error: "" }); },
    flush,
    /** Explicit recovery creates only a missing file, then drains any newer typing. */
    restore(): Promise<void> {
      if (restoration) return restoration;
      const run = async () => {
        while (operation) await operation;
        await write(state.text, null);
        await flush();
      };
      restoration = run().finally(() => { restoration = null; });
      return restoration;
    },
  };
}
export type NoteDraft = ReturnType<typeof createNoteDraft>;
