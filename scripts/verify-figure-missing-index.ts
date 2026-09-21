import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from 'linkedom';
import { get } from 'svelte/store';
import { readFigureSnapshot } from '../src/lib/project/figureSnapshot';
import { figureSnapshotBridgeIO } from '../src/lib/project/figureSnapshotBridgeIO';
import { planFigSave } from '../src/lib/project/figfiles';
import { loadFigModel } from '../flux-core/model';
import { composeFigure } from '../flux-core/figures';
import type { Project } from '../src/lib/types';
import type { FileBridge } from '../src/lib/project/types';
const { createFileCore } = createRequire(import.meta.url)('../electron/ipc/files.cjs');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-missing-index-'));
const root = path.join(base, 'project'), outside = path.join(base, 'other');
await fs.mkdir(root); await fs.mkdir(outside);
const handlers = new Map<string, Function>();
createFileCore({ app: { getPath: () => base }, roots: () => [root, outside], projectRootFor: () => [root], setPendingRoot() {} }).registerHandlers({ handle: (channel: string, fn: Function) => handlers.set(channel, fn) });
const event = { sender: { id: 71 } };
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
const bridge = Object.fromEntries(['exists','readText','readFile','writeText','writeFile','mkdir','remove','readdir','projectAssetPath','fsyncDir'].map(name => [name, (...args: unknown[]) => call('fs:' + name, ...args)])) as unknown as FileBridge;
(globalThis as any).window = { fig: bridge }; (globalThis as any).DOMParser = DOMParser;
const store = await import('../src/lib/store');
const { loadFigInto, saveFigFrom } = await import('../src/lib/project/figbridge');
const { sendSlideToCanvas } = await import('../src/lib/project/convert');
const manifest = { schemaVersion: '0.1.0', id: 'p', title: 'Fixture', manuscript: { path: 'paper/main.qmd' }, references: { library: 'bib/library.bib' }, figures: [] };
const model: Project = { version: 2, name: 'Scientific record', canvases: [{ id: 'canvas-1', name: 'Results' }], figures: [{ id: 'f', canvasId: 'canvas-1', name: 'Annotated', x: 0, y: 0, width: 80, height: 40, elements: [], captions: { __figure__: 'The original scientific caption' } }], assets: [], palette: [] };
let checks = 0;
function ok(label: string) { console.log('✓ ' + label); checks++; }
async function reset() {
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify(manifest));
  store.embeddedProjectRoot.set(root);
}
async function seed() {
  await reset(); const plan = planFigSave(model, null);
  for (const item of [...plan.canvases, ...plan.captions, plan.index]) { const dest = path.join(root, item.path); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, item.text); }
}
async function bytes() {
  const result: Record<string, string> = {};
  async function walk(dir: string) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (entry.name === '.meta') continue; const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else result[path.relative(root, file)] = (await fs.readFile(file)).toString('base64'); } }
  await walk(root); return result;
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>';
const input = path.join(base, 'input.svg'); await fs.writeFile(input, svg);
try {
  await seed(); await loadFigInto(root, 'Fixture'); const live = JSON.stringify(get(store.project));
  await fs.rm(path.join(root, 'fig/index.json')); const prior = await bytes();
  await assert.rejects(loadFigInto(root, 'Fixture', { reload: true }), /index is missing/);
  assert.equal(JSON.stringify(get(store.project)), live, 'failed reload retains accepted model');
  await assert.rejects(saveFigFrom(root), /changed on disk/);
  await assert.rejects(composeFigure(root, [input]), /index is missing/);
  await assert.rejects(sendSlideToCanvas(root, { id: 's', name: 'New', elements: [], beats: [] } as any, { id: 'd', stage: { width: 80, height: 40 }, assets: [] }, null), /index is missing/);
  assert.deepEqual(await bytes(), prior); ok('deleted populated index refuses GUI reload/save, Node compose and conversion without changing any authored byte');
  await loadFigInto(root, 'Fixture'); await assert.rejects(saveFigFrom(root), /index is missing/);
  assert.deepEqual(await bytes(), prior); ok('initial GUI inspection locks an incomplete subsystem against save');
  for (const rel of ['fig/canvases/old.json', 'fig/assets/scientific.png', 'fig/captions/old.md', 'fig/index.json.bak', 'fig/index.json.corrupt-1']) {
    await reset(); await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), 'retained bytes');
    const before = await bytes(); await assert.rejects(loadFigModel(root), /index is missing/); assert.deepEqual(await bytes(), before); ok('standalone prior data refuses empty initialization: ' + rel);
  }
  await reset(); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ ...manifest, figures: [{ id: 'f', canvas: 'canvas-1' }] }));
  await assert.rejects(loadFigModel(root), /remain registered/); ok('manifest registration prevents empty adoption even if all fig files disappeared');
  await seed(); await loadFigInto(root, 'Accepted before inventory fault'); await fs.rm(path.join(root, 'fig/index.json')); const inventoryBefore = await bytes();
  const originalReaddir = fs.readdir;
  (fs as any).readdir = async (p: string, ...args: unknown[]) => { if (p === path.join(root, 'fig')) throw Object.assign(new Error('EACCES inventory denied'), { code: 'EACCES' }); return (originalReaddir as Function)(p, ...args); };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await bridge.readdir!(path.join(root, 'fig')), []);
    await assert.rejects(bridge.readdir!(path.join(root, 'fig'), true), /EACCES/);
    await assert.rejects(loadFigModel(root), /EACCES/);
    await assert.rejects(saveFigFrom(root, { force: true }), /inventory.*EACCES/);
    const snapshot = await readFigureSnapshot(figureSnapshotBridgeIO(root, bridge)); assert.equal(snapshot.status, 'failed'); assert.match(snapshot.diagnostics[0].message, /EACCES/);
  } finally { (fs as any).readdir = originalReaddir; syncBuiltinESMExports(); }
  assert.deepEqual(await bytes(), inventoryBefore);
  ok('actual native strict directory adapter, both engines and explicit overwrite retain inventory access failures and original bytes');
  const unsupported = await readFigureSnapshot({ readText: async () => null }); assert.equal(unsupported.status, 'failed'); ok('missing inventory capability cannot authorize fresh mutation');
  await reset(); await fs.symlink(outside, path.join(root, 'fig'));
  await assert.rejects(loadFigModel(root), /symlink escapes/);
  const escaped = await readFigureSnapshot(figureSnapshotBridgeIO(root, bridge)); assert.equal(escaped.status, 'failed'); assert.match(escaped.diagnostics[0].message, /escapes/); ok('existing and nearest-parent inventories reject symlinks into another approved project');
  await reset(); await fs.mkdir(path.join(root, 'fig', 'rendered'), { recursive: true }); await fs.writeFile(path.join(root, 'fig/rendered/external.svg'), svg);
  for (const directory of ['canvases', 'assets', 'captions']) await fs.mkdir(path.join(root, 'fig', directory));
  assert.equal((await loadFigModel(root)).project.figures.length, 0);
  await loadFigInto(root, 'Fresh'); await saveFigFrom(root);
  const composed = await composeFigure(root, [input]); const reopened = await loadFigModel(root); assert.ok(reopened.project.figures.some(f => f.id === composed.figureId));
  assert.equal(await fs.readFile(path.join(root, 'fig/rendered/external.svg'), 'utf8'), svg); ok('fresh empty directories and unrelated rendered files preserve GUI save and Node compose/reopen workflows');
  await seed(); assert.equal((await loadFigModel(root)).project.figures[0].id, 'f'); ok('supported indexed legacy snapshot remains writable');
  console.log(`FIGURE MISSING INDEX: PASS (${checks} checks)`);
} finally { await fs.rm(base, { recursive: true, force: true }); }
