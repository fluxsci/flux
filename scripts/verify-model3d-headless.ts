import './lib/cssStub.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { harness } from './lib/harness.mjs';
import { inspectGlb } from '../src/lib/model3d/glbCore.mjs';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { planFigSave } from '../src/lib/project/figfiles';
import { figureToSvg } from '../src/lib/export';
import { model3dSvgContext, staticModelRequest } from '../src/lib/model3d/static';
import { posterPath } from '../src/lib/model3d/poster';
import type { Project, Figure } from '../src/lib/types';
import type { Model3dAsset, Scene3dManifest } from '../src/lib/model3d/types';
const h = harness('verify-model3d-headless'), scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-m3d-headless-'));
process.env.HOME = path.join(scratch, 'home'); process.env.XDG_CONFIG_HOME = path.join(scratch, 'config'); process.env.XDG_DATA_HOME = path.join(scratch, 'data'); process.env.FLUX_NO_MIGRATE = '1';
const core = await import('../flux-core/index'), cache = await import('../flux-core/model3dPosterCache');
const root = path.join(scratch, 'project'); await core.scaffold(root, { title: '3D headless' });
const bytes = await fs.readFile('scripts/fixtures/model3d/fluxplot/continuous.glb'), manifest: Scene3dManifest = JSON.parse(await fs.readFile('scripts/fixtures/model3d/fluxplot/continuous.fluxplot.json', 'utf8'));
const asset: Model3dAsset = { id: 'model', name: 'Continuous mesh', kind: 'glb', path: 'assets/model.glb', naturalWidth: 336, naturalHeight: 252, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), model: inspectGlb(bytes) };
const element = { ...makeModel3dElement(asset, { id: 'placed-model', manifest }), name: 'Neuron poster', source: { glbPath: 'plots/original.glb', sha256: asset.sha256 }, rotation: 17, flipX: true, opacity: .6 };
const figure: Figure = { id: 'models', name: 'Models', canvasId: 'canvas', x: 0, y: 0, width: 450, height: 350, elements: [element] };
const model: Project = { version: 2, name: '3D', canvases: [{ id: 'canvas', name: 'Canvas' }], figures: [figure], assets: [asset], palette: [] };
async function writeModel() { const plan = planFigSave(model, null); for (const entry of [...plan.canvases, ...plan.captions, plan.index]) { const file = path.join(root, entry.path); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, entry.text); } }
await writeModel(); await fs.mkdir(path.join(root, 'fig/assets'), { recursive: true }); await fs.writeFile(path.join(root, 'fig', asset.path), bytes); await fs.writeFile(path.join(root, 'fig/assets/model.fluxplot.json'), JSON.stringify(manifest));
function crc(bytes: Uint8Array) { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
const pngChunk = (tag: string, data: Buffer) => { const name = Buffer.from(tag), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([name, data])), out.length - 4); return out; };
function png(w: number, height: number) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((w * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) { const at = y * (w * 4 + 1) + x * 4 + 1; rows[at] = 170; rows[at + 1] = 80; rows[at + 2] = 100; rows[at + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
async function tree(directory: string): Promise<string[]> { const out: string[] = []; for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) { const file = path.join(directory, entry.name); if (entry.isDirectory()) out.push(...await tree(file)); else out.push(`${path.relative(scratch, file)}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`); } return out.sort(); }
let batches = 0, reads = 0; const batchSizes: number[] = [];
const renderBatch: NonNullable<Parameters<typeof cache.resolveModelPosters>[3]['renderBatch']> = async (requests, options) => {
  batches++; batchSizes.push(requests.length); await fs.mkdir(options.outDir, { recursive: true });
  for (const id of new Set(requests.map(request => request.spec.assetId))) { await options.modelBytes(id); reads++; }
  const results = []; for (const request of requests) { const file = path.join(options.outDir, `${request.key}.png`), bytes = png(request.spec.w, request.spec.h); await fs.writeFile(file, bytes); results.push({ key: request.key, path: file, w: request.spec.w, h: request.spec.h, bytes: bytes.length, renderMs: 0, encodeMs: 0 }); }
  return { renderer: 'gate fixture', readyMs: 0, spawnMs: 0, totalMs: 0, results };
};
try {
  const before = await tree(scratch), cold = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'collect', renderBatch });
  h.eq(await tree(scratch), before, 'cold collect does not mkdir/write project or machine cache'); h.eq([batches, reads], [0, 0], 'cold collect does not render or read GLB bytes');
  h.ok(cold.warnings.some(w => w.includes('Neuron poster') && w.includes('poster not rendered')), 'placeholder warning names placement');
  const placeholder = figureToSvg(figure, id => cold.urls[id], undefined, undefined, { model3d: cold.context });
  h.ok(placeholder.includes('data-model3d-placeholder') && placeholder.includes('Height') && /<text\b/.test(placeholder), 'cold placeholder retains vector furniture');
  const projectBefore = await tree(root), image = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', renderBatch });
  h.eq(await tree(root), projectBefore, 'explicit image rendering writes only machine cache'); h.eq([batches, reads], [1, 1], 'explicit image uses one batched model read');
  const request = image.requests[0], posterBytes = await fs.readFile(path.join(cache.machineModelPosterDir(), `${request.key}.png`));
  h.ok(cache.validModelPosterPng(posterBytes, request) && !cache.validModelPosterPng(posterBytes, { w: 1, h: 1 }), 'cache validates full PNG and exact dimensions');
  const corrupt = Buffer.from(posterBytes); corrupt[corrupt.length - 6] ^= 1; h.ok(!cache.validModelPosterPng(corrupt, request), 'corrupt PNG CRC rejected');
  const indexedHeader = Buffer.alloc(13); indexedHeader.writeUInt32BE(1); indexedHeader.writeUInt32BE(1,4); indexedHeader[8]=8; indexedHeader[9]=3;
  const indexed = Buffer.concat([posterBytes.subarray(0,8),pngChunk('IHDR',indexedHeader),pngChunk('IDAT',deflateSync(Buffer.from([0,0]))),pngChunk('IEND',Buffer.alloc(0))]);
  h.ok(!cache.validModelPosterPng(indexed,{w:1,h:1}), 'indexed PNG without required palette is a cache miss');
  const unknownCritical = Buffer.concat([posterBytes.subarray(0,33),pngChunk('ABCD',Buffer.alloc(0)),posterBytes.subarray(33)]);
  h.ok(!cache.validModelPosterPng(unknownCritical,request), 'unknown critical PNG chunks refuse cache publication');
  const warm = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'collect', renderBatch }); h.eq([batches, reads], [1, 1], 'warm collector uses machine poster without model IO');
  const svg = await core.renderFigureSvg(root, figure.id, { model3dPolicy: 'collect' });
  h.ok(svg.includes('data:image/png;') && svg.includes('Height') && !svg.includes('model/gltf') && !svg.includes(bytes.toString('base64')), 'headless SVG contains real poster and furniture, never GLB data URL');
  h.ok(svg.includes('rotate(17') && svg.includes('scale(-1 1)') && (svg.match(/opacity="0.6"/g) ?? []).length === 1, 'static model opacity/rotation/flip apply once');
  const signatureBefore = await cache.modelPosterAvailabilitySignature(root); await fs.mkdir(path.join(root, 'fig/renders/model3d'), { recursive: true }); await fs.writeFile(path.join(root, posterPath(request.key)), posterBytes);
  h.ok(signatureBefore !== await cache.modelPosterAvailabilitySignature(root), 'Connect cache signature changes on poster publication');
  // M3: the signature covers only this project's live keys, and the LRU touch
  // on a machine-cache hit is not a publication.
  const signed = await cache.modelPosterAvailabilitySignature(root), machine = cache.machineModelPosterDir();
  await fs.mkdir(machine, { recursive: true }); await fs.writeFile(path.join(machine, 'm3d-00000000000abc.png'), posterBytes);
  h.eq(await cache.modelPosterAvailabilitySignature(root), signed, 'another project\'s machine-cache poster does not change this project\'s signature');
  const liveMachine = path.join(machine, `${request.key}.png`), touched = new Date(Date.now() - 3600_000); await fs.utimes(liveMachine, touched, touched);
  const touchedSignature = await cache.modelPosterAvailabilitySignature(root);
  await cache.resolveModelPosters(root, [figure], [asset], { policy: 'collect' });
  h.ok(Math.abs((await fs.stat(liveMachine)).mtimeMs - touched.getTime()) < 2, 'cold collection never touches the machine cache');
  await fs.rm(path.join(root, posterPath(request.key)));
  await cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', renderBatch });
  h.ok((await fs.stat(liveMachine)).mtimeMs > touched.getTime(), 'an image-request hit marks its machine poster recently used');
  await fs.writeFile(path.join(root, posterPath(request.key)), posterBytes);
  h.ok(await cache.modelPosterAvailabilitySignature(root) !== touchedSignature, 'republishing a live project poster changes the signature');
  const afterRepublish = await cache.modelPosterAvailabilitySignature(root); const now = new Date(); await fs.utimes(liveMachine, now, now);
  h.eq(await cache.modelPosterAvailabilitySignature(root), afterRepublish, 'an LRU touch alone does not invalidate Connect pictures');
  await fs.rm(path.join(machine, 'm3d-00000000000abc.png'));
  const stored = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'collect' });
  const source = await import('../src/shell/modes/paper/scholar/figures');
  source.__seedFigures([], { [figure.id]: figure }, {}, [], {}, [asset], [], { [asset.id]: manifest }, stored.urls);
  h.eq(source.renderFigureSvgForDisk(figure.id), svg, 'Paper disk and Node SVG are byte-identical with the same PNG');
  const display = source.renderFigureSvg(figure.id)!; h.ok(display.includes('pap__placed-model__') && !display.includes('id="placed-model__'), 'Paper furniture gradient IDs have separate display namespace');
  const metadataPath = path.join(root, 'fig/assets/model.fluxplot.json'), original = await fs.readFile(metadataPath, 'utf8');
  for (const content of ['{broken', JSON.stringify({ ...manifest, schemaVersion: '9.0.0' }), JSON.stringify({ ...manifest, glbSha256: 'f'.repeat(64) })]) {
    await fs.writeFile(metadataPath, content); const result = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'collect' });
    h.ok(!result.manifests[asset.id] && result.warnings.length > 0 && await fs.readFile(metadataPath, 'utf8') === content, 'invalid/newer/mismatched metadata downgrades without writes');
  }
  await fs.writeFile(metadataPath, original);
  const conflict = { ...figure, id: 'conflicting', elements: [{ ...element, source: { ...element.source, sha256: 'e'.repeat(64) } }] };
  const conflicted = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'collect', allFigures: [figure, conflict] }); h.ok(!conflicted.manifests[asset.id], 'binding sees conflicting placements outside requested figure');
  const many = { ...figure, elements: Array.from({ length: 66 }, (_, i) => ({ ...element, id: `angle-${i}`, orbitAzimuth: i + 100 })) };
  const batchBefore = batches; await cache.resolveModelPosters(root, [many], [asset], { policy: 'project', surface: 'thumbnail', renderBatch });
  h.eq(batchSizes.slice(-2), [64, 2], 'large export chunks at native 64-request boundary'); h.eq(batches - batchBefore, 2, 'batch chunking is sequential and complete');
  const duplicate = { ...figure, elements: [element, { ...element, id: 'copy' }] }, duplicateBefore = batches;
  await cache.resolveModelPosters(root, [duplicate], [asset], { policy: 'project', surface: { kind: 'raster', dpi: 150 }, renderBatch }); h.eq(batches - duplicateBefore, 1, 'duplicate placements share one native batch request'); h.eq(batchSizes.at(-1), 1, 'poster keys deduplicated before worker');
  const changed = { ...element, orbitAzimuth: 299 }, changedFigure = { ...figure, elements: [changed] }; await fs.writeFile(path.join(root, 'fig', asset.path), Buffer.from([1, 2, 3]));
  const mismatch = await cache.resolveModelPosters(root, [changedFigure], [asset], { policy: 'image', renderBatch }); h.ok(mismatch.warnings.some(w => w.includes('changed since')) && !Object.keys(mismatch.urls).length, 'native provider refuses changed prepared bytes before rendering'); await fs.writeFile(path.join(root, 'fig', asset.path), bytes);
  const modelFile = path.join(root,'fig',asset.path), oversized = 200*1024*1024+1;
  await fs.truncate(modelFile,oversized); let oversizedSpawned = false;
  const large = await cache.resolveModelPosters(root,[changedFigure],[asset],{policy:'image',renderBatch:async()=>{oversizedSpawned=true;throw Error('unexpected worker');}});
  h.ok(!oversizedSpawned && large.warnings.some(w=>w.includes('model byte limit')), 'actual oversize GLB refuses worker despite forged small asset metadata');
  await fs.writeFile(modelFile,bytes);
  const lateLarge = await cache.resolveModelPosters(root,[changedFigure],[asset],{policy:'image',renderBatch:async(_requests,options)=>{await fs.truncate(modelFile,oversized);await options.modelBytes(asset.id);throw Error('unexpected bytes');}});
  h.ok(lateLarge.warnings.some(w=>w.includes('exceeds 200 MiB')), 'opened-file size is bounded again after a delayed source grows');
  await fs.writeFile(modelFile,bytes);
  const outside = path.join(scratch,'outside.glb'); await fs.writeFile(outside,bytes); let outsideRead = false;
  const swapped = await cache.resolveModelPosters(root,[changedFigure],[asset],{policy:'image',renderBatch:async(_requests,options)=>{await fs.rm(modelFile);await fs.symlink(outside,modelFile);await options.modelBytes(asset.id);outsideRead=true;throw Error('unexpected bytes');}});
  h.ok(!outsideRead && swapped.warnings.some(w=>w.includes('escapes project root')), 'delayed model provider rechecks realpath confinement before reading substituted symlink');
  await fs.rm(modelFile);await fs.writeFile(modelFile,bytes);
  const escape = path.join(scratch, 'external.png'); await fs.writeFile(escape, posterBytes); const expected = staticModelRequest({ ...element, orbitAzimuth: 298 }, asset, manifest, 'figure'); await fs.symlink(escape, path.join(root, posterPath(expected.key)));
  const denied = await cache.resolveModelPosters(root, [{ ...figure, elements: [expected.element] }], [asset], { policy: 'collect' }); h.ok(!denied.urls[expected.ref], 'project cache symlink cannot read outside project');
  await fs.rm(path.join(root, posterPath(expected.key)));

  // H1: a missing GLB degrades to "placeholder (or cached poster) + warning";
  // it never breaks headless rendering, compile or repair of the figure.
  h.section('poster batch planning (M2) and machine cache pruning (M3)');
  const { planPosterBatches, POSTER_BATCH_LIMITS } = await import('../flux-core/model3dPosters');
  const { constants: bufferConstants } = await import('node:buffer');
  const MiB = 1024 * 1024, sizes: Record<string, number> = { a: 100 * MiB, b: 100 * MiB, c: 100 * MiB, big: 200 * MiB };
  const reqs = (models: (string | string[])[]) => models.map((m, i) => ({ i, models: Array.isArray(m) ? m : [m] }));
  const plan = (models: (string | string[])[]) => planPosterBatches(reqs(models), r => r.models, id => sizes[id]);
  h.eq(plan(['a', 'b', 'c', 'a']).batches.map(b => b.map(r => r.i)), [[0, 1], [2, 3]], 'distinct model bytes above 256 MiB start a new worker job; a shared model counts once');
  h.eq(plan(Array(66).fill('a')).batches.map(b => b.length), [64, 2], 'the 64-request page limit still applies');
  h.eq([plan([['big', 'big']]).batches.length, plan([['a', 'big']]).oversized.map(r => r.i)], [1, [0]], 'a request whose own models exceed the page cap is refused, never sent');
  h.ok(Math.ceil(POSTER_BATCH_LIMITS.maxModelBytes / 3) * 4 + 16 * MiB < bufferConstants.MAX_STRING_LENGTH, `a full batch stays below the V8 string limit (${bufferConstants.MAX_STRING_LENGTH} chars) with page headroom`);
  const sparse: Model3dAsset[] = [];
  for (const id of ['heavy-a', 'heavy-b', 'heavy-c']) { const file = path.join(root, 'fig/assets', `${id}.glb`); await fs.writeFile(file, ''); await fs.truncate(file, 150 * MiB); sparse.push({ ...asset, id, path: `assets/${id}.glb`, bytes: 150 * MiB, sha256: createHash('sha256').update(id).digest('hex') }); }
  const heavy = { ...figure, elements: sparse.map((a, i) => ({ ...element, id: `heavy-${i}`, assetId: a.id })) }, jobs: string[][] = [];
  await cache.resolveModelPosters(root, [heavy], sparse, { policy: 'image', renderBatch: async requests => { jobs.push([...new Set(requests.map(r => r.spec.assetId))]); throw Error('planned only'); } });
  h.eq(jobs, [['heavy-a'], ['heavy-b'], ['heavy-c']], 'actual stat sizes split 3 x 150 MiB models into three worker jobs');
  for (const a of sparse) await fs.rm(path.join(root, 'fig', a.path));
  const day = 86400_000, t = Date.now(), key = (name: string) => `m3d-${name.padStart(14, '0')}`, entry = (name: string, size: number, ageDays: number) => ({ name: `${key(name)}.png`, size, mtimeMs: t - ageDays * day });
  h.eq(cache.planMachinePosterPrune([entry('a1', 10, 15), entry('a2', 10, 15), entry('a3', 10, 1)], new Set([key('a2')]), t), [`${key('a1')}.png`], 'machine cache age rule: older than 14 days goes, protected keys stay');
  const big = 400 * MiB;
  h.eq(cache.planMachinePosterPrune([entry('b1', big, 3), entry('b2', big, 2), entry('b3', big, 1)], new Set([key('b1')]), t), [`${key('b2')}.png`], 'machine cache size cap evicts least recently used first, skipping protected keys');
  h.eq(cache.planMachinePosterPrune([entry('c1', 10, 1), { name: 'notes.txt', size: 5 * 1024 * MiB, mtimeMs: 0 }], new Set(), t), [], 'only m3d-*.png files count toward or fall to the prune');
  const oldMachine = path.join(machine, 'm3d-000000000000ff.png'), keepName = path.join(machine, 'keep.png');
  await fs.writeFile(oldMachine, posterBytes); await fs.writeFile(keepName, 'x'); const old = new Date(t - 20 * day); await fs.utimes(oldMachine, old, old); await fs.utimes(keepName, old, old);
  h.eq(await cache.pruneMachineModelPosters({ protect: new Set([request.key]) }), ['m3d-000000000000ff.png'], 'pruneMachineModelPosters applies the plan to <userData>/model3d-posters');
  h.ok(await fs.access(keepName).then(() => true) && await fs.access(liveMachine).then(() => true), 'unrelated files and protected live posters survive the prune');
  await fs.rm(keepName);

  h.section('missing GLB file');
  const { readFigureSnapshot } = await import('../src/lib/project/figureSnapshot');
  const snapshotIO = { readText: async (rel: string) => fs.readFile(path.join(root, rel), 'utf8').catch(() => null), assetExists: async (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false), listDirectory: async () => null };
  model.figures.push({ id: 'plain', name: 'Plain', canvasId: 'canvas', x: 520, y: 0, width: 200, height: 120, elements: [] });
  model.assets.push({ ...asset, id: 'orphan', path: 'assets/orphan.glb' });
  await writeModel(); await fs.rm(modelFile);
  const missingSnapshot = await readFigureSnapshot(snapshotIO);
  h.eq(missingSnapshot.status, 'complete', 'a missing placed GLB leaves the figure model complete (repairable)');
  h.ok(missingSnapshot.assetIssues.length === 1 && missingSnapshot.assetIssues[0].message.includes('fig/assets/model.glb') && missingSnapshot.assetIssues[0].message.includes('placed-model') && missingSnapshot.assetIssues[0].message.includes('models') && /restore .* or delete the element/.test(missingSnapshot.assetIssues[0].message), 'the snapshot names file, element and figure with the repair');
  h.ok(!missingSnapshot.assetIssues.some(issue => issue.assetId === 'orphan') && !missingSnapshot.diagnostics.length, 'a missing GLB that no element places is not flagged');
  const noSpawn: typeof renderBatch = async () => { throw Error('rendered a missing model'); };
  const servedMissing = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', renderBatch: noSpawn });
  h.ok(servedMissing.urls[request.ref]?.startsWith('data:image/png;') && servedMissing.warnings.some(w => w.includes('fig/assets/model.glb is missing') && w.includes('cached poster')), 'a cached poster is still served by key when its GLB is missing, with a warning');
  const uncached = { ...figure, elements: [{ ...element, orbitAzimuth: 297 }] };
  const placeholderMissing = await cache.resolveModelPosters(root, [uncached], [asset], { policy: 'project', renderBatch: noSpawn });
  h.ok(!Object.keys(placeholderMissing.urls).length && placeholderMissing.warnings.some(w => w.includes('is missing') && w.includes('placeholder')) && !placeholderMissing.warnings.some(w => w.includes('rendered a missing model')), 'an uncached view of a missing GLB is a named placeholder; no worker is spawned');
  const bare = { ...asset, model: undefined } as unknown as Model3dAsset;
  const noMetadata = await cache.resolveModelPosters(root, [figure], [bare], { policy: 'image', renderBatch: noSpawn });
  h.ok(noMetadata.warnings.some(w => w.includes('missing model metadata') && w.includes('Neuron poster')) && figureToSvg(figure, id => noMetadata.urls[id], undefined, undefined, { model3d: noMetadata.context }).includes('data-model3d-placeholder'), 'missing model metadata is a per-placement warning and placeholder, not a thrown read');
  const figureWarnings: string[] = [], missingSvg = await core.renderFigureSvg(root, figure.id, { model3dPolicy: 'image', warnings: figureWarnings });
  h.ok(missingSvg.includes('data:image/png;') && figureWarnings.some(w => w.includes('is missing')), 'render-figure succeeds with the cached poster and names the missing file');
  const canvasWarnings: string[] = [], missingCanvas = await core.renderCanvasSvg(root, 'canvas', { model3dPolicy: 'image', warnings: canvasWarnings });
  h.ok(missingCanvas.svg.includes('<svg x="520" y="0"') && missingCanvas.svg.includes('data:image/png;') && canvasWarnings.some(w => w.includes('is missing')) && !missingCanvas.svg.includes('data-figure-error'), 'render-canvas renders every figure despite the missing model');
  const materialized = await core.materializeRenders(root);
  h.ok(materialized.wrote === 2 && !materialized.failed.length && materialized.warnings.some(w => w.includes('is missing')), 'compile materialization writes every figure and warns about the missing model');
  const { connect } = await import('../flux-core/connect/index'), { detectAgentIdentity } = await import('../flux-core/agentIdentity');
  const pack = await connect({ target: root, identity: detectAgentIdentity({}) });
  h.ok(pack.images.length > 0 && pack.problems.some(p => p.includes('is missing')), 'connect still produces overview images and reports the missing model as a project problem');
  await core.deleteElements(root, [element.id]);
  const repaired = await core.loadFigModel(root);
  h.ok(!repaired.project.figures.flatMap(f => f.elements).some(e => e.id === element.id), 'delete-element removes the broken placement headlessly');
  const repairedWarnings: string[] = []; await core.renderFigureSvg(root, figure.id, { model3dPolicy: 'image', warnings: repairedWarnings });
  h.eq(repairedWarnings.filter(w => w.includes('3D')), [], 'after deleting the placement the figure renders without 3D warnings');
  await fs.writeFile(modelFile, bytes);
  model.assets.push({ id: 'missing-image', name: 'Missing image', kind: 'png', path: 'assets/missing-image.png', naturalWidth: 10, naturalHeight: 10 });
  model.figures.push({ id: 'broken', name: 'Broken', canvasId: 'canvas', x: 800, y: 0, width: 100, height: 100, elements: [{ id: 'broken-image', type: 'image', assetId: 'missing-image', x: 0, y: 0, width: 10, height: 10, rotation: 0 } as unknown as Figure['elements'][number]] });
  await writeModel();
  const brokenWarnings: string[] = [], brokenCanvas = await core.renderCanvasSvg(root, 'canvas', { model3dPolicy: 'collect', warnings: brokenWarnings });
  h.ok(brokenCanvas.svg.includes('data-figure-error="broken"') && brokenWarnings.some(w => w.includes('figure "broken"')) && brokenCanvas.svg.includes('<svg x="520" y="0"'), 'one unrenderable figure becomes a named error frame; the rest of the canvas still renders');

  // A custom nested GLB path keeps its sidecars in the canonical fig/assets
  // (every GUI and Node reader looks there). The CLI/Connect poster path read
  // the GLB's own folder instead: furniture/fields/states went missing and its
  // poster keys disagreed with the app's.
  h.eq([cache.modelSidecarDirectory('fig', 'assets/models/deep/x.glb'), cache.modelSidecarDirectory('slides/talk', 'assets/sub/x.glb'), cache.modelSidecarDirectory('', 'slides/talk/assets/sub/x.glb'), cache.modelSidecarDirectory('', 'fig/assets/models/x.glb')],
    ['fig/assets', 'slides/talk/assets', 'slides/talk/assets', 'fig/assets'], 'sidecar folder is the owning document\'s assets folder, whatever the GLB nesting');
  const nested: Model3dAsset = { ...asset, id: 'nested', path: 'assets/models/deep/nested.glb' }, nestedElement = { ...element, id: 'nested-view', assetId: 'nested' };
  await fs.mkdir(path.join(root, 'fig/assets/models/deep'), { recursive: true }); await fs.writeFile(path.join(root, 'fig', nested.path), bytes);
  await fs.writeFile(path.join(root, 'fig/assets/nested.fluxplot.json'), JSON.stringify(manifest));
  const nestedResolved = await cache.resolveModelPosters(root, [{ ...figure, elements: [nestedElement] }], [nested], { policy: 'collect' });
  h.eq(nestedResolved.manifests.nested, manifest, 'nested GLB: the poster path reads its canonical sidecar');
  h.eq(nestedResolved.requests[0]?.key, staticModelRequest(nestedElement, nested, manifest, 'figure').key, 'nested GLB: CLI/Connect poster keys match the app composition');
  // A slide step's part visibility is a poster input: it joins the key and the
  // Node render spec, and a still whose part state cannot be rendered never
  // borrows another state's poster.
  {
    const hiddenField = () => ({ 'height.field': { opacity: 0, visible: false } });
    const specs: unknown[] = [], capture: typeof renderBatch = async (requests, options) => { specs.push(...requests.map(r => r.spec.partOpacity)); return renderBatch(requests, options); };
    const stepped = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', renderBatch: capture, partStates: hiddenField });
    const design = staticModelRequest(element, asset, manifest, 'figure');
    h.ok(stepped.requests[0].key !== design.key && stepped.requests[0].key === staticModelRequest(element, asset, manifest, 'figure', { 'height.field': 0 }).key, 'a hidden-at-step part gives the poster a distinct key');
    h.eq(specs, [{ 'height.field': 0 }], 'the Node render spec carries the part factor');
    const refuse: typeof renderBatch = async () => { throw Error('worker unavailable'); };
    const fallback = await cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', surface: { kind: 'raster', dpi: 150 }, renderBatch: refuse, partStates: () => ({ 'height.field': { opacity: .5, visible: true } }) });
    h.ok(!Object.keys(fallback.urls).length && !fallback.warnings.some(w => w.includes('using the stored poster')), 'an unrenderable part state never falls back to a poster of another part state');
  }
  // End to end through the CLI deck gather and the actual headless worker: a
  // mesh part that appears at step 1 is absent from the step-0 still.
  {
    const { createDeck, addSlide, addBeat } = await import('../src/lib/slide/ops');
    const { payloadModelContext } = await import('../src/lib/slide/export/model3dPayloadHost');
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const partBytes = await fs.readFile('scripts/fixtures/model3d/fluxplot/morph-a.glb'), partManifest: Scene3dManifest = JSON.parse(await fs.readFile('scripts/fixtures/model3d/fluxplot/morph-a.fluxplot.json', 'utf8'));
    const partAsset: Model3dAsset = { id: 'parts', name: 'Parts', kind: 'glb', path: 'assets/parts.glb', naturalWidth: 336, naturalHeight: 252, bytes: partBytes.length, sha256: createHash('sha256').update(partBytes).digest('hex'), model: inspectGlb(partBytes) };
    const deck = createDeck({ withTitleSlide: false }); deck.id = 'parts-deck'; deck.assets = [partAsset];
    const slide = addSlide(deck);
    slide.elements.push({ ...makeModel3dElement(partAsset, { id: 'part-view', manifest: partManifest }), x: 40, y: 30, width: 336, height: 252, orbitAzimuth: 0, orbitElevation: 0, modelLighting: 'unlit' });
    addBeat(deck, slide.id)!.tracks.push({ id: 'left-in', target: 'part-view', part: 'cortex.left', preset: 'fade', duration: 400 });
    const assetsDir = path.join(root, 'slides', deck.id, 'assets'); await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, 'parts.glb'), partBytes); await fs.writeFile(path.join(assetsDir, 'parts.fluxplot.json'), JSON.stringify(partManifest));
    await core.saveDeck(root, deck);
    const saved = (await core.loadDeck(root, deck.id)).slides[0].elements[0] as typeof element;
    const gathered = await core.gatherDeckPayload(root, deck.id, undefined, { refreshSources: false });
    const hiddenRef = staticModelRequest(saved, partAsset, partManifest, 'slide', { 'cortex.left': 0 }).ref, designRef = staticModelRequest(saved, partAsset, partManifest, 'slide').ref;
    const stepZero = gathered.payload.assets?.[hiddenRef], stepOne = gathered.payload.assets?.[designRef];
    h.ok(hiddenRef !== designRef && !!stepZero?.startsWith('data:image/png;') && !!stepOne?.startsWith('data:image/png;'), `the CLI deck gather renders a step-0 still (hidden part) and a step-1 still under distinct keys (${gathered.warnings.join('; ') || 'no warnings'})`);
    const decode = async (url: string) => { const image = await loadImage(Buffer.from(url.split(',')[1], 'base64')), c = createCanvas(image.width, image.height), g = c.getContext('2d'); g.drawImage(image, 0, 0); return { w: image.width, h: image.height, data: g.getImageData(0, 0, image.width, image.height).data }; };
    const coverage = (p: Awaited<ReturnType<typeof decode>>, from: number, to: number) => { let n = 0; for (let y = 0; y < p.h; y++) for (let x = Math.floor(p.w * from); x < Math.floor(p.w * to); x++) if (p.data[(y * p.w + x) * 4 + 3] > 10) n++; return n; };
    const [zero, one] = [await decode(stepZero!), await decode(stepOne!)];
    h.ok(coverage(one, 0, .45) > 500 && coverage(zero, 0, .45) < coverage(one, 0, .45) * .02 && Math.abs(coverage(zero, .55, 1) - coverage(one, .55, 1)) < coverage(one, .55, 1) * .02,
      `the hidden left mesh part is absent from the actual headless step-0 still (left ${coverage(zero, 0, .45)} vs ${coverage(one, 0, .45)} px; right ${coverage(zero, .55, 1)} vs ${coverage(one, .55, 1)})`);
    const authored = await cache.resolveModelPosters(root, [{ ...figure, elements: [{ ...saved, overrides: { 'cortex.left': { hidden: true } } }] }], [{ ...partAsset, path: `slides/${deck.id}/assets/parts.glb` }], { policy: 'image', surface: 'slide', assetPrefix: '', manifests: { parts: partManifest } });
    const reference = await decode(Object.values(authored.urls)[0]!);
    let max = 0; for (let i = 0; i < reference.data.length; i++) max = Math.max(max, Math.abs(reference.data[i] - zero.data[i]));
    h.ok(reference.w === zero.w && max <= 2, `the step-0 still matches an actual render with that part hidden (max channel difference ${max})`);
    const offline = payloadModelContext(gathered.payload);
    h.ok(offline.modelPoster(saved, { 'cortex.left': 0 }) === stepZero && offline.modelPoster(saved) === stepOne, 'offline-HTML pre-ready posters find the still of the step\'s part state');
  }
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', signal: aborted.signal, renderBatch })); h.ok(true, 'canceled native resolve stops before work');
  await fs.mkdir('test-results/model3d/headless', { recursive: true }); await fs.writeFile('test-results/model3d/headless/figure.svg', svg);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
await h.done();
