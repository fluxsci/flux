import { get, writable, type Readable } from 'svelte/store';
import { harness } from './lib/harness.mjs';
import { trackModel3dImport } from '../src/lib/model3d/importProgress';
import { toasts, dismissToast } from '../src/lib/toast';

const h = harness('verify-model3d-import-progress');
const original = { setTimeout, clearTimeout };
const originalToasts = get(toasts);
let clock = 0, next = 0, subscriptions = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
globalThis.setTimeout = ((callback: () => void, delay: number) => { const id = ++next; timers.set(id, { at: clock + delay, callback }); return id; }) as any;
globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any;
function advance(ms: number) { clock += ms; for (const [id, task] of [...timers]) if (task.at <= clock) { timers.delete(id); task.callback(); } }
const value = writable('A');
const owner: Readable<string> = { subscribe(fn) { subscriptions++; const unsub = value.subscribe(fn); return () => { subscriptions--; unsub(); }; } };
const begin = (name: string) => trackModel3dImport(name, () => get(value) === 'A', [owner]);
try {
  const fast = begin('fast.glb');
  h.eq([get(toasts).length, subscriptions, timers.size], [0, 1, 1], 'starts work without immediate toast or repeating timer');
  advance(999); h.eq(get(toasts).length, 0, 'feedback does not precede the one-second budget');
  fast(); advance(1);
  h.eq([get(toasts).length, subscriptions, timers.size], [0, 0, 0], 'fast settlement removes timer and subscription without flashing feedback');
  const first = begin('same.glb'); advance(1000);
  h.eq(get(toasts).map(t => [t.msg, t.detail, t.ttl]), [['Importing 3D model…', 'same.glb', 0]], 'slow import has truthful filename and sticky status');
  const second = begin('same.glb'); advance(1000);
  h.eq(get(toasts).map(t => t.detail), ['same.glb (2 imports)'], 'concurrent same-name imports have distinct ownership in one toast');
  first(); first();
  h.eq(get(toasts).map(t => t.detail), ['same.glb'], 'older and repeated cleanup leave the newer operation visible');
  const third = begin('other.glb'); advance(1000);
  h.eq(get(toasts).map(t => t.detail), ['same.glb, other.glb'], 'different concurrent filenames remain visible');
  dismissToast(get(toasts)[0].id); second();
  h.eq(get(toasts).map(t => t.detail), ['other.glb'], 'a remaining operation survives toast dismissal and another operation settling');
  value.set('B'); value.set('A'); advance(1000); third();
  h.eq([get(toasts).length, subscriptions, timers.size], [0, 0, 0], 'owner ABA retires visible feedback permanently and releases subscriptions');
  const pending = begin('pending.glb'); value.set('B'); value.set('A'); advance(1000); pending();
  h.eq([get(toasts).length, subscriptions, timers.size], [0, 0, 0], 'destination switch before delay cannot publish stale feedback');
  value.set('B'); begin('stale.glb')();
  h.eq([get(toasts).length, subscriptions, timers.size], [0, 0, 0], 'already stale operation creates no timer or subscriptions');
} finally {
  value.set('B');
  for (const toast of get(toasts)) dismissToast(toast.id);
  toasts.set(originalToasts);
  globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout;
}
await h.done();
