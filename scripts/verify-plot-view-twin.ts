#!/usr/bin/env -S npx tsx
// Colour-system plan C4 (Flux half) — a twin value axis is its own view key:
//   • `viewFits` returns a `y2` (and `x2`) fit when the panel has a twin axis (fluxplot
//     `axes[].y2` / `.x2`: ax.twinx(), a secondary axis), and honours `view.y2` on its own;
//   • `applyPlotView` re-projects a series with `axis: "y2"` through the twin's domain while the
//     primary series stays put, and moves the twin's own ticks (`axis.y2.tick.k`);
//   • the controls (`plotViewPatch`, `setPlotView`) accept `y2Min` / `y2Max` / `y2Scale`,
//     normalise generator defaults back to absence and refuse a key the plot lacks;
//   • `plotViewIssues` says nothing about a twin series it can project.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOMParser, parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import type { FluxPlotManifest } from '../src/lib/plot/types';
import type { PlotView, Project, SemanticPlotElement } from '../src/lib/types';
import { viewFits, seriesFits, projectWith, guideData, plotViewIssues, seriesVertices } from '../src/lib/plot/project';
import { applyPlotView, restoreProjection } from '../src/lib/plot/projectDom';
import { preparePlot } from '../src/lib/plot/parse';
import { plotViewPatch, plotAxisKeys } from '../src/lib/plot/viewControls';
import { setPlotView } from '../src/lib/ops';

