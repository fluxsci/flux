import { beginGesture, editGen, finishGesture, rollbackGesture, type GestureCheckpoint } from '../store';

const active = new Set<() => void>();
/** Settle previews before the outgoing editor is flushed or its store replaced. */
export function cancelActiveEdits() {
  for (const cancel of [...active].reverse()) cancel();
}

/** A property control owns its checkpoint, not the generic pointer action.
 * Preview callbacks mutate; one finish makes one undo, cancel restores baseline.
 * Unrelated edits terminate coalescing instead of joining someone else's undo. */
export function editSession() {
  let checkpoint: GestureCheckpoint | null = null;
  let generation = -1;
  function finish() {
    finishGesture(checkpoint);
    checkpoint = null;
    active.delete(cancel);
  }
  function cancel() {
    if (checkpoint && generation === editGen.n) rollbackGesture(checkpoint);
    else finishGesture(checkpoint);
    checkpoint = null;
    active.delete(cancel);
  }
  return {
    run(apply: () => void) {
      if (checkpoint && generation !== editGen.n) finish();
      checkpoint ??= beginGesture();
      active.add(cancel);
      apply();
      generation = editGen.n;
    },
    finish,
    cancel,
  };
}
