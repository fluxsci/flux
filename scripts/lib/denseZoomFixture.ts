// Portable saved-project reproduction of the dense zoom cull/remount storm.
// Assets are generated here; no owner project, font, URL or image is required.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildScaffoldTree } from '../../src/lib/project/scaffoldTree';
import { executeFigSave, planFigSave } from '../../src/lib/project/figfiles';
import { createDeck } from '../../src/lib/slide/ops';
import type { Figure, Project, SemanticPlotElement } from '../../src/lib/types';

export async function writeDenseZoomFixture(root: string) {
  const write = async (rel: string, text: string) => {
    const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  };
  const tree = buildScaffoldTree({ title: 'Portable dense zoom regression' }, createDeck({ id: 'dense-zoom-deck', title: 'Dense zoom', withTitleSlide: true }));
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, text] of tree.files) await write(rel, text);

  function svg(dense: boolean) {
    const circles = Array.from({ length: dense ? 2000 : 20 }, (_, i) => `<circle cx="${8 + i * 73 % 380}" cy="${8 + i * 47 % 280}" r="1.1" fill="#224466"/>`).join('');
    // Real semantic point art often has a stable one-leaf group around each
    // clipped path. 1,000 pairs + 2,000 circles keep the same 4,000-node panel
    // while reproducing 18,000 redundant paint clips across the whole scene.
    const clipped = dense ? Array.from({ length: 1000 }, (_, i) => `<g id="mark-${i}"><path clip-path="url(#axes-clip)" d="M${8 + i * 61 % 380} ${8 + i * 37 % 280}h.2" fill="none" stroke="#224466" stroke-width="2.2"/></g>`).join('') : '';
    // A small hidden semantic part reproduces the content-time bounds work
    // that was repeatedly forced by real plot remounts at each deep fold.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><defs><clipPath id="axes-clip"><rect width="400" height="300"/></clipPath></defs><g id="figure" data-role="figure"><g id="series.points" data-role="points">${clipped}${circles}</g><g id="hidden.panel" data-role="plot-area"><rect x="390" y="0" width="10" height="300" fill="#ff0000"/></g></g></svg>`;
  }
  const manifest = { schemaVersion: '0.3.0', spec: 'fluxplot', title: 'Deterministic point cloud', series: [{ id: 'series', svg: { points: 'series.points' } }] };
  for (const id of ['dense', 'small']) {
    await write(`fig/assets/zoom-${id}.svg`, svg(id === 'dense'));
    await write(`fig/assets/zoom-${id}.fluxplot.json`, JSON.stringify(manifest));
  }
  const plot = (frame: number, i: number): SemanticPlotElement => ({
    id: `dense-${frame}-${i}`, type: 'plot', assetId: 'zoom-dense', x: 30 + i % 3 * 220,
    y: 80 + Math.floor(i / 3) * 240, width: 200, height: 150, rotation: 0,
    overrides: i % 2 ? { 'hidden.panel': { hidden: true } } : {},
  });
  const figures: Figure[] = [0, 1].map(i => ({
    id: `zoom-frame-${i}`, canvasId: 'zoom-canvas', name: `Figure ${i + 1}`, referenceKey: `fig-zoom-${i}`, family: 'figure', number: i + 1,
    x: i * 1400, y: 0, width: i ? 4400 : 1200, height: 900, background: '#ffffff',
    elements: Array.from({ length: 9 }, (_, n) => plot(i, n)),
  }));
  // These live-eligible plots are inside the already mounted second frame but
  // beyond the initial mount AND hysteresis rectangles. They fit the bounded
  // detached supplement and must become ordinary live DOM after the wide fold.
  const supplementIDs = ['supplement-0', 'supplement-1'];
  for (const [i, id] of supplementIDs.entries()) figures[1].elements.push({
    id, type: 'plot', assetId: 'zoom-small', x: 3700 + i * 400, y: 200, width: 120, height: 90, rotation: 0,
  });
  figures[0].elements.push({ id: 'dense-edit-marker', name: 'Edit marker', type: 'rect', x: 1100, y: 790, width: 70, height: 70,
    rotation: 0, fill: '#f000c0', stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
  const project: Project = { version: 2, name: 'Dense zoom fixture', canvases: [{ id: 'zoom-canvas', name: 'Zoom canvas' }], figures,
    assets: ['dense', 'small'].map(id => ({ id: `zoom-${id}`, name: `Zoom ${id}`, kind: 'svg', path: `assets/zoom-${id}.svg`, naturalWidth: 400, naturalHeight: 300 })), palette: [] };
  await executeFigSave(planFigSave(project, null), { read: async rel => fs.readFile(path.join(root, rel), 'utf8').catch(() => null), write });
  await write('manuscript/main.qmd', '---\ntitle: Dense zoom regression\n---\n\nDisposable, self-contained verification project.\n');
  const receipt = { initialZoom: .6, densePlots: 18, marksPerPlot: 3000, denseMarks: 54000, densePrimitiveNodes: 72000, clippedWrappers: 18000, maxSceneNodes: 150000,
    frameIDs: figures.map(f => f.id), modelIDs: figures.flatMap(f => f.elements.map(e => e.id)), supplementIDs,
    markerID: 'dense-edit-marker', markerColor: [240, 0, 192], canvasPath: 'fig/canvases/zoom-canvas.json' };
  await write('dense-zoom-fixture.json', JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1]?.endsWith('denseZoomFixture.ts')) {
  if (!process.argv[2]) throw Error('Disposable project directory required');
  await writeDenseZoomFixture(process.argv[2]);
}
