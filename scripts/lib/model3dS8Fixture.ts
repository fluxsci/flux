/** Add exactly four models to a disposable copy of the public S8 example. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyPublicS8Fixture } from './model3dS8PublicFixture.mjs';
import { model3dScaleFixtures } from './model3dScaleFixture.mjs';
import { prepareModel3dImport, makeImportedModel3dElement } from '../../src/lib/model3d/importData';
import { scene3dSidecarWrites } from '../../src/lib/model3d/persistence';
import { FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from '../../src/lib/project/types';
const [source, destination] = process.argv.slice(2), scratch = process.env.MODEL3D_NATIVE_SCRATCH;
if (!scratch || !path.resolve(scratch).startsWith(os.tmpdir() + path.sep) || !path.resolve(destination ?? '').startsWith(path.resolve(scratch) + path.sep)) throw Error('Owned scratch S8 destination required');
const provenance = await verifyPublicS8Fixture(source);
await fs.cp(source, destination, { recursive: true });
const indexPath = path.join(destination, 'fig/index.json'), index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const canvasPath = path.join(destination, 'fig/canvases', index.canvases[0].id + '.json'), canvas = JSON.parse(await fs.readFile(canvasPath, 'utf8'));
const figure = canvas.figures[0], oldHeight = figure.height;
const originalElements=JSON.stringify(figure.elements), originalCount=figure.elements.length;
const additions = [];
for (const [i, fixture] of (await model3dScaleFixtures(4)).entries()) {
  const assetId = `s8-model-${i}`;
  const prepared = await prepareModel3dImport({ bytes: fixture.bytes, assetId, name: `S8 ${i + 1}`, manifestText: JSON.stringify(fixture.manifest) });
  if (!prepared.data.manifest || prepared.data.warnings.length) throw Error('S8 model fixture failed canonical preparation');
  const element = makeImportedModel3dElement(prepared.data, { id: assetId, box: { x: 20 + i * 240, y: oldHeight + 20, width: 220, height: 210 } });
  figure.elements.push(element); index.assets.push(prepared.data.asset);
  await fs.writeFile(path.join(destination, 'fig', prepared.data.asset.path), prepared.bytes);
  for (const [rel, text] of scene3dSidecarWrites('fig/assets', assetId, prepared.data)) if (text !== null) await fs.writeFile(path.join(destination, rel), text);
  additions.push({ elementId: element.id, assetId, sha256: prepared.data.asset.sha256, triangles: prepared.data.asset.model.triangles, x: element.x, y: element.y, width: element.width, height: element.height });
}
if(JSON.stringify(figure.elements.slice(0,originalCount))!==originalElements)throw Error('Original public artwork was changed');
figure.height = oldHeight + 240;
index.schemaVersion = FIG_INDEX_SCHEMA_VERSION; canvas.schemaVersion = CANVAS_SCHEMA_VERSION;
await fs.writeFile(canvasPath, JSON.stringify(canvas, null, 2)); await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
await fs.writeFile(path.join(destination, 's8-fixture-receipt.json'), JSON.stringify({ source: { repo: provenance.repo, commit: provenance.commit, tree: provenance.tree }, canvasId: canvas.id, figureId: figure.id, previousHeight: oldHeight, height: figure.height, additions, note: 'Original public 2D content retained; only four models and a bottom row were added in scratch. Matched image baseline must use identical placement and figure extent.' }, null, 2));
