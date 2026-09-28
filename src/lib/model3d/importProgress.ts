/** Feedback owns no import work: its one-shot timer never delays preparation. */
import type { Readable } from 'svelte/store';
import { pushToast, dismissToast } from '../toast';

const visible = new Map<symbol, string>();
let toastId: number | undefined;
function refresh() {
  if (!visible.size) {
    if (toastId !== undefined) dismissToast(toastId);
    toastId = undefined;
    return;
  }
  const counts = new Map<string, number>();
  for (const name of visible.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const detail = [...counts].map(([name, count]) => count > 1 ? `${name} (${count} imports)` : name).join(', ');
  toastId = pushToast('info', 'Importing 3D model…', { detail, ttl: 0 });
}

/** Each invocation owns its timer, subscriptions and contribution to the toast.
 * A destination transition retires feedback permanently, including A→B→A. */
export function trackModel3dImport(name: string, current: () => boolean, owners: Readable<unknown>[]): () => void {
  const token = Symbol(), unsubscribers: (() => void)[] = [];
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    if (visible.delete(token)) refresh();
  };
  if (!current()) { dispose(); return dispose; }
  timer = setTimeout(() => {
    if (!current()) { dispose(); return; }
    visible.set(token, name);
    refresh();
  }, 1000);
  for (const owner of owners) {
    if (disposed) break;
    const unsubscribe = owner.subscribe(() => { if (!current()) dispose(); });
    if (disposed) unsubscribe(); else unsubscribers.push(unsubscribe);
  }
  return dispose;
}
