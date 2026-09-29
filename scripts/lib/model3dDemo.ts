/** Reproducible scratch-only review project, built with canonical Figure APIs. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { buildScaffoldTree } from '../../src/lib/project/scaffoldTree';
import { createDeck } from '../../src/lib/slide/ops';
import { createModel3dDemoDeck } from './model3dDemoDeck';

export const DEMO_STEMS = ['neuron', 'cortex-states', 'continuous-field', 'cortex-pial', 'cortex-inflated', 'cell-sequence'] as const;
export const DEMO_INPUTS = path.resolve(import.meta.dirname, '../fixtures/model3d/demo');
export function demoSourceRevision(source: string) {
  const fluxplotCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: source, encoding: 'utf8' });
  if (branch.error || branch.status !== 0 && branch.status !== 1) throw branch.error ?? new Error(`Cannot read fluxplot branch: ${branch.stderr}`);
  return { fluxplotBranch: branch.status === 1 ? 'detached HEAD' : branch.stdout.trim(), fluxplotCommit };
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, file: string) => file.startsWith(root + path.sep);
// Per-process TMPDIR changes during isolation; use the stable OS scratch root.
const scratchBase = fs.realpath(process.platform === 'win32' ? os.tmpdir() : '/tmp');

async function scratchPath(input: string): Promise<string> {
  const root = path.resolve(input), temporary = await scratchBase;
  if (!inside(temporary, root)) throw new Error('Demo destination must be a child of the system temporary directory');
  let ancestor = root;
  while (true) {
    try {
      const stat = await fs.lstat(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(ancestor) !== ancestor || !inside(temporary, ancestor) && ancestor !== temporary) throw new Error('Demo destination must have real scratch directory ancestors');
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  return root;
}
export async function emptyScratchDestination(input: string): Promise<string> {
  const root = await scratchPath(input);
  const entries = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  if (entries.length) throw new Error('Demo destination is not empty; choose a new scratch directory');
  return root;
}

/** Build privately and publish only into the captured, still-empty destination. */
async function publishScratchDirectory<T>(input: string, build: (stage: string, root: string) => Promise<T>): Promise<T> {
  const root = await emptyScratchDestination(input), parent = path.dirname(root);
  // The caller chooses a directory under an existing real scratch parent. No
  // recursive mkdir may follow a parent replaced after the initial check.
  if (parent !== await scratchBase) await scratchPath(parent);
  const directory = await fs.open(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const parentStat = await directory.stat();
  const original = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
  const assertParent = async () => {
    const now = await fs.lstat(parent);
    if (!now.isDirectory() || now.isSymbolicLink() || !same(now, parentStat) || await fs.realpath(parent) !== parent) throw new Error('Demo destination parent changed during generation');
  };
  const assertDestination = async () => {
    await assertParent();
    const now = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!!now !== !!original || now && (!original || !same(now, original) || !now.isDirectory() || now.isSymbolicLink() || (await fs.readdir(root)).length)) throw new Error('Demo destination changed during generation');
  };
  let stage: string | undefined;
  try {
    await assertDestination();
    stage = await fs.mkdtemp(path.join(await scratchBase, 'flux-model3d-demo-stage-'));
    const stageStat = await fs.lstat(stage), value = await build(stage, root);
    await assertDestination();
    // Linux resolves the final name beneath the opened parent, even if its
    // pathname is swapped between the check and rename. rename itself never
    // follows an existing target symlink or replaces a populated directory.
    const target = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}/${path.basename(root)}` : root;
    await fs.rename(stage, target); stage = undefined;
    try { await assertParent(); }
    catch (error) {
      const published = await fs.lstat(target).catch(() => undefined);
      if (published && same(published, stageStat)) await fs.rm(target, { recursive: true });
      throw error;
    }
    return value;
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    await directory.close();
  }
}

async function scratchEnvironment(): Promise<void> {
  if (process.env.FLUX_NO_MIGRATE !== '1') throw new Error('Demo generation requires FLUX_NO_MIGRATE=1');
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    if (!process.env[key]) throw new Error(`Demo generation requires scratch ${key}`);
    await scratchPath(process.env[key]!);
  }
}

/** Uses the supplied development checkout read-only; uv never syncs its environment. */
export async function generateDemoInputs(destination: string, fluxplotRoot: string): Promise<void> {
  await scratchEnvironment();
  return publishScratchDirectory(destination, stage => generateInputsInto(stage, fluxplotRoot));
}

async function generateInputsInto(destination: string, fluxplotRoot: string): Promise<void> {
  const source = path.resolve(fluxplotRoot), script = path.join(source, 'examples/scene3d_demo.py');
  const python = path.join(source, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await fs.access(python); const code = await fs.readFile(script);
  const revision = demoSourceRevision(source);
  const changed = execFileSync('git', ['status', '--porcelain', '--', 'src/fluxplot', 'examples/scene3d_demo.py'], { cwd: source, encoding: 'utf8' }).trim();
  if (changed) throw new Error('Record demo inputs from a committed fluxplot source checkpoint');
  await fs.mkdir(destination, { recursive: true }); await fs.writeFile(path.join(destination, 'scene3d_demo.py'), code);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('uv', ['run', '--no-project', '--no-config', '--offline', '--python', python, 'python', path.join(destination, 'scene3d_demo.py'), '--out', destination], {
      cwd: destination, env: { ...process.env, PYTHONPATH: path.join(source, 'src'), FLUX_NO_MIGRATE: '1', MPLBACKEND: 'Agg', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Public fluxplot example failed (${code}): ${output}`)));
  });
  const files: Record<string, string> = { 'scene3d_demo.py': sha(code) };
  for (const stem of DEMO_STEMS) for (const suffix of ['glb', 'fluxplot.json', 'recipe.json']) files[`${stem}.${suffix}`] = sha(await fs.readFile(path.join(destination, `${stem}.${suffix}`)));
  await fs.writeFile(path.join(destination, 'SHA256SUMS.json'), JSON.stringify(files, null, 2) + '\n');
  await fs.writeFile(path.join(destination, 'PROVENANCE.json'), JSON.stringify({ source: 'fluxplot/examples/scene3d_demo.py', ...revision, command: 'node --import tsx scripts/gen-model3d-demo-fixtures.ts <fluxplot-worktree>', recipe: 'Valid non-rerunnable sidecars emitted by the unchanged public example' }, null, 2) + '\n');
}

