// Figure and Slide own one editing store. Serialize the WHOLE initialization,
// not just the tenant flag: a slow deck read must finish before another editor
// loads into that store. Components mount their editing controls only afterward.
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { panes, evictMode } from './paneStore';
import { flushByIdChecked } from './lifecycle';
import { setStoreTenant, type StoreTenant } from '../lib/tenancy';
import { pushToast } from '../lib/toast';
import { gestureCancelHook } from '../lib/store';
import { cancelActiveEdits } from '../lib/interact/editSession';

let pending: Promise<unknown> = Promise.resolve();

export function initializeEditor(
  mode: StoreTenant,
  paneId: string,
  alive: () => boolean,
  initialize: () => Promise<void>,
): Promise<void> {
  const requested = () => alive() && get(panes).some(p => p.id === paneId && p.mode === mode);
  const work = pending.catch(() => {}).then(async () => {
    if (!alive()) return;
    if (!requested()) { evictMode(mode); await tick(); return; }
    const previous = mode === 'figure' ? 'slide' : 'figure';
    gestureCancelHook.fn?.();
    cancelActiveEdits();
    const result = await flushByIdChecked(previous);
    if (!alive()) return;
    if (!result.ok) {
      // Restore only the pane still requesting this switch. A later navigation
      // elsewhere must not be stolen by an earlier failed request.
      panes.update(ps => ps.map(p => p.id === paneId && p.mode === mode ? { ...p, mode: previous } : p));
      pushToast('error', `Could not leave ${previous === 'figure' ? 'Figure' : 'Slide'}`, {
        detail: 'Your edits are preserved. Retry saving or resolve the save conflict before switching editors.',
      });
      await tick();
      evictMode(mode); // discard the uninitialized candidate, never its owner
      await tick();
      return;
    }
    if (!requested()) { evictMode(mode); await tick(); return; }
    evictMode(previous);
    await tick(); // teardown completes before ownership and history change
    if (!requested()) { evictMode(mode); await tick(); return; }
    setStoreTenant(mode);
    await initialize();
  });
  pending = work;
  return work;
}
