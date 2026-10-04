import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

  // A heartbeat renew that THROWS is transient: the lease file is still this owner's and a live owner
  // is never stale. Both heartbeats used to treat it as lost: the GUI window then refused its own
  // operations ("heldBy: human", v0.2.0 packaged smoke on CI, 2026-10-04) and the engine failed work it
  // had completed. Only a renew that finds another owner's token is a real loss. The failure here is
  // genuine, not patched in: a live contender's ticket-0 register makes renew wait out its 5 s
  // arbitration deadline and throw, exactly as a loaded machine does.
  const blockArbitration = async (dir: string, name: string) => {
    const queue = path.join(await fs.realpath(dir), `.${name}.arbitration`), token = randomUUID();
    await fs.mkdir(queue, { recursive: true });
    const file = path.join(queue, `${token}.choosing.json`);
    await fs.writeFile(file, JSON.stringify({ token, pid: process.pid, host: os.hostname(), ticket: 0, ts: new Date().toISOString() }));
    return () => fs.rm(file, { force: true });
  };
  const ARBITRATION_DEADLINE = 5000;
  {
    const beating = createGuiLeases({ rootFor: () => root, fluxLibDir: () => path.join(root, 'library'), heartbeatMs: 20 });
    try {
      assert.equal(await beating.set(sender(7), { name: 'project', held: true }), true);
      const lockDir = path.join(root, '.meta/locks');
      const unblock = await blockArbitration(lockDir, 'project');
      await new Promise(r => setTimeout(r, ARBITRATION_DEADLINE + 600)); // one renew times out and throws
      await unblock();
      const afterHiccup = await beating.acquire(sender(7), { name: 'project', expectedRoot: root });
      assert.ok(afterHiccup.ok, `a transient renew failure must not cost the window its own activity (${JSON.stringify(afterHiccup)})`);
      await beating.release(sender(7), { name: 'project', token: afterHiccup.token });
      // A real loss still counts: another owner's token in the lease file is never adopted.
      const file = path.join(lockDir, 'project.json');
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...record, token: 'someone-else', client: 'agent' }));
      await new Promise(r => setTimeout(r, 120)); // beats see the foreign token
      const stolen = await beating.acquire(sender(7), { name: 'project', expectedRoot: root });
      assert.equal(stolen.ok, false, 'a lease another owner holds is not adopted by the heartbeat');
      await fs.rm(file);
    } finally { await beating.releaseAll(); }
  }
  {
    const result = await withLockAt(root, 'transient', 'mcp', async () => {
      const unblock = await blockArbitration(root, 'transient');
      await new Promise(r => setTimeout(r, ARBITRATION_DEADLINE + 600));
      await unblock();
      return 'completed';
    }, { heartbeatMs: 20 });
    assert.equal(result, 'completed', 'a transient renew failure does not fail completed, still-owned work');
  }
  console.log('Operation leases: same-process exclusion, explicit nesting, exception cleanup, token ABA, live TTL and native sender/child ownership PASS');
} finally { await fs.rm(root, { recursive: true, force: true }); }
