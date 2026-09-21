import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { planFigSave } from '../src/lib/project/figfiles';
import { renderFigureSvg, materializeRenders } from '../flux-core/render';
import type { Project, SemanticPlotElement } from '../src/lib/types';
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-render-manifest-'));
const root = path.join(base, 'project'), outside = path.join(base, 'external');
await fs.mkdir(root); await fs.mkdir(outside);
const sidecar = { spec: 'fluxplot', schemaVersion: '0.1.0', plotType: 'fixture', svg: 'input.svg', size: { width: 40, height: 20, unit: 'px' }, axes: [], series: [], parts: { id: 'root', role: 'container', children: [{ id: 'scientific-series', role: 'group', members: ['data-point'] }] } };
const externalManifest = path.join(outside, 'source.fluxplot.json');
await fs.writeFile(externalManifest, JSON.stringify(sidecar));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect id="data-point" width="40" height="20" fill="black"/></svg>';
const model: Project = { version: 2, name: 'Fixture', canvases: [{ id: 'c', name: 'Canvas' }], figures: [{ id: 'f', canvasId: 'c', name: 'Figure', x: 0, y: 0, width: 40, height: 20, elements: [{ id: 'p', type: 'plot', assetId: 'a', x: 0, y: 0, width: 40, height: 20, rotation: 0, source: { svgPath: 'plots/missing.svg', manifestPath: 'plots/source.fluxplot.json' }, overrides: { 'scientific-series': { fill: '#ff0000' } } }] }], assets: [{ id: 'a', name: 'Scientific plot', kind: 'svg', path: 'assets/a.svg', naturalWidth: 40, naturalHeight: 20 }], palette: [] };
async function save() { const plan = planFigSave(model, null); for (const item of [...plan.canvases, ...plan.captions, plan.index]) { await fs.mkdir(path.dirname(path.join(root, item.path)), { recursive: true }); await fs.writeFile(path.join(root, item.path), item.text); } }
const source = (model.figures[0].elements[0] as SemanticPlotElement).source!;
let checks = 0; const ok = (label: string) => { checks++; console.log('✓ ' + label); };
function red(markup: string) { assert.match(markup, /id="p__data-point"[^>]*style="[^"]*fill:#ff0000|style="[^"]*fill:#ff0000[^>]*id="p__data-point"/, 'group semantic override survives exported SVG'); }
try {
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ schemaVersion: '0.1.0', id: 'p', title: 'Fixture', manuscript: { path: 'paper/main.qmd' }, references: { library: 'bib/library.bib' }, figures: [] }));
  await save(); await fs.mkdir(path.join(root, 'fig/assets')); await fs.writeFile(path.join(root, 'fig/assets/a.svg'), svg); await fs.mkdir(path.join(root, 'plots'));
  await fs.writeFile(path.join(root, 'plots/source.fluxplot.json'), JSON.stringify(sidecar));
  red(await renderFigureSvg(root, 'f')); ok('legacy project-relative manifest fallback preserves group overrides in exported markup');
  await fs.rename(path.join(root, 'plots/source.fluxplot.json'), path.join(root, 'plots/actual.fluxplot.json'));
  await fs.symlink('actual.fluxplot.json', path.join(root, 'plots/source.fluxplot.json'));
  red(await renderFigureSvg(root, 'f')); ok('symlink wholly inside project remains compatible');
  await fs.rm(path.join(root, 'plots/source.fluxplot.json')); await fs.symlink(externalManifest, path.join(root, 'plots/source.fluxplot.json'));
  let externalReads = 0; const originalRead = fs.readFile;
  (fs as any).readFile = async (file: string, ...args: unknown[]) => { if (String(file) === externalManifest || String(file) === path.join(root, 'plots/source.fluxplot.json')) externalReads++; return (originalRead as Function)(file, ...args); }; syncBuiltinESMExports();
  try { await assert.rejects(renderFigureSvg(root, 'f'), /symlink escapes/); } finally { (fs as any).readFile = originalRead; syncBuiltinESMExports(); }
  assert.equal(externalReads, 0); ok('project-relative manifest symlink to another root is refused before any source bytes are read');
  await fs.mkdir(path.join(root, 'fig/renders')); const published = path.join(root, 'fig/renders/f.svg'); await fs.writeFile(published, 'prior complete export bytes');
  const result = await materializeRenders(root); assert.equal(result.wrote, 0); assert.deepEqual(result.failed, ['f']); assert.equal(await fs.readFile(published, 'utf8'), 'prior complete export bytes'); ok('actual materialization reports failed figure and preserves prior saved export bytes');
  await fs.rm(path.join(root, 'plots/source.fluxplot.json')); await fs.writeFile(path.join(root, 'plots/source.fluxplot.json'), '{');
  await assert.rejects(renderFigureSvg(root, 'f'), /JSON|property|Unexpected/); ok('existing corrupt semantic sidecar cannot silently become a derived plot');
  source.svgPath = path.join(outside, 'explicit.svg'); source.manifestPath = externalManifest; source.external = true; await save();
  await fs.writeFile(path.join(root, 'fig/assets/a.fluxplot.json'), JSON.stringify(sidecar));
  red(await renderFigureSvg(root, 'f')); ok('explicit external source imports render faithfully from their copied asset-local manifest');
  await fs.rm(path.join(root, 'fig/assets/a.fluxplot.json')); await fs.symlink(externalManifest, path.join(root, 'fig/assets/a.fluxplot.json'));
  await assert.rejects(renderFigureSvg(root, 'f'), /symlink escapes/); ok('asset-local manifest also rejects escaping symlink instead of hiding read failure');
  console.log(`RENDER MANIFEST CONFINEMENT: PASS (${checks} checks)`);
} finally { await fs.rm(base, { recursive: true, force: true }); }
