// A volume without hard links (exFAT, FAT): every create-only publisher falls
// back to an exclusive copy instead of failing. The owner's demo project on an
// external exFAT SSD could not open at all — lock:acquire died on
// "ENOTSUP: operation not supported on socket, link" (2026-10-07).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { withLockAt } from '../flux-core/locks';
import { atomicWrite } from '../flux-core/fsx';
import { publishModelFile } from '../flux-core/model3dFile';
const require = createRequire(import.meta.url);
const { publishExclusive, isNoHardLinks } = require('../electron/fsExclusive.cjs');
const leases = require('../electron/operationLease.cjs');
const { createVerifiedCopy } = require('../electron/verifiedCopy.cjs');
const { createVerifiedMove } = require('../electron/verifiedMove.cjs');
const { createFileCore, APPLE_DOUBLE_RE } = require('../electron/ipc/files.cjs');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-fs-exclusive-'));
const realLink = fs.link;
const noHardLinks = () => { fs.link = async () => { throw Object.assign(new Error('ENOTSUP: operation not supported on socket, link'), { code: 'ENOTSUP' }); }; };
try {
  const tmp = path.join(root, 'tmp'), linked = path.join(root, 'linked'), copied = path.join(root, 'copied');
  await fs.writeFile(tmp, 'bytes');
  assert.equal(await publishExclusive(tmp, linked), 'linked', 'a volume with hard links still links');

  noHardLinks();
  // Larger than the copy buffer, so the loop runs more than once.
  const big = Buffer.alloc((1 << 20) * 2 + 17, 7); await fs.writeFile(tmp, big);
  assert.equal(await publishExclusive(tmp, copied, { mode: 0o600 }), 'copied');
  assert.ok((await fs.readFile(copied)).equals(big), 'the copy carries every byte');
  if (process.platform !== 'win32') assert.equal((await fs.stat(copied)).mode & 0o777, 0o600, 'the copy keeps the requested mode');
  await fs.writeFile(tmp, 'replacement');
  await assert.rejects(publishExclusive(tmp, copied), { code: 'EEXIST' });
  assert.ok((await fs.readFile(copied)).equals(big), 'the fallback never clobbers an existing file');
  assert.equal(isNoHardLinks(Object.assign(new Error(), { code: 'EACCES' })), false, 'a real refusal is not a missing feature');

  // The reported failure: the lease bakery's registers.
  const lease = await leases.acquire(root, 'project', 'human');
  assert.equal(lease.ok, true, 'a lease is acquired on a volume without hard links');
  assert.equal((await leases.acquire(root, 'project', 'mcp')).ok, false, '…and still excludes a second writer');
  assert.equal(await leases.release(lease.lease), true);
  // macOS's AppleDouble sibling of a register (`._<token>.json`, xattrs on exFAT) is not a contender.
  const queue = path.join(await fs.realpath(root), '.project.arbitration');
  await fs.writeFile(path.join(queue, '._3f2504e0-4f89-41d3-9a0c-0305e82c3301.choosing.json'), Buffer.from([0, 5, 22, 7, 0, 2]));
  const started = Date.now(), again = await leases.acquire(root, 'project', 'human');
  assert.equal(again.ok, true); assert.ok(Date.now() - started < 1000, 'an AppleDouble file never stalls arbitration');
  await leases.release(again.lease);
  let active = 0, max = 0;
  await Promise.all([1, 2, 3].map(() => withLockAt(root, 'export', 'mcp', async () => {
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--;
  })));
  assert.equal(max, 1, 'contending locks still serialize');
  assert.deepEqual((await fs.readdir(path.join(root, '.export.arbitration'))).filter(n => n.endsWith('.json')), [], 'no register is left behind');

  const doc = path.join(root, 'paper', 'new.qmd');
  await atomicWrite(doc, 'first', true);
  await assert.rejects(atomicWrite(doc, 'second', true), { code: 'EEXIST' });
  assert.equal(await fs.readFile(doc, 'utf8'), 'first', 'create-only document writes refuse an existing file');
  assert.deepEqual((await fs.readdir(path.dirname(doc))).sort(), ['new.qmd'], 'no temp file is left behind');

  const source = path.join(root, 'source.png'); await fs.writeFile(source, 'pixels');
  await createVerifiedCopy()(source, path.join(root, 'assets', 'copy.png'));
  assert.equal(await fs.readFile(path.join(root, 'assets', 'copy.png'), 'utf8'), 'pixels', 'asset copies publish');
  await createVerifiedMove()(source, path.join(root, 'assets', 'moved.png'));
  assert.equal(await fs.readFile(path.join(root, 'assets', 'moved.png'), 'utf8'), 'pixels', 'captures move');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });

  const model = path.join(root, 'fig', 'assets', 'model.glb');
  await publishModelFile(root, model, Buffer.from('glb'), true);
  assert.equal(await fs.readFile(model, 'utf8'), 'glb', '3D models publish create-only');
  await assert.rejects(publishModelFile(root, model, Buffer.from('other'), true), /EEXIST/);
  assert.equal(await fs.readFile(model, 'utf8'), 'glb');

  // The renderer's listing hides macOS's `._X` beside `X`, never a lone `._X` the user named.
  const plots = path.join(root, 'plots'); await fs.mkdir(plots);
  for (const name of ['a.svg', '._a.svg', '._lonely.svg']) await fs.writeFile(path.join(plots, name), 'x');
  const handlers = new Map<string, Function>();
  createFileCore({ app: { getPath: () => root }, roots: () => [root], projectRootFor: () => [root], setPendingRoot() {} }).registerHandlers({ handle: (channel: string, fn: Function) => handlers.set(channel, fn) });
  const listed = (await handlers.get('fs:readdir')!({ sender: { id: 1 } }, plots)).map((e: { name: string }) => e.name).sort();
  assert.deepEqual(listed, ['._lonely.svg', 'a.svg'], 'fs:readdir drops AppleDouble siblings only');
  assert.ok(APPLE_DOUBLE_RE.test(path.join(plots, '._a.svg')) && !APPLE_DOUBLE_RE.test(path.join(root, '._dir', 'a.svg')), 'the watcher ignores AppleDouble files, not their neighbours');
  console.log('verify-fs-exclusive: ok');
} finally {
  fs.link = realLink;
  await fs.rm(root, { recursive: true, force: true });
}
