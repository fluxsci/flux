import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { harness } from './lib/harness.mjs';
import { writeGlb, prepareGlb, GLB_LIMITS } from '../src/lib/model3d/glbCore.mjs';
import { createMemBridge } from '../src/lib/project/memBridge';
import { prepareModel3dImport, makeImportedModel3dElement, parseModel3dImportMetadata } from '../src/lib/model3d/importData';
import type { Scene3dManifest } from '../src/lib/model3d/types';
const h = harness('verify-model3d-import'), require = createRequire(import.meta.url);
const native = require('../electron/model3dImport.cjs');
const { createModel3dCore } = require('../electron/ipc/model3d.cjs');
const { createFileCore } = require('../electron/ipc/files.cjs');
const bytes = writeGlb({ parts: [{ name: 'neuron.axon', positions: [0,0,0, 3,0,0, 0,2,1], indices: [0,1,2] }] });
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const manifest: Scene3dManifest = { spec: 'fluxplot/scene3d', schemaVersion: '0.1.0', glb: 'neuron.glb', glbSha256: sha(bytes),
  size: { width: 4, height: 3, unit: 'in' }, view: { azimuth: 76, elevation: 24, projection: 'perspective', fov: 35 },
  parts: [{ id: 'neuron.axon', role: 'mesh', node: 'neuron.axon', color: '#D14D41' }, { id: 'title', role: 'title', text: 'Neuron' }] };
const metadata = JSON.stringify(manifest), recipe = JSON.stringify({ outputs: { glb: 'neuron.glb' } });
const prepared = await prepareModel3dImport({ bytes, assetId: 'neuron', name: 'neuron.glb', manifestText: metadata, recipeText: recipe });
h.eq(prepared.bytes, prepareGlb(bytes).bytes, 'import uses the shared GLB preparation core');
h.eq([prepared.data.sourceSha256, prepared.data.asset.sha256], [sha(bytes), sha(prepared.bytes)], 'original and prepared hashes are separate exact receipts');
h.eq(prepared.data.manifestHash, sha(metadata), 'manifest receipt binds exact source text');
const textured = new Uint8Array(await fs.readFile(new URL('./fixtures/model3d/textured.glb', import.meta.url)));
const stripped = await prepareModel3dImport({ bytes: textured, assetId: 'stripped', name: 'textured.glb',
  manifestText: JSON.stringify({ spec: 'fluxplot/scene3d', schemaVersion: '0.1.0', glb: 'textured.glb', glbSha256: sha(textured) }) });
h.ok(stripped.data.sourceSha256 !== stripped.data.asset.sha256 && !!stripped.data.manifest, 'metadata binds original bytes when preparation changes the GLB');
const element = makeImportedModel3dElement({ ...prepared.data, source: { glbPath: '/project/plots/neuron.glb', manifestPath: '/project/plots/neuron.fluxplot.json' } }, { root: '/project', id: 'neuron-view' });
h.eq([element.width, element.height, element.name, element.orbitAzimuth, element.orbitElevation, element.orbitProjection, element.orbitFov], [384,288,'Neuron',76,24,'perspective',35], 'manifest physical size, view and name become element defaults');
h.eq([element.fill, element.modelColors, element.source?.glbPath, element.source?.sha256], ['#D14D41','source','plots/neuron.glb',sha(bytes)], 'source colors and portable original-byte provenance survive');
const unknownDefault=makeImportedModel3dElement({...prepared.data,manifest:{...manifest,view:{...manifest.view,states:{ghost:1}}}});
h.ok(!unknownDefault.modelStates,'public imported element never persists metadata-only shape names');
const plain = makeImportedModel3dElement({ ...prepared.data, manifest: undefined }, { figureWidth: 400 });
h.eq([plain.width, plain.height], [200,150], 'plain mesh defaults to half figure width and a 4:3 box');
// Review L1: bytes that do not even parse as a scene3d manifest are never
// persisted; newer or differently bound scene3d manifests are kept inactive.
for (const [text, kept] of [['not json', false], [JSON.stringify({ ...manifest, schemaVersion: '9.0.0' }), true], [JSON.stringify({ ...manifest, glbSha256: '0'.repeat(64) }), true], [JSON.stringify({ spec: 'fluxplot', schemaVersion: '0.3.0' }), false]] as const) {
  const fallback = await parseModel3dImportMetadata({ info: prepared.data.asset.model, sourceSha256: sha(bytes), manifestText: text });
  h.ok(!fallback.manifest && fallback.warnings.length > 0 && (fallback.raw?.manifest === text) === kept, `invalid, newer, mismatched and 2D metadata degrade without rejecting mesh (${kept ? 'raw scene3d kept' : 'unparsed bytes dropped'})`);
}
const badRecipe = await parseModel3dImportMetadata({ info: prepared.data.asset.model, sourceSha256: sha(bytes), recipeText: '{broken' });
h.ok(badRecipe.raw?.recipe === undefined && badRecipe.warnings.some(w => w.includes('recipe')), 'an unparseable recipe is reported and never persisted');

