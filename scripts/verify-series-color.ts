#!/usr/bin/env -S npx tsx
// Colour-system plan B2 (Flux half) — one colour for a whole series:
//   • `plot/seriesColor` names every part a series is drawn by (svg.*, components + members,
//     points) plus its legend swatch, each with the paint it takes (a line its stroke, a bar its
//     fill, markers and swatches both faces); a colour-mapped series is refused;
//   • `ops.setSeriesColor` writes one override per part and null clears exactly those keys;
//   • the `set-series-color` CLI persists exactly the shared op's result, --clear restores, a
//     deckId/slideId target edits Design, and the real MCP registry twin persists the same bytes;
//   • plan F6: `restyle` of a series' whole line / points also writes its legend swatch, while a
//     single bar or point (a highlight) leaves the key alone.
import { mkdtemp, readFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { harness } from './lib/harness.mjs';
import { tsxRun } from './lib/tsxRun.mjs';
import * as core from '../flux-core/index';
import { loadFigModel } from '../flux-core/model';
import { setSeriesColor, setPartOverride } from '../src/lib/ops';
import { seriesParts, seriesPartIds, legendSwatchesOf, seriesColorPatch, seriesColorIssue, seriesOf, seriesPrimaryOf, paintForRole, swatchMirror } from '../src/lib/plot/seriesColor';
import { createDeck, addSlide, addElement } from '../src/lib/slide/ops';
import type { FluxPlotManifest } from '../src/lib/plot/types';
import type { Project, SemanticPlotElement } from '../src/lib/types';

const h = harness('verify-series-color'), root = await mkdtemp(join(tmpdir(), 'flux-series-color-'));
const run = promisify(execFile), repo = resolve(import.meta.dirname, '..');
const fixtures = join(repo, 'scripts/fixtures/fluxplot03');
const cli = (...args: string[]) => run(...tsxRun(join(repo, 'flux-cli.ts'), [...args, '--root', root]), { cwd: repo, timeout: 90000 });
const rejects = async (args: string[], why: string) => { try { await cli(...args); h.fail(`${why} rejected`); } catch { h.ok(true, `${why} rejected`); } };
let client: Client | undefined;
try {
  const bars = JSON.parse(await readFile(join(fixtures, 'presets.fluxplot.json'), 'utf8')) as FluxPlotManifest;
  const lines = JSON.parse(await readFile(join(fixtures, 'panels-a.fluxplot.json'), 'utf8')) as FluxPlotManifest;

  // 1. the pure part model
  const barIds = seriesPartIds(bars, 'panel.counts.counts');
  h.ok(barIds.length === 3 && barIds.every(id => /\.bar\.\d$/.test(id)), `a bar series is its bars (${barIds.join(', ')})`);
  h.eq(legendSwatchesOf(bars, 'panel.counts.counts'), ['panel.counts.legend.entry.0.swatch'], 'the legend swatch is found through entries[].series');
  const barParts = seriesParts(bars, 'panel.counts.counts');
  h.eq(barParts.map(p => p.paint), ['fill', 'fill', 'fill', 'both'], 'bars take a fill, the swatch both faces');
  h.eq(seriesColorPatch(bars, 'panel.counts.counts', '#ff0000')['panel.counts.counts.bar.1'], { fill: '#ff0000' }, 'a bar patch is fill only');
  h.eq(seriesColorPatch(bars, 'panel.counts.counts', '#ff0000')['panel.counts.legend.entry.0.swatch'], { fill: '#ff0000', stroke: '#ff0000' }, 'a swatch patch paints both');
  h.eq(seriesColorPatch(bars, 'panel.counts.counts', null)['panel.counts.counts.bar.0'], { fill: null }, 'null clears the same keys');
  h.ok(!!seriesColorIssue(bars, 'panel.density.cloud')?.includes('colour scale'), 'a colour-mapped series (hexmatrix) is refused with a pointer to its scale');
  h.ok(!!seriesColorIssue(bars, 'nope')?.includes('not found'), 'an unknown series is refused');
  h.eq(seriesColorIssue(bars, 'panel.counts.counts'), null, 'a plain series is fine');
  const lineParts = seriesParts(lines, 'panel.small.control');
  h.eq(lineParts.find(p => p.partId === 'panel.small.control.line')?.paint, 'stroke', 'a line takes its stroke');
  h.eq(lineParts.find(p => p.partId === 'panel.small.control.points')?.paint, 'both', 'the points group takes both faces');
  h.ok(lineParts.some(p => p.partId === 'panel.small.control.point.0' && p.paint === 'both'), 'every point is named');
  h.eq(legendSwatchesOf(lines, 'panel.small.control'), [], 'no legend, no swatch');
  h.eq(paintForRole('errorbar', 'line'), 'stroke', 'error bars take a stroke');
  h.eq(paintForRole('area', 'shape'), 'fill', 'an area takes a fill');
  h.eq(paintForRole('tick-label', 'text'), null, 'text takes no series colour');
  h.eq(seriesOf(bars, 'panel.counts.counts.bar.2'), 'panel.counts.counts', 'seriesOf resolves a member');
  h.eq(seriesPrimaryOf(bars, 'panel.counts.counts.bar.2'), undefined, 'one bar is not the whole series');
  h.eq(seriesPrimaryOf(lines, 'panel.small.control.line'), 'panel.small.control', 'a series line is the whole series');
  h.eq(swatchMirror({ stroke: '#123456', strokeWidth: 3 }), { fill: '#123456', stroke: '#123456' }, 'a stroke mirrors onto both swatch faces');
  h.eq(swatchMirror({ hidden: true }), null, 'hiding a part leaves its key alone');

  // 2. the op on a project
  const plot = { id: 'p1', type: 'plot', assetId: 'a', x: 0, y: 0, width: 10, height: 10 } as unknown as SemanticPlotElement;
  const project = { figures: [{ id: 'f', elements: [plot] }] } as unknown as Project;
  const patch = setSeriesColor(project, 'p1', bars, 'panel.counts.counts', '#ff0000');
  h.eq(Object.keys(patch).length, 4, 'the op reports four parts');
  h.eq(plot.overrides?.['panel.counts.counts.bar.0'], { fill: '#ff0000' }, 'the bar override landed');
  h.eq(plot.overrides?.['panel.counts.legend.entry.0.swatch'], { fill: '#ff0000', stroke: '#ff0000' }, 'the swatch override landed');
  setSeriesColor(project, 'p1', bars, 'panel.counts.counts', null);
  h.ok(!plot.overrides, 'clearing removes every override it wrote');
  let threw = '';
  try { setSeriesColor(project, 'p1', bars, 'panel.density.cloud', '#ff0000'); } catch (e) { threw = (e as Error).message; }
  h.ok(threw.includes('colour scale'), 'the op refuses a colour-mapped series');
  // F6 coupling through setPartOverride
  const linePlot = { id: 'p2', type: 'plot', assetId: 'b', x: 0, y: 0, width: 10, height: 10 } as unknown as SemanticPlotElement;
  const withLegend = structuredClone(lines);
  withLegend.guides = [...(withLegend.guides ?? []), { id: 'panel.small.legend', svgId: 'panel.small.legend', role: 'legend', entries: [{ series: 'panel.small.control', swatch: 'panel.small.legend.entry.0.swatch', label: 'panel.small.legend.entry.0.label', text: 'Control' }] } as unknown as NonNullable<FluxPlotManifest['guides']>[number]];
  const proj2 = { figures: [{ id: 'f', elements: [linePlot] }] } as unknown as Project;
  setPartOverride(proj2, 'p2', 'panel.small.control.line', { stroke: '#00aa00' }, withLegend);
  h.eq(linePlot.overrides?.['panel.small.legend.entry.0.swatch'], { fill: '#00aa00', stroke: '#00aa00' }, 'restyling the series line writes its legend swatch');
  setPartOverride(proj2, 'p2', 'panel.small.control.point.0', { fill: '#ff00ff' }, withLegend);
  h.eq(linePlot.overrides?.['panel.small.legend.entry.0.swatch'], { fill: '#00aa00', stroke: '#00aa00' }, 'highlighting one point leaves the key alone');

  // 3. the CLI twin on a real project
  await core.scaffold(root, { title: 'Series colours' });
  await mkdir(join(root, 'plots'), { recursive: true });
  for (const ext of ['svg', 'fluxplot.json', 'recipe.json']) await copyFile(join(fixtures, `presets.${ext}`), join(root, `plots/presets.${ext}`));
  await core.createFigure(root, { id: 'fig-sc', name: 'Series' });
  await core.importPlots(root, 'fig-sc', [join(root, 'plots/presets.svg')]);
  const read = async () => { const m = await loadFigModel(root); return { m, el: m.project.figures.find(f => f.id === 'fig-sc')!.elements.find(e => e.type === 'plot') as SemanticPlotElement }; };
  const original = await read(), id = original.el.id;
  const expected = structuredClone(original.m.project);
  setSeriesColor(expected, id, bars, 'panel.counts.counts', '#ff0000');
  const out = JSON.parse((await cli('set-series-color', 'fig-sc', 'panel.counts.counts', '#FF0000', '--element', id)).stdout || '{}');
  void out;
  const live = (await read()).el;
  h.eq(live.overrides, expected.figures.find(f => f.id === 'fig-sc')!.elements.find(e => e.id === id)!.overrides, 'CLI writes exactly the shared op result (colour lower-cased)');
  await cli('set-series-color', 'fig-sc', 'panel.counts.counts', '#00ff00'); // elementId omitted: one plot
  h.eq((await read()).el.overrides?.['panel.counts.counts.bar.2'], { fill: '#00ff00' }, 'elementId may be omitted when the figure has one plot');
  await rejects(['set-series-color', 'fig-sc', 'panel.density.cloud', '#ff0000'], 'a colour-mapped series');
  await rejects(['set-series-color', 'fig-sc', 'panel.counts.counts', 'red'], 'a non-hex colour');
  await rejects(['set-series-color', 'fig-sc', 'panel.counts.counts'], 'no colour and no --clear');
  h.eq((await read()).el.overrides?.['panel.counts.counts.bar.2'], { fill: '#00ff00' }, 'refusals leave the saved bytes unchanged');
  await cli('set-series-color', 'fig-sc', 'panel.counts.counts', '--clear');
  h.ok(!(await read()).el.overrides, '--clear restores the generated colours');
  // restyle of a member bar does not touch the key; the legend entry stays generated
  await cli('restyle', 'fig-sc', 'panel.counts.counts.bar.0', '--fill', '#123456');
  const afterRestyle = (await read()).el.overrides ?? {};
  h.eq(afterRestyle['panel.counts.counts.bar.0'], { fill: '#123456' }, 'restyle writes the bar');
  h.ok(!afterRestyle['panel.counts.legend.entry.0.swatch'], 'one bar is a highlight: the swatch is untouched');

  // 4. a deck target edits Design
  const deck = createDeck({ id: 'talk', title: 'Series', withTitleSlide: false }), slide = addSlide(deck, { layout: 'blank' });
  addElement(deck, slide.id, structuredClone({ ...original.el, overrides: undefined }));
  await core.saveDeck(root, deck);
  await cli('set-series-color', `talk/${slide.id}`, 'panel.counts.counts', '#0000ff', '--element', id);
  const disk = JSON.parse(await readFile(join(root, 'slides/talk/deck.json'), 'utf8'));
  h.eq(disk.slides[0].elements.find((e: { id: string }) => e.id === id).overrides['panel.counts.legend.entry.0.swatch'], { fill: '#0000ff', stroke: '#0000ff' }, 'deck Design persists the series colour (swatch included)');

  // 5. the real MCP registry twin
  const [cmd, args] = tsxRun('flux-mcp.ts', [root, '--toolset', 'full']);
  client = new Client({ name: 'verify-series-color', version: '0' });
  await client.connect(new StdioClientTransport({ command: cmd, args, cwd: repo, env: { ...process.env, FLUX_NO_MIGRATE: '1', FLUX_MCP_TOOLSET: 'full' } as Record<string, string> }));
  const expectedMcp = structuredClone((await read()).m.project);
  setSeriesColor(expectedMcp, id, bars, 'panel.counts.counts', '#abcdef');
  const response = await client.callTool({ name: 'set_series_color', arguments: { target: 'fig-sc', elementId: id, seriesId: 'panel.counts.counts', color: '#abcdef' } });
  h.ok(!response.isError, 'MCP set_series_color succeeds');
  h.eq((await read()).el.overrides, expectedMcp.figures.find(f => f.id === 'fig-sc')!.elements.find(e => e.id === id)!.overrides, 'the MCP twin persists the same bytes as the op');
  const cleared = await client.callTool({ name: 'set_series_color', arguments: { target: 'fig-sc', elementId: id, seriesId: 'panel.counts.counts', clear: true } });
  h.ok(!cleared.isError && !(await read()).el.overrides, 'MCP clear restores');
  h.ok(core.setSeriesColor === setSeriesColor && core.seriesColorPatch === seriesColorPatch, 'headless exports share the authoring implementation');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done(async () => { await client?.close(); await rm(root, { recursive: true, force: true }); });
