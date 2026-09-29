import { harness } from './lib/harness.mjs';
import { targetPartIds, resolveTargetLeaves } from '../src/lib/slide/targets';
import { modelPartTargets } from '../src/lib/slide/model3dTargets';
import { compileSlide, semanticTargets } from '../src/lib/slide/compile';
import { handoffTargetResolver } from '../src/lib/slide/handoffTargets';
import { createDeck, addSlide, addBeat, setTransform } from '../src/lib/slide/ops';
import { addAppearanceTracks } from '../src/lib/slide/animateSelection';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { inspectGlb, writeGlb } from '../src/lib/model3d/glbCore.mjs';
import type { Scene3dManifest, Model3dAsset } from '../src/lib/model3d/types';
import type { Track } from '../src/lib/slide/types';

const h = harness('verify-slide-model3d-parts');
const manifest: Scene3dManifest = { spec: 'fluxplot/scene3d', schemaVersion: '0.1.0', glb: 'neuron.glb', parts: [
  { id: 'neuron.soma', node: 'soma', role: 'soma', series: 'neuron' },
  { id: 'neuron.axon', node: 'axon', role: 'axon', series: 'neuron' },
  { id: 'neuron.dendrites', role: 'dendrites', series: 'neuron' },
  { id: 'neuron.dendrites.a', node: 'dendrite.a', role: 'branch', parent: 'neuron.dendrites' },
  { id: 'neuron.dendrites.b', node: 'dendrite.b', role: 'branch', parent: 'neuron.dendrites' },
  { id: 'axes.x.label', role: 'axis-label', text: 'X' },
  { id: 'height', node: 'field', role: 'surface', field: { range: [0, 1], cmap: { name: 'grey', stops: [[0, '#000000'], [1, '#ffffff']] } } },
  { id: 'height.colorbar', role: 'colorbar', field: 'height' },
] };
const original = JSON.stringify(manifest), resolve = modelPartTargets(manifest);
h.eq(resolve.leaves('@series:neuron'), ['neuron.soma', 'neuron.axon', 'neuron.dendrites.a', 'neuron.dendrites.b'], 'synthetic series targets actual mesh leaves in source order');
h.eq(resolve.leaves('neuron.dendrites'), ['neuron.dendrites.a', 'neuron.dendrites.b'], 'authored container expands to its descendants');
h.eq(resolve.leaves('@axes'), ['axes.x.label'], 'synthetic axes target vector furniture');
h.eq(resolve.leaves('@field:height'), ['height', 'height.colorbar'], 'field container targets its mesh and colorbar');
h.eq(targetPartIds({ parts: ['neuron.axon', '@series:neuron', 'neuron.axon'], selector: { role: 'branch', except: ['neuron.dendrites'] } }, manifest), ['neuron.axon', 'neuron.soma'], 'authored union deduplicates and exclusions expand through the same tree');
h.eq(targetPartIds({ selector: { role: 'branch' } }, manifest), ['neuron.dendrites.a', 'neuron.dendrites.b'], 'mesh role selectors resolve accepted semantic leaves');
h.eq(targetPartIds({ selector: { role: 'axis-label' } }, manifest), ['axes.x.label'], 'furniture role selectors share the same target vocabulary');
h.eq(targetPartIds({ selector: { index: 0 } }, manifest), [], 'scene3d does not invent 2D datum indices');
h.eq(resolve.leaves('missing'), [], 'unknown 3D part is a missing target');
h.eq(JSON.stringify(manifest), original, 'target resolution never rewrites the source sidecar');
const cycle = structuredClone(manifest); cycle.parts = [{ id: 'a', role: 'group', parent: 'b' }, { id: 'b', role: 'group', parent: 'a' }];
try { modelPartTargets(cycle).leaves('a'); h.ok(false, 'cyclic unvalidated tree refuses'); } catch { h.ok(true, 'cyclic unvalidated tree refuses'); }

