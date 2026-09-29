import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DOMParser } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { resolveDeckAssets } from '../src/lib/project/slideBridge';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { inspectGlb, writeGlb } from '../src/lib/model3d/glbCore.mjs';
import { createHash } from 'node:crypto';
import type { Model3dAsset } from '../src/lib/model3d/types';
import type { FileBridge } from '../src/lib/project/types';
import type { Deck } from '../src/lib/slide/types';
const h = harness('verify-model3d-deck-assets');
const bytes = writeGlb({ parts: [{ name: 'neuron.mesh', positions: [0,0,0,1,0,0,0,1,1], indices: [0,1,2] }] });
const asset: Model3dAsset = { id:'neuron', kind:'glb', name:'Neuron', path:'assets/neuron.glb', naturalWidth:320, naturalHeight:240, sha256:createHash('sha256').update(bytes).digest('hex'), bytes:bytes.length, model:inspectGlb(bytes) };
const el = makeModel3dElement(asset, {id:'neuron-view'});
const manifest = {spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'neuron.glb',parts:[{id:'neuron.mesh',role:'mesh',node:'neuron.mesh'}]};
const files = new Map<string,string>([['/scratch/slides/deck/assets/neuron.glb','binary'],['/scratch/slides/deck/assets/neuron.fluxplot.json',JSON.stringify(manifest)]]);
let binaryReads = 0;
const bridge = { exists:async(p:string)=>files.has(p), readText:async(p:string)=>{if(!files.has(p))throw Error('missing');return files.get(p)!;}, readFile:async()=>{binaryReads++;throw Error('GLB must not enter renderer assetData');} } as unknown as FileBridge;
const deck = {id:'deck',assets:[asset],slides:[{id:'s',elements:[el],beats:[]}]} as unknown as Deck;
const local = await resolveDeckAssets('/scratch', deck, ()=>true, true, bridge);
h.eq(local.data,{},'deck GLB never enters assetData');
h.eq(local.assets,[asset],'deck GLB metadata remains intact');
h.eq(local.diagnostics,[],'valid deck-local model resolves');
const {get}=await import('svelte/store'); const {scene3dManifests,clearScene3dSidecars}=await import('../src/lib/model3d/store');
clearScene3dSidecars();h.eq(get(scene3dManifests),{},'deferred read does not publish metadata');local.publish();h.eq(get(scene3dManifests).neuron,manifest,'owned publication primes scene metadata');
files.set('/scratch/fig/index.json',JSON.stringify({assets:[asset]}));
files.set('/scratch/fig/assets/neuron.glb','binary');files.set('/scratch/fig/assets/neuron.fluxplot.json',JSON.stringify(manifest));
const external = await resolveDeckAssets('/scratch',{...deck,assets:[]},()=>true,true,bridge);
h.eq(external.assets,[{...asset,path:'fig/assets/neuron.glb'}],'figure-derived GLB stays by-id with complete metadata');h.ok(external.external.has(asset.id),'figure-derived model is external');h.eq(external.data,{},'external GLB never becomes image bytes');
files.delete('/scratch/slides/deck/assets/neuron.glb');
const absent=await resolveDeckAssets('/scratch',deck,()=>true,true,bridge);
h.eq(absent.assets,[asset],'missing model retains metadata for a placeholder');h.ok(absent.diagnostics.some(d=>d.assetId===asset.id),'missing model emits named diagnostic');h.eq(binaryReads,0,'all model resolution is metadata-only');
files.set('/scratch/slides/deck/assets/neuron.glb', 'binary');
files.set('/scratch/slides/deck/assets/neuron.fluxplot.json', JSON.stringify({ ...manifest, glbSha256: 'a'.repeat(64) }));
const targetOnly = { ...deck, slides: [{ id: 's', elements: [], beats: [{ tracks: [{ target: 'earlier-model', preset: 'transform', to: { assetId: asset.id, glbPath: 'plots/neuron.glb', sha256: 'b'.repeat(64) } }] }] }] } as unknown as Deck;
clearScene3dSidecars(); const targetResolved = await resolveDeckAssets('/scratch', targetOnly, () => true, true, bridge); targetResolved.publish();
h.ok(!get(scene3dManifests).neuron, 'Change-only model target original receipt suppresses a mismatched manifest');
h.ok(targetResolved.diagnostics.some(d => d.reason.includes('different GLB bytes')), 'Change-only source mismatch has an explicit diagnostic');
const { deckModel3dBindings } = await import('../src/lib/slide/model3dBindings');
const targetTrack = targetOnly.slides[0].beats[0].tracks[0];
const styledTarget = { ...targetOnly, animStyles: [{ id: 'target-style', name: 'Target', family: 'transform', track: { preset: 'transform', duration: 300 } }], slides: [{ ...targetOnly.slides[0], beats: [{ tracks: [{ ...targetTrack, styleId: 'target-style' }] }] }] } as unknown as Deck;
h.eq(deckModel3dBindings(styledTarget).get(asset.id), { kind: 'known', sha256: 'b'.repeat(64) }, 'styled track retains its explicit content target source binding');
const conflictingTarget = structuredClone(targetOnly); conflictingTarget.slides[0].elements = [{ ...el, source: { glbPath: 'plots/neuron.glb', sha256: 'a'.repeat(64) } }];
h.eq(deckModel3dBindings(conflictingTarget).get(asset.id), { kind: 'conflict', sha256s: ['a'.repeat(64), 'b'.repeat(64)] }, 'placed and Change-only conflicting receipts do not pick an arbitrary source');
// Exercise public persistence boundaries with real scratch files. Renderer
// binary reads/writes are forbidden; only the real native copy helpers may
// transport GLB bytes. This is not an Electron/preload qualification.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-deck-assets-'));
const require = createRequire(import.meta.url);
const nativeCopy = require('../electron/verifiedCopy.cjs').createVerifiedCopy();
const nativeDeckCopy = require('../electron/videoMedia.cjs').copyVideoAssets;
let beforeCopy: (() => Promise<void>) | undefined, beforeRead: ((p: string) => Promise<void>) | undefined;
let copies = 0, deckCopies = 0, deniedBinary = 0;
const disk = {
  exists: async (p: string) => fs.access(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }),
  readText: async (p: string) => { await beforeRead?.(p); return fs.readFile(p, 'utf8'); },
  readFile: async (p: string) => { if (/\.glb$/i.test(p)) { deniedBinary++; throw Error('Renderer GLB read forbidden'); } return new Uint8Array(await fs.readFile(p)); },
  writeText: async (p: string, text: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, text); },
  writeFile: async (p: string, data: Uint8Array) => { if (/\.glb$/i.test(p)) { deniedBinary++; throw Error('Renderer GLB write forbidden'); } await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); },
  mkdir: async (p: string) => { await fs.mkdir(p, { recursive: true }); },
  remove: async (p: string) => { await fs.rm(p, { force: true }); },
  readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map(e => ({ name: e.name, dir: e.isDirectory() })),
  projectAssetPath: async (r: string, rel: string) => { assert.equal(r, root); const p = await fs.realpath(path.join(r, rel)); assert.ok(p === root || p.startsWith(root + path.sep)); return p; },
  copyFileVerified: async (a: string, b: string, sha: string) => { copies++; await beforeCopy?.(); return nativeCopy(a, b, sha); },
  copySlideVideoAssets: async (request: unknown) => { deckCopies++; return nativeDeckCopy(request); },
  lockAcquire: async (_scope: string, _name: string, expectedRoot: string) => { assert.equal(expectedRoot, root); return { ok: true, noop: true }; },
};
(globalThis as any).window = { fig: disk };
(globalThis as any).DOMParser = DOMParser;
const store = await import('../src/lib/store');
const assetStore = await import('../src/lib/assets');
const { setStoreTenant } = await import('../src/lib/tenancy');
const {model3dDeckScope,modelAssetPrefix}=await import('../src/lib/model3d/editorScope');
const { loadDeckModel, currentDeck, commitDeckLive } = await import('../src/lib/slide/store');
const { createDeck, addSlide } = await import('../src/lib/slide/ops');
const { planFigSave } = await import('../src/lib/project/figfiles');
const { readFigureSnapshot } = await import('../src/lib/project/figureSnapshot');
const { sendFigureToDeck, sendSlideToCanvas } = await import('../src/lib/project/convert');
const { readDeck, writeDeckDirect, loadDeckInto, saveDeckFrom, duplicateDeckInProject, resetDeckBaselines } = await import('../src/lib/project/slideBridge');
const { scene3dRecipes, scene3dIssues } = await import('../src/lib/model3d/store');
const unknownManifest = '{ "spec":"fluxplot/scene3d", "schemaVersion":"99.0.0", "owner":"keep exact bytes" }\n';
const invalidRecipe = '{not valid JSON; preserve exactly}\n';
const sha = asset.sha256;
const figure = { id: 'figure', canvasId: 'canvas', name: 'Neuron figure', x: 0, y: 0, width: 400, height: 300, elements: [structuredClone(el)] };
async function seed(figureModels = false, sidecar = unknownManifest) {
  beforeCopy = undefined; beforeRead = undefined; copies = 0; deckCopies = 0;
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  store.embeddedProjectRoot.set(root); setStoreTenant('figure'); assert.equal(get(model3dDeckScope),null); resetDeckBaselines(); clearScene3dSidecars(); assetStore.assetData.set({});
  const project = { version: 2 as const, name: 'Scientific fixture', canvases: [{ id: 'canvas', name: 'Canvas' }], figures: [{ ...structuredClone(figure), elements: figureModels ? [structuredClone(el)] : [] }], assets: figureModels ? [structuredClone(asset)] : [], palette: [] };
  const plan = planFigSave(project, null);
  for (const file of [...plan.canvases, ...plan.captions, plan.index]) await disk.writeText(path.join(root, file.path), file.text);
  await disk.writeText(path.join(root, 'project.json'), JSON.stringify({ schemaVersion: '0.1.0', id: 'project', title: 'Scientific fixture', manuscript: { path: 'paper/notes.qmd' }, references: { library: 'bib/library.bib' }, figures: [], slides: [] }));
  if (figureModels) await bundle('fig', sidecar);
  store.project.set(project);
}
async function bundle(prefix: string, sidecar = unknownManifest) {
  await fs.mkdir(path.join(root, prefix, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, prefix, asset.path), bytes);
  await fs.writeFile(path.join(root, prefix, 'assets/neuron.fluxplot.json'), sidecar);
  await fs.writeFile(path.join(root, prefix, 'assets/neuron.recipe.json'), invalidRecipe);
}
async function persistedFiles() {
  const map = new Map<string, string>();
  async function walk(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) await walk(file); else map.set(path.relative(root, file), (await fs.readFile(file)).toString('base64')); } }
  await walk(root); return map;
}
async function originalsUnchanged(snapshot: Map<string, string>) { for (const [rel, value] of snapshot) assert.equal((await fs.readFile(path.join(root, rel))).toString('base64'), value, rel); }
async function diskDeck(id = 'source-deck', sidecar = unknownManifest) {
  const d = createDeck({ id, withTitleSlide: false }); d.assets = [structuredClone(asset)]; const s = addSlide(d); s.elements.push(structuredClone(el));
  await bundle(`slides/${id}`, sidecar); await writeDeckDirect(root, d, { expectedText: null }); return d;
}
try {
  await seed(); const d = await diskDeck(); setStoreTenant('slide'); await loadDeckInto(root, d.id);
  h.eq(modelAssetPrefix(asset.id,get(model3dDeckScope)),`slides/${d.id}`,'owned deck load publishes local model prefix before editor consumers');
  h.eq(get(assetStore.assetData), {}, 'public deck open keeps GLB out of renderer assetData');
  h.ok(!get(scene3dManifests).neuron && !get(scene3dRecipes).neuron && get(scene3dIssues).neuron.length >= 2, 'newer manifest and invalid recipe remain inactive with diagnostics');
  commitDeckLive(value => { value.title = 'Saved title'; }); await saveDeckFrom(root);
  h.eq((await readDeck(root, d.id))?.title, 'Saved title', 'public model deck Save persists and reopens normal edits');
  h.eq(await fs.readFile(path.join(root, `slides/${d.id}/assets/neuron.fluxplot.json`), 'utf8'), unknownManifest, 'ordinary deck Save preserves newer raw manifest bytes');
  h.eq(await fs.readFile(path.join(root, `slides/${d.id}/assets/neuron.recipe.json`), 'utf8'), invalidRecipe, 'ordinary deck Save preserves invalid raw recipe bytes');
  const duplicate = await duplicateDeckInProject(root, d.id); assert.ok(duplicate);
  h.eq(createHash('sha256').update(await fs.readFile(path.join(root, `slides/${duplicate}/assets/neuron.glb`))).digest('hex'), sha, 'public deck duplicate copies actual GLB bytes through native batch');
  h.eq(await fs.readFile(path.join(root, `slides/${duplicate}/assets/neuron.fluxplot.json`), 'utf8'), unknownManifest, 'duplicate preserves newer sidecar byte for byte');
  h.eq(await fs.readFile(path.join(root, `slides/${duplicate}/assets/neuron.recipe.json`), 'utf8'), invalidRecipe, 'duplicate preserves invalid recipe byte for byte');
  h.eq(deckCopies, 1, 'one native batch owns all duplicated model files');
  const deckBefore = await fs.readFile(path.join(root, `slides/${d.id}/deck.json`), 'utf8');
  await fs.rm(path.join(root, `slides/${d.id}/assets/neuron.glb`));
  await assert.rejects(saveDeckFrom(root), /3D model file.*missing/); h.eq(await fs.readFile(path.join(root, `slides/${d.id}/deck.json`), 'utf8'), deckBefore, 'missing GLB refuses Save without changing deck bytes');
  const manifestBefore = await fs.readFile(path.join(root, 'project.json'), 'utf8'); await assert.rejects(duplicateDeckInProject(root, d.id));
  h.eq(await fs.readFile(path.join(root, 'project.json'), 'utf8'), manifestBefore, 'missing model refuses duplicate before registering a broken deck');

  await seed(true); const byId = await sendFigureToDeck(root, figure, null); const sent = await readDeck(root, byId.deckId); assert.ok(sent);
  h.eq(sent.assets?.length ?? 0, 0, 'saved Figure model remains an external by-id deck reference');
  h.eq(copies, 0, 'saved Figure by-id conversion never copies or reads GLB into renderer');
  setStoreTenant('slide'); await loadDeckInto(root, byId.deckId);
  h.eq(modelAssetPrefix(asset.id,get(model3dDeckScope)),'','figure-derived model path stays project-relative in deck scope');
  h.eq(get(store.project).assets[0].path, 'fig/assets/neuron.glb', 'public deck reopen resolves canonical Figure-owned model path');
  await fs.rm(path.join(root, 'fig/assets/neuron.glb')); const byIdBefore = await fs.readFile(path.join(root, `slides/${byId.deckId}/deck.json`), 'utf8');
  let missingById: unknown; try { await saveDeckFrom(root); } catch (error) { missingById = error; }
  h.ok(/3D model file.*missing/.test(String(missingById)), 'missing by-id model reports the named restore-or-delete refusal');
  h.eq(await fs.readFile(path.join(root, `slides/${byId.deckId}/deck.json`), 'utf8'), byIdBefore, 'missing by-id model refuses Save too');

  await seed(); await bundle('fig'); store.project.update(p => ({ ...p, assets: [structuredClone(asset)] }));
  const unsaved = await sendFigureToDeck(root, figure, null);
  h.eq(copies, 1, 'unsaved Figure model uses one native verified copy');
  h.eq(await fs.readFile(path.join(root, `slides/${unsaved.deckId}/assets/neuron.fluxplot.json`), 'utf8'), unknownManifest, 'Figure-to-deck conversion preserves inactive raw sidecar');
  h.eq((await readDeck(root, unsaved.deckId))?.assets?.[0].path, 'assets/neuron.glb', 'copied model stores a deck-relative canonical path');

  const mismatchedText = JSON.stringify({ ...manifest, glbSha256: 'a'.repeat(64) }, null, 1) + '\n';
  await seed(); await bundle('fig', mismatchedText); store.project.update(p => ({ ...p, assets: [structuredClone(asset)] }));
  const boundFigure = { ...structuredClone(figure), elements: [{ ...structuredClone(el), source: { glbPath: 'plots/original.glb', sha256: 'b'.repeat(64) } }] };
  const bound = await sendFigureToDeck(root, boundFigure, null); setStoreTenant('slide'); await loadDeckInto(root, bound.deckId);
  h.ok(!get(scene3dManifests).neuron, 'converted original source receipt keeps mismatched metadata inactive after public reopen');
  h.eq(await fs.readFile(path.join(root, `slides/${bound.deckId}/assets/neuron.fluxplot.json`), 'utf8'), mismatchedText, 'mismatched source sidecar survives conversion with exact raw bytes');

  await seed(); const localDeck = await diskDeck(); setStoreTenant('slide'); await loadDeckInto(root, localDeck.id);
  const converted = await sendSlideToCanvas(root, localDeck.slides[0], localDeck, 'canvas');
  const snapshot = await readFigureSnapshot({ readText: async rel => disk.exists(path.join(root, rel)).then(yes => yes ? disk.readText(path.join(root, rel)) : null) });
  h.eq(snapshot.status, 'complete', 'deck-to-Figure conversion reopens a complete canonical Figure project');
  h.eq(snapshot.project.figures.find(f => f.id === converted.figureId)?.elements[0].type, 'model3d', 'public conversion retains the 3D element');
  h.eq(snapshot.project.assets[0].path, 'assets/neuron.glb', 'deck-to-Figure copy adopts a Figure-relative canonical model path');
  h.eq(await fs.readFile(path.join(root, 'fig/assets/neuron.fluxplot.json'), 'utf8'), unknownManifest, 'deck-to-Figure conversion preserves inactive raw manifest');
  h.eq(await fs.readFile(path.join(root, 'fig/assets/neuron.recipe.json'), 'utf8'), invalidRecipe, 'deck-to-Figure conversion preserves invalid raw recipe');
  h.eq(copies, 1, 'deck-to-Figure uses verified native transport once');

  await seed(); const colliding = await diskDeck(); setStoreTenant('slide'); await loadDeckInto(root, colliding.id);
  await fs.mkdir(path.join(root, 'fig/assets'), { recursive: true }); await fs.writeFile(path.join(root, 'fig/assets/neuron.glb'), 'unindexed owner bytes');
  const beforeCollision = await persistedFiles(); await assert.rejects(sendSlideToCanvas(root, colliding.slides[0], colliding, 'canvas'), /destination contains different bytes/);
  await originalsUnchanged(beforeCollision); h.ok(true, 'native destination collision preserves every pre-existing scientific and canonical byte');

  await seed(); const owned = await diskDeck(); setStoreTenant('slide'); await loadDeckInto(root, owned.id); const beforeSwitch = await persistedFiles();
  beforeCopy = async () => { store.embeddedProjectRoot.set('/different-project'); };
  await assert.rejects(sendSlideToCanvas(root, owned.slides[0], owned, 'canvas'), /Project changed/); beforeCopy = undefined;
  await originalsUnchanged(beforeSwitch); h.ok(true, 'owner switch during native copy refuses canonical adoption and preserves originals');

  await seed(); const unreadable = await diskDeck(); setStoreTenant('slide'); await loadDeckInto(root, unreadable.id); const beforeUnreadable = await persistedFiles();
  beforeRead = async p => { if (p.endsWith('neuron.fluxplot.json')) throw Error('EACCES'); };
  await assert.rejects(sendSlideToCanvas(root, unreadable.slides[0], unreadable, 'canvas'), /cannot copy unreadable manifest/); beforeRead = undefined;
  await originalsUnchanged(beforeUnreadable); h.eq(copies, 0, 'whole-sidecar preflight refuses unreadable metadata before native publication');
  h.eq(deniedBinary, 0, 'all public model load/save/duplicate/conversion paths avoid renderer GLB reads and writes');
} finally { beforeCopy = undefined; beforeRead = undefined; await fs.rm(root, { recursive: true, force: true }); }
await h.done();
