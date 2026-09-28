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
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(cache.resolveModelPosters(root, [figure], [asset], { policy: 'image', signal: aborted.signal, renderBatch })); h.ok(true, 'canceled native resolve stops before work');
  await fs.mkdir('test-results/model3d/headless', { recursive: true }); await fs.writeFile('test-results/model3d/headless/figure.svg', svg);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
await h.done();