const bytes = writeGlb({ parts: [{ name: 'soma', positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,2] }] });
const asset: Model3dAsset = { id: 'neuron', name: 'Neuron', kind: 'glb', path: 'assets/neuron.glb', bytes: bytes.length, sha256: 'a'.repeat(64), model: inspectGlb(bytes) };
const deck = createDeck({ withTitleSlide: false }); deck.assets = [asset];
const slide = addSlide(deck), element = makeModel3dElement(asset, { id: 'M' }); slide.elements.push(element);
const beat = addBeat(deck, slide.id)!;
const enter: Track = { id: 'axon-in', target: 'M', part: 'neuron.axon', preset: 'fade', duration: 1000, easing: 'linear' };
beat.tracks.push(enter);
const branch = addBeat(deck, slide.id)!; branch.tracks.push({ id: 'branches-in', target: 'M', part: 'neuron.dendrites', preset: 'fade', duration: 1000, easing: 'linear' });
const end = addBeat(deck, slide.id)!; end.tracks.push({ id: 'axon-out', target: 'M', part: 'neuron.axon', preset: 'fadeOut', duration: 1000, easing: 'linear' });
const opts = { modelManifest: (id: string) => id === asset.id ? manifest : undefined };
const compiled = compileSlide(slide, deck.stage, opts);
h.eq(semanticTargets(enter, slide, opts), ['neuron.axon'], 'compiler uses the same model target leaves');
h.eq(compiled.sample(0).partStates.M['neuron.axon'], { opacity: 0, visible: false }, 'first entrance hides only its named mesh before playback');
h.eq(compiled.sample(1, 500).partStates.M['neuron.axon'], { opacity: .5, visible: true }, 'mesh entrance uses the canonical appearance sampler');
h.eq(compiled.sample(1, 500).partStates.M['neuron.soma'], undefined, 'unmentioned neighboring mesh is untouched');
h.eq(compiled.sample(1, 1000).partStates.M['neuron.dendrites.a'], { opacity: 0, visible: false }, 'later dendrite entrance remains unborn');
h.eq(compiled.sample(2, 500).partStates.M['neuron.dendrites.b'], { opacity: .5, visible: true }, 'container descendants share appearance timing');
h.eq(compiled.sample(3, 1000).partStates.M['neuron.axon'], { opacity: 0, visible: false }, 'mesh exit settles invisible');
h.eq(compiled.sample(1, 500).partStates, compiled.sample(1, 500).partStates, 'random repeated sampling is deterministic');
h.eq(slide.elements[0], element, 'presentation never edits Design geometry or source');
h.eq(resolveTargetLeaves({ element: 'M', parts: ['@axes'] }, slide, () => undefined, opts.modelManifest), [{ elementId: 'M', partIds: ['axes.x.label'] }], 'TargetRef resolves furniture through model metadata');
h.eq(resolveTargetLeaves({ element: 'M', parts: ['neuron.axon'] }, slide, () => undefined), [{ elementId: 'M', partIds: [] }], 'plain GLB has no invented semantic targets');
h.ok(compileSlide(slide, deck.stage).issues.some(issue => issue.reason.includes('No matching semantic parts')), 'missing model metadata is an actionable animation issue');
const nextManifest = { ...manifest, parts: [{ id: 'other', node: 'other', role: 'mesh' }] };
setTransform(deck, slide.id, beat.id, 'M', { toAssetId: 'next' });
const resolveAt = handoffTargetResolver(slide, () => undefined, id => id === 'next' ? nextManifest : manifest);
h.eq(resolveAt({ element: 'M', parts: ['other'] }, 2), [{ elementId: 'M', partIds: ['other'] }], 'handoff target resolution uses prior content-change metadata');
h.eq(resolveAt({ element: 'M', parts: ['neuron.axon'] }, 2), [], 'old content part names cannot target the new model');
const added = addAppearanceTracks(deck, slide.id, [{ elementId: 'M', partId: 'other' }, { elementId: 'M', partId: 'other' }], 'appear', 2, {});
h.eq(added?.trackIds.length, 1, 'X-ray appearance batches deduplicate model part rows');
h.eq(branch.tracks.at(-1)?.preset, 'fade', 'model parts use an ordinary fade track');
await h.done();
