#!/usr/bin/env -S npx tsx
// Colour-system plan F6 — hover readouts: one pure text builder (plot/readout.ts) says what a
// plot part IS in data terms, from the manifest and the node's data-* attributes, for the Figure
// canvas' deep-hover box and the X-ray tree alike:
//   • a point → x / y; a bar → its category (the axis tick label) and height; a hexagon → its
//     count and centre; a heatmap cell → its value (missing when data-missing); a contour band →
//     its levels; a significance bracket → the test, p (with its correction) and effect size;
//   • a series root → the point count, y range, recorded statistics (glowbar / fluxbox), band
//     kind, image channels and colour; a legend swatch → its series; a colorbar → its scale;
//   • scaffold (ticks, spines) says nothing (null), so the affordance stays quiet there.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { partReadout, readoutText, nodeAttrs } from '../src/lib/plot/readout';
import type { FluxPlotManifest } from '../src/lib/plot/types';

const h = harness('verify-plot-readout');
const repo = resolve(import.meta.dirname, '..'), fixtures = join(repo, 'scripts/fixtures/fluxplot03');
const load = (n: string) => JSON.parse(readFileSync(join(fixtures, `${n}.fluxplot.json`), 'utf8')) as FluxPlotManifest;
try {
  const presets = load('presets'), lines = load('panels-a'), fields = load('fields');
  // bars: category + height
  const bar1 = partReadout(presets, 'panel.counts.counts.bar.1')!;
  h.eq(bar1.title, 'Counts · bar 1', 'a bar names its series and index');
  h.eq(bar1.lines, ['x = b', 'height 5'], 'a bar reads its axis category and its height');
  // hexagons
  const hex = partReadout(presets, 'panel.density.cloud.hex.1.2')!;
  h.ok(hex.title.startsWith('cloud · hexagon 1,2'), `a hexagon names its row and column (${hex.title})`);
  h.ok(hex.lines[0].startsWith('x = -0.4629, y = -1.888'), `a hexagon reads its centre (${hex.lines[0]})`);
  h.eq(hex.lines[1], 'count 3', 'and its count');
  // points from the line fixture
  const pt = partReadout(lines, 'panel.small.control.point.4')!;
  h.eq(pt.title, 'Control · point 4', 'a point names its series (by label) and index');
  h.ok(/^x = .+, y = .+$/.test(pt.lines[0]), `a point reads x and y (${pt.lines[0]})`);
  // a series root
  const root = partReadout(lines, 'panel.small.control.line')!;
  h.eq(root.title, 'Control · line', 'a series line names the series and kind');
  h.ok(/^\d+ points, y .+ … .+$/.test(root.lines[0]), `a series reads its point count and y range (${root.lines[0]})`);
  h.ok(root.lines.some(l => l.startsWith('colour #')), 'and its colour');
  // a heatmap cell: the DOM value first, the field matrix as fallback, missing stated
  const cellSeries = fields.series.find(s => s.field?.kind === 'heatmap')!;
  const cellId = `${cellSeries.id}.cell.1.2`;
  const cell = partReadout(fields, cellId, { 'data-value': '0.25' })!;
  h.eq(cell.lines, ['value 0.25', 'row 1, column 2'], 'a cell reads data-value and its position');
  const missing = partReadout(fields, cellId, { 'data-missing': '1' })!;
  h.eq(missing.lines[0], 'value missing', 'a missing cell says so');
  const fromMatrix = partReadout(fields, `${cellSeries.id}.cell.0.0`)!;
  h.ok(fromMatrix.lines[0].startsWith('value '), `without a DOM value the field matrix answers (${fromMatrix.lines[0]})`);
  // contour bands
  const contour = fields.series.find(s => s.field?.kind === 'contourf' || s.field?.kind === 'contour');
  if (contour) {
    const band = partReadout(fields, `${contour.id}.level.0`, { 'data-level-low': '-inf', 'data-level-high': '0.5', 'data-role': 'contour-level' })!;
    h.eq(band.lines, ['band -inf … 0.5'], 'a contour band reads its levels');
  }
  // brackets with stats (fp.brackets provenance), and without
  const withStats = structuredClone(presets);
  const br = withStats.overlays!.find(o => o.role === 'significance-bracket')! as unknown as Record<string, unknown>;
  br.stats = { test: "Welch's t-test", statistic: 3.2, p: 0.03, pCorrected: 0.045, correction: 'holm', effectSizeMethod: "Hedges' g", effectSize: 1.21, ciLow: 0.2, ciHigh: 2.2, n: [8, 8] };
  const bracket = partReadout(withStats, br.svgId as string)!;
  h.eq(bracket.title, 'a vs b', 'a bracket names its pair');
  h.eq(bracket.lines, ["Welch's t-test", 'p = 0.045 (holm)', "Hedges' g 1.21 [0.2, 2.2]", 'n = 8 / 8'], 'a bracket reads the test, corrected p, effect size and sizes');
  const plain = partReadout(presets, 'panel.counts.significance-bracket.0')!;
  h.eq(plain.lines, ['p = 0.03'], 'a bracket without stats still reads its p');
  h.eq(partReadout(presets, 'panel.counts.annotation.peak')!.lines, ['peak'], 'an annotation reads its text');
  // legend swatch → its series; colorbar → its scale
  h.eq(partReadout(presets, 'panel.counts.legend.entry.0.swatch')!.title, 'Legend · Counts', 'a legend swatch names its series');
  const cb = presets.guides!.find(g => g.role === 'colorbar')!;
  const key = partReadout(presets, cb.svgId!);
  h.ok(!!key && key.title.startsWith('Colour scale') && /viridis|cmasher|crameri|\w+, log|\w+, linear/.test(key.lines[0]), `a colorbar reads its scale (${key?.lines[0]})`);
  // scaffold says nothing
  h.eq(partReadout(presets, 'panel.counts.axis.x.tick.1'), null, 'a tick has no readout');
  h.eq(partReadout(presets, 'panel.counts.axis.x.spine'), null, 'a spine has no readout');
  h.eq(partReadout(undefined, 'x'), null, 'no manifest, no readout');
  // the text form and the DOM attribute reader
  h.eq(readoutText(bar1), 'Counts · bar 1\nx = b\nheight 5', 'readoutText joins title and lines');
  h.eq(readoutText(null), '', 'null reads as empty');
  const { document } = parseHTML('<html><body><g id="c" data-role="cell"><path data-value="1.5"/></g></body></html>');
  const attrs = nodeAttrs(document.getElementById('c') as unknown as Parameters<typeof nodeAttrs>[0]);
  h.eq([attrs['data-role'], attrs['data-value']], ['cell', '1.5'], 'nodeAttrs reads the node and its first tagged descendant');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done();
