import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { DOMParser } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { createDeck, addSlide } from '../src/lib/slide/ops';
import { inspectGlb } from '../src/lib/model3d/glbCore.mjs';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { createSlideRepository } from '../src/lib/slide/embedRepository';
import { createPreviewModelBridge } from '../src/lib/slide/previewModelBridge';
import { embedKey } from '../src/lib/slide/embed';
import { createServiceHost } from '../src/lib/model3d/serviceHost';
import { shareEmbedModels, restoreEmbedModels } from '../src/lib/slide/embedModels';
import { prepareSlideDocument } from '../src/lib/slide/embedDocument';
import { slideQuartoTransform } from '../src/lib/slide/embedQuarto';
import { prepareExport } from '../src/lib/exportPrep';
import type { Model3dAsset } from '../src/lib/model3d/types';
const h = harness('verify-model3d-embed');
execFileSync(process.execPath, ['scripts/gen-slide-embed-assets.mjs'], { stdio: 'pipe' });
Object.assign(globalThis, { DOMParser });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-embed-'));
const bytes = await fs.readFile('scripts/fixtures/model3d/fluxplot/named-parts.glb');
const asset: Model3dAsset = { id: 'neuron', name: 'Neuron', kind: 'glb', path: 'assets/neuron.glb', naturalWidth: 400, naturalHeight: 300, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), model: inspectGlb(bytes) };
const deck = createDeck({ id: 'models', withTitleSlide: false });
deck.assets = [asset];
for (const id of ['front', 'side']) { const s = addSlide(deck); s.id = id; s.elements = [makeModel3dElement(asset, { id: `${id}-mesh` })]; }
let binaryReads = 0, permitBytes = false;
const io = { modelData: 'omit' as const,
  readText: (p: string) => fs.readFile(p, 'utf8'),
  readFile: async (p: string) => { if (p.endsWith('.glb')) { binaryReads++; assert.ok(permitBytes, 'live repository may not read GLB bytes'); } return fs.readFile(p); },
  writeText: async (p: string, text: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, text); },
  mkdir: async (p: string) => { await fs.mkdir(p, { recursive: true }); },
  exists: async (p: string) => fs.access(p).then(() => true, () => false),
  modelPoster: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
};
const ref = (id: string) => `![](../slides/models/renders/${id}-step-0.svg){#embed-${id} .flux-slide deck="models" slide="${id}"}`;
try {
  await io.writeText(`${root}/project.json`, JSON.stringify({ schemaVersion: '0.1.0', slides: [{ id: deck.id, path: 'slides/models/deck.json' }] }));
  await io.writeText(`${root}/slides/models/deck.json`, JSON.stringify(deck));
  await fs.mkdir(`${root}/slides/models/assets`, { recursive: true }); await fs.writeFile(`${root}/slides/models/assets/neuron.glb`, bytes);
  await fs.copyFile('scripts/fixtures/model3d/fluxplot/named-parts.fluxplot.json', `${root}/slides/models/assets/neuron.fluxplot.json`);
  const repo = createSlideRepository(root, io), first = await repo.load({ deck: deck.id, slide: 'front' });
  const otherRepo = createSlideRepository(root, io), other = await otherRepo.load({ deck: deck.id, slide: 'front' });
  h.ok(first.modelSource?.scope !== other.modelSource?.scope, 'independent repository owners have distinct source lifetimes');
  otherRepo.dispose(); h.ok(first.modelSource?.isCurrent(), 'disposing another repository preserves this live model source');

  h.eq(binaryReads, 0, 'live Paper repository loads only model metadata and poster');
  h.eq(first.payload.models, {}, 'live model bytes never enter serialized widget payload');
  h.eq(first.modelSource?.assets[0].path, 'slides/models/assets/neuron.glb', 'live host receives explicit immutable deck-owned path');
  repo.invalidate(); const next = await repo.load({ deck: deck.id, slide: 'front' });
  h.ok(!first.modelSource?.isCurrent() && next.modelSource?.isCurrent(), 'same-root invalidation retires old file ownership without reusing stale snapshot');
  permitBytes = true;
  const a = await repo.materialize({ deck: deck.id, slide: 'front' }, { portable: true });
  const b = await repo.materialize({ deck: deck.id, slide: 'side' }, { portable: true });
  h.eq(a.payload.models?.neuron, bytes.toString('base64'), 'portable materialization explicitly gathers exact GLB bytes');
  const shared = shareEmbedModels({ a: a.payload, b: b.payload });
  h.eq(Object.keys(shared.models), ['neuron'], 'different slide payloads share one asset-id byte table');
  h.ok(!('models' in shared.payloads.a) && !('models' in shared.payloads.b), 'per-slide records hold references instead of duplicate bytes');
  h.eq(restoreEmbedModels(shared.payloads.b, shared.models).models, a.payload.models, 'offline hydration restores exact model bytes');
  assert.throws(() => shareEmbedModels({ a: a.payload, collision: { ...b.payload, models: { neuron: 'different' } } }), /different bytes/);
  assert.throws(() => restoreEmbedModels(shared.payloads.a, {}), /Missing included/);
  h.ok(true, 'colliding model identities and missing shared bytes fail closed');
  const built = await prepareSlideDocument(`${ref('front')}\n\n${ref('side')}`, repo, { interactive: true, strict: true });
  const data = JSON.parse(/id="flux-slide-data">(.*?)<\/script>/s.exec(built.tail)![1]);
  h.eq(Object.keys(data.models), ['neuron'], 'real document serializer emits one GLB table across slides');
  h.eq(built.tail.split(bytes.toString('base64')).length - 1, 1, 'portable HTML includes the actual GLB bytes exactly once');
  const generated = JSON.parse(await fs.readFile('.generated/slide-embed-assets.json', 'utf8'));
  const modelGenerated = JSON.parse(await fs.readFile('.generated/slide-embed-model3d-assets.json', 'utf8'));
  h.ok(!Object.hasOwn(generated, 'model3dRuntime') && !JSON.stringify(generated).includes(modelGenerated.runtime), 'fonts and ordinary slide assets contain no model runtime bytes');
  h.ok(built.tail.includes(modelGenerated.runtime), '3D document includes the conditional renderer IIFE');
  h.eq(generated.model3dCsp, `'sha256-${createHash('sha256').update(modelGenerated.runtime).digest('base64')}'`, 'conditional runtime has its own exact generated CSP hash');
  const adapter = path.join(root, 'isolated', 'dist', 'embed-adapter.mjs');
  await build({ entryPoints: ['flux-core/slideEmbedAssets.ts'], outfile: adapter, bundle: true, platform: 'node', format: 'esm', external: ['esbuild'], logLevel: 'silent' });
  const sidecar = path.join(path.dirname(adapter), 'slide-export-assets.json');
  const packaged = { runtime: 'unused deck runtime', embed: generated, model3dRuntime: modelGenerated.runtime };
  await fs.writeFile(sidecar, JSON.stringify(packaged));
  const probe = path.join(path.dirname(adapter), 'probe.mjs');
  await fs.writeFile(probe, `import {loadEmbedAssets,loadEmbedModelRuntime} from './embed-adapter.mjs';import {createHash} from 'node:crypto';const a=await loadEmbedAssets();const m=await loadEmbedModelRuntime();console.log(JSON.stringify({runtime:createHash('sha256').update(a.runtime).digest('hex'),model:createHash('sha256').update(m).digest('hex'),fonts:a.fonts}));`);
  const probeOptions = { encoding: 'utf8' as const, cwd: root, env: { ...process.env, FLUX_EXPORT_SIDECAR: sidecar, NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const actual = JSON.parse(execFileSync(process.execPath, [probe], probeOptions));
  h.eq(actual, { runtime: createHash('sha256').update(generated.runtime).digest('hex'), model: createHash('sha256').update(modelGenerated.runtime).digest('hex'), fonts: generated.fonts }, 'isolated Node adapter loads exact Paper/model runtimes and fonts solely from shipped sidecar');
  for (const [missing, message] of [['embed', 'Paper slide runtime is missing'], ['model3dRuntime', '3D runtime is missing']] as const) {
    const old: Record<string, unknown> = { ...packaged }; delete old[missing]; await fs.writeFile(sidecar, JSON.stringify(old));
    let error = ''; try { execFileSync(process.execPath, [probe], probeOptions); } catch (e) { error = String((e as { stderr?: unknown }).stderr); }
    h.ok(error.includes(message) && error.includes('Rebuild Flux'), `isolated Node adapter rejects an old sidecar without ${missing} with a rebuild instruction`);
  }
  const plain = structuredClone(a.payload); plain.deck.slides[0].elements = []; plain.deck.assets = []; delete plain.models;
  const plainRepo = { materialize: async () => ({ ...a, payload: plain, modelSource: undefined }) } as unknown as typeof repo;
  const empty = await prepareSlideDocument(ref('front'), plainRepo, { interactive: true, strict: true });
  h.ok(!empty.tail.includes(modelGenerated.runtime), '2D-only document carries no model runtime');
  const still = await prepareSlideDocument(ref('front'), repo, { interactive: false, strict: true });
  h.ok(!still.tail && still.blocks[0].html.includes('flux-slide-poster'), 'static Word/PDF route retains the step-zero poster without scripts');
  // The live Paper preview (interactive + live, not strict) re-renders ~160 ms
  // after every edit. Superseded contract (28f862dc cached portable bytes per
  // slide; each render still serialized them, the iframe re-parsed them, and
  // the cache kept a deleted model): the preview now carries model metadata
  // only and draws through the parent's worker over the preview model bridge.
  const previewRepo = createSlideRepository(root, io), preview = `${ref('front')}\n\n${ref('side')}`;
  const render = () => prepareSlideDocument(preview, previewRepo, { interactive: true, live: true });
  const dataOf = (tail: string) => JSON.parse(/id="flux-slide-data">(.*?)<\/script>/s.exec(tail)![1]);
  const readsAtStart = binaryReads, reads = () => binaryReads - readsAtStart;
  const firstPreview = await render(), firstData = dataOf(firstPreview.tail);
  h.eq(reads(), 0, 'the live preview reads no GLB bytes');
  h.ok(firstData.modelBridge === true && !Object.keys(firstData.models ?? {}).length && !Object.values(firstData.payloads as Record<string, any>).some(p => p.modelIds?.length), 'the live preview document carries model metadata only and asks for the bridge');
  h.ok(!firstPreview.tail.includes(bytes.subarray(0, 3072).toString('base64')) && !firstPreview.tail.includes(modelGenerated.runtime), 'no GLB bytes and no model runtime ride in the preview document');
  h.eq([...firstPreview.bridged].sort(), [embedKey({ deck: deck.id, slide: 'front' }), embedKey({ deck: deck.id, slide: 'side' })].sort(), 'both model slides are served over the bridge');
  for (let i = 0; i < 3; i++) await render();
  h.eq((await render()).tail, firstPreview.tail, 'repeated preview renders are byte-identical');
  h.eq(reads(), 0, 'repeated preview renders read no GLB bytes');
  previewRepo.invalidate(); const invalidated = await render();
  h.ok(invalidated.tail !== firstPreview.tail && reads() === 0, 'an invalidation changes the preview document (its bridged models re-mount and re-check their files) without reading GLB bytes');
  const turned = structuredClone(deck); (turned.slides[0].elements[0] as { orbitAzimuth: number }).orbitAzimuth += 30;
  await io.writeText(`${root}/slides/models/deck.json`, JSON.stringify(turned)); previewRepo.invalidate();
  const changedPreview = dataOf((await render()).tail), front = Object.values(changedPreview.payloads as Record<string, any>).find(p => p.deck.slides[0].id === 'front');
  h.ok(reads() === 0 && front.deck.slides[0].elements[0].orbitAzimuth === turned.slides[0].elements[0].orbitAzimuth, 'a changed slide re-renders from metadata alone');
  const strictBefore = binaryReads; await prepareSlideDocument(preview, previewRepo, { interactive: true, strict: true });
  h.eq(binaryReads - strictBefore, 2, 'strict exports gather and validate fresh GLB bytes every time');

  h.section('preview model bridge (parent half)');
  {
    const listeners = new Set<(event: Event) => void>(), posted: { message: any; transfer?: Transferable[] }[] = [];
    const target = { addEventListener: (_: string, fn: (event: Event) => void) => { listeners.add(fn); }, removeEventListener: (_: string, fn: (event: Event) => void) => { listeners.delete(fn); } };
    const frame = { postMessage: (message: unknown, _origin: string, transfer?: Transferable[]) => { posted.push({ message, transfer }); } } as unknown as Window;
    const stranger = { postMessage() {} } as unknown as Window;
    let closed = 0;
    const served: { snapshot: any; disposed: boolean; retains: string[]; releases: string[]; renders: { spec: any; options: any }[] }[] = [];
    // A worker stand-in with the real backend's file contract: every NEW hold
    // re-checks the snapshot's model file exists.
    const serve = (snapshot: any) => {
      const record = { snapshot, disposed: false, retains: [] as string[], releases: [] as string[], renders: [] as { spec: any; options: any }[] }; served.push(record);
      return { backend: {
        retain: async (asset: any) => { const id = typeof asset === 'string' ? asset : asset.id; record.retains.push(id); const meta = snapshot.modelSource.assets.find((a: any) => a.id === id);
          if (!await io.exists(`${root}/${meta.path}`)) throw new Error(`3D model file missing: ${meta.name}`); return { ...meta.model, bytes: meta.bytes, parseMs: 0 }; },
        release: (id: string) => { record.releases.push(id); },
        renderBitmap: (spec: any, options: any) => { record.renders.push({ spec, options }); return options?.lane === 'idle' && spec.w === 7 ? new Promise<ImageBitmap>((_r, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) : Promise.resolve({ close() { closed++; } } as unknown as ImageBitmap); },
      } as any, dispose() { record.disposed = true; } };
    };
    const bridgeRepo = createSlideRepository(root, io);
    const bridge = createPreviewModelBridge({ repository: bridgeRepo, frame: () => frame, serve, target });
    const frontKey = embedKey({ deck: deck.id, slide: 'front' }), sideKey = embedKey({ deck: deck.id, slide: 'side' });
    const send = (data: Record<string, unknown>, source: Window = frame) => { for (const fn of listeners) fn({ source, data } as unknown as Event); };
    const replyTo = async (call: number) => { for (let i = 0; i < 200; i++) { const found = posted.find(p => p.message.fluxModel3dReply === call); if (found) return found; await new Promise(r => setTimeout(r, 1)); } return undefined; };
    let call = 0;
    const ask = async (body: Record<string, unknown>, doc = 'doc-1') => { const id = ++call; send({ fluxModel3d: body.op, doc, call: id, ...body }); return replyTo(id); };
    const spec = (extra: Record<string, unknown> = {}) => ({ assetId: 'neuron', element: deck.slides[0].elements[0], w: 120, h: 80, manifest: { forged: true }, ...extra });
    bridge.keep([frontKey, sideKey]);
    send({ fluxModel3d: 'hello', doc: 'doc-1' });
    const retained = await ask({ op: 'retain', source: frontKey, id: 'neuron' });
    h.ok(retained?.message.ok === true && retained.message.value.bytes === asset.bytes && retained.message.doc === 'doc-1', 'the owning preview document retains a slide model through the worker backend');
    const strangerCall = ++call; send({ fluxModel3d: 'retain', doc: 'doc-1', call: strangerCall, source: frontKey, id: 'neuron' }, stranger);
    h.eq(await replyTo(strangerCall), undefined, 'messages from any other window are ignored');
    const outside = await ask({ op: 'retain', source: embedKey({ deck: deck.id, slide: 'hidden' }), id: 'neuron' });
    h.ok(outside?.message.ok === false && /not part of the current preview/.test(outside.message.error), 'a slide outside the latest render is refused');
    const foreign = await ask({ op: 'render', source: frontKey, spec: spec({ assetId: 'elsewhere' }) });
    const huge = await ask({ op: 'render', source: frontKey, spec: spec({ w: 100000 }) });
    h.ok(foreign?.message.ok === false && huge?.message.ok === false && /Invalid 3D render request/.test(foreign.message.error + huge.message.error), 'foreign model identities and unbounded sizes are refused');
    const frame1 = await ask({ op: 'render', source: frontKey, spec: spec(), channel: 'model3d-view-1', lane: 'interactive' });
    const rendered = served[0].renders.at(-1)!;
    h.ok(frame1?.message.ok === true && frame1.transfer?.[0] === frame1.message.value, 'a render replies with the transferred bitmap');
    h.ok(!rendered.spec.manifest?.forged && rendered.options.channel === 'paper-preview:doc-1:model3d-view-1' && rendered.options.signal instanceof AbortSignal, 'manifests come from the parent snapshot and channels are scoped to the document');
    h.eq(served.length, 1, 'retains and renders of one slide share one worker backend');
    const slowCall = ++call; send({ fluxModel3d: 'render', doc: 'doc-1', call: slowCall, source: frontKey, spec: spec({ w: 7 }), lane: 'idle' });
    for (let i = 0; i < 100 && !served[0].renders.some(r => r.spec.w === 7); i++) await new Promise(r => setTimeout(r, 1));
    send({ fluxModel3d: 'hello', doc: 'doc-2' });
    h.ok(served[0].renders.find(r => r.spec.w === 7)!.options.signal.aborted, 'a new preview document aborts the replaced document\'s in-flight renders');
    h.eq(await ask({ op: 'retain', source: frontKey, id: 'neuron' }, 'doc-1'), undefined, 'the replaced document can no longer call');
    h.ok((await ask({ op: 'retain', source: frontKey, id: 'neuron' }, 'doc-2'))?.message.ok === true && served.length === 1 && served[0].retains.length === 1, 'the next document reuses the resident worker hold (no geometry reload per edit)');
    await fs.rename(`${root}/slides/models/assets/neuron.glb`, `${root}/neuron.glb.away`);
    bridgeRepo.invalidate();
    const gone = await ask({ op: 'retain', source: frontKey, id: 'neuron' }, 'doc-2');
    h.ok(served[0].disposed && served.length === 2 && gone?.message.ok === false && /3D model file missing/.test(gone.message.error), 'after an invalidation a deleted GLB is re-checked and refused (no cached copy outlives the file)');
    await fs.rename(`${root}/neuron.glb.away`, `${root}/slides/models/assets/neuron.glb`);
    h.ok((await ask({ op: 'retain', source: frontKey, id: 'neuron' }, 'doc-2'))?.message.ok === true, 'a restored file renders again');
    h.ok((await ask({ op: 'retain', source: sideKey, id: 'neuron' }, 'doc-2'))?.message.ok === true && served.length === 3, 'each rendered slide gets its own worker backend');
    bridgeRepo.invalidate(); bridge.keep([frontKey, sideKey]); await new Promise(r => setTimeout(r, 1));
    h.ok(served[1].disposed && served[2].disposed, 'keeping the rendered set drops the holds of a retired repository generation');
    h.ok((await ask({ op: 'retain', source: frontKey, id: 'neuron' }, 'doc-2'))?.message.ok === true && served.length === 4, 'the current generation retains afresh');
    bridge.keep([sideKey]); await new Promise(r => setTimeout(r, 1));
    h.ok(served[3].disposed, 'a slide that leaves the rendered set releases its worker backend');
    bridge.dispose(); h.eq(listeners.size, 0, 'disposing the bridge stops listening');
    bridgeRepo.dispose();
  }
  previewRepo.dispose(); await io.writeText(`${root}/slides/models/deck.json`, JSON.stringify(deck));
  const entry = `${root}/paper/report.qmd`, include = `${root}/paper/detail.qmd`;
  const before = `# Results\n\n${ref('front')}\n\n{{< include detail.qmd >}}\n`, detail = `${ref('side')}\n`;
  await io.writeText(entry, before); await io.writeText(include, detail);
  const prepared = await prepareExport(io, { entry, ctx: { captions: new Map(), figures: new Map() }, ...slideQuartoTransform(root, repo, true) });
  const output = await io.readText(entry), fragment = await io.readText(include);
  h.eq((output + fragment).split(bytes.toString('base64')).length - 1, 1, 'actual Quarto include preparation deduplicates GLB bytes globally');
  h.eq((output + fragment).split(modelGenerated.runtime).length - 1, 1, 'Quarto includes get exactly one conditional renderer');
  await prepared.restore(); h.eq([await io.readText(entry), await io.readText(include)], [before, detail], 'Quarto restoration preserves all source bytes');
  repo.dispose(); h.ok(!next.modelSource?.isCurrent(), 'repository disposal retires every live model source');
  let resolveLoad!: (value: any) => void, releases = 0, renders = 0, closes = 0;
  const loading = new Promise<any>(resolve => { resolveLoad = resolve; });
  const host = createServiceHost({ retain: () => loading, release: () => { releases++; }, renderBitmap: async () => { renders++; return { close: () => { closes++; } } as ImageBitmap; } });
  const warm = { assetId: asset.id, element: deck.slides[0].elements[0] as any, w: 80, h: 60 };
  const firstReady = host.ready([asset.id], [warm]), secondReady = host.ready([asset.id]);
  await Promise.resolve(); h.eq(renders, 0, 'service host never warms a model before its bytes are ready');
  resolveLoad({ ...asset.model, parseMs: 0 }); await Promise.all([firstReady, secondReady]);
  h.eq([renders, closes], [1, 1], 'worker warmup completes once and closes its transferred bitmap');
  host.dispose(); h.eq(releases, 1, 'concurrent readiness balances one retained geometry');
  const blocked = createServiceHost({ retain: () => new Promise(() => {}), release: () => {}, renderBitmap: async () => { throw new Error('unreachable'); } });
  const waiting = blocked.ready([asset.id]); blocked.dispose();
  await assert.rejects(waiting, /disposed/); h.ok(true, 'disposed service host settles even when its byte source never resolves');
  const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage() { throw new Error('cancelled frame published'); } }) } as unknown as HTMLCanvasElement;
  const sourceFailed = createServiceHost({ retain: async () => ({ ...asset.model, parseMs: 0 } as any), release() {}, renderBitmap: async () => { throw new DOMException('Source changed', 'AbortError'); } });
  await assert.rejects(sourceFailed.view(canvas).render(warm.element, 80, 60), /Source changed/);
  h.ok(true, 'a current source cancellation rejects instead of reporting an unpainted frame successful'); sourceFailed.dispose();
  const replacing = createServiceHost({ retain: async () => ({ ...asset.model, parseMs: 0 } as any), release() {}, renderBitmap: (_spec, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(new DOMException('Superseded', 'AbortError')), { once: true }); }) });
  const view = replacing.view(canvas), earlier = view.render(warm.element, 80, 60), latest = view.render(warm.element, 80, 60);
  await earlier; view.dispose(); await latest; replacing.dispose();
  h.ok(true, 'superseded and disposed view cancellation settles without publishing or leaking rejection');


} finally { await fs.rm(root, { recursive: true, force: true }); }
await h.done();
