// Sender-bound adapter over the SAME filesystem lease engine used by flux-core.
const path = require('node:path');
const leases = require('./operationLease.cjs');
function createGuiLeases({ rootFor, fluxLibDir }) {
  const activities = new Map(), operations = new Map();
  function directory(scope, root) {
    if (scope === 'fluxlib') return path.join(fluxLibDir(), '.fluxlib', 'locks');
    if (scope !== 'project' || !root) throw new Error('No active project for lease');
    return path.join(root, '.meta', 'locks');
  }
  function owner(e, scope, name, expectedRoot) {
    if (!e.sender || e.sender.isDestroyed?.()) throw new Error('Lease sender is closed');
    const root = rootFor(e, expectedRoot), dir = directory(scope, root);
    return { sender: e.sender.id, root, dir, key: `${e.sender.id}:${dir}:${name}`, scope, name };
  }
  function heartbeat(entry) {
    entry.beats = Promise.resolve();
    entry.timer = setInterval(() => {
      entry.beats = entry.beats.then(async () => {
        if (!entry.stopped && !await leases.renew(entry.lease)) entry.lost = true;
      }).catch(() => { entry.lost = true; });
    }, 10000);
    entry.timer.unref?.();
  }
  async function dispose(entry) {
    entry.stopped = true; clearInterval(entry.timer); await entry.beats;
    return leases.release(entry.lease);
  }
  async function releaseActivity(entry) {
    entry.retiring = true;
    if (entry.children) return;
    if (activities.get(entry.key) === entry) activities.delete(entry.key);
    await dispose(entry);
  }
  async function releaseOperation(entry) {
    operations.delete(entry.lease.token);
    await dispose(entry);
    if (entry.parent) {
      entry.parent.children--;
      if (entry.parent.retiring && !entry.parent.children) await releaseActivity(entry.parent);
    }
  }
  async function set(e, { name, held, scope = 'project' }) {
    const context = owner(e, scope, name);
    return leases.queued(context.dir, `${name}.activity`, async () => {
      const entry = activities.get(context.key);
      if (!held) { if (entry) await releaseActivity(entry); return true; }
      if (entry && !entry.retiring) return leases.renew(entry.lease);
      const result = await leases.acquire(context.dir, name, 'human');
      if (!result.ok) return false;
      const next = { ...context, lease: result.lease, children: 0 };
      activities.set(context.key, next); heartbeat(next); return true;
    });
  }
  async function acquire(e, { name, scope = 'project', expectedRoot }) {
    const context = owner(e, scope, name, expectedRoot);
    if (scope === 'project' && expectedRoot != null && path.resolve(expectedRoot) !== path.resolve(context.root)) throw new Error('Project changed before lease acquisition');
    return leases.queued(context.dir, `${name}.activity`, async () => {
      if (scope === 'project' && rootFor(e, context.root) !== context.root) throw new Error('Project changed while awaiting lease');
      const candidate = activities.get(context.key);
      const parent = candidate && !candidate.retiring && !candidate.lost ? candidate : null;
      if (parent) await leases.assertOwned(parent.lease);
      // Explicitly derive a short operation from this sender's activity lease.
      // A distinct child resource serializes operations even within that sender.
      const result = await leases.acquire(context.dir, parent ? `${name}.operation` : name, 'human');
      if (!result.ok) return { ok: false, heldBy: result.heldBy };
      if (parent) parent.children++;
      const entry = { ...context, lease: result.lease, parent };
      operations.set(result.lease.token, entry); heartbeat(entry);
      return { ok: true, token: result.lease.token };
    });
  }
  async function check(e, { token, scope = 'project', name }) {
    const entry = operations.get(token);
    if (!entry || entry.sender !== e.sender?.id || entry.scope !== scope || entry.name !== name || entry.lost) throw new Error('Operation lease is no longer owned');
    if (scope === 'project' && rootFor(e, entry.root) !== entry.root) throw new Error('Project changed during operation');
    await leases.assertOwned(entry.lease);
    if (entry.parent) await leases.assertOwned(entry.parent.lease);
    return true;
  }
  async function release(e, { token, scope = 'project', name }) {
    const entry = operations.get(token);
    if (!entry || entry.sender !== e.sender?.id || entry.scope !== scope || entry.name !== name) return false;
    // Captured dir, never mutable current root: project-switch cleanup can retire
    // precisely the original operation without touching the newly opened root.
    await releaseOperation(entry); return true;
  }
  async function releaseFor(sender) {
    for (const entry of [...operations.values()]) if (entry.sender === sender) await releaseOperation(entry);
    for (const entry of [...activities.values()]) if (entry.sender === sender) await releaseActivity(entry);
  }
  async function releaseAll() {
    for (const entry of [...operations.values()]) await releaseOperation(entry);
    for (const entry of [...activities.values()]) await releaseActivity(entry);
  }
  function register(ipc) {
    ipc.handle('lock:set', set); ipc.handle('lock:acquire', acquire); ipc.handle('lock:release', release); ipc.handle('lock:check', check);
  }
  return { register, releaseFor, releaseAll, set, acquire, release, check };
}
module.exports = { createGuiLeases };
