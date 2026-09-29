import { get, writable } from 'svelte/store';
import { beginGesture, editGen, finishGesture, rollbackGesture, selection, type GestureCheckpoint } from '../store';

export interface EditPreview { owner: symbol; ids: string[]; phase: 'active' | 'settled'; time: number }
/** Hosts can paint interactive previews without owning another history entry. */
export const editPreview = writable<EditPreview | null>(null);
const active = new Set<() => void>();
/** Settle previews before the outgoing editor is flushed or its store replaced. */
export function cancelActiveEdits() {
  for (const settle of [...active].reverse()) settle();
}

/** A property control owns its checkpoint, not the generic pointer action.
 * Preview callbacks mutate; one finish makes one undo, cancel restores baseline.
 * Unrelated edits terminate coalescing instead of joining someone else's undo. */
export function editSession(options: { handoff?: 'cancel' | 'finish'; terminalOnConflict?: boolean; onSettle?: () => void } = {}) {
  let checkpoint: GestureCheckpoint | null = null;
  let generation = -1;
  let ids: string[] = [];
  const owner = Symbol('edit session');
  const handoff = () => (options.handoff === 'finish' ? finish() : cancel());
  function publish(phase: EditPreview['phase'], time = performance.now()) { editPreview.set({ owner, ids, phase, time }); }
  function settled() {
    const hadCheckpoint = !!checkpoint;
    checkpoint = null;
    active.delete(handoff);
    if (hadCheckpoint) { publish('settled'); options.onSettle?.(); }
  }
  function finish() { finishGesture(checkpoint); settled(); }
  function cancel() {
    if (checkpoint && generation === editGen.n) rollbackGesture(checkpoint);
    else finishGesture(checkpoint);
    settled();
  }
  return {
    run(apply: () => void, time = performance.now()) {
      if (checkpoint && generation !== editGen.n) { finish(); if (options.terminalOnConflict) return; }
      if (!checkpoint) { ids = [...get(selection)]; checkpoint = beginGesture(); }
      active.add(handoff);
      try { apply(); generation = editGen.n; publish('active', time); }
      catch (error) {
        if (checkpoint) rollbackGesture(checkpoint);
        settled();
        throw error;
      }
    },
    finish,
    cancel,
  };
}
