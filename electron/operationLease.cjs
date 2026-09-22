// Filesystem lease shared by Electron and the Node engine. Only an opaque operation
// token owns a lease. The short transition critical section uses per-contender
// bakery registers: every register has a unique, never-reused pathname. Thus stale
// cleanup can only unlink the inspected contender, never a successor (the ABA bug
// in read/rename/delete of a shared lock pathname). The public *.json remains the
// compatible diagnostic/deferral record. Cooperating writers must use this module.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const HOST = os.hostname();
const TTL = 30_000;
const queues = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function resource(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('Invalid lease resource');
  return name;
}
async function canonicalDir(dir) { await fs.mkdir(dir, { recursive: true }); return fs.realpath(dir); }
async function read(file) {
  try { const raw = await fs.readFile(file, 'utf8'); try { return JSON.parse(raw); } catch { return { corrupt: true, ts: new Date((await fs.stat(file)).mtimeMs).toISOString() }; } }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function alive(info) {
  if (info.host !== HOST || !Number.isInteger(info.pid) || info.pid <= 0) return null;
  try { process.kill(info.pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : true; }
}
function stale(info, ttl = TTL) {
  if (!info) return true;
  const live = alive(info);
  if (live === true) return false; // a slow live operation is never stolen
  if (live === false) return true;
  const stamp = Date.parse(info.ts);
  return Number.isFinite(stamp) && Date.now() - stamp > ttl;
}
// Windows sharing violations live in fsRetry.cjs — one implementation for the
// lease record here and for every project-file write in flux-core/fsx.ts. The
// arbitration registers need no retry: they are never replaced (see transition).
const { shareRetry } = require("./fsRetry.cjs");
async function atomic(file, value, exclusive = false) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await shareRetry(() => (exclusive ? fs.link(tmp, file) : fs.rename(tmp, file)));
  } finally {
    // The temp link is disposable: losing it leaks a byte, losing the operation
    // loses the user's work.
    await shareRetry(() => fs.rm(tmp, { force: true })).catch(() => {});
  }
}
const discard = file => shareRetry(() => fs.rm(file, { force: true })).catch(() => {});
const ticketOf = info => (Number.isSafeInteger(info.ticket) ? info.ticket : 0);
/**
 * The live contenders, ONE record per token. A token that has published its
 * number is read at that number even while its choosing flag is still on disk
 * (the higher wins), and a token carrying only the flag reads as 0 — which
 * makes every other contender wait, the conservative half of the bakery.
 */
async function registers(dir) {
  const byToken = new Map();
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name), info = await read(file);
    if (!info) continue;
    if (stale(info)) { await discard(file); continue; }
    const seen = byToken.get(info.token);
    if (!seen || ticketOf(info) > ticketOf(seen)) byToken.set(info.token, info);
  }
  return [...byToken.values()];
}
/**
 * Lamport's bakery: publish a choosing flag, read everyone, publish a number,
 * then wait for every contender that outranks you.
 *
 * NOTHING here ever replaces a file. The number used to be written OVER the
 * choosing record at the same pathname, and on Windows that rename-replace
 * fails outright for a destination that was hard-linked moments earlier —
 * measured 3 failures per 100 sequential acquire+release cycles, and not
 * transient: 2.5 s of backoff never landed it, while unlinking that same
 * destination and renaming to a fresh name both succeeded immediately. A
 * failed release then left the lease on disk, and because its owning process
 * was still alive nothing could ever call it stale — which is what reached the
 * user as "project is busy (held by human)" and as a project that would not
 * open (2026-09-22). So the two phases are two files with unique, never-reused
 * names, each created by an exclusive link, and the flag is deleted once the
 * number is out. A delete that loses to a scanner handle is harmless here: the
 * flag's 0 is ignored in favour of the number, and stale cleanup collects it.
 */
async function transition(dir, name, fn) {
  const queueDir = path.join(dir, `.${name}.arbitration`);
  await fs.mkdir(queueDir, { recursive: true });
  const token = randomUUID();
  const choosing = path.join(queueDir, `${token}.choosing.json`);
  const file = path.join(queueDir, `${token}.json`);
  const base = { token, pid: process.pid, host: HOST, ts: new Date().toISOString() };
  await atomic(choosing, { ...base, ticket: 0 }, true);
  try {
    const others = await registers(queueDir);
    const ticket = 1 + Math.max(0, ...others.map(ticketOf));
    await atomic(file, { ...base, ticket }, true);
    await discard(choosing);
    const deadline = Date.now() + 5000;
    for (;;) {
      const wait = (await registers(queueDir)).some(x => x.token !== token &&
        (ticketOf(x) === 0 || ticketOf(x) < ticket || (ticketOf(x) === ticket && x.token < token)));
      if (!wait) return await fn();
      if (Date.now() > deadline) throw new Error(`Lease arbitration timed out: ${name}`);
      await delay(5);
    }
  } finally { await discard(file); await discard(choosing); }
}
async function inspect(dir, name) { return read(path.join(await canonicalDir(dir), `${resource(name)}.json`)); }
async function acquire(dir, name, client, options = {}) {
  dir = await canonicalDir(dir); resource(name);
  return transition(dir, name, async () => {
    const file = path.join(dir, `${name}.json`), current = await read(file);
    if (current && !stale(current, options.ttlMs)) return { ok: false, heldBy: current.client || 'unknown', info: current };
    const lease = { dir, name, client, token: randomUUID(), pid: process.pid, host: HOST, ts: new Date().toISOString() };
    await atomic(file, lease);
    return { ok: true, lease };
  });
}
async function renew(lease) {
  return transition(lease.dir, lease.name, async () => {
    const file = path.join(lease.dir, `${lease.name}.json`), current = await read(file);
    if (!current || current.token !== lease.token) return false;
    lease.ts = new Date().toISOString();
    await atomic(file, lease);
    return true;
  });
}
async function release(lease) {
  return transition(lease.dir, lease.name, async () => {
    const file = path.join(lease.dir, `${lease.name}.json`), current = await read(file);
    if (!current || current.token !== lease.token) return false;
    await shareRetry(() => fs.rm(file)); return true;
  });
}
async function assertOwned(lease) {
  const current = await read(path.join(lease.dir, `${lease.name}.json`));
  if (!current || current.token !== lease.token) throw new Error(`Lost lease: ${lease.name}`);
}
async function queued(dir, name, fn) {
  dir = await canonicalDir(dir); resource(name);
  const key = path.join(dir, name), prior = queues.get(key) || Promise.resolve();
  let done; const gate = new Promise(resolve => { done = resolve; });
  const tail = prior.then(() => gate); queues.set(key, tail);
  await prior;
  try { return await fn(dir); } finally { done(); if (queues.get(key) === tail) queues.delete(key); }
}
module.exports = { acquire, release, renew, inspect, assertOwned, queued, stale, canonicalDir };
