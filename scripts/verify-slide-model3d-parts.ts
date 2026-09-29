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
import { modelPartOpacity } from '../src/lib/model3d/appearance';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { saveDeck, loadDeck, compileDeckSlide, animateElementVerb, setTrackVerb } from '../flux-core/slides';
import { trackFanout, refLabel } from '../src/shell/modes/slide/animator/shared';
import { editorStashedParts } from '../src/lib/editorPresentation';
import { posterKey } from '../src/lib/model3d/poster';

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
const key = posterKey(element, asset, manifest, { w: 256, h: 256 });
h.eq(posterKey(element, asset, manifest, { w: 256, h: 256 }, { 'neuron.axon': 1 }), key, 'identity appearance factors keep existing poster keys');
h.ok(posterKey(element, asset, manifest, { w: 256, h: 256 }, { 'neuron.axon': .5 }) !== key, 'sampled mesh opacity is part of the poster identity');
h.eq(posterKey(element, asset, manifest, { w: 256, h: 256 }, { 'axes.x.label': 0 }), key, 'vector-only appearance does not rerender the mesh');
h.eq(modelPartOpacity({ a: { visible: false }, b: { opacity: .4 }, c: { opacity: 1 } }), { a: 0, b: .4 }, 'presentation factors preserve partial opacity and omit identity');
h.eq(modelPartOpacity({ a: { visible: false } }, true), { a: .25 }, 'authoring ghost visibility remains a transient factor');
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
h.eq(compileSlide(slide, deck.stage).sample(0).presentation.elementStates.M, undefined, 'missing model metadata never turns a mesh entrance into whole-model hiding');
const nextManifest = { ...manifest, parts: [{ id: 'other', node: 'other', role: 'mesh' }] };
setTransform(deck, slide.id, beat.id, 'M', { toAssetId: 'next' });
const resolveAt = handoffTargetResolver(slide, () => undefined, id => id === 'next' ? nextManifest : manifest);
h.eq(resolveAt({ element: 'M', parts: ['other'] }, 2), [{ elementId: 'M', partIds: ['other'] }], 'handoff target resolution uses prior content-change metadata');
h.eq(resolveAt({ element: 'M', parts: ['neuron.axon'] }, 2), [], 'old content part names cannot target the new model');
const added = addAppearanceTracks(deck, slide.id, [{ elementId: 'M', partId: 'other' }, { elementId: 'M', partId: 'other' }], 'appear', 2, {});
h.eq(added?.trackIds.length, 1, 'X-ray appearance batches deduplicate model part rows');
h.eq(branch.tracks.at(-1)?.preset, 'fade', 'model parts use an ordinary fade track');
const timingSlide = structuredClone(slide); timingSlide.beats = [{ id: 'design', tracks: [] }, { id: 'timing', tracks: [
  { id: 'all', target: 'M', parts: ['neuron.soma', 'neuron.axon', 'axes.x.label'], preset: 'fade', duration: 1000, easing: 'linear', stagger: { perMs: 200 } },
  { id: 'following', target: 'M', part: 'height', preset: 'fade', duration: 100, anchor: { trackId: 'all', edge: 'end' } },
] }];
const timing = compileSlide(timingSlide, deck.stage, opts);
h.eq(timing.cues[1].tracks[1].start, 1400, 'anchor after mixed mesh/furniture stagger includes every semantic leaf');
h.eq(timing.sample(1, 500).partStates.M['axes.x.label']?.opacity, .1, 'mixed stagger uses the full semantic order in pure sampling');
h.eq(trackFanout(timingSlide.beats[1].tracks[0], timingSlide, manifest), 3, 'Animator fanout agrees with the compiler for 3D parts');
h.ok(refLabel({element:'M',parts:['height.colorbar']}, timingSlide, () => manifest).includes('Colorbar'), 'Animator label uses the shared 3D tree vocabulary');
const stashed=editorStashedParts({partStates:{M:{'neuron.axon':{visible:false}}}},[element],{},{neuron:manifest});
h.ok(stashed.get('M')?.has('@series:neuron'), 'hidden mesh excludes an ancestor edit which would silently affect it');
h.eq(editorStashedParts({ghostHidden:true,partStates:{M:{'neuron.axon':{visible:false}}}},[element],{},{neuron:manifest}).size,0,'Show hidden restores normal part editing');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-slide-model-parts-'));
try {
  const seed = buildScaffoldTree({title:'Saved semantic model parts'}, createDeck());
  for (const [relative, content] of seed.files) { const file=path.join(root,relative); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,content); }
  const binary=await fs.readFile('scripts/fixtures/model3d/fluxplot/morph-a.glb'), metadata=JSON.parse(await fs.readFile('scripts/fixtures/model3d/fluxplot/morph-a.fluxplot.json','utf8'));
  const sourceHash=createHash('sha256').update(binary).digest('hex');
  const saved=createDeck({withTitleSlide:false}); saved.id='parts';
  const a: Model3dAsset={...asset,id:'a',path:'assets/a.glb',model:inspectGlb(binary),sha256:sourceHash,bytes:binary.length};
  const b: Model3dAsset={...a,id:'b',path:'assets/nested/custom.glb'}; saved.assets=[a,b];
  const scene=addSlide(saved), placed=makeModel3dElement(a,{id:'saved-model'}); scene.elements.push(placed);
  const change=addBeat(saved,scene.id)!; setTransform(saved,scene.id,change.id,placed.id,{toAssetId:b.id,source:{kind:'external',glbPath:'plots/raw.glb',sha256:sourceHash}});
  saved.animStyles=[{id:'change-style',name:'Slow content',family:'transform',track:{preset:'transform',duration:900}}]; change.tracks[0].styleId='change-style';
  const reveal=addBeat(saved,scene.id)!;
  await fs.mkdir(path.join(root,'slides/parts/assets'),{recursive:true});
  await fs.writeFile(path.join(root,'slides/parts/assets/b.fluxplot.json'),JSON.stringify(metadata));
  // Deliberately no GLB exists: semantic compile/edit reads metadata only.
  await saveDeck(root,saved);
  const result=await animateElementVerb(root,saved.id,scene.id,placed.id,{beatIndex:2,part:'cortex.left'});
  let loaded=await loadDeck(root,saved.id), compiled=await compileDeckSlide(root,loaded,scene.id);
  h.eq(compiled.cues[2].tracks.find(t=>t.track.id===result.trackId)?.parts,['cortex.left'],'public animate_element resolves future-only model metadata at canonical id sidecar despite nested GLB path');
  h.ok(!compiled.issues.some(issue=>issue.reason.includes('No matching semantic parts')), 'saved styled Change plus model-part appearance compiles without a metadata warning');
  const all=loaded.slides[0].beats[2].tracks[0]; all.parts=['cortex.left','cortex.right'];delete all.part;all.stagger={perMs:200};all.duration=1000;
  loaded.slides[0].beats[2].tracks.push({id:'follow',target:placed.id,part:'cortex.right',preset:'fadeOut',duration:200,anchor:{trackId:all.id!,edge:'end'}});
  await saveDeck(root,loaded); const edited=await setTrackVerb(root,saved.id,scene.id,'follow',{anchor:null});
  h.eq(edited.start,1200,'public set_track detaches model stagger anchor at the same effective time');
  metadata.glbSha256='f'.repeat(64);await fs.writeFile(path.join(root,'slides/parts/assets/b.fluxplot.json'),JSON.stringify(metadata));
  loaded=await loadDeck(root,saved.id);compiled=await compileDeckSlide(root,loaded,scene.id);
  h.ok(compiled.issues.some(issue=>issue.reason.includes('No matching semantic parts')), 'mismatched original content receipt keeps future semantic metadata inactive on Node compile');
  h.eq(await fs.readFile(path.join(root,'slides/parts/assets/b.fluxplot.json'),'utf8'),JSON.stringify(metadata),'read-only compilation preserves raw mismatched sidecar');
} finally { await fs.rm(root,{recursive:true,force:true}); }
await h.done();