type DemoOptions = { fluxplotRoot?: string; posters?: boolean; environment?: string };
export async function createModel3dDemo(input: string, options: DemoOptions = {}) {
  await scratchEnvironment();
  return publishScratchDirectory(input, (stage, root) => buildModel3dDemo(stage, root, options));
}

async function buildModel3dDemo(root: string, publishedRoot: string, options: DemoOptions) {
  const core = await import('../../flux-core/index');
  // Canonical scaffolding always includes a starter deck. Omit its persisted
  // entries before first publication; the review deck is authored through core below.
  const tree = buildScaffoldTree({ title: 'Flux 3D review demo' }, createDeck({ id: 'review-starter', title: 'Review starter' }));
  tree.manifest.slides = [];
  await fs.mkdir(root, { recursive: true });
  for (const directory of tree.dirs.filter(name => !name.startsWith('slides/'))) await fs.mkdir(path.join(root, directory), { recursive: true });
  for (const [name, text] of tree.files.filter(([name]) => !name.startsWith('slides/'))) await fs.writeFile(path.join(root, name), name === 'project.json' ? JSON.stringify(tree.manifest, null, 2) + '\n' : text);
  if (options.fluxplotRoot) await generateDemoInputs(path.join(root, 'plots'), options.fluxplotRoot);
  else {
    const receipt = JSON.parse(await fs.readFile(path.join(DEMO_INPUTS, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>;
    for (const [name, hash] of Object.entries(receipt)) {
      if (path.basename(name) !== name) throw new Error('Invalid demo fixture receipt filename');
      const bytes = await fs.readFile(path.join(DEMO_INPUTS, name)); if (sha(bytes) !== hash) throw new Error(`Demo fixture differs from receipt: ${name}`);
      await fs.writeFile(path.join(root, 'plots', name), bytes);
    }
    for (const name of ['SHA256SUMS.json', 'PROVENANCE.json']) await fs.copyFile(path.join(DEMO_INPUTS, name), path.join(root, 'plots', name));
  }
  await core.deleteFigure(root, 'fig-1');
  const figures = [
    { id: 'model3d-overview', name: 'Neuron, shapes and a value field', width: 1020, height: 410 },
    { id: 'model3d-morph', name: 'Corresponding cortex surfaces', width: 750, height: 400 },
    { id: 'model3d-sequence', name: 'Shape sequence', width: 390, height: 380 },
  ];
  for (const figure of figures) await core.createFigure(root, figure);
  const placements = [
    ['neuron', figures[0].id, 20, 65], ['cortex-states', figures[0].id, 385, 65], ['continuous-field', figures[0].id, 700, 65],
    ['cortex-pial', figures[1].id, 20, 55], ['cortex-inflated', figures[1].id, 385, 55], ['cell-sequence', figures[2].id, 25, 50],
  ] as const;
  const models: Record<string, { elementId: string; assetId: string; figureId: string }> = {};
  for (const [stem, figureId, x, y] of placements) {
    const result = await core.addModel(root, figureId, path.join(root, 'plots', `${stem}.glb`), { name: stem, box: { x, y }, noPoster: true });
    if (result.warnings.length) throw new Error(`Demo import warning (${stem}): ${result.warnings.join('; ')}`);
    models[stem] = { elementId: result.elementId, assetId: result.assetId, figureId };
  }
  await core.setModelViewCommand(root, { target: models['cortex-states'].elementId, noPoster: true }, { states: { inflated: .35 } });
  await core.setModelViewCommand(root, { target: models['cell-sequence'].elementId, noPoster: true }, { frame: 2.5 });
  await core.setModelFieldCommand(root, { target: models['continuous-field'].elementId, noPoster: true }, { field: 'height.field', cmap: 'viridis', min: -1, max: 1 });
  await core.setCaption(root, figures[0].id, 'A named neuron-like triangle mesh, a cortex with inflated/bent shape states, and a live continuous value field. All three come from the public fluxplot scene3d example.');
  await core.setCaption(root, figures[1].id, 'Pial cortex (left) and inflated cortex (right) share indexed topology. The review deck morphs this corresponding pair with a shared-topology vertex flight.');
  await core.setCaption(root, figures[2].id, 'Eight ordered shape frames. The saved view is Frame 2.5, represented only by adjacent named weights.');
  const morph = await core.modelInfo(path.join(root, 'plots/cortex-pial.glb'), { morphWith: path.join(root, 'plots/cortex-inflated.glb') });
  if (!morph.ok || !('morph' in morph) || !morph.morph?.ok) throw new Error('Demo cortex pair lost morph correspondence');
  const reviewDeck = await createModel3dDemoDeck(root);
  const posters = options.posters ? await core.renderModelPosters(root) : undefined;
  if (posters) for (const poster of posters.posters) if (poster.path) poster.path = path.join(publishedRoot, path.relative(root, poster.path));
  await fs.writeFile(path.join(root, 'paper/notes.qmd'), '---\ntitle: Flux 3D review demo\nbibliography: ../references/library.bib\n---\n\n# Figure review\n\n@fig-model3d-overview shows the neuron, shape-state and continuous-field examples.\n\n@fig-model3d-morph contains the corresponding cortex pair.\n\n@fig-model3d-sequence contains the shape sequence.\n\n# Motion review\n\n' + reviewDeck.embed + '\n');
  const receipt = { root: publishedRoot, inputs: JSON.parse(await fs.readFile(path.join(root, 'plots/PROVENANCE.json'), 'utf8')), figures: figures.map(f => f.id), models, morphCompatible: true, deck: reviewDeck, posters: posters ?? null };
  await fs.writeFile(path.join(root, 'DEMO.json'), JSON.stringify(receipt, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'README.md'), `# Flux 3D scratch demo\n\nOpen this folder in the reviewed Flux build. Select Figure and the first overview. Double-click a mesh to orbit, use the Shape controls on cortex-states, and change the continuous-field range. The morph pair is in the second Figure.\n\nOpen Slides and choose Flux 3D · motion review. Its five slides cover Turntable, Shape change, Ghost, crossfade Become and vertex morph. Advance once from Design on each slide to play its motion. On Turntable, advance again to Dendrites appear: only the dendrites fade in, while soma and axon stay visible. The Paper contains this slide as a live embed. The generated source triplets and exact public Python example are in plots/. Recipes are valid, intentionally non-rerunnable descriptors from that example; rerun the copied script explicitly with an installed scene3d fluxplot environment. Source updates are explicit in Flux. See scripts/MODEL3D_DEMO.md in the Flux checkout for commands.\n\nDEMO.json records target IDs for agent commands. Cached posters are derived and may be regenerated.\n`);
  if (options.environment) await fs.writeFile(path.join(root, 'DEMO-ENV.json'), JSON.stringify({ environment: options.environment, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, FLUX_NO_MIGRATE: '1' }, null, 2) + '\n');
  return receipt;
}
