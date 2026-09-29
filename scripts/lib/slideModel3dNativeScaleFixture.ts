import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildScaffoldTree } from '../../src/lib/project/scaffoldTree';
import { slideModel3dScaleFixture } from './slideModel3dScaleFixture';
const scratch = path.resolve(process.env.MODEL3D_NATIVE_SCRATCH ?? ''), root = path.resolve(process.argv[2] ?? '');
if (!scratch.startsWith(os.tmpdir() + path.sep) || !root.startsWith(scratch + path.sep)) throw Error('Owned scratch child required');
const fixture = await slideModel3dScaleFixture(), tree = buildScaffoldTree({ title: 'Model slide GPU qualification' }, fixture.deck);
const write = async (relative: string, content: string | Buffer) => {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw Error('Fixture path escaped scratch');
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
};
for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
for (const [relative, text] of tree.files) await write(relative, text);
for (const file of fixture.files) await write(`slides/${fixture.deck.id}/${file.path}`, file.base64 ? Buffer.from(file.base64, 'base64') : file.text!);
await write('slide-scale-fixture.json', JSON.stringify({ ghostIds: fixture.ghostIds, assetIds: fixture.assetIds, receipt: fixture.receipt }));
