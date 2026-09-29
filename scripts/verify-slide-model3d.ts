import { harness } from './lib/harness.mjs';
import { createDeck, addSlide, addBeat, addTurntable, setTransform, normalizeDeck } from '../src/lib/slide/ops';
import { applyState, diffState, lerpElement, lerpFields, lerpStates, contentPlan, transformPreState, transformEndState } from '../src/lib/slide/tween';
import { deckToProject, projectIntoDeck } from '../src/lib/slide/deckProject';
import { validateDeckFile } from '../src/lib/project/validate';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { inspectGlb, writeGlb } from '../src/lib/model3d/glbCore.mjs';
import type { Model3dAsset } from '../src/lib/model3d/types';

const h = harness('verify-slide-model3d');
const bytes = writeGlb({ parts: [{ name: 'mesh', positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,2] }] });
const asset: Model3dAsset = { id: 'mesh', name: 'Mesh', kind: 'glb', path: 'assets/mesh.glb', bytes: bytes.byteLength, sha256: 'a'.repeat(64), model: inspectGlb(bytes) };
const a = makeModel3dElement(asset, { id: 'model' });
const b = { ...a, orbitAzimuth: a.orbitAzimuth - 720, orbitZoom: 9, orbitRoll: 40, orbitPanX: 2, orbitProjection: 'perspective' as const, modelStates: { inflated: 2 }, fields: { field: { range: [2, 8] as [number, number], cmap: 'viridis' } } };
const mid = lerpElement(a, b, .5);
h.ok(mid.type === 'model3d', 'model sampling preserves its kind');
if (mid.type === 'model3d') {
  h.eq(mid.orbitAzimuth, a.orbitAzimuth - 360, 'full turns use an unwrapped scalar instead of shortest arc');
  h.ok(Math.abs(mid.orbitZoom - Math.sqrt(a.orbitZoom * 9)) < 1e-12, 'zoom interpolates geometrically');
  h.eq([mid.orbitRoll, mid.orbitPanX], [20, 1], 'optional orbit channels have zero defaults');
  h.eq(mid.modelStates, { inflated: 1 }, 'missing shape weight defaults to zero');
}
h.eq(lerpElement(a, b, .99, .49).type === 'model3d' && (lerpElement(a, b, .99, .49) as typeof a).orbitProjection, a.orbitProjection, 'projection switches on raw progress, independent of eased overshoot');
h.eq(lerpElement(a, b, 0, 1), b, 'true endpoint is the exact authored element');
h.eq(applyState(a, diffState(a, b)), b, 'endpoint checkout round trips all model properties');
h.eq(contentPlan(a, b).mode, 'model-live', 'model content never enters static SVG recompilation');
h.eq(contentPlan(a, { ...a, type: 'image' } as never).mode, 'crossfade', 'cross-kind content retains the existing crossfade policy');
h.eq(lerpStates({ a: -2, gone: 1 }, { a: 2, new: 2 }, .25), { a: -1, gone: .75, new: .5 }, 'signed states interpolate across the union of names');
const special = JSON.parse('{"__proto__":2,"constructor":-1}');
h.eq(lerpStates({}, special, .5), JSON.parse('{"__proto__":1,"constructor":-0.5}'), 'dynamic shape names are own keys');
h.eq(lerpFields({ f: { range: [0, 2], cmap: 'a' } }, { f: { range: [2, 6], cmap: 'b' } }, .25, .6), { f: { range: [.5, 3], cmap: 'b' } }, 'field limits are continuous and map choice uses raw progress');
h.eq(lerpFields({ f: { range: [2, 2] } }, { f: { range: [4, 4] } }, .5), { f: { range: [3, 3] } }, 'constant field ranges stay valid');

const deck = createDeck({ withTitleSlide: false }); deck.assets = [asset];
const slide = addSlide(deck); slide.elements.push(a);
const beat = addBeat(deck, slide.id)!;
const turn = addTurntable(deck, { slideId: slide.id, beatId: beat.id, target: a.id, turns: 2 })!;
h.eq([turn.preset, turn.duration, turn.easing, turn.to?.state?.orbitAzimuth], ['transform', 6000, 'linear', a.orbitAzimuth - 720], 'Turntable authors an ordinary linear transform');
h.eq(addTurntable(deck, { slideId: slide.id, beatId: slide.beats[0].id, target: a.id }), null, 'Turntable refuses the resting beat');
const next = addBeat(deck, slide.id)!;
const ccw = addTurntable(deck, { slideId: slide.id, beatId: next.id, target: a.id, turns: .5, direction: 'ccw', durationMs: 900 })!;
h.eq(ccw.to?.state?.orbitAzimuth, a.orbitAzimuth - 540, 'later Turntable starts at the previous effective endpoint');
const before = JSON.stringify(deck);
try { addTurntable(deck, { slideId: slide.id, beatId: next.id, target: a.id, turns: NaN }); h.ok(false, 'invalid turn count refused'); } catch { h.eq(JSON.stringify(deck), before, 'invalid turn count refuses without mutation'); }
setTransform(deck, slide.id, beat.id, a.id, { toAssetId: 'next', source: { glbPath: 'plots/next.glb', sha256: 'b'.repeat(64), manifestPath: 'plots/next.fluxplot.json' } });
h.eq(transformPreState(slide, a.id, 2)?.type === 'model3d' && (transformPreState(slide, a.id, 2) as typeof a).assetId, 'next', 'earlier model content destinations become the next transform source');
h.eq((transformEndState(a, turn) as typeof a).assetId, 'next', 'content targets apply through the shared endpoint helper');
h.eq(turn.to?.glbPath, 'plots/next.glb', 'GLB source provenance travels with the content target');
h.eq(validateDeckFile(deck), [], 'model deck and metadata-only GLB asset pass the canonical generated schema');
const invalid = structuredClone(deck); delete (invalid.assets![0] as Partial<Model3dAsset>).model;
h.ok(validateDeckFile(invalid).length > 0, 'GLB asset metadata is required in decks');
h.eq(projectIntoDeck(deckToProject(deck, deck.assets!), deck), deck, 'model deck projection identity retains all states, assets and tracks');
const old = { ...createDeck({ withTitleSlide: false }), schemaVersion: '0.5.0' };
h.eq(normalizeDeck(old).schemaVersion, '0.6.0', 'legacy decks retain the animation-v2 migration target');
h.eq(deck.schemaVersion, '0.6.0', '3D folds into the unpublished 0.6 minor');
await h.done();
