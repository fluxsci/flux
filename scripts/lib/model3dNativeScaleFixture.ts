/** Canonical scratch-only native scale fixture; no application test handles. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildScaffoldTree } from '../../src/lib/project/scaffoldTree';
import { createDeck } from '../../src/lib/slide/ops';
import { executeFigSave, planFigSave } from '../../src/lib/project/figfiles';
import { prepareModel3dImport, makeImportedModel3dElement } from '../../src/lib/model3d/importData';
import { scene3dSidecarWrites } from '../../src/lib/model3d/persistence';
import { model3dScaleFixtures } from './model3dScaleFixture.mjs';
import type { Project } from '../../src/lib/types';

const root = path.resolve(process.argv[2] ?? '');
const scratch = path.resolve(process.env.MODEL3D_NATIVE_SCRATCH ?? '');
if (!scratch.startsWith(os.tmpdir() + path.sep) || !root.startsWith(scratch + path.sep)) throw Error('Native scale fixture requires a child of its owned scratch directory');
await fs.mkdir(root, { recursive: true });
const write = async (rel: string, text: string) => {
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) throw Error('Fixture path escapes scratch project');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
};
const tree = buildScaffoldTree({ title: 'Native 3D scale qualification' }, createDeck({ id: 'scale-scratch-deck', title: 'Unused scratch deck', withTitleSlide: true }));
for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
for (const [rel, text] of tree.files) await write(rel, text);
const project: Project = {
  version: 2, name: 'Native 3D scale', canvases: [{ id: 'scale-canvas', name: 'Scale canvas' }], assets: [], palette: [],
  figures: [{ id: 'scale-models', canvasId: 'scale-canvas', referenceKey: 'fig-scale-models', name: 'Figure 1', family: 'figure', number: 1,
    x: 0, y: 0, width: 930, height: 480, background: '#ffffff', elements: [], guides: { x: [], y: [] } }],
};
const receipts = [];
for (const [i, fixture] of (await model3dScaleFixtures()).entries()) {
  const prepared = await prepareModel3dImport({ bytes: fixture.bytes, assetId: fixture.stem, name: `${fixture.stem}.glb`, manifestText: JSON.stringify(fixture.manifest) });
  if (prepared.data.asset.model.triangles !== 250000 || !prepared.data.manifest || prepared.data.warnings.length) throw Error(`Invalid scale fixture ${fixture.stem}: ${prepared.data.warnings}`);
  const source = { glbPath: path.join(root, 'plots', `${fixture.stem}.glb`), manifestPath: path.join(root, 'plots', `${fixture.stem}.fluxplot.json`) };
  const element = makeImportedModel3dElement({ ...prepared.data, source }, { root, id: `scale-element-${i}`, box: { x: 10 + i % 4 * 230, y: 10 + Math.floor(i / 4) * 230, width: 220, height: 210 } });
  project.assets.push(prepared.data.asset); project.figures[0].elements.push(element);
  await fs.writeFile(path.join(root, 'fig', prepared.data.asset.path), prepared.bytes);
  await fs.writeFile(source.glbPath, fixture.bytes); await fs.writeFile(source.manifestPath, JSON.stringify(fixture.manifest));
  for (const [rel, value] of scene3dSidecarWrites('fig/assets', fixture.stem, prepared.data)) if (value !== null) await write(rel, value);
  receipts.push({ id: prepared.data.asset.id, triangles: prepared.data.asset.model.triangles, bytes: prepared.bytes.length, sourceSha256: prepared.data.sourceSha256, preparedSha256: prepared.data.asset.sha256 });
}
await executeFigSave(planFigSave(project, null), { read: async rel => fs.readFile(path.join(root, rel), 'utf8').catch(() => null), write });
await write(tree.manifest.manuscript.path, '---\ntitle: Native 3D scale qualification\n---\n\n# Disposable performance fixture\n\nFigure @fig-scale-models.\n');
await write('scale-fixture-receipt.json', JSON.stringify({ count: receipts.length, fixtures: receipts }, null, 2));
