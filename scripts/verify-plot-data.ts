#!/usr/bin/env -S npx tsx
// Colour-system plan F5 — `get-plot-data` / `get_plot_data`: a plot's data from its manifest.
//   • the pure reader returns the series (exact data, points, colour) and fluxplot's payloads —
//     the hexmatrix fixture's 27 bins with count / value / x / y — colour scales without their
//     tables (with, under --fields lut), axis domains and scales without pixel anchors, overlays
//     with a bracket's statistics, and the style block;
//   • --series narrows to one series (by id or name), --fields to sections, an unknown series is
//     refused;
//   • arrays longer than --limit are windowed from --offset and every cut is listed in `pages`
//     with its true length; short arrays pass whole; nested payload arrays page too;
//   • the CLI and the real MCP registry twin return the same document for a figure and a deck target.
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
import { plotData, paginate, DEFAULT_LIMIT, MAX_LIMIT } from '../src/lib/plot/plotData';
import { createDeck, addSlide, addElement } from '../src/lib/slide/ops';
import type { FluxPlotManifest } from '../src/lib/plot/types';
import type { SemanticPlotElement } from '../src/lib/types';

const h = harness('verify-plot-data'), root = await mkdtemp(join(tmpdir(), 'flux-plot-data-'));
const run = promisify(execFile), repo = resolve(import.meta.dirname, '..');
const fixtures = join(repo, 'scripts/fixtures/fluxplot03');
const cli = (...args: string[]) => run(...tsxRun(join(repo, 'flux-cli.ts'), [...args, '--root', root]), { cwd: repo, timeout: 90000 });
let client: Client | undefined;
try {
  const manifest = JSON.parse(await readFile(join(fixtures, 'presets.fluxplot.json'), 'utf8')) as FluxPlotManifest;

  // 1. the pure reader
  const all = plotData(manifest);
  h.eq(all.plotType, 'hexmatrix', 'plotType is reported');
  h.eq(all.series?.map(s => s.id), ['panel.counts.counts', 'panel.density.cloud'], 'every series is returned');
  const cloud = all.series!.find(s => s.id === 'panel.density.cloud')!;
  const bins = (cloud.hexmatrix as { bins: { count: number; value: number; x: number; y: number; svgId: string }[] }).bins;
  h.eq(bins.length, 27, 'the hexmatrix payload carries its 27 bins');
  h.ok(bins.every(b => typeof b.count === 'number' && typeof b.x === 'number' && typeof b.y === 'number' && b.svgId.startsWith('panel.density.cloud.hex.')), 'each bin has count, x, y and its svg id');
  h.eq(cloud.color, { hex: 'varies', scale: 'cloud' }, 'a colour-mapped series says so');
  const counts = all.series!.find(s => s.id === 'panel.counts.counts')!;
  h.ok(Array.isArray((counts.data as { x: unknown[] }).x) && (counts.bar as { length: number[] }).length.length === 3, 'a bar series carries data and its bar payload');
  h.ok(!('svg' in counts) && !('components' in counts) && !('capabilities' in counts), 'renderer bookkeeping (svg, components, capabilities) is left out');
  h.eq(all.colorScales?.length, 1, 'colour scales are returned');
  h.ok(!('lut' in (all.colorScales![0].colormap as object)) && (all.colorScales![0].colormap as { N: number }).N === 256, 'without the table, with its size');
  h.ok(Array.isArray(plotData(manifest, { fields: ['colorScales', 'lut'] }).colorScales![0].colormap && (plotData(manifest, { fields: ['colorScales', 'lut'] }).colorScales![0].colormap as { lut: string[] }).lut) && (plotData(manifest, { fields: ['colorScales', 'lut'] }).colorScales![0].colormap as { lut: string[] }).lut.length === 256, 'lut in fields keeps the 256-entry table');
  const ax = all.axes![0] as { id: string; x: { scale: string; domain: number[]; anchors?: unknown } };
  h.eq(ax.x.scale, 'linear', 'axis scale is reported');
  h.ok(Array.isArray(ax.x.domain) && ax.x.domain.length === 2, 'axis domain is reported');
  h.ok(!('anchors' in ax.x), 'pixel anchors are left out');
  const bracket = all.overlays!.find(o => o.role === 'significance-bracket')!;
  h.eq(bracket.between, ['a', 'b'], 'a bracket overlay names its pair');
  h.eq(bracket.p, 0.03, 'and its p');
  h.ok(!!all.style && typeof (all.style as { tokens: unknown }).tokens === 'object', 'the style block rides along');
  h.eq(all.pages, [], 'nothing was windowed at the default limit');
  // filters
  const one = plotData(manifest, { seriesId: 'cloud', fields: ['series'] });
  h.eq(one.series?.map(s => s.id), ['panel.density.cloud'], 'a series is selectable by name');
  h.ok(!one.colorScales && !one.axes && !one.overlays, 'fields narrows the sections');
  let threw = '';
  try { plotData(manifest, { seriesId: 'nope' }); } catch (e) { threw = (e as Error).message; }
  h.ok(threw.includes('Series not found'), 'an unknown series is refused with the known ids');
  // the 0.3.2 payloads, from real generator output (features.* — scripts/fixtures/fluxplot03/make_features.py)
  const features = JSON.parse(await readFile(join(fixtures, 'features.fluxplot.json'), 'utf8')) as FluxPlotManifest;
  const feat = plotData(features);
  const byId = Object.fromEntries(feat.series!.map(s => [s.id as string, s]));
  const reg = byId['panel.fit.dose'].regression as { kind: string; coefficients: number[]; r2: number; p: number; n: number; ci: number; grid: number[]; fit: number[] };
  h.eq([reg.kind, reg.coefficients.length, reg.n, reg.ci], ['linear', 2, 30, 0.95], 'a regression series carries its fit record');
  h.ok(reg.r2 > 0.5 && reg.p < 0.001 && reg.grid.length === 100 && reg.fit.length === 100, 'with R², p and the fitted curve');
  h.eq((byId['panel.fit.dose'].band as { what: string }).what, '95% CI', 'and its band names what it is');
  const kde = byId['panel.fit.density'].kde as { grid: number[]; density: number[]; bandwidth: number; n: number };
  h.ok(kde.grid.length === 200 && kde.density.length === 200 && kde.bandwidth > 0 && kde.n === 120, 'a kde series carries grid, density, bandwidth and n');
  h.eq((byId['panel.twin.state'].step as { where: string }).where, 'post', 'a step series carries where');
  h.eq(byId['panel.twin.temp'].axis, 'y2', 'a series on a twin says which value axis it reads');
  const twinAxes = feat.axes!.find(a => a.panelId === 'panel.twin') as { y2: { label: string; domain: number[] }; x2: { secondary: { of: string; samples: number[][] } }; x: { tickLocator: string; tickFormatter: string } };
  h.eq(twinAxes.y2.label, 'temperature (°C)', 'axes[].y2 is returned');
  h.ok(twinAxes.x2.secondary.of === 'x' && twinAxes.x2.secondary.samples.length >= 2, 'a secondary axis carries its sampled transform');
  h.eq([twinAxes.x.tickLocator, twinAxes.x.tickFormatter], ['auto', 'plain'], 'every axis carries its tick scheme');
  const barF = byId['panel.cells.means'].bar as { keys: string[]; center: number[]; width: number[] };
  h.eq(barF.keys, ['ctl', 'low', 'high'], 'bars carry their category keys');
  h.eq((byId['panel.cells.means'].uncertainty as { errShape: string }).errShape, 'symmetric', 'errorbars say their shape');
  const img = byId['panel.image.cells'].image as { channels: { name: string; scale: string }[]; pixelSize: number[]; units: string };
  h.eq(img.channels.map(c => c.name), ['dapi', 'gfp'], 'an image lists its channels');
  h.eq([img.pixelSize, img.units], [[0.5, 0.5], 'µm'], 'with pixel size and units');
  const alphaScale = feat.colorScales!.find(sc => sc.id === 'mean') as { alpha: { source: string; range: number[]; norm: { kind: string } } };
  h.eq([alphaScale.alpha.source, alphaScale.alpha.range, alphaScale.alpha.norm.kind], ['count', [0.3, 1], 'linear'], 'a colour scale returns its alpha channel');
  const stats = feat.overlays!.filter(o => o.role === 'significance-bracket').map(o => (o as { stats: { test: string; pCorrected: number; correction: string } }).stats);
  h.ok(stats.length === 3 && stats.every(s => s.test === "Welch's t-test" && s.correction === 'holm' && typeof s.pCorrected === 'number'), 'brackets carry the test behind their stars');
  h.eq((feat.overlays!.find(o => o.role === 'scalebar') as { length: number; units: string }).length, 2, 'a scale bar carries its length');
  const fig = feat.figure as { title: string; legends: string[]; annotations: { id: string; text: string }[]; background: string };
  h.eq([fig.title, fig.legends, fig.background], ['figure.title', ['figure.legend'], 'figure.background'], 'the figure block is returned');
  h.eq(fig.annotations, [{ id: 'figure.annotation.0', text: 'A' }], 'with its annotations');
  const figLegend = feat.guides!.find(g => g.id === 'figure.legend') as { entries: { text: string; series: string }[] };
  h.eq(figLegend.entries.filter(e => e.series).map(e => e.series), ['panel.fit.dose', 'panel.fit.density', 'panel.twin.rate', 'panel.twin.state', 'panel.twin.temp'], 'a figure legend joins its entries to panel-prefixed series (lines, fits, a twin series)');
  // known generator gap (fluxplot 1bc6f6a): a figure-legend entry standing for a BAR container has no series
  // (bar marks carry member ids, no group id, and figure_scope skips them); Flux tolerates the null.
  h.eq(figLegend.entries.find(e => e.text === 'Mean')?.series, undefined, 'the bar entry is left unjoined by the generator (documented gap)');
  h.eq(feat.panels!.length, 5, 'panels are returned');
  h.ok(!plotData(features, { fields: ['series'] }).figure, 'fields narrows figure and panels too');
  // stats on a bracket (synthetic on the presets fixture, whose bracket predates fp.brackets)
  const withStats = structuredClone(manifest);
  (withStats.overlays![1] as Record<string, unknown>).stats = { test: "Welch's t-test", p: 0.03, effectSize: 1.2, correction: 'holm' };
  h.eq((plotData(withStats, { fields: ['overlays'] }).overlays![1] as { stats: { test: string } }).stats.test, "Welch's t-test", 'a bracket\'s stats block is returned');

  // 2. pagination
  const big = structuredClone(manifest);
  const n = 5000;
  (big.series![0] as unknown as { data: { x: number[]; y: number[] } }).data = { x: Array.from({ length: n }, (_, i) => i), y: Array.from({ length: n }, (_, i) => i * 2) };
  (big.series![0] as unknown as { points: { index: number; svgId: string }[] }).points = Array.from({ length: n }, (_, i) => ({ index: i, svgId: `p.${i}` }));
  const page = plotData(big, { seriesId: 'panel.counts.counts', fields: ['series'], offset: 2000, limit: 1000 });
  const d = page.series![0].data as { x: number[]; y: number[] };
  h.eq([d.x.length, d.x[0], d.x.at(-1)], [1000, 2000, 2999], 'a long array is windowed from the offset');
  h.eq(d.y[0], 4000, 'every long array takes the same window');
  const pts = page.series![0].points as { index: number }[];
  h.eq([pts.length, pts[0].index], [1000, 2000], 'per-point records page too');
  h.eq(page.pages.map(p => p.path).sort(), ['series[panel.counts.counts].data.x', 'series[panel.counts.counts].data.y', 'series[panel.counts.counts].points'], 'every cut is listed by path');
  h.eq(page.pages[0], { path: page.pages[0].path, total: 5000, offset: 2000, limit: 1000, returned: 1000 }, 'with its true length and window');
  h.eq(((page.series![0].bar as { length: number[] }).length).length, 3, 'a short array passes whole even at an offset');
  h.eq(plotData(big, { limit: 50000 }).limit, MAX_LIMIT, 'the limit is capped');
  h.eq(plotData(big).limit, DEFAULT_LIMIT, 'the default limit is 1000');
  const tail = plotData(big, { seriesId: 'panel.counts.counts', fields: ['series'], offset: 4900, limit: 1000 });
  h.eq(((tail.series![0].data as { x: number[] }).x).length, 100, 'the last page is short');
  const nested = paginate({ rows: Array.from({ length: 12 }, (_, r) => Array.from({ length: 12 }, (_, c) => r * 12 + c)) }, 0, 5, 'field.values', []) as { rows: number[][] };
  h.eq([nested.rows.length, nested.rows[0].length], [5, 5], 'nested arrays (a value matrix) page in both dimensions');

  // 3. the CLI twin, figure and deck targets
  await core.scaffold(root, { title: 'Plot data' });
  await mkdir(join(root, 'plots'), { recursive: true });
  for (const ext of ['svg', 'fluxplot.json', 'recipe.json']) await copyFile(join(fixtures, `presets.${ext}`), join(root, `plots/presets.${ext}`));
  await core.createFigure(root, { id: 'fig-pd', name: 'Data' });
  await core.importPlots(root, 'fig-pd', [join(root, 'plots/presets.svg')]);
  const m = await loadFigModel(root);
  const el = m.project.figures.find(f => f.id === 'fig-pd')!.elements.find(e => e.type === 'plot') as SemanticPlotElement;
  const viaCli = JSON.parse((await cli('get-plot-data', 'fig-pd', el.id, '--series', 'panel.density.cloud', '--fields', 'series,axes')).stdout);
  h.eq(viaCli.elementId, el.id, 'the CLI names the plot it read');
  h.eq((viaCli.series[0].hexmatrix.bins as unknown[]).length, 27, 'the CLI returns the hexmatrix bins');
  h.ok(Array.isArray(viaCli.axes) && !viaCli.colorScales, 'CLI --fields narrows the sections');
  const noEl = JSON.parse((await cli('get-plot-data', 'fig-pd', '--limit', '10')).stdout);
  h.eq(noEl.elementId, el.id, 'elementId may be omitted when the figure has one plot');
  h.ok(noEl.pages.some((p: { path: string; total: number }) => p.path === 'series[panel.density.cloud].hexmatrix.bins' && p.total === 27), 'the CLI windows the bins at --limit 10 and reports the cut');
  const deck = createDeck({ id: 'talk', title: 'Data', withTitleSlide: false }), slide = addSlide(deck, { layout: 'blank' });
  addElement(deck, slide.id, structuredClone(el));
  await core.saveDeck(root, deck);
  const viaDeck = JSON.parse((await cli('get-plot-data', `talk/${slide.id}`, el.id, '--fields', 'series')).stdout);
  h.eq(viaDeck.series.length, 2, 'a deck target reads the slide\'s copy');
  try { await cli('get-plot-data', 'fig-pd', el.id, '--series', 'nope'); h.fail('unknown series rejected'); } catch { h.ok(true, 'unknown series rejected'); }

  // 4. the real MCP registry twin
  const [cmd, args] = tsxRun('flux-mcp.ts', [root, '--toolset', 'full']);
  client = new Client({ name: 'verify-plot-data', version: '0' });
  await client.connect(new StdioClientTransport({ command: cmd, args, cwd: repo, env: { ...process.env, FLUX_NO_MIGRATE: '1', FLUX_MCP_TOOLSET: 'full' } as Record<string, string> }));
  const res = await client.callTool({ name: 'get_plot_data', arguments: { target: 'fig-pd', elementId: el.id, seriesId: 'panel.density.cloud', fields: ['series', 'axes'] } });
  h.ok(!res.isError, 'MCP get_plot_data succeeds');
  const mcpDoc = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}');
  h.eq(mcpDoc, viaCli, 'MCP and CLI return the same document');
  h.ok(core.plotData === plotData, 'headless exports share the reader');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done(async () => { await client?.close(); await rm(root, { recursive: true, force: true }); });
