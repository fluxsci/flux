import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { withLockAt } from '../flux-core/locks';
const require = createRequire(import.meta.url);
const leases = require('../electron/operationLease.cjs');
const { createGuiLeases } = require('../electron/guiLeases.cjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-operation-leases-'));
try {
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => enter = r);
  let active = 0, max = 0, secondEntered = false;
  const a = withLockAt(root, 'project', 'mcp', async lease => {
    active++; max = Math.max(max, active); enter(); await gate;
    await withLockAt(root, 'project', 'mcp', async nested => { assert.equal(nested.token, lease.token); }, { parent: lease });
    active--;
  });
  await ready;
  const b = withLockAt(root, 'project', 'mcp', async () => { secondEntered = true; active++; max = Math.max(max, active); active--; });
  await new Promise(r => setImmediate(r));
  assert.equal(secondEntered, false);
  assert.ok((await leases.inspect(root, 'project')).token);
  release(); await Promise.all([a, b]); assert.equal(max, 1);
  assert.equal(await leases.inspect(root, 'project'), null);
  await assert.rejects(withLockAt(root, 'project', 'mcp', async () => { throw new Error('injected'); }), /injected/);
  assert.equal(await leases.inspect(root, 'project'), null);

  const old = (await leases.acquire(root, 'ownership', 'mcp')).lease;
  assert.equal((await leases.acquire(root, 'ownership', 'mcp')).ok, false);
  await leases.release(old);
  const current = (await leases.acquire(root, 'ownership', 'mcp')).lease;
  assert.equal(await leases.release(old), false);
  assert.equal(await leases.renew(old), false);
  assert.equal((await leases.inspect(root, 'ownership')).token, current.token);
  await fs.writeFile(path.join(root, 'ownership.json'), JSON.stringify({ ...current, ts: '2000-01-01T00:00:00Z' }));
  assert.equal((await leases.acquire(root, 'ownership', 'other', { ttlMs: 1 })).ok, false, 'live process cannot expire mid-operation');
  await leases.release(current);

  const native = createGuiLeases({ rootFor: () => root, fluxLibDir: () => path.join(root, 'library') });
  const sender = (id: number) => ({ sender: { id, isDestroyed: () => false } });
  const first = await native.acquire(sender(1), { scope: 'fluxlib', name: 'library' });
  assert.ok(first.ok && first.token);
  assert.equal((await native.acquire(sender(2), { scope: 'fluxlib', name: 'library' })).ok, false);
  assert.equal(await native.release(sender(2), { scope: 'fluxlib', name: 'library', token: first.token }), false);
  assert.equal((await native.acquire(sender(1), { scope: 'fluxlib', name: 'library' })).ok, false);
  await native.release(sender(1), { scope: 'fluxlib', name: 'library', token: first.token });
  assert.equal(await native.set(sender(1), { name: 'project', held: true }), true);
  assert.equal(await native.set(sender(2), { name: 'project', held: true }), false);
  const child = await native.acquire(sender(1), { name: 'project' }); assert.ok(child.ok);
  assert.equal((await native.acquire(sender(1), { name: 'project' })).ok, false);
  await native.set(sender(1), { name: 'project', held: false });
  assert.equal((await leases.acquire(path.join(root, '.meta/locks'), 'project', 'cli')).ok, false, 'activity parent retained while child runs');
  await native.release(sender(1), { name: 'project', token: child.token });
  const cli = await leases.acquire(path.join(root, '.meta/locks'), 'project', 'cli'); assert.ok(cli.ok); await leases.release(cli.lease);
  await native.releaseAll();
  console.log('Operation leases: same-process exclusion, explicit nesting, exception cleanup, token ABA, live TTL and native sender/child ownership PASS');
} finally { await fs.rm(root, { recursive: true, force: true }); }
