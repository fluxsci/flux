// WS6/W3 — advisory locks for safe app↔agent coexistence. A lock is a small JSON
// file recording who holds it and when. They are *advisory*: cooperating writers
// (flux-core, the live bridge, and the GUI while a human is editing) check before
// writing so an agent's file write can't clobber an in-flight human edit — it's
// deferred with a clear message instead. Locks auto-expire (a crashed holder
// never wedges anything).
//
// W3 (V1 review): locks are now DIRECTORY-scoped so the machine-global FluxLib
// gets its own lock space (`<lib>/.fluxlib/locks/`) alongside the per-project
// `<root>/.meta/locks/`; `withLockAt` gained bounded retries (FluxLib mutations
// are millisecond-scale, so a contending writer waits briefly instead of
// erroring); and the GUI restamps held locks (heartbeat in electron/main.cjs)
// so a long human edit never falsely expires.

import * as fs from "node:fs/promises";
import * as path from "node:path";

const TTL_MS = 30_000; // a lock older than this is considered stale (holder gone)

export interface LockInfo {
  client: string;
  pid: number;
  ts: string;
}

export const projectLockDir = (root: string): string => path.join(root, ".meta", "locks");
export const fluxlibLockDir = (lib: string): string => path.join(lib, ".fluxlib", "locks");

const lockFileAt = (dir: string, name: string) => path.join(dir, `${name}.json`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The client identity used when none is passed explicitly ("cli" | "mcp" | …).
// Lives here (not index.ts) so fluxlib.ts can use locks without an import cycle.
let LOCK_CLIENT = "core";
export function setLockClient(c: string): void {
  LOCK_CLIENT = c;
}
export function getLockClient(): string {
  return LOCK_CLIENT;
}

async function readLockAt(dir: string, name: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await fs.readFile(lockFileAt(dir, name), "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

function fresh(info: LockInfo): boolean {
  const t = Date.parse(info.ts);
  return Number.isFinite(t) && Date.now() - t < TTL_MS;
}

/** If `name` is held by a *fresh* lock owned by someone other than `client`, return it. */
export async function heldByOtherAt(
  dir: string,
  name: string,
  client: string,
): Promise<LockInfo | null> {
  const info = await readLockAt(dir, name);
  return info && fresh(info) && info.client !== client ? info : null;
}

/** Sentinel returned by tryAcquireAt when it cleared a stale/corrupt lock —
 *  the caller should retry immediately (this attempt is free). */
const CLEARED: LockInfo = { client: "", pid: 0, ts: "" };

/** Atomically try to take the lock via exclusive-create (open "wx") — the fix
 *  for the check-then-write race where two processes both saw "free" and both
 *  proceeded. Returns null on success, the blocking LockInfo when held, or the
 *  CLEARED sentinel after removing a stale lock (caller retries). `strictPid`
 *  treats a fresh same-client lock from ANOTHER process as blocking (two `cli`
 *  invocations must serialize); without it, same-client re-acquire restamps. */
async function tryAcquireAt(
  dir: string,
  name: string,
  client: string,
  strictPid: boolean,
): Promise<LockInfo | null> {
  await fs.mkdir(dir, { recursive: true });
  const p = lockFileAt(dir, name);
  const payload = JSON.stringify({ client, pid: process.pid, ts: new Date().toISOString() });
  try {
    const fh = await fs.open(p, "wx");
    try {
      await fh.writeFile(payload, "utf8");
    } finally {
      await fh.close();
    }
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
  }
  const info = await readLockAt(dir, name);
  if (info && fresh(info)) {
    const ours = info.client === client && (!strictPid || info.pid === process.pid);
    if (!ours) return info;
    // our own fresh lock — restamp in place
    await fs.writeFile(p, payload).catch(() => {});
    return null;
  }
  // stale or unreadable — clear it and let the caller retry the exclusive create
  await fs.rm(p, { force: true }).catch(() => {});
  return CLEARED;
}

export async function acquireLockAt(dir: string, name: string, client: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const blocker = await tryAcquireAt(dir, name, client, false);
    if (!blocker) return true;
    if (blocker !== CLEARED) return false;
  }
  return false;
}

export async function releaseLockAt(dir: string, name: string, client?: string): Promise<void> {
  const info = await readLockAt(dir, name);
  if (info && client && info.client !== client) return; // never release another client's lock
  await fs.rm(lockFileAt(dir, name), { force: true }).catch(() => {});
}

/** Run `fn` while holding `name` in `dir`. Acquisition is atomic (exclusive
 *  create). A human-held lock defers immediately (activity locks last 10s+);
 *  another agent's ms-scale lock is retried `retries` times before deferring. */
export async function withLockAt<T>(
  dir: string,
  name: string,
  client: string,
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 0;
  const delayMs = opts.delayMs ?? 250;
  let attempt = 0;
  for (;;) {
    const blocker = await tryAcquireAt(dir, name, client, true);
    if (!blocker) break;
    if (blocker === CLEARED) continue; // cleared a stale lock — retry is free
    if (blocker.client === "human" || attempt >= retries) {
      const who =
        blocker.client === "human" ? "a human edit is in progress" : `held by ${blocker.client}`;
      throw new Error(`deferred: "${name}" is locked (${who}). Re-run in a moment.`);
    }
    attempt++;
    await sleep(delayMs);
  }
  try {
    return await fn();
  } finally {
    // release only our own lock (client+pid) — never a contender's fresh one
    const info = await readLockAt(dir, name);
    if (!info || (info.client === client && info.pid === process.pid))
      await fs.rm(lockFileAt(dir, name), { force: true }).catch(() => {});
  }
}

// ---- back-compat project-rooted API (unchanged signatures) -----------------

export async function heldByOther(root: string, name: string, client: string): Promise<LockInfo | null> {
  return heldByOtherAt(projectLockDir(root), name, client);
}

export async function acquireLock(root: string, name: string, client: string): Promise<boolean> {
  return acquireLockAt(projectLockDir(root), name, client);
}

export async function releaseLock(root: string, name: string, client?: string): Promise<void> {
  return releaseLockAt(projectLockDir(root), name, client);
}

/** Run `fn` while holding `name`. A human-held lock defers immediately; another
 *  agent's (ms-scale) lock is retried briefly before deferring. */
export async function withLock<T>(root: string, name: string, client: string, fn: () => Promise<T>): Promise<T> {
  return withLockAt(projectLockDir(root), name, client, fn, { retries: 8 });
}