const mem = createMemBridge(), enc = new TextEncoder(), root = '/project';
mem._files.set(`${root}/project.json`, enc.encode(JSON.stringify({ schemaVersion: '0.1.0' })));
mem._files.set(`${root}/fig/index.json`, enc.encode(JSON.stringify({ assets: [] })));
mem._files.set(`${root}/plots/neuron.glb`, bytes);
mem._files.set(`${root}/plots/neuron.fluxplot.json`, enc.encode(metadata));
mem._files.set(`${root}/plots/neuron.recipe.json`, enc.encode(recipe));
await mem.watchRoot!(root);
const request = { root, sourcePath: `${root}/plots/neuron.glb`, target: { kind: 'figure' as const } };
const imported = await mem.importModel3d!(request);
const ownership = { root, target: request.target, assetId: imported.asset.id, receipt: imported.receipt };
h.eq(mem._files.get(`${root}/fig/${imported.asset.path}`), prepared.bytes, 'memory bridge writes native-style GLB bytes in fig/assets');
h.eq(imported.manifest, manifest, 'memory bridge returns parsed metadata separately');
h.ok(!('bytes' in imported) && !JSON.stringify(imported).includes('data:model'), 'IPC result contains metadata, never GLB bytes/data URLs');
h.eq(mem._files.get(`${root}/plots/neuron.glb`), bytes, 'source is unchanged');
await assert.rejects(() => mem.discardModel3d!({ ...ownership, receipt: 'wrong' }), /receipt/);
h.ok(mem._files.has(`${root}/fig/${imported.asset.path}`), 'wrong receipt cannot discard an asset');
await mem.adoptModel3d!(ownership);
await assert.rejects(() => mem.discardModel3d!(ownership), /adopted/);
h.ok(mem._files.has(`${root}/fig/${imported.asset.path}`), 'adopted but unsaved asset cannot be removed by stale cancellation');
const canceled = await mem.importModel3d!(request);
await mem.discardModel3d!({ ...ownership, assetId: canceled.asset.id, receipt: canceled.receipt });
h.ok(!mem._files.has(`${root}/fig/${canceled.asset.path}`), 'unadopted canceled import cleans up its owned files');
// The slide destination is a separate receipt capability and storage owner.
const deckId = 'model-deck', target = { kind: 'slide' as const, deckId };
const deckFile = `${root}/slides/${deckId}/deck.json`;
mem._files.set(`${root}/project.json`, enc.encode(JSON.stringify({ schemaVersion: '0.1.0', slides: [{ id: deckId, path: `slides/${deckId}/deck.json` }] })));
mem._files.set(deckFile, enc.encode(JSON.stringify({ id: deckId, schemaVersion: '0.6.0', slides: [], assets: [] })));
const slideImport = await mem.importModel3d!({ ...request, target });
const slideOwnership = { root, target, assetId: slideImport.asset.id, receipt: slideImport.receipt };
h.eq(slideImport.assetPrefix, `slides/${deckId}`, 'memory import returns explicit deck asset prefix');
h.eq(mem._files.get(`${root}/slides/${deckId}/${slideImport.asset.path}`), prepared.bytes, 'memory deck owns prepared model bytes outside Figure assets');
await assert.rejects(() => mem.discardModel3d!({ ...slideOwnership, target: request.target }), /receipt/);
await assert.rejects(() => mem.discardModel3d!({ ...slideOwnership, target: { kind: 'slide', deckId: 'other' } }), /receipt/);
h.ok(true, 'memory receipt cannot be replayed into Figure or a different deck');
mem._files.set(deckFile, enc.encode(JSON.stringify({ id: deckId, schemaVersion: '0.6.0', slides: [], assets: [slideImport.asset] })));
await assert.rejects(() => mem.discardModel3d!(slideOwnership), /already saved/);
h.ok(mem._files.has(`${root}/slides/${deckId}/${slideImport.asset.path}`), 'saved deck ownership protects imported GLB on cancellation');
for (const badId of ['../fig', '__proto__', 'unregistered']) await assert.rejects(() => mem.importModel3d!({ ...request, target: { kind: 'slide', deckId: badId } }), /Unsafe|registered/);
h.ok(true, 'memory slide import refuses unsafe and unregistered destinations');
for (const change of ['unregister', 'future'] as const) {
  const projectText = mem._files.get(`${root}/project.json`)!, deckText = mem._files.get(deckFile)!;
  let release!: () => void; const held = new Promise<void>(resolve => release = resolve);
  const file = { name: 'held.glb', size: bytes.length, async arrayBuffer() { await held; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } } as File;
  const pending = mem.importDroppedModel3d!(file, { root, target });
  if (change === 'unregister') mem._files.set(`${root}/project.json`, enc.encode(JSON.stringify({ schemaVersion: '0.1.0', slides: [] })));
  else mem._files.set(deckFile, enc.encode(JSON.stringify({ id: deckId, schemaVersion: '9.0.0', slides: [] })));
  const count = mem._files.size; release();
  await assert.rejects(() => pending, /registered|cannot be edited/);
  h.eq(mem._files.size, count, `held memory drop revalidates ${change} destination before publication`);
  mem._files.set(`${root}/project.json`, projectText); mem._files.set(deckFile, deckText);
}
const before = mem._files.size;
mem._files.set(`${root}/plots/bad.glb`, enc.encode('bad'));
await assert.rejects(() => mem.importModel3d!({ ...request, sourcePath: `${root}/plots/bad.glb` }), /GLB/);
h.eq(mem._files.size, before + 1, 'refused geometry publishes no assets');
const changing = mem.importModel3d!(request);
await mem.watchRoot!('/other');
await assert.rejects(() => changing, /project changed/);
h.eq(mem._files.size, before + 1, 'project switch cancels publication before any files appear');

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-import-'));
try {
  const project = path.join(scratch, 'project'), external = path.join(scratch, 'external');
  await fs.mkdir(path.join(project, 'plots'), { recursive: true });
  await fs.mkdir(path.join(project, 'fig'), { recursive: true });
  await fs.mkdir(external);
  await fs.writeFile(path.join(project, 'project.json'), JSON.stringify({ schemaVersion: '0.1.0' }));
  await fs.writeFile(path.join(project, 'fig/index.json'), JSON.stringify({ assets: [] }));
  const source = path.join(project, 'plots/neuron.glb');
  await fs.writeFile(source, bytes);
  await fs.writeFile(source.replace('.glb', '.fluxplot.json'), metadata);
  await fs.writeFile(source.replace('.glb', '.recipe.json'), recipe);
  const owned = await native.prepareModel3d({ root: project, target: request.target, sourcePath: source });
  h.eq(sha(await fs.readFile(owned.files[0])), sha(prepared.bytes), 'native and memory preparation publish identical bytes');
  h.eq(owned.result.manifest, imported.manifest, 'native and memory accepted metadata match');
  h.eq(sha(await fs.readFile(source)), sha(bytes), 'native import preserves the original source');
  h.eq(owned.files.length, 3, 'GLB and both raw sidecars are atomically published as owned files');
  await native.cleanupPreparedModel3d(owned);
  h.ok(!(await fs.readdir(path.join(project, 'fig/assets'))).length, 'native cancel removes all and only import-owned files');

  await fs.mkdir(path.join(project, `slides/${deckId}`), { recursive: true });
  await fs.writeFile(path.join(project, 'project.json'), JSON.stringify({ schemaVersion: '0.1.0', slides: [{ id: deckId, path: `slides/${deckId}/deck.json` }] }));
  const nativeDeck = path.join(project, `slides/${deckId}/deck.json`);
  await fs.writeFile(nativeDeck, JSON.stringify({ id: deckId, schemaVersion: '0.6.0', slides: [], assets: [] }));
  const slideOwned = await native.prepareModel3d({ root: project, target, sourcePath: source });
  h.eq(slideOwned.result.assetPrefix, `slides/${deckId}`, 'native import returns the same deck prefix as memory');
  h.eq(sha(await fs.readFile(slideOwned.files[0])), sha(prepared.bytes), 'native deck GLB matches shared preparation exactly');
  h.ok(slideOwned.files.every((file: string) => file.startsWith(path.join(project, `slides/${deckId}/assets/`))), 'every native model sidecar stays in its deck');
  await fs.writeFile(nativeDeck, JSON.stringify({ id: deckId, schemaVersion: '0.6.0', slides: [], assets: [slideOwned.result.asset] }));
  await assert.rejects(() => native.cleanupPreparedModel3d(slideOwned), /already saved/);
  h.ok(true, 'native cleanup reads saved deck ownership, not Figure ownership');
  await native.cleanupPreparedModel3d(slideOwned, { checkSaved: false });
  for (const badId of ['../fig', '__proto__', 'unregistered']) await assert.rejects(() => native.prepareModel3d({ root: project, target: { kind: 'slide', deckId: badId }, sourcePath: source }), /Unsafe|registered/);
  h.ok(true, 'native slide import refuses unsafe and unregistered destinations');
  await fs.writeFile(nativeDeck, JSON.stringify({ id: deckId, schemaVersion: '9.0.0', slides: [] }));
  await assert.rejects(() => native.prepareModel3d({ root: project, target, sourcePath: source }), /cannot be edited/);
  h.ok(true, 'future deck schema refuses native publication');
  await fs.writeFile(nativeDeck, JSON.stringify({ id: deckId, schemaVersion: '0.6.0', slides: [], assets: [] }));
  let removedDeck = false;
  await assert.rejects(() => native.prepareModel3d({ root: project, target, sourcePath: source, async readGuard(file: string) {
    if (!removedDeck && file === source) { removedDeck = true; await fs.writeFile(path.join(project, 'project.json'), JSON.stringify({ schemaVersion: '0.1.0', slides: [] })); }
  } }), /registered/);
  h.ok(!(await fs.readdir(path.join(project, `slides/${deckId}/assets`))).length, 'removing deck registration during preparation publishes no files');
  await fs.writeFile(path.join(project, 'project.json'), JSON.stringify({ schemaVersion: '0.1.0', slides: [{ id: deckId, path: `slides/${deckId}/deck.json` }] }));

  const sparse = path.join(project, 'plots/too-large.glb');
  h.eq(native.MAX_BYTES, GLB_LIMITS.maxBytes, 'the CommonJS import boundary uses the shared GLB byte limit');
  await fs.writeFile(sparse, ''); await fs.truncate(sparse, native.MAX_BYTES + 1);
  await assert.rejects(() => native.prepareModel3d({ root: project, target: request.target, sourcePath: sparse }), /exceeds 200 MiB/);
  h.ok(!(await fs.readdir(path.join(project, 'fig/assets'))).length, 'oversized source is refused before publication or whole-file allocation');
  let checks = 0;
  await assert.rejects(() => native.prepareModel3d({ root: project, target: request.target, sourcePath: source, checkCurrent() { if (++checks >= 6) throw Error('lease changed'); } }), /lease changed/);
  h.ok(!(await fs.readdir(path.join(project, 'fig/assets'))).length, 'cancellation between native publications removes partial owned batch');
  await fs.writeFile(path.join(external, 'other.glb'), bytes);
  await fs.symlink(path.join(external, 'other.glb'), path.join(project, 'plots/escape.glb'));
  await assert.rejects(() => native.prepareModel3d({ root: project, target: request.target, sourcePath: path.join(project, 'plots/escape.glb') }), /symlink escapes/);
  h.ok(true, 'project-relative source symlink cannot escape its project');

  const handlers = new Map<string, (...args: any[]) => any>();
  const sender = Object.assign(new EventEmitter(), { id: 17, isDestroyed: () => false });
  const e = { sender };
  let currentRoot = project, generation = 1;
  const fileCore = createFileCore({ app: { getPath: (kind: string) => path.join(scratch, `allowed-${kind}`) }, dialog: {}, shell: {}, roots: () => [project], windowFor: () => null });
  const ipc = createModel3dCore({ rootFor: () => currentRoot, generationFor: () => generation, fsReadGuard: fileCore.fsReadGuard });
  ipc.registerHandlers({ handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) });
  const call = (name: string, payload: any, event = e) => Promise.resolve().then(() => handlers.get(`model3d:${name}`)!(event, payload));
  const nativeRequest = { root: project, sourcePath: path.join(external, 'other.glb'), target: request.target };
  await assert.rejects(() => call('import', nativeRequest), /denied|outside|access/i);
  h.ok(true, 'ordinary native import enforces real per-window source authorization');
  fileCore.approveDir(sender.id, nativeRequest.sourcePath);
  const picked = await call('import', nativeRequest);
  const pickOwnership = { root: project, target: request.target, assetId: picked.asset.id, receipt: picked.receipt };
  const otherSender = Object.assign(new EventEmitter(), { id: 18, isDestroyed: () => false });
  await assert.rejects(() => call('discard', pickOwnership, { sender: otherSender }), /receipt/);
  h.ok(true, 'another window cannot use a prepared import receipt');
  const ipcSlide = await call('import', { ...nativeRequest, target });
  const ipcSlideOwnership = { root: project, target, assetId: ipcSlide.asset.id, receipt: ipcSlide.receipt };
  await assert.rejects(() => call('discard', { ...ipcSlideOwnership, target: request.target }), /receipt/);
  await assert.rejects(() => call('adopt', { ...ipcSlideOwnership, target: { kind: 'slide', deckId: 'other' } }), /receipt/);
  await call('discard', ipcSlideOwnership);
  h.ok(true, 'actual IPC receipt rejects cross-kind and cross-deck capability replay');
  await call('adopt', pickOwnership);
  await assert.rejects(() => call('discard', pickOwnership), /adopted/);
  h.ok(await fs.stat(path.join(project, 'fig', picked.asset.path)), 'native adoption protects the unsaved installed model');
  const second = await call('import', { ...nativeRequest, sourcePath: source });
  await fs.writeFile(path.join(project, 'fig/index.json'), JSON.stringify({ assets: [second.asset] }));
  await assert.rejects(() => call('discard', { ...pickOwnership, assetId: second.asset.id, receipt: second.receipt }), /already saved/);
  h.ok(true, 'saved document ownership independently blocks deletion');
  const aba = await call('import', { ...nativeRequest, sourcePath: source });
  const abaOwnership = { ...pickOwnership, assetId: aba.asset.id, receipt: aba.receipt };
  currentRoot = external; generation++; currentRoot = project; generation++;
  await assert.rejects(() => call('adopt', abaOwnership), /project changed/);
  await assert.rejects(() => call('discard', abaOwnership), /adopted/);
  h.ok(await fs.stat(path.join(project, 'fig', aba.asset.path)), 'late rejected adoption retains possibly installed files and consumes stale cleanup authority');
  h.ok(true, 'project A to B to A cannot report a successful old adoption');

  const racing = await call('import', { ...nativeRequest, sourcePath: source });
  const racingOwnership = { ...pickOwnership, assetId: racing.asset.id, receipt: racing.receipt };
  const readFile = fs.readFile;
  let release!: () => void, arrived!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  fs.readFile = (async (...args: any[]) => {
    const value = await (readFile as any)(...args);
    if (String(args[0]) === path.join(project, 'fig/index.json')) { arrived(); await pause; }
    return value;
  }) as typeof fs.readFile;
  try {
    const discarding = call('discard', racingOwnership);
    await waiting;
    await assert.rejects(() => call('adopt', racingOwnership), /canceled/);
    release(); await discarding;
    h.ok(true, 'adopt never succeeds while an earlier discard owns asynchronous deletion');
  } finally { release(); fs.readFile = readFile; }
  const partial = await call('import', { ...nativeRequest, sourcePath: source });
  const partialOwnership = { ...pickOwnership, assetId: partial.asset.id, receipt: partial.receipt };
  const remove = fs.rm;
  fs.rm = (async (file: any, ...args: any[]) => {
    if (String(file).endsWith(`${partial.asset.id}.fluxplot.json`)) throw Object.assign(Error('read only'), { code: 'EROFS' });
    return (remove as any)(file, ...args);
  }) as typeof fs.rm;
  try {
    await assert.rejects(() => call('discard', partialOwnership), /read only/);
    await assert.rejects(() => call('adopt', partialOwnership), /canceled/);
    h.ok(true, 'partial cleanup failure never restores an adoptable receipt with missing geometry');
  } finally { fs.rm = remove; }
  await call('discard', partialOwnership);
  h.ok(!(await fs.readdir(path.join(project, 'fig/assets'))).some(p => p.startsWith(partial.asset.id)), 'failed cancellation can retry cleanup safely');
  currentRoot = external; generation++;
  await assert.rejects(() => call('import', nativeRequest), /project changed/);
  h.ok(true, 'request root must still belong to the requesting window');
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
await h.done();
