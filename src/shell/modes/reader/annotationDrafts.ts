// A failed note remains a registered save owner even if its view is evicted.
// Reopening the same pane/paper/annotation restores the draft and retry action.
import { registerFlushable } from "../../lifecycle";
export interface AnnotationDraft {
  text: string; saved: string; error: string; pending: Promise<void> | null;
  persist: (text: string) => Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
}
const drafts = new Map<string, AnnotationDraft>();
export function annotationDraft(key: string, paneId: string, initial: string, persist: (text: string) => Promise<void>): AnnotationDraft {
  const existing = drafts.get(key);
  if (existing) { existing.persist = persist; return existing; }
  let unregister = () => {};
  const draft: AnnotationDraft = {
    text: initial, saved: initial, error: "", pending: null, persist,
    async flush() {
      if (draft.pending) await draft.pending;
      if (draft.text === draft.saved) return;
      const text = draft.text;
      const operation = draft.persist(text).then(() => { draft.saved = text; draft.error = ""; }, error => {
        draft.error = String(error instanceof Error ? error.message : error); throw error;
      });
      draft.pending = operation;
      try { await operation; } finally { if (draft.pending === operation) draft.pending = null; }
    },
    dispose() {
      if (draft.text !== draft.saved || draft.pending) return;
      unregister(); drafts.delete(key);
    },
  };
  unregister = registerFlushable({ id: `reader-note-${key}`, paneId, isDirty: () => draft.text !== draft.saved || !!draft.pending, flush: () => draft.flush() });
  drafts.set(key, draft);
  return draft;
}
