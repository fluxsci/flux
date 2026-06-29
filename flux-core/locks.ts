// WS6 — advisory locks for safe app↔agent coexistence. A lock is a small JSON
// file under `<root>/.meta/locks/<name>.json` recording who holds it and when.
// They are *advisory*: cooperating writers (flux-core, the live bridge, and the
// GUI while a human is editing) check before writing so an agent's file write
// can't clobber an in-flight human edit — it's deferred with a clear message
// instead. Locks auto-expire (a crashed holder never wedges the project).

import * as fs from "node:fs/promises";
import * as path from "node:path";

const TTL_MS = 30_000; // a lock older than this is considered stale (holder gone)

export interface LockInfo {
  client: string;
  pid: number;
  ts: string;
}

const lockPath = (root: string, name: string) => path.join(root, ".meta", "locks", `${name}.json`);

async function readLock(root: string, name: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await fs.readFile(lockPath(root, name), "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

function fresh(info: LockInfo): boolean {
  const t = Date.parse(info.ts);
  return Number.isFinite(t) && Date.now() - t < TTL_MS;
}

/** If `name` is held by a *fresh* lock owned by someone other than `client`, return it. */
export async function heldByOther(root: string, name: string, client: string): Promise<LockInfo | null> {
  const info = await readLock(root, name);
  return info && fresh(info) && info.client !== client ? info : null;
}

export async function acquireLock(root: string, name: string, client: string): Promise<boolean> {
  if (await heldByOther(root, name, client)) return false;
  await fs.mkdir(path.dirname(lockPath(root, name)), { recursive: true });
  await fs.writeFile(lockPath(root, name), JSON.stringify({ client, pid: process.pid, ts: new Date().toISOString() }));
  return true;
}

export async function releaseLock(root: string, name: string, client?: string): Promise<void> {
  const info = await readLock(root, name);
  if (info && client && info.client !== client) return; // never release another client's lock
  await fs.rm(lockPath(root, name), { force: true }).catch(() => {});
}

/** Run `fn` while holding `name`; if another fresh client holds it, throw a "deferred" error. */
export async function withLock<T>(root: string, name: string, client: string, fn: () => Promise<T>): Promise<T> {
  const other = await heldByOther(root, name, client);
  if (other) {
    const who = other.client === "human" ? "a human edit is in progress" : `held by ${other.client}`;
    throw new Error(`deferred: "${name}" is locked (${who}). Re-run in a moment.`);
  }
  await acquireLock(root, name, client);
  try {
    return await fn();
  } finally {
    await releaseLock(root, name, client);
  }
}
