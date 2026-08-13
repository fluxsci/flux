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

let tmpSeq = 0;
const tmpFor = (p: string) =>
  path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}-${++tmpSeq}`);

/** Claim the lock atomically WITH its content: write a private tmp, hard-link it
 *  into place (link fails EEXIST when held — the exclusive create), rm the tmp.
 *  The old open("wx")-then-write claim had a torn window where a contender read
 *  the just-created file EMPTY, judged it corrupt, deleted the holder's live
 *  lock and walked into the critical section beside it (verify-note's contention
 *  gate caught the lost update; verify-w3-locks §6 pins it). Filesystems without
 *  hard links fall back to "wx" — the race window returns there, but no such
 *  target platform is known. */
async function claimLock(p: string, payload: string): Promise<"claimed" | "held"> {
  const tmp = tmpFor(p);
  await fs.writeFile(tmp, payload, "utf8");
  try {
    await fs.link(tmp, p);
    return "claimed";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return "held";
    // link unsupported here — fall back to exclusive create.
    try {
      const fh = await fs.open(p, "wx");
      try {
        await fh.writeFile(payload, "utf8");
      } finally {
        await fh.close();
      }
      return "claimed";
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException)?.code === "EEXIST") return "held";
      throw e2;
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Restamp OUR OWN fresh lock in place, atomically (tmp + rename) — a plain
 *  truncate-and-write here reopens the torn-read window claimLock closes.
 *  Only ever called after reading our own fresh payload back; contenders never
 *  touch a fresh lock, so the rename cannot clobber anyone. */
async function restampLock(p: string, payload: string): Promise<void> {
  const tmp = tmpFor(p);
  await fs.writeFile(tmp, payload, "utf8");
  try {
    await fs.rename(tmp, p);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Take a stale/corrupt lock out of the way WITHOUT racing the other contenders:
 *  rename it to a private trash name first — exactly ONE contender's rename can
 *  succeed, so the double-clear race (A clears, B claims, A's rm deletes B's
 *  fresh claim) is structurally gone. Losing the rename means someone else is
 *  handling it — nothing to do. */
async function takeStaleLock(p: string): Promise<void> {
  const trash = tmpFor(p);
  try {
    await fs.rename(p, trash);
    await fs.rm(trash, { force: true }).catch(() => {});
  } catch {
    /* ENOENT: another contender took it first */
  }
}

/** Atomically try to take the lock. Returns null on success, the blocking
 *  LockInfo when held, or the CLEARED sentinel after removing a stale lock
 *  (caller retries). `strictPid` treats a fresh same-client lock from ANOTHER
 *  process as blocking (two `cli` invocations must serialize); without it,
 *  same-client re-acquire restamps. Unreadable lock files are never destroyed
 *  on sight: a vanished file just retries, and corrupt content only clears once
 *  its MTIME is past the TTL — claims are content-atomic, so young-but-corrupt
 *  can only be a write in flight from a pre-fix holder or a dying machine. */
async function tryAcquireAt(
  dir: string,
  name: string,
  client: string,
  strictPid: boolean,
): Promise<LockInfo | null> {
  await fs.mkdir(dir, { recursive: true });
  const p = lockFileAt(dir, name);
  const payload = JSON.stringify({ client, pid: process.pid, ts: new Date().toISOString() });
  if ((await claimLock(p, payload)) === "claimed") return null;
  let raw: string | null = null;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return CLEARED; // released between claim and read — nothing to clear, just retry
  }
  let info: LockInfo | null = null;
  try {
    info = JSON.parse(raw) as LockInfo;
  } catch {
    info = null;
  }
  if (info && fresh(info)) {
    const ours = info.client === client && (!strictPid || info.pid === process.pid);
    if (!ours) return info;
    await restampLock(p, payload);
    return null;
  }
  if (!info) {
    const st = await fs.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs < TTL_MS)
      return { client: "unknown", pid: 0, ts: new Date(st.mtimeMs).toISOString() };
  }
  await takeStaleLock(p);
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

/** The shared acquisition loop behind withLockAt / withHeartbeatLockAt. Throws the
 *  standard "deferred" error when the lock stays contended. */
async function acquireOrDefer(
  dir: string,
  name: string,
  client: string,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 0;
  const delayMs = opts.delayMs ?? 250;
  let attempt = 0;
  for (;;) {
    const blocker = await tryAcquireAt(dir, name, client, true);
    if (!blocker) return;
    if (blocker === CLEARED) continue; // cleared a stale lock — retry is free
    if (blocker.client === "human" || attempt >= retries) {
      const who =
        blocker.client === "human" ? "a human edit is in progress" : `held by ${blocker.client}`;
      throw new Error(`deferred: "${name}" is locked (${who}). Re-run in a moment.`);
    }
    attempt++;
    await sleep(delayMs);
  }
}

/** Release only our own lock (client+pid) — never a contender's fresh one. */
async function releaseOwn(dir: string, name: string, client: string): Promise<void> {
  const info = await readLockAt(dir, name);
  if (!info || (info.client === client && info.pid === process.pid))
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
  await acquireOrDefer(dir, name, client, opts);
  try {
    return await fn();
  } finally {
    await releaseOwn(dir, name, client);
  }
}

/** withLockAt for operations that can OUTLIVE the 30s TTL (an assign-inbox scan, a
 *  long import): the held lock is restamped every `heartbeatMs` so a contender never
 *  sees it stale mid-operation, and the restamp only rewrites while the file is still
 *  ours (a stall past the TTL where someone legitimately cleared+took it is not
 *  clobbered). Interval is injectable for tests. */
export async function withHeartbeatLockAt<T>(
  dir: string,
  name: string,
  client: string,
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; heartbeatMs?: number } = {},
): Promise<T> {
  await acquireOrDefer(dir, name, client, opts);
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const restamp = async () => {
    const info = await readLockAt(dir, name);
    if (info && info.client === client && info.pid === process.pid) {
      const payload = JSON.stringify({ client, pid: process.pid, ts: new Date().toISOString() });
      await restampLock(lockFileAt(dir, name), payload); // atomic — no torn-read window
    }
  };
  const timer = setInterval(() => void restamp(), heartbeatMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await releaseOwn(dir, name, client);
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
