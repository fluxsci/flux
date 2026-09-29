import { harness } from './lib/harness.mjs';
import { createDeck, addSlide, addBeat, becomeTransform, appearFrom, addGhostTransform, setTransform } from '../src/lib/slide/ops';
import { compileSlide } from '../src/lib/slide/compile';
import { transformEndState } from '../src/lib/slide/tween';
import { elementStageOutlines } from '../src/lib/slide/targetGeometry';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { inspectGlb, writeGlb } from '../src/lib/model3d/glbCore.mjs';
import { modelPair } from '../src/lib/slide/model3dMorph';
import { sourceAt } from '../src/lib/slide/ghost';
import type { Model3dAsset, Model3dElement } from '../src/lib/model3d/types';
import type { Element } from '../src/lib/types';
import type { Project } from '../src/lib/types';
import { figureSourceOwners } from '../src/lib/project/figureSourceOwners';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { saveDeck, loadDeck, become as fileBecome, appearFrom as fileAppearFrom, setTransformTrack } from '../flux-core/slides';

const h = harness('verify-slide-model3d-morph');
const binaries = new Map<string, Uint8Array>();
const makeAsset = (id: string, positions: number[], indices = [0,1,2]): Model3dAsset => {
  const data = writeGlb({ parts: [{ name: 'dendrites', positions, indices }] });
  binaries.set(id, data);
  return { id, name: id, kind: 'glb', path: `assets/${id}.glb`, naturalWidth: 200, naturalHeight: 150, bytes: data.byteLength, sha256: id.repeat(64).slice(0,64), model: inspectGlb(data) };
};
const assets = [makeAsset('a', [0,0,0, 1,0,0, 0,1,0]), makeAsset('b', [0,0,0, 2,0,1, 0,2,0]), makeAsset('c', [0,0,0, 2,0,1, 0,2,0, 1,1,0], [0,1,2,1,3,2])];
function scene(target = 1) {
  const deck = createDeck({ withTitleSlide: false }); deck.assets = structuredClone(assets);
  const slide = addSlide(deck), beat = addBeat(deck, slide.id)!;
  const a = makeModel3dElement(assets[0], { id: 'source' });
  const b: Model3dElement = { ...makeModel3dElement(assets[target], { id: 'destination' }), x: 350, orbitAzimuth: 170, orbitRoll: 12, orbitZoom: 2,
    modelStates: { expanded: .7 }, fields: { activity: { range: [2,9], cmap: 'magma' } }, overrides: { dendrites: { fill: '#cc1122' } },
    source: { glbPath: 'plots/b.glb', manifestPath: 'plots/b.fluxplot.json', recipePath: 'plots/b.recipe.json', sha256: 'f'.repeat(64) } };
  slide.elements.push(a,b);
  return { deck, slide, beat, a, b };
}
{
  const { deck, slide, beat, a, b } = scene();
  const result = becomeTransform(deck, slide.id, beat.id, a.id, b.id)!;
  h.eq(result.morph, true, 'compatible model Become reports vertex morph');
  h.eq(beat.tracks[0].to?.become?.mode, 'handoff', 'model destination defaults to non-consuming handoff');
  h.eq(slide.elements.length, 2, 'handoff retains both placements');
  const compiled = compileSlide(slide, deck.stage, deck);
  h.eq(compiled.handoffs.length, 1, 'model handoff compiles');
  h.eq(compiled.issues, [], 'compatible pair has no generic raster fallback issue');
  h.ok(compiled.sample(1, 0).presentation.hiddenElementIds.includes(b.id), 'destination is hidden before flight');
  h.ok(compiled.sample(1).presentation.hiddenElementIds.includes(a.id), 'source is hidden after flight');
  h.ok(!compiled.sample(1).presentation.hiddenElementIds.includes(b.id), 'destination reveals at completion');
  const outline = elementStageOutlines(a);
  h.ok(outline.length === 1 && outline[0].paint.raster === true, 'model contributes an explicit raster outline for snapshot handoff');
}
{
  const { deck, slide, beat, a, b } = scene(2);
  const result = appearFrom(deck, slide.id, beat.id, { element: b.id }, a.id)!;
  h.eq(result.morph, false, 'incompatible Appear from remains a valid crossfade');
  h.ok(result.reason?.includes('dendrites') && result.reason.includes('vertices'), 'first mismatch identifies the mesh and vertex counts');
  const issues = compileSlide(slide, deck.stage, deck).issues;
  h.eq(issues.length, 1, 'incompatible handoff has one nonblocking issue');
  h.ok(issues[0]?.reason.includes('share_topology_with') && issues[0]?.reason.includes('crossfade'), 'issue gives the shared-topology repair');
  h.eq(compileSlide(slide, deck.stage, deck).handoffs.length, 1, 'compatibility warning does not reject playback');
}
{
  const { deck, slide, beat, a, b } = scene();
  const result = becomeTransform(deck, slide.id, beat.id, a.id, b.id, { mode: 'consume' })!;
  const track = beat.tracks[0], end = sourceAt(slide, a.id, 2, transformEndState(a, track)) as Model3dElement;
  h.eq(result.morph, true, 'explicit consume reports compatible morphology');
  h.eq(track.to?.assetId, b.assetId, 'consume stores the destination content asset');
  h.eq([end.assetId, end.orbitAzimuth, end.orbitRoll, end.orbitZoom, end.fields, end.overrides, end.modelStates, end.source], [b.assetId,b.orbitAzimuth,b.orbitRoll,b.orbitZoom,b.fields,b.overrides,b.modelStates,b.source], 'consume retains every destination model channel and original source receipt');
  h.eq(slide.elements.map(e => e.id), [a.id], 'consume removes only the destination placement');
  h.eq(deck.assets?.length, 3, 'immutable assets remain available for undo and earlier states');
  h.eq(end.id, a.id, 'consume retains the source identity');
}
{
  const { deck, slide, beat, a, b } = scene(2);
  setTransform(deck, slide.id, beat.id, a.id, { toAssetId: b.assetId, source: b.source });
  const compiled = compileSlide(slide, deck.stage, { modelAsset: id => deck.assets?.find(asset => asset.id === id) });
  h.ok(compiled.issues.some(issue => issue.reason.includes('dendrites') && issue.reason.includes('share_topology_with')), 'content-only Change uses the same compatibility diagnosis');
  h.eq((compiled.sample(1).elements[0] as Model3dElement).assetId, b.assetId, 'incompatible content still reaches its exact destination');
}
{
  const { deck, slide, beat, a } = scene(); slide.elements.splice(1);
  a.overrides = { dendrites: { fill: '#112233' } }; a.fields = { activity: { range: [1,2] } };
  const ghosts = addGhostTransform(deck, slide.id, beat.id, a.id, { count: 8, duration: 100, states: Array.from({length:8}, (_,i) => ({ x: i * 20, orbitAzimuth: i * 45 })) })!;
  h.eq(new Set(ghosts.elementIds).size, 8, 'eight model ghosts have independent identities');
  h.ok(slide.elements.every(e => e.type === 'model3d' && e.assetId === a.assetId), 'ghosts share the immutable model asset');
  const copy = slide.elements[1] as Model3dElement; copy.overrides!.dendrites.fill = '#abcdef'; copy.fields!.activity.range![0] = 20;
  h.eq([a.overrides.dendrites.fill, a.fields.activity.range?.[0]], ['#112233',1], 'copy fields and overrides are independent objects');
  const compiled = compileSlide(slide, deck.stage, deck);
  h.eq(compiled.sample(0).presentation.unbornElementIds?.length, 8, 'all ghost views are unborn before their birth beat');
  h.eq(compiled.sample(1).elements.filter(e => e.type === 'model3d').slice(1).map(e => (e as Model3dElement).orbitAzimuth), [0,45,90,135,180,225,270,315], 'each model ghost receives its own orbit endpoint');
}
for (const reverse of [false, true]) {
  const { deck, slide, beat, a, b } = scene();
  const video = { ...b, type: 'video', assetId: 'video', posterAssetId: 'poster', durationMs: 1000 } as unknown as Element;
  slide.elements[1] = video;
  const source = reverse ? video : a, target = reverse ? a : video;
  const before = JSON.stringify(deck);
  try { becomeTransform(deck, slide.id, beat.id, source.id, target.id, { mode: 'consume' }); h.fail('video consume refused'); }
  catch { h.eq(JSON.stringify(deck), before, 'video consume refuses without mutation'); }
  const result = becomeTransform(deck, slide.id, beat.id, source.id, target.id)!;
  h.eq(result.morph, false, 'model/video handoff reports poster crossfade in both directions');
  h.eq(compileSlide(slide, deck.stage, deck).handoffs.length, 1, 'whole model/video poster handoff is admitted in both directions');
}
{
  const { deck, slide, beat, a } = scene();
  slide.elements[0] = { ...a, type: 'video', assetId: 'video', posterAssetId: 'poster', durationMs: 1000 } as unknown as Element;
  slide.elements[1] = { ...slide.elements[1], type: 'image' } as Element;
  const before = JSON.stringify(deck);
  try { becomeTransform(deck, slide.id, beat.id, a.id, 'destination', { mode: 'handoff' }); h.fail('unrelated video handoff refused'); }
  catch { h.eq(JSON.stringify(deck), before, 'unrelated video refusal is preserved'); }
  try { addGhostTransform(deck, slide.id, beat.id, a.id); h.fail('video ghost refused'); }
  catch { h.eq(JSON.stringify(deck), before, 'video ghost refusal is preserved'); }
}
h.eq(modelPair(scene().a, scene().b, {})?.ok, false, 'absent topology conservatively crossfades');
{
  const { deck, slide, beat, a, b } = scene(); deck.assets = [];
  const lookup = (id: string) => assets.find(asset => asset.id === id);
  const result = becomeTransform(deck, slide.id, beat.id, a.id, b.id, { modelAsset: lookup });
  h.eq(result?.morph, true, 'saved Figure-by-id metadata participates in authoring results');
  h.eq(compileSlide(slide, deck.stage, { modelAsset: lookup }).issues, [], 'external model lookup agrees with compilation');
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-slide-model-morph-'));
try {
  const tree = buildScaffoldTree({ title: 'Model morph verification' }, createDeck());
  for (const relative of tree.dirs) await fs.mkdir(path.join(root, relative), { recursive: true });
  for (const [relative, data] of tree.files) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); }
  const { deck, slide, beat, a, b } = scene(); deck.id = 'models';
  for (const asset of assets) { const file = path.join(root, 'slides/models', asset.path); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, binaries.get(asset.id)!); }
  await saveDeck(root, deck);
  const result = await fileBecome(root, deck.id, slide.id, beat.id, a.id, { assetId: b.assetId });
  h.eq(result.morph, true, 'public file Become accepts compatible GLB content without force');
  const saved = await loadDeck(root, deck.id), target = saved.slides[0].beats[1].tracks[0].to!;
  h.eq([target.assetId,target.glbPath,target.sha256], [b.assetId,b.source!.glbPath,b.source!.sha256], 'file content record preserves known original source receipt');
  const next = addBeat(saved, slide.id)!; await saveDeck(root, saved);
  const cross = await fileBecome(root, deck.id, slide.id, next.id, a.id, { assetId: assets[2].id });
  h.ok(cross.morph === false && cross.reason?.includes('dendrites'), 'public incompatible GLB content reports a valid crossfade, without force');
  const latest = await loadDeck(root, deck.id), finalTo = latest.slides[0].beats[2].tracks[0].to!;
  h.ok(!finalTo.glbPath && !finalTo.sha256, 'bare content target does not inherit the prior asset source receipt');
  // The general sparse Transform command must use the same model content
  // receipt policy as Become, including clearing an earlier target receipt.
  const genericDeck = await loadDeck(root, deck.id);
  genericDeck.slides = structuredClone(deck.slides);
  await saveDeck(root, genericDeck);
  await setTransformTrack(root, deck.id, slide.id, beat.id, a.id, { toAssetId: b.assetId, state: { orbitAzimuth: 123 } });
  let generic = (await loadDeck(root, deck.id)).slides[0].beats[1].tracks[0].to!;
  h.eq([generic.assetId, generic.glbPath, generic.manifestPath, generic.recipePath, generic.sha256], [b.assetId, b.source!.glbPath, b.source!.manifestPath, b.source!.recipePath, b.source!.sha256], 'public set_transform retains the full original model target receipt');
  h.eq(generic.state?.orbitAzimuth, 123, 'generic content target keeps its sparse camera patch');
  await setTransformTrack(root, deck.id, slide.id, beat.id, a.id, { toAssetId: assets[2].id });
  generic = (await loadDeck(root, deck.id)).slides[0].beats[1].tracks[0].to!;
  h.ok(generic.assetId === assets[2].id && !generic.glbPath && !generic.sha256 && !generic.manifestPath && !generic.recipePath, 'generic bare GLB target clears stale prior source provenance');
  const beforeBadTarget = await fs.readFile(path.join(root, 'slides', deck.id, 'deck.json'), 'utf8');
  try { await setTransformTrack(root, deck.id, slide.id, beat.id, a.id, { toAssetId: 'missing-model' }); h.fail('unknown generic model target refuses'); }
  catch { h.eq(await fs.readFile(path.join(root, 'slides', deck.id, 'deck.json'), 'utf8'), beforeBadTarget, 'unknown generic model target refuses before canonical publication'); }
  // Figure assets remain by-id references, resolved through metadata only.
  const indexPath = path.join(root, 'fig/index.json'), index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.assets = assets; await fs.writeFile(indexPath, JSON.stringify(index));
  for (const asset of assets) await fs.writeFile(path.join(root, 'fig', asset.path), binaries.get(asset.id)!);
  const externalDeck = structuredClone(deck); externalDeck.assets = []; await saveDeck(root, externalDeck);
  const external = await fileAppearFrom(root, deck.id, slide.id, beat.id, b.id, a.id);
  h.eq(external.morph, true, 'public file Appear from resolves Figure-owned model metadata');
  // A future (even disabled) content reference owns its exact saved source.
  const orphan = structuredClone(externalDeck); orphan.slides[0].elements = [a]; orphan.slides[0].beats[1].tracks = [];
  const track = setTransform(orphan, slide.id, beat.id, a.id, { toAssetId: b.assetId, source: b.source })!; track.disabled = true;
  await saveDeck(root, orphan);
  const owners = await figureSourceOwners(root, { assets, figures: [] } as unknown as Project, { readText: file => fs.readFile(file, 'utf8') });
  const owner = owners.project.figures.flatMap(f => f.elements).find(e => e.type === 'model3d' && e.assetId === b.assetId) as Model3dElement;
  h.eq([owner?.source?.glbPath,owner?.source?.sha256,owner?.source?.manifestPath,owner?.source?.recipePath], [b.source!.glbPath,b.source!.sha256,b.source!.manifestPath,b.source!.recipePath], 'future-only model content retains its GLB source and original hash for source planning');
  h.ok(owners.deckAssetIds.has(b.assetId), 'future-only model content retains its Figure-owned asset dependency');
} finally { await fs.rm(root, { recursive: true, force: true }); }
await h.done();
