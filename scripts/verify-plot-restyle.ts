#!/usr/bin/env -S npx tsx
// Real mount-action dispatch and unnormalized XML, after every seeded edit.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { preparePlot, bakePlotStyles, hoistPlotClips } from '../src/lib/plot/parse';
import { mountPlot } from '../src/lib/plot/mount';
import { plotDom, plotManifests, mountCounters } from '../src/lib/plot/store';
import { svgIntrinsicPx } from '../src/lib/plot/compensate';
import { ensureColormapLuts } from '../src/lib/color/colormapLuts';
import { FLUX_DARK } from '../src/lib/slide/theme';
import type { SemanticPlotElement, PartOverride } from '../src/lib/types';

const h = harness('verify-plot-restyle');
const { document } = parseHTML('<html><body></body></html>');
// linkedom exposes XML node serialization through toString, without the
// browser's XMLSerializer constructor. Preserve those bytes verbatim.
class XMLSerializer { serializeToString(node: Node) { return node.toString(); } }
Object.assign(globalThis, { document, DOMParser, XMLSerializer });
const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
const host = () => document.createElementNS('http://www.w3.org/2000/svg', 'g') as unknown as SVGGElement;
let seed = 0x503;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const fixtures = ['colorscale/hexmatrix-alpha', 'fluxplot03/features', 'fluxplot03/panels-a', 'fluxplot03/presets'];
try {
  await ensureColormapLuts();
  for (const name of fixtures) {
    h.section(name);
    const path = `scripts/fixtures/${name}`;
    const prepared = preparePlot(readFileSync(`${path}.svg`, 'utf8'), JSON.parse(readFileSync(`${path}.fluxplot.json`, 'utf8')));
    const root = prepared.root!, manifest = prepared.manifest!;
    bakePlotStyles(root); hoistPlotClips(root);
    plotDom.set('asset', root); plotManifests.set({ asset: manifest });
    const size = svgIntrinsicPx(root);
    let element: SemanticPlotElement = { id: 'plot', assetId: 'asset', type: 'plot', x: 20, y: 30, width: size.w * 1.2, height: size.h * .9, rotation: 0 };
    const target = host(), action = mountPlot(target, { element });
    const initial = target.firstElementChild;
    Object.assign(mountCounters, { renders: 0, restyles: 0, reclones: 0 });
    const ids = Array.from(root.querySelectorAll('[id]')).filter(n => !n.closest('defs')).map(n => n.id);
    const leaves = Array.from(root.querySelectorAll('[id]')).filter(n => !n.closest('defs') && (n.matches('path,text,circle,rect,line') || n.children.length === 1)).map(n => n.id);
    let leaf = leaves[0];
    const groups = (manifest.series ?? []).map(s => s.id);
    const textId = ids.find(id => /ticklabel|tick-label|title/.test(id)) ?? root.querySelector('text[id]')?.id ?? leaf;
    let theme: typeof FLUX_DARK | null = null;
    for (let step = 0; step < 30; step++) {
      const edits: Record<string, PartOverride> = { ...(element.overrides ?? {}) };
      switch (step % 10) {
        case 0: leaf = leaves[Math.floor(random() * leaves.length)]; edits[leaf] = { hidden: true, dx: 1 + random() * 5, dy: -random() * 4, opacity: .5, fill: '#ee2255', stroke: '#334455', strokeWidth: .7 }; element = { ...element, overrides: edits }; break;
        case 1: if (step === 11) edits[leaf] = { hidden: false }; else delete edits[leaf]; element = { ...element, overrides: edits }; break;
        case 2: edits[groups[Math.floor(random() * groups.length)] ?? leaf] = { hidden: false, dx: random() * 5, fill: '#2255ee' }; edits[textId] = { fontSize: 7 + random() * 8, fontFamily: 'serif', fontStyle: 'italic', fontWeight: 'bold', textDecoration: 'underline' }; element = { ...element, overrides: edits }; break;
        case 3: element = { ...element, overrides: undefined, contentScale: .5 + random() * 1.5 }; break;
        case 4: element = { ...element, colorScale: Object.fromEntries((manifest.colorScales ?? []).map(s => [s.id, { norm: { vmax: Number(s.norm.vmax) * (.6 + random() * .3) } }])), contentScale: .5 + random() * 1.5 }; break;
        case 5: element = { ...element, colorScale: Object.fromEntries((manifest.colorScales ?? []).map(s => [s.id, { cmap: { name: 'test', N: 3, lut: ['#112233ff', '#557799ff', '#aaddffff'], under: '#112233ff', over: '#aaddffff', bad: '#00000000' } }])), contentScale: .5 + random() * 1.5 }; break;
        case 6: element = { ...element, colorScale: Object.fromEntries((manifest.colorScales ?? []).map(s => [s.id, { cmap: { name: 'test', N: 3, lut: ['#112233ff', '#ff3355ff', '#aaddffff'], under: '#112233ff', over: '#aaddffff', bad: '#00000000' } }])), view: { x: { domain: [.1, .8] }, y: { domain: [.2, .9] }, y2: { domain: [20, 80] } } }; break;
        case 7: element = { ...element, colorScale: undefined, view: { x: { domain: [-.2, 1 + random()] }, y2: { domain: [10, 90] } } }; break;
        case 8: theme = FLUX_DARK; break;
        case 9: theme = null; element = { ...element, ...(step === 29 ? { view: undefined } : {}) }; break;
      }
      action.update({ element, theme });
      h.ok(target.firstElementChild === initial, `step ${step}: retains mounted clone`);
      const freshHost = host(), fresh = mountPlot(freshHost, { element, theme });
      const actual = serialize(target.firstChild!), expected = serialize(freshHost.firstChild!);
      if (actual !== expected) {
        writeFileSync('/tmp/p3-restyled.svg', actual); writeFileSync('/tmp/p3-fresh.svg', expected);
        const at = [...actual].findIndex((c, i) => c !== expected[i]);
        h.fail(`step ${step}: XML differs at ${at}: ${actual.slice(Math.max(0, at - 90), at + 220)} / ${expected.slice(Math.max(0, at - 90), at + 220)}`);
        fresh.destroy(); break;
      }
      h.ok(true, `step ${step}: byte-identical fresh mount`);
      fresh.destroy();
    }
    h.eq(mountCounters.reclones, 0, '30 style edits never re-clone');
    h.eq(mountCounters.restyles, 30, '30 style edits dispatch exactly 30 restyles');
    element = { ...element, width: element.width + 10 }; action.update({ element });
    h.eq(mountCounters.reclones, 1, 'a width change re-clones exactly once');
    action.destroy();
  }
  h.section('clip-hoist restoration');
  const clip = preparePlot('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><defs><clipPath id="clip"><rect width="100" height="100"/></clipPath></defs><g id="series"><g id="a"><path id="leaf" d="M0 0L10 10" clip-path="url(#clip)"/></g><g id="b"><path d="M20 0L30 10" clip-path="url(#clip)"/></g></g></svg>');
  h.eq(hoistPlotClips(clip.root!).groups, 1, 'the fixture really has a hoisted singleton-wrapper run');
  plotDom.set('clip', clip.root!); plotManifests.set({ clip: clip.manifest! });
  let clipEl: SemanticPlotElement = { id: 'clip-placement', type: 'plot', assetId: 'clip', x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  const clipHost = host(), clipAction = mountPlot(clipHost, { element: clipEl });
  for (const overrides of [{ a: { dx: 4, opacity: .6 } }, undefined, { leaf: { dy: -3, opacity: .3 } }, undefined]) {
    clipEl = { ...clipEl, overrides }; clipAction.update({ element: clipEl });
    const freshHost = host(), fresh = mountPlot(freshHost, { element: clipEl });
    h.ok(serialize(clipHost.firstChild!) === serialize(freshHost.firstChild!), 'leaf clips and run markers match a fresh mount after edits/removal');
    fresh.destroy();
  }
  clipAction.destroy();
  h.section('colour table length change');
  {
    // QA-P3: a short table, then the generated one (or limits only). Resizing the
    // previous table's stops left its spacing text nodes behind (500 blank lines,
    // bare appended stops): the same pixels, but not a fresh mount's bytes.
    const path = 'scripts/fixtures/colorscale/heatmap';
    const prepared = preparePlot(readFileSync(`${path}.svg`, 'utf8'), JSON.parse(readFileSync(`${path}.fluxplot.json`, 'utf8')));
    plotDom.set('table', prepared.root!); plotManifests.set({ table: prepared.manifest! });
    const scale = prepared.manifest!.colorScales![0];
    let tableEl: SemanticPlotElement = { id: 'table-placement', type: 'plot', assetId: 'table', x: 0, y: 0, width: 300, height: 220, rotation: 0 };
    const tableHost = host(), tableAction = mountPlot(tableHost, { element: tableEl });
    const short = { cmap: { name: 'short', N: 3, lut: ['#112233ff', '#557799ff', '#aaddffff'], under: '#112233ff', over: '#aaddffff', bad: '#00000000' } };
    for (const [label, entry] of [['a 3-entry table', short], ['limits only (the generated 256-entry table)', { norm: { vmax: Number(scale.norm.vmax) * .8 } }], ['the 3-entry table again', short], ['as generated', undefined]] as const) {
      tableEl = { ...tableEl, colorScale: entry ? { [scale.id]: entry } : undefined }; tableAction.update({ element: tableEl });
      const freshHost = host(), fresh = mountPlot(freshHost, { element: tableEl });
      h.ok(serialize(tableHost.firstChild!) === serialize(freshHost.firstChild!), `${label}: the key's gradient matches a fresh mount byte for byte`);
      fresh.destroy();
    }
    tableAction.destroy();
  }
  h.section('elastic exception');
  const path = 'scripts/fixtures/relayout/line/base';
  const prepared = preparePlot(readFileSync(`${path}.svg`, 'utf8'), JSON.parse(readFileSync(`${path}.fluxplot.json`, 'utf8')));
  plotDom.set('elastic', prepared.root!); plotManifests.set({ elastic: prepared.manifest! });
  const size = svgIntrinsicPx(prepared.root!);
  let element: SemanticPlotElement = { id: 'elastic', type: 'plot', assetId: 'elastic', x: 0, y: 0, width: size.w, height: size.h, rotation: 0 };
  const target = host(), action = mountPlot(target, { element });
  const before = mountCounters.reclones;
  element = { ...element, contentScale: 1.2 }; action.update({ element });
  h.eq(mountCounters.reclones, before + 1, 'an elastic auto-layout style edit re-clones');
  action.destroy();
} catch (error) { h.fail(error.stack ?? String(error)); }
await h.done();
