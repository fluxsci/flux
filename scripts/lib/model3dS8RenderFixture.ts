/** Refresh only the changed scratch figure render; never resync original plot sources. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { renderFigureSvg } from '../../flux-core/render';
const [root, variant] = process.argv.slice(2), scratch = process.env.MODEL3D_NATIVE_SCRATCH;
if (!scratch || !path.resolve(scratch).startsWith(os.tmpdir() + path.sep) || !path.resolve(root).startsWith(path.resolve(scratch) + path.sep)) throw Error('Owned scratch S8 render required');
const fixture = JSON.parse(await fs.readFile(path.join(root, 's8-fixture-receipt.json'), 'utf8'));
const warnings: string[] = [];
const svg = await renderFigureSvg(root, fixture.figureId, { model3dPolicy: 'collect', posterSurface: { kind: 'editor' }, warnings });
if (warnings.length || /data-model3d-placeholder/.test(svg)) throw Error('S8 Paper render is incomplete: ' + warnings.join('; '));
if (variant === 'model' && (svg.match(/data-model3d-poster=/g)?.length ?? 0) !== 4) throw Error('S8 Paper figure must contain all four decoded mesh posters');
await fs.writeFile(path.join(root, 'fig/renders', fixture.figureId + '.svg'), svg);
await fs.writeFile(path.join(root, 's8-render-receipt.json'), JSON.stringify({ variant, figureId: fixture.figureId, bytes: Buffer.byteLength(svg), warnings, meshPosters: svg.match(/data-model3d-poster=/g)?.length ?? 0 }, null, 2));
