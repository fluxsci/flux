// The shell must retain failed/dirty note owners after their view has gone away.
import { get } from "svelte/store";
import { registerFlushable, notifyFlushOwnerReady } from "../../shell/lifecycle";
import { panes, focusedPaneId } from "../../shell/paneStore";
import { storeTenant } from "../tenancy";
import { createNoteDraft, type NoteDraft } from "./noteDraftCore";
import { savePlotNote, type PlotNote } from "./notes";
interface Entry { draft: NoteDraft; users: number; owners: Map<string, () => void>; off?: () => void }
const drafts = new Map<string, Entry>();
export function acquireNoteDraft(note: PlotNote, diskText: string): { draft: NoteDraft; release: () => void } {
  let entry = drafts.get(note.path);
  if (!entry) {
    entry = { draft: createNoteDraft(diskText, (text, expected) => savePlotNote(note, text, expected)), users: 0, owners: new Map() };
    drafts.set(note.path, entry);
    const created = entry;
    let wasDirty = false;
    created.off = created.draft.subscribe(st => {
      const dirty = st.pending || st.text !== st.saved;
      if (dirty === wasDirty) return;
      wasDirty = dirty;
      for (const id of created.owners.keys()) notifyFlushOwnerReady(id);
    });
  } else {
    const st = entry.draft.current();
    if (!st.pending && st.text === st.saved) entry.draft.reload(diskText);
    else if (diskText !== st.saved) entry.draft.conflict("This note changed outside Flux. Your unsaved draft is kept here.");
  }
  const held = entry;
  entry.users++;
  const mode = storeTenant(), paneId = get(panes).find(p => p.mode === mode)?.id ?? get(focusedPaneId);
  const id = `${mode}-plot-note-${paneId}-${note.path}`;
  if (!entry.owners.has(id)) entry.owners.set(id, registerFlushable({ id, paneId,
    isDirty: () => { const st = held.draft.current(); return st.pending || st.text !== st.saved; },
    flush: () => held.draft.flush(),
  }));
  function cleanup() {
    const st = held.draft.current();
    if (held.users || st.pending || st.text !== st.saved || drafts.get(note.path) !== held) return;
    for (const unregister of held.owners.values()) unregister();
    held.off?.();
    drafts.delete(note.path);
  }
  return { draft: entry.draft, release() {
    held.users--;
    // A failed save retains both the text and its shell owner. Cleanup happens after any
    // close handshake has checked its stable registry snapshot, never inside flush().
    void held.draft.flush().catch(() => {}).finally(() => setTimeout(cleanup, 0));
  } };
}
