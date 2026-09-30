#!/usr/bin/env -S npx tsx
// Colour-system plan F7 (Flux half) — value morphs and data-order stagger:
//   • `stagger.by` orders a ramp by each part's data: `"data"` / `{ key: "value" }` (a hexagon's
//     mean, a cell's value, a bar's height), `{ key: "count" }`, `{ key: "index" }`; the compiler
//     reads the manifest, the player the node's data-* attributes, and both rank alike;
//   • a morph between two versions of a plot tweens bars by category key (height), hexagons /
//     cells by row.col (geometry and colour value through the colour law), using
//     `capabilities.valueMorph`; a version pair with keyed members is a Become candidate even
//     without line / point series;
//   • the per-panel build: one beat sequence per panel (its four phases), panels in manifest
//     order, figure-scope titles first and figure legends last.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOMParser, parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import type { FluxPlotManifest } from '../src/lib/plot/types';
import type { Slide, Track, Stagger } from '../src/lib/slide/types';
import { viewFits, projectWith, hasTweenableSeries, keyedMorphable, dataOfPixel } from '../src/lib/plot/project';
import { applyPlotView, restoreProjection } from '../src/lib/plot/projectDom';
import { preparePlot } from '../src/lib/plot/parse';
import { colorFor } from '../src/lib/plot/colorscale';
import { staggerKey, manifestCoordinates, nodeCoordinate } from '../src/lib/slide/staggerData';
import { staggerRanks, patchStagger } from '../src/lib/slide/stagger';
import { compileSlide } from '../src/lib/slide/compile';
import { computeSlideAnims } from '../src/lib/slide/player/player';
import { autoAnimatePlot, applyAutoAnimation } from '../src/lib/slide/autobuild';
import { createDeck, addSlide, addElement } from '../src/lib/slide/ops';
import { FLUX_DARK } from '../src/lib/slide/theme';

