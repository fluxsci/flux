// Short RMW leases are owned by an operation token, not by the renderer label.
import { fileBridge } from '../project/types';
export interface IpcLease { scope: 'project' | 'fluxlib'; name: string; token?: string; root?: string; assertOwned?: () => Promise<void> }
const queues = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function withIpcLock<T>(scope: 'project' | 'fluxlib', name: string,
  fn: (lease: IpcLease) => Promise<T>, opts: { retries?: number; delayMs?: number; parent?: IpcLease; root?: string } = {}): Promise<T> {
  if (opts.parent) {
    if (opts.parent.scope !== scope || opts.parent.name !== name || opts.parent.root !== opts.root) throw new Error('Parent lease belongs to a different resource');
    await opts.parent.assertOwned?.();
    return fn(opts.parent);
  }
  const key = `${scope}:${opts.root ?? ""}:${name}`, prior = queues.get(key) ?? Promise.resolve();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), tail = prior.then(() => gate);
  queues.set(key, tail); await prior;
  const fb = fileBridge();
  let lease: IpcLease | undefined;
  try {
    if (!fb?.lockAcquire) return await fn({ scope, name });
    for (let attempt = 0; ; attempt++) {
      const result = await fb.lockAcquire(scope, name, opts.root);
      if (result.ok) {
        if (!result.token && !result.noop) throw new Error(`Lease "${name}" returned no operation token`);
        lease = { scope, name, root: opts.root, token: result.token, assertOwned: async () => { if (result.token && fb.lockCheck && await fb.lockCheck(scope, name, result.token) !== true) throw new Error(`Operation lease "${name}" is no longer owned`); } }; break;
      }
      // `heldBy` is the LOCK CLIENT label, and the GUI's own label is "human"
      // — it exists so an agent can be told a person is editing. Reporting it
      // back to that person read as "project is busy (held by human)", which
      // named the reader as the obstacle (owner report 2026-09-22). Anything
      // else is an agent or another Flux process, and worth naming.
      if (attempt >= (opts.retries ?? 8)) {
        const holder = !result.heldBy || result.heldBy === 'human'
          ? 'another Flux operation is still finishing'
          : `${result.heldBy} is working on it`;
        throw new Error(`"${name}" is busy — ${holder}. Try again in a moment.`);
      }
      await sleep(opts.delayMs ?? 250);
    }
    const result = await fn(lease);
    await lease.assertOwned?.();
    return result;
  } finally {
    try { if (lease?.token) await fb?.lockRelease?.(scope, name, lease.token); }
    finally { finish(); if (queues.get(key) === tail) queues.delete(key); }
  }
}