const { document } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { document, DOMParser });
const h = harness('verify-plot-view-twin');
const repo = resolve(import.meta.dirname, '..'), fixtures = join(repo, 'scripts/fixtures/fluxplot03');
const manifest = JSON.parse(readFileSync(join(fixtures, 'features.fluxplot.json'), 'utf8')) as FluxPlotManifest;
const svg = readFileSync(join(fixtures, 'features.svg'), 'utf8');
const nums = (d: string | null | undefined) => (d ?? '').match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
const pathOf = (root: Element, id: string) => { const n = root.querySelector(`[id="${id}"]`); return (n?.tagName.toLowerCase() === 'path' ? n : n?.querySelector('path'))?.getAttribute('d') ?? null; };
const near = (a: number, b: number, msg: string, eps = 1e-4) => h.ok(Number.isFinite(a) && Math.abs(a - b) < eps, `${msg}: ${a} ≈ ${b}`);
try {
  const twinAxes = manifest.axes.find(a => a.panelId === 'panel.twin')! as unknown as { y2: { domain: number[]; anchors: { data: number; svg: number }[] }; x2: { domain: number[] }; y: { domain: number[] } };
  h.ok(!!twinAxes.y2 && !!twinAxes.x2, 'the fixture panel has a y2 (twinx) and an x2 (secondary) axis');
  const raw = viewFits(manifest, undefined, 'panel.twin')!;
  h.ok(!!raw.y2, 'viewFits returns a fit for the twin (y2) axis');
  h.ok(!raw.x2 && (twinAxes.x2 as { supported?: boolean }).supported === false, 'a secondary axis on a functional scale (no anchors) is not viewable on its own: it follows its parent');
  h.eq(plotAxisKeys({ axes: [manifest.axes.find(a => a.panelId === 'panel.twin')!] } as unknown as FluxPlotManifest), ['x', 'y', 'y2'], 'the panel offers three view keys (the secondary axis is not one)');
  h.eq(plotAxisKeys({ axes: [manifest.axes.find(a => a.panelId === 'panel.fit')!] } as unknown as FluxPlotManifest), ['x', 'y'], 'a plain panel offers two');
  const temp = manifest.series.find(s => s.id === 'panel.twin.temp')!, rate = manifest.series.find(s => s.id === 'panel.twin.rate')!;
  h.eq((temp as { axis?: string }).axis, 'y2', 'the temperature series reads the twin axis');
  const [lo, hi] = twinAxes.y2.domain;
  const view: PlotView = { y2: { domain: [lo, lo + (hi - lo) / 2] } };
  const fits = viewFits(manifest, view, 'panel.twin')!;
  h.ok(!!fits.y2 && fits.y2.m !== raw.y2!.m, 'a y2 view changes only the twin fit');
  h.ok(fits.y.m === raw.y.m && fits.y.c === raw.y.c && fits.x.m === raw.x.m, 'the panel\'s own fits are untouched');
  const sTemp = seriesFits(fits, 'y2')!, sRate = seriesFits(fits, undefined)!;
  h.ok(sTemp.y === fits.y2 && sRate.y === fits.y, 'seriesFits picks the twin fit for a y2 series');
  h.eq(seriesFits({ x: fits.x, y: fits.y }, 'y2'), null, 'a y2 series without a twin fit cannot project');
  const twinOnly = { ...manifest, axes: [manifest.axes.find(a => a.panelId === 'panel.twin')!], series: manifest.series.filter(s => s.panelId === 'panel.twin') } as unknown as FluxPlotManifest;
  h.eq(plotViewIssues(twinOnly, view).filter(i => i.includes('twin')), [], 'no twin-axis issue for a view the plot can project');

  // the DOM: the temperature line moves, the rate line does not, the y2 ticks move
  const { root } = preparePlot(svg, manifest);
  const before = { temp: pathOf(root!, 'panel.twin.temp.line'), rate: pathOf(root!, 'panel.twin.rate.line') };
  const guides = guideData(manifest, root!);
  const y2Ticks = [...guides].filter(([leaf, g]) => g.axis === 'y2' && /\.tick\.\d+$/.test(leaf));
  h.ok(y2Ticks.length >= 2, `the twin's ticks are recovered as y2 guides (${y2Ticks.length})`);
  h.ok(![...guides.values()].some(g => g.axis === 'x2'), 'the unsupported secondary axis contributes no guides (its ticks stay put)');
  applyPlotView(root!, manifest, view, '');
  const after = { temp: pathOf(root!, 'panel.twin.temp.line'), rate: pathOf(root!, 'panel.twin.rate.line') };
  const rateBefore = nums(before.rate), rateAfter = nums(after.rate);
  h.ok(rateBefore.length === rateAfter.length && rateBefore.every((v, i) => Math.abs(v - rateAfter[i]) < 1e-3), 'the primary series keeps its geometry');
  h.ok(after.temp !== before.temp, 'the twin series is re-projected');
  const v0 = seriesVertices(temp)[0];
  near(nums(after.temp)[1], projectWith(fits.y2!, v0.y), 'its first vertex sits at the twin fit\'s projection of its data');
  near(nums(after.temp)[0], projectWith(fits.x, v0.x), 'and keeps its x');
  // at rest the twin axis is re-ticked for its new domain (F4); the primary axes are not
  const [tickLeaf] = y2Ticks[0];
  h.eq((root!.querySelector(`[id="${tickLeaf}"]`) as SVGElement).style.display, 'none', 'a generated y2 tick is hidden');
  const y2Clones = Array.from(root!.querySelectorAll('[data-projection-tick][id*="axis.y2.tick."]'));
  h.ok(y2Clones.length >= 2, `the y2 axis is re-ticked (${y2Clones.length} ticks)`);
  h.ok(!root!.querySelector('[data-projection-tick][id*="axis.y.tick."]') && !root!.querySelector('[data-projection-tick][id*="axis.x.tick."]'), 'the primary axes keep their ticks');
  const xTick = [...guides].find(([, g]) => g.axis === 'x')!;
  h.ok(!root!.querySelector(`[id="${xTick[0]}"]`)!.getAttribute('transform')?.startsWith('translate'), 'an x tick is left alone by a y2 view');
  // in a tween the generated y2 ticks move by the twin fit's displacement instead
  restoreProjection(root!);
  applyPlotView(root!, manifest, view, '', { t: 1 });
  const [, tickGuide] = y2Ticks[0];
  const transform = root!.querySelector(`[id="${tickLeaf}"]`)!.getAttribute('transform') ?? '';
  const expectedDy = projectWith(fits.y2!, tickGuide.value) - projectWith(raw.y2!, tickGuide.value);
  const m = /translate\(([-\d.e+]+) ([-\d.e+]+)\)/.exec(transform);
  h.ok(!!m, `a y2 tick is translated in a tween (${transform.slice(0, 40)})`);
  if (m) near(Number(m[2]), expectedDy, 'by the twin fit\'s displacement of its value', 1e-3);
  restoreProjection(root!);
  h.eq(pathOf(root!, 'panel.twin.temp.line'), before.temp, 'restore puts the twin series back');

  // controls and the op
  const twinManifest = { ...manifest, axes: [manifest.axes.find(a => a.panelId === 'panel.twin')!], series: manifest.series.filter(s => s.panelId === 'panel.twin') } as unknown as FluxPlotManifest;
  const patch = plotViewPatch(undefined, twinManifest, { y2Min: lo, y2Max: lo + 1 })!;
  h.eq(patch, { y2: { domain: [lo, lo + 1] } }, 'plotViewPatch accepts y2 limits');
  let threw = '';
  try { plotViewPatch(undefined, twinManifest, { x2Scale: 'linear' }); } catch (e) { threw = (e as Error).message; }
  h.ok(threw.length > 0, `an x2 field on the unviewable secondary axis is refused (${threw.slice(0, 60)})`);
  threw = '';
  try { plotViewPatch(undefined, { ...twinManifest, axes: [manifest.axes.find(a => a.panelId === 'panel.fit')!] } as unknown as FluxPlotManifest, { y2Min: 1 }); } catch (e) { threw = (e as Error).message; }
  h.ok(threw.includes('no y2 axis'), `a plot without a twin refuses y2 fields (${threw})`);
  const el = { id: 'p1', type: 'plot', assetId: 'a' } as unknown as SemanticPlotElement;
  const project = { figures: [{ id: 'f', elements: [el] }] } as unknown as Project;
  setPlotView(project, 'p1', { y2: { domain: [lo, lo + 1], scale: 'linear' } }, twinManifest.axes[0]);
  h.eq(el.view, { y2: { domain: [lo, lo + 1] } }, 'setPlotView keeps a y2 domain and drops the default scale');
  setPlotView(project, 'p1', { y2: { domain: [lo, hi] } }, twinManifest.axes[0]);
  h.eq(el.view, undefined, 'a y2 domain equal to the generator default clears the view');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done();