const { document } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { document, DOMParser });
const h = harness('verify-plot-value-morph');
const repo = resolve(import.meta.dirname, '..'), fixtures = join(repo, 'scripts/fixtures/fluxplot03');
const load = (n: string) => ({ svg: readFileSync(join(fixtures, `${n}.svg`), 'utf8'), manifest: JSON.parse(readFileSync(join(fixtures, `${n}.fluxplot.json`), 'utf8')) as FluxPlotManifest });
const nums = (d: string | null | undefined) => (d ?? '').match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
const pathOf = (root: Element, id: string) => { const n = root.querySelector(`[id="${id}"]`); return (n?.tagName.toLowerCase() === 'path' ? n : n?.querySelector('path')) as Element | null; };
const top = (root: Element, id: string) => { const v = nums(pathOf(root, id)?.getAttribute('d')); return Math.min(...v.filter((_, i) => i % 2 === 1)); };
const near = (a: number, b: number, msg: string, eps = 2e-3) => h.ok(Number.isFinite(a) && Math.abs(a - b) < eps, `${msg}: ${a} ≈ ${b}`);
const styleOf = (n: Element) => (n as unknown as { style: { getPropertyValue(p: string): string } }).style;
try {
  const A = load('features'), B = load('features-b');
  const hexA = A.manifest.series.find(s => s.id === 'panel.hex.mean')!;
  const bins = (hexA as unknown as { hexmatrix: { bins: { svgId: string; value: number; count: number }[] } }).hexmatrix.bins;
  const hexIds = bins.map(b => b.svgId);

  h.section('data-order stagger');
  h.eq([staggerKey(undefined), staggerKey('index'), staggerKey('x'), staggerKey('data'), staggerKey({ key: 'value' }), staggerKey({ key: 'count' }), staggerKey({ key: 'index' })],
    [null, null, 'x', 'value', 'value', 'count', 'index'], 'staggerKey maps every spelling');
  h.eq(manifestCoordinates(A.manifest, hexIds, 'value'), bins.map(b => b.value), 'hexagons rank by their value from the manifest');
  h.eq(manifestCoordinates(A.manifest, hexIds, 'count'), bins.map(b => b.count), 'and by their count');
  const barIds = A.manifest.series.find(s => s.id === 'panel.cells.means')!.svg.bars!;
  const barLen = (A.manifest.series.find(s => s.id === 'panel.cells.means') as unknown as { bar: { length: number[] } }).bar.length;
  h.eq(manifestCoordinates(A.manifest, barIds, 'value'), barLen, 'bars rank by their height');
  h.eq(manifestCoordinates(A.manifest, ['nope'], 'value'), [null], 'an unknown part has no coordinate (input order)');
  const ranks = staggerRanks(hexIds.length, 'start', manifestCoordinates(A.manifest, hexIds, 'count'));
  const byRank = hexIds.map((id, i) => ({ id, rank: ranks[i], count: bins[i].count })).sort((a, b) => a.rank - b.rank);
  h.ok(byRank.every((r, i) => i === 0 || r.count >= byRank[i - 1].count), 'ranks climb with the count');
  const { root: rootA } = preparePlot(A.svg, A.manifest);
  const hexNode = rootA!.querySelector(`[id="${hexIds[3]}"]`)!;
  h.eq([nodeCoordinate(hexNode as unknown as Parameters<typeof nodeCoordinate>[0], 'value'), nodeCoordinate(hexNode as unknown as Parameters<typeof nodeCoordinate>[0], 'count')], [bins[3].value, bins[3].count], 'a node reads data-value / data-count the way the manifest says');
  // compiler and player rank alike through a slide
  const stage = { width: 640, height: 360 };
  const wrap = document.createElement('div') as unknown as HTMLElement;
  for (const [i, id] of hexIds.entries()) { const n = document.createElement('div'); n.id = `plot__${id}`; n.setAttribute('data-count', String(bins[i].count)); n.setAttribute('data-value', String(bins[i].value)); wrap.appendChild(n as unknown as Node); }
  const t: Track = { id: 'tr', target: 'plot', parts: hexIds, preset: 'fade', start: 0, duration: 200, stagger: { perMs: 20, by: { key: 'count' } } };
  const slide: Slide = { id: 's', elements: [{ type: 'plot', id: 'plot', assetId: 'a', x: 0, y: 0, width: 400, height: 300, rotation: 0 }], beats: [{ id: 'base', tracks: [] }, { id: 'b1', tracks: [t] }] };
  const opts = { theme: FLUX_DARK, plotManifest: () => A.manifest, plotRoot: () => rootA!, reducedMotion: true };
  const compiled = compileSlide(slide, stage, opts);
  const specs = computeSlideAnims(slide, { elements: new Map([['plot', wrap]]) }, document.createElement('div') as unknown as HTMLElement, stage, opts);
  const ct = compiled.cues[1].tracks[0];
  h.eq(ct.ranks, ranks, 'the compiler ranks the hexagons by count');
  h.eq(specs.map(s => s.delay), ct.ranks.map(r => r * 20), 'the player delays every hexagon by the same rank');
  h.eq(patchStagger(undefined, { perMs: 10, by: { key: 'value' } }).by, { key: 'value' }, 'patchStagger accepts a data key');
  let threw = '';
  try { patchStagger(undefined, { perMs: 10, by: { key: 'weight' } as unknown as Stagger['by'] }); } catch (e) { threw = (e as Error).message; }
  h.ok(threw.includes('ordering key'), 'and refuses an unknown one');

  h.section('a morph between two plot versions');
  h.ok(hasTweenableSeries(A.manifest, B.manifest), 'the two versions are a Become candidate (keyed bars and hexagons; the lines too)');
  const barsA = A.manifest.series.find(s => s.id === 'panel.cells.means')!, barsB = B.manifest.series.find(s => s.id === 'panel.cells.means')!;
  h.ok(keyedMorphable(barsA, barsB), 'bar series with valueMorph are keyed-morphable');
  h.ok(!keyedMorphable(barsA, { ...barsB, capabilities: { dataMorph: false, valueMorph: false } } as typeof barsB), 'not without the capability');
  const { root: rootB } = preparePlot(B.svg, B.manifest);
  const bSeries = new Map(B.manifest.series.map(s => [s.id, s]));
  const morph = (t: number) => ({ t, raw: t, toManifest: B.manifest, sourceRoot: rootA!, targetRoot: rootB!, geometryInterpolated: true, assetChange: true, series: (a: (typeof A.manifest.series)[number]) => bSeries.get(a.id) ?? null });
  const barId = barIds[2], keyA = rootA!.querySelector(`[id="${barId}"]`)!.getAttribute('data-key');
  const twinId = B.manifest.series.find(s => s.id === 'panel.cells.means')!.svg.bars!.find(id => rootB!.querySelector(`[id="${id}"]`)!.getAttribute('data-key') === keyA)!;
  const topA = top(rootA!, barId), topB = top(rootB!, twinId);
  h.ok(Math.abs(topA - topB) > 0.5, `the two versions differ in that bar's height (${topA} vs ${topB}, key ${keyA})`);
  const rawA = viewFits(A.manifest, undefined, 'panel.cells')!, rawB = viewFits(B.manifest, undefined, 'panel.cells')!;
  const hA = dataOfPixel(rawA.y, topA), hB = dataOfPixel(rawB.y, topB);
  applyPlotView(rootA!, A.manifest, undefined, '', morph(0.5));
  const mid = top(rootA!, barId);
  const midFitM = (rawA.y.m + rawB.y.m) / 2, midFitC = (rawA.y.c + rawB.y.c) / 2;
  near(mid, midFitM * (hA + hB) / 2 + midFitC, 'half-way, the bar top is the midpoint height through the blended fit', 5e-2);
  applyPlotView(rootA!, A.manifest, undefined, '', morph(1));
  near(top(rootA!, barId), topB, 'at the end the bar has the other version\'s geometry', 5e-2);
  // hexagons: geometry and colour value by row.col (measured on the restored, generated A)
  restoreProjection(rootA!);
  const scale = A.manifest.colorScales!.find(sc => sc.id === 'mean')!;
  const shared = hexIds.find(id => rootB!.querySelector(`[id="${id}"]`) && rootA!.querySelector(`[id="${id}"]`)?.getAttribute('data-value') !== rootB!.querySelector(`[id="${id}"]`)?.getAttribute('data-value'))!;
  const vA = Number(rootA!.querySelector(`[id="${shared}"]`)!.getAttribute('data-value')), vB = Number(rootB!.querySelector(`[id="${shared}"]`)!.getAttribute('data-value'));
  const hex6 = (c: string) => c.replace(/\s/g, '').slice(0, 7);
  h.eq(hex6(styleOf(rootA!.querySelector(`[id="${shared}"]`)!).getPropertyValue('fill')), hex6(colorFor(scale, vA)), 'as generated, the hexagon is painted at its own value');
  applyPlotView(rootA!, A.manifest, undefined, '', morph(0.5));
  const hexMid = rootA!.querySelector(`[id="${shared}"]`)!;
  near(Number(hexMid.getAttribute('data-value')), (vA + vB) / 2, 'a shared hexagon carries the tweened value');
  h.eq(hex6(styleOf(hexMid).getPropertyValue('fill')), hex6(colorFor(scale, (vA + vB) / 2)), 'and is painted through the colour law at that value');
  restoreProjection(rootA!);
  h.eq(Number(rootA!.querySelector(`[id="${shared}"]`)!.getAttribute('data-value')), vA, 'restore brings the generated value back');
  h.eq(hex6(styleOf(rootA!.querySelector(`[id="${shared}"]`)!).getPropertyValue('fill')), hex6(colorFor(scale, vA)), 'and the generated paint');

  h.section('per-panel build');
  const beats = autoAnimatePlot(A.manifest, 'el', { perPanel: true });
  const groups = beats.map(b => b.label!.split(' · ')[0]).filter((g, i, all) => i === 0 || g !== all[i - 1]);
  h.eq(groups, ['Figure', 'fit', 'twin', 'hex', 'cells', 'image', 'Figure'], `panels build one after another, figure titles first and the figure legend last (${groups.join(' → ')})`);
  h.ok(beats.every(b => /^auto-\d+-\d+$/.test(b.id)), 'beat ids carry group and phase');
  const phases = beats.map(b => b.autoPhase!);
  h.ok(phases.every((p, i) => i === 0 || p > phases[i - 1]), 'autoPhase climbs through the groups');
  const fitBeats = beats.filter(b => b.label!.startsWith('fit ·'));
  h.ok(fitBeats.every(b => b.tracks.every(t => t.part!.startsWith('panel.fit.') || t.part === 'gridlines')), 'a panel\'s beats hold only its own parts');
  const dataBeat = beats.find(b => b.label === 'cells · Data')!;
  h.ok(!!dataBeat && dataBeat.tracks.some(t => t.part === 'panel.cells.means.bars'), 'the bar panel\'s Data beat reveals its bars');
  h.ok(beats[beats.length - 1].tracks.some(t => t.part!.startsWith('figure.legend.entry.')), 'the figure legend (entry by entry) closes the build');
  const flat = autoAnimatePlot(A.manifest, 'el');
  h.ok(flat.length <= 4 && flat.every(b => /^auto-\d$/.test(b.id)), 'without the option the four shared phases stay');
  const deck = createDeck({ id: 'd', title: 'T', withTitleSlide: false }), sl = addSlide(deck, { layout: 'blank' });
  addElement(deck, sl.id, { type: 'plot', id: 'el', assetId: 'a', x: 0, y: 0, width: 400, height: 300, rotation: 0 } as Parameters<typeof addElement>[2]);
  const added = applyAutoAnimation(deck, sl.id, 'el', A.manifest, { perPanel: true });
  h.eq(added, beats.length, 'applyAutoAnimation lands every per-panel beat');
  const slideBeats = deck.slides.find(s => s.id === sl.id)!.beats;
  h.eq(slideBeats.slice(1).map(b => b.label), beats.map(b => b.label), 'in order after the resting beat');
  applyAutoAnimation(deck, sl.id, 'el', A.manifest, { perPanel: true });
  h.eq(deck.slides.find(s => s.id === sl.id)!.beats.length, slideBeats.length, 're-running is idempotent');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done();
