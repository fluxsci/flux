// Disposable canonical project for real production/preload model3d acceptance.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScaffoldTree } from '../../src/lib/project/scaffoldTree';
import { executeFigSave, planFigSave } from '../../src/lib/project/figfiles';
import { createDeck } from '../../src/lib/slide/ops';
import type { Project } from '../../src/lib/types';

const [root] = process.argv.slice(2);
if (!root) throw Error('Disposable project directory required');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const write = async (rel: string, text: string) => {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const tree = buildScaffoldTree({ title: 'Native model3d verification' }, createDeck({ id: 'native-model-deck', title: 'Scratch deck', withTitleSlide: true }));
for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
for (const [rel, text] of tree.files) await write(rel, text);
const project: Project = {
  version: 2, name: 'Native model3d', canvases: [{ id: 'native-canvas', name: 'Native canvas' }], assets: [], palette: [],
  figures: [{ id: 'native-model', canvasId: 'native-canvas', referenceKey: 'fig-native-model', name: 'Native model', family: 'figure', number: 1,
    x: 0, y: 0, width: 600, height: 450, background: '#ffffff', elements: [], guides: { x: [], y: [] } }],
};
await executeFigSave(planFigSave(project, null), { read: async rel => fs.readFile(path.join(root, rel), 'utf8').catch(() => null), write });
const source = path.join(repo, 'scripts/fixtures/model3d/native/neuron');
await fs.copyFile(source + '.glb', path.join(root, 'plots/neuron.glb'));
await fs.copyFile(source + '.fluxplot.json', path.join(root, 'plots/neuron.fluxplot.json'));
await write('manuscript/main.qmd', '---\ntitle: Native model3d verification\n---\n\n# Disposable native verification\n\nFigure @fig-native-model.\n');
