// Shared Node/native operation leases. Human/client labels are diagnostics only;
// independent tasks never become reentrant merely because they share a process.
import * as path from 'node:path';
import * as leases from '../electron/operationLease.cjs';
export type LockLease = leases.OperationLease;
export interface LockInfo { client: string; pid: number; ts: string; token?: string; host?: string }
export const projectLockDir = (root: string): string => path.join(root, '.meta', 'locks');
export const fluxlibLockDir = (lib: string): string => path.join(lib, '.fluxlib', 'locks');
let LOCK_CLIENT = 'core';
export function setLockClient(c: string): void { LOCK_CLIENT = c; }
export function getLockClient(): string { return LOCK_CLIENT; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Compatibility API retains its caller-owned handle internally. New operations use
// withLockAt; clients cannot release a lease acquired through another API/process.
const manual = new Map<string, LockLease>();
const manualKey = async (dir: string, name: string, client: string) => `${await leases.canonicalDir(dir)}\0${name}\0${client}`;
export async function heldByOtherAt(dir: string, name: string, client: string): Promise<LockInfo | null> {
  const info = await leases.inspect(dir, name);
  const own = manual.get(await manualKey(dir, name, client));
  return info && !leases.stale(info) && info.token !== own?.token ? info : null;
}
export async function acquireLockAt(dir: string, name: string, client: string): Promise<boolean> {
  const key = await manualKey(dir, name, client);
  const existing = manual.get(key);
  if (existing) return leases.renew(existing); // explicit compatibility handle only
  const result = await leases.acquire(dir, name, client);
  if (!result.ok) return false;
  manual.set(key, result.lease); return true;
}
export async function releaseLockAt(dir: string, name: string, client?: string): Promise<void> {
  if (!client) return; // no unowned release
  const key = await manualKey(dir, name, client), lease = manual.get(key);
  if (!lease) return;
  manual.delete(key); await leases.release(lease);
}
export interface LockOptions { retries?: number; delayMs?: number; heartbeatMs?: number; parent?: LockLease }
export async function withLockAt<T>(dir: string, name: string, client: string, fn: (lease: LockLease) => Promise<T>, opts: LockOptions = {}): Promise<T> {
  if (opts.parent) {
    if (opts.parent.dir !== await leases.canonicalDir(dir) || opts.parent.name !== name) throw new Error('Parent lease belongs to a different resource');
    await leases.assertOwned(opts.parent); return fn(opts.parent);
  }
  return leases.queued(dir, name, async canonical => {
    let lease: LockLease;
    for (let attempt = 0; ; attempt++) {
      const result = await leases.acquire(canonical, name, client);
      if (result.ok) { lease = result.lease; break; }
      if (result.heldBy === 'human' || attempt >= (opts.retries ?? 0)) {
        const who = result.heldBy === 'human' ? 'a human edit is in progress' : `held by ${result.heldBy}`;
        throw new Error(`deferred: "${name}" is locked (${who}). Re-run in a moment.`);
      }
      await sleep(opts.delayMs ?? 250);
    }
    let stopped = false, lost: unknown = null, beats = Promise.resolve();
    const timer = setInterval(() => {
      beats = beats.then(async () => { if (!stopped && !await leases.renew(lease)) lost = new Error(`Lost lease: ${name}`); }).catch(error => { lost = error; });
    }, opts.heartbeatMs ?? 10_000);
    timer.unref?.();
    try {
      const result = await fn(lease);
      await leases.assertOwned(lease);
      if (lost) throw lost;
      return result;
    } finally {
      stopped = true; clearInterval(timer); await beats; await leases.release(lease);
    }
  });
}
export const withHeartbeatLockAt = withLockAt;
export async function assertLockOwned(lease: LockLease): Promise<void> { return leases.assertOwned(lease); }
export const heldByOther = (root: string, name: string, client: string) => heldByOtherAt(projectLockDir(root), name, client);
export const acquireLock = (root: string, name: string, client: string) => acquireLockAt(projectLockDir(root), name, client);
export const releaseLock = (root: string, name: string, client?: string) => releaseLockAt(projectLockDir(root), name, client);
export const withLock = <T>(root: string, name: string, client: string, fn: (lease: LockLease) => Promise<T>, opts: LockOptions = {}) => withLockAt(projectLockDir(root), name, client, fn, { retries: 8, ...opts });
