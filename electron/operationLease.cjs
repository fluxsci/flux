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
async function atomic(file, value, exclusive = false) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    // On Windows a just-created file is briefly held open by the antivirus scanner,
    // so link/rename onto it fails with EPERM/EBUSY a few percent of the time (60
    // arbitration cycles reproduced 2 such failures, 2026-09-22). One failure was
    // enough to abort a save and orphan the project lease. Retry briefly instead.
    for (let attempt = 0; ; attempt++) {
      try {
        if (exclusive) await fs.link(tmp, file); else await fs.rename(tmp, file);
        break;
      } catch (error) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } finally { await fs.rm(tmp, { force: true }); }
}
async function registers(dir) {
  const records = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name), info = await read(file);
    if (!info) continue;
    if (stale(info)) { await fs.rm(file, { force: true }); continue; }
    records.push(info);
  }
  return records;
}
async function transition(dir, name, fn) {
  const queueDir = path.join(dir, `.${name}.arbitration`);
  await fs.mkdir(queueDir, { recursive: true });
  const token = randomUUID(), file = path.join(queueDir, `${token}.json`);
  const record = { token, pid: process.pid, host: HOST, ts: new Date().toISOString(), ticket: 0 };
  await atomic(file, record, true);
  try {
    const others = await registers(queueDir);
    record.ticket = 1 + Math.max(0, ...others.map(x => Number.isSafeInteger(x.ticket) ? x.ticket : 0));
    await atomic(file, record);
    const deadline = Date.now() + 5000;
    for (;;) {
      const wait = (await registers(queueDir)).some(x => x.token !== token &&
        (!Number.isSafeInteger(x.ticket) || x.ticket === 0 || x.ticket < record.ticket || (x.ticket === record.ticket && x.token < token)));
      if (!wait) return await fn();
      if (Date.now() > deadline) throw new Error(`Lease arbitration timed out: ${name}`);
      await delay(5);
    }
  } finally { await fs.rm(file, { force: true }); }
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
    await fs.rm(file); return true;
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
