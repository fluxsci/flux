/** Same immutable meshes/deck for browser and production-native qualification. */
import { createHash } from 'node:crypto';
import { model3dScaleFixtures } from './model3dScaleFixture.mjs';
import { blobMesh } from '../gen-model3d-fixtures.mjs';
import { inspectGlb, writeGlb } from '../../src/lib/model3d/glbCore.mjs';
import { prepareModel3dImport, makeImportedModel3dElement } from '../../src/lib/model3d/importData';
import { createDeck, addSlide, addBeat, addGhostTransform, setTransform } from '../../src/lib/slide/ops';
import { compileSlide } from '../../src/lib/slide/compile';
import { morphCompatible } from '../../src/lib/model3d/morphPair';

export async function slideModel3dScaleFixture(deckId = 'model3d-scale') {
  const [a] = await model3dScaleFixtures(1), geometry = blobMesh(250, 500);
  // A 40% shape change makes actual morph pixels distinguishable at tile size.
  // Vertex/index order stays exact; both assets retain all 250,000 triangles.
  const bytes = writeGlb({ parts: [{ name: 'sample.mesh', ...geometry, positions: geometry.positions.map((v: number, i: number) => i % 3 === 0 ? v * 1.4 : v) }] });
  const info = inspectGlb(bytes), manifest = structuredClone(a.manifest), stem = 'scale-model-target';
  Object.assign(manifest, { glb: `${stem}.glb`, glbSha256: createHash('sha256').update(bytes).digest('hex'), bounds: { min: info.bounds.min, max: info.bounds.max } });
  for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]] as const) manifest.axes[axis].lim = [info.bounds.min[index], info.bounds.max[index]];
  const input = [a, { stem, bytes, info, manifest }], files: { path: string; base64?: string; text?: string }[] = [];
  const prepared = await Promise.all(input.map(f => prepareModel3dImport({ bytes: f.bytes, assetId: f.stem, name: f.stem, manifestText: JSON.stringify(f.manifest) })));
  const deck = createDeck({ id: deckId, title: '3D slide scale', withTitleSlide: false });
  deck.stage = { width: 1080, height: 720 }; deck.background = '#ffffff'; deck.assets = prepared.map(p => p.data.asset);
  for (const [i, p] of prepared.entries()) {
    if (p.data.asset.model.triangles !== 250000 || p.data.warnings.length || !p.data.manifest) throw Error(`Invalid model scale fixture: ${p.data.warnings.join('; ')}`);
    files.push({ path: p.data.asset.path, base64: Buffer.from(p.bytes).toString('base64') }, { path: `assets/${p.data.asset.id}.fluxplot.json`, text: JSON.stringify(p.data.manifest) });
  }
  if (!morphCompatible(deck.assets[0].model!, deck.assets[1].model!).ok) throw Error('Scale pair must actually share topology');
  const model = (id: string, box: { x: number; y: number; width: number; height: number }) => {
    const element = makeImportedModel3dElement(prepared[0].data, { root: '/scratch', id, box });
    // These generated immutable assets have no external authoring source.
    delete element.source; return element;
  };
  const single = addSlide(deck, { name: 'Single model', layout: 'blank' }); single.id = 'scale-single'; single.background = '#ffffff';
  single.elements = [model('scale-single-model', { x: 250, y: 80, width: 580, height: 550 })];
  const turn = addBeat(deck, single.id, { label: 'Orbit', advance: 'click' })!;
  setTransform(deck, single.id, turn.id, single.elements[0].id, { state: { orbitAzimuth: 330 }, duration: 2400, curve: 'linear' });
  const multi = addSlide(deck, { name: 'Morph and eight ghosts', layout: 'blank' }); multi.id = 'scale-morph'; multi.background = '#ffffff';
  const box = (i: number) => ({ x: 20 + i % 3 * 350, y: 15 + Math.floor(i / 3) * 235, width: 330, height: 220 });
  multi.elements = [model('scale-source', box(0))];
  const birth = addBeat(deck, multi.id, { label: 'Eight ghosts', advance: 'click' })!;
  const ghosts = addGhostTransform(deck, multi.id, birth.id, 'scale-source', { count: 8, original: 'stay', duration: 400, curve: 'linear', states: Array.from({ length: 8 }, (_, i) => ({ ...box(i + 1), orbitAzimuth: i * 35, orbitElevation: 10 + i * 5 })) })!;
  const morph = addBeat(deck, multi.id, { label: 'Vertex morph', advance: 'click' })!;
  for (const id of ['scale-source', ...ghosts.elementIds]) setTransform(deck, multi.id, morph.id, id, { toAssetId: prepared[1].data.asset.id, duration: 2400, curve: 'linear' });
  const compiled = compileSlide(multi, deck.stage, { modelAsset: id => deck.assets.find(a => a.id === id) });
  if (compiled.issues.length) throw Error(`Scale fixture has animation issues: ${JSON.stringify(compiled.issues)}`);
  return { deck, files, ghostIds: ghosts.elementIds, assetIds: deck.assets.map(a => a.id), receipt: { triangles: prepared.map(p => p.data.asset.model.triangles), bytes: prepared.map(p => p.bytes.length), sha256: prepared.map(p => p.data.asset.sha256), ghostCount: 8, morphDurationMs: 2400, sourceNames: input.map(f => f.stem) } };
}
