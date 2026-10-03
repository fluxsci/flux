#!/usr/bin/env -S npx tsx
// Colour-system plan C7 (Flux half) — saved part ids survive fluxplot's renames through
// `manifest.idAliases`:
//   • an override keyed by an OLD spine id (`axis.x.spine`, `axis.x.spine-2`) or the old
//     panel-prefixed figure background lands on the renamed node (`axis.x.spine.bottom`,
//     `figure.background`) when the fixture is mounted through the shared applier;
//   • an old series ROOT stands for every id beneath it: `ctl-n-6.line` → `<new root>.line`
//     (longest prefix wins, an exact alias beats a prefix, an unaliased id passes through);
//   • slide part targets and the X-ray's leaf resolution go through the same map
//     (`resolveTargets` / `leavesOf`), so captions, tracks and restyles saved before 0.3.2 keep
//     pointing at the same parts.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOMParser, parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { aliasPartId, resolveTargets } from '../src/lib/plot/tree';
import { leavesOf } from '../src/lib/slide/targets';
import { preparePlot, prefixIds, applyOverrides } from '../src/lib/plot/parse';
import type { FluxPlotManifest } from '../src/lib/plot/types';

const { document } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { document, DOMParser });
const h = harness('verify-id-aliases');
const repo = resolve(import.meta.dirname, '..'), fixtures = join(repo, 'scripts/fixtures/fluxplot03');
const load = (n: string) => ({ svg: readFileSync(join(fixtures, `${n}.svg`), 'utf8'), manifest: JSON.parse(readFileSync(join(fixtures, `${n}.fluxplot.json`), 'utf8')) as FluxPlotManifest });
try {
  const { svg, manifest } = load('presets');
  const aliases = (manifest as { idAliases: Record<string, string> }).idAliases;
  h.eq(aliases['panel.counts.axis.x.spine'], 'panel.counts.axis.x.spine.bottom', 'the fixture aliases the old spine id');
  h.eq(aliases['panel.counts.figure.background'], 'figure.background', 'and the old panel-prefixed figure background');

  // 1. the pure map
  h.eq(aliasPartId(manifest, 'panel.counts.axis.x.spine'), 'panel.counts.axis.x.spine.bottom', 'exact alias');
  h.eq(aliasPartId(manifest, 'panel.counts.axis.y.spine-2'), 'panel.counts.axis.y.spine.right', 'the collision-repaired second spine maps to its side');
  h.eq(aliasPartId(manifest, 'panel.counts.axis.x.spine.bottom'), 'panel.counts.axis.x.spine.bottom', 'a current id passes through');
  h.eq(aliasPartId(manifest, 'panel.counts.counts.bar.1'), 'panel.counts.counts.bar.1', 'an unaliased id passes through');
  h.eq(aliasPartId(undefined, 'x.y'), 'x.y', 'no manifest, no change');
  const rooted = { ...manifest, idAliases: { 'panel.a.il-6-pg-ml': 'panel.a.il-6-pg-ml-1a2b3c', 'panel.a.il-6-pg-ml.points': 'panel.a.il-6-pg-ml-1a2b3c.dots', 'panel.a': 'panel.alpha' } } as unknown as FluxPlotManifest;
  h.eq(aliasPartId(rooted, 'panel.a.il-6-pg-ml.line'), 'panel.a.il-6-pg-ml-1a2b3c.line', 'an old series root stands for every id under it');
  h.eq(aliasPartId(rooted, 'panel.a.il-6-pg-ml.point.3'), 'panel.a.il-6-pg-ml-1a2b3c.point.3', 'members follow the root');
  h.eq(aliasPartId(rooted, 'panel.a.il-6-pg-ml.points'), 'panel.a.il-6-pg-ml-1a2b3c.dots', 'an exact alias beats a prefix');
  h.eq(aliasPartId(rooted, 'panel.a.il-6-pg-ml'), 'panel.a.il-6-pg-ml-1a2b3c', 'the root itself maps exactly');
  h.eq(aliasPartId(rooted, 'panel.a.other.line'), 'panel.alpha.other.line', 'the longest matching prefix wins (shorter panel alias applies elsewhere)');
  h.eq(aliasPartId(rooted, 'panel.ab.other'), 'panel.ab.other', 'a prefix must end at a dot: panel.a does not cover panel.ab');

  // 2. resolution through the parts tree and slide targets
  h.eq(resolveTargets(manifest, 'panel.counts.axis.x.spine'), ['panel.counts.axis.x.spine.bottom'], 'resolveTargets maps a leaf through the aliases');
  h.eq(leavesOf(manifest, 'panel.counts.figure.background'), ['figure.background'], 'slide targets (leavesOf) map too');
  const groupLeaves = resolveTargets(manifest, 'panel.counts.axis.x');
  h.ok(groupLeaves.includes('panel.counts.axis.x.spine.bottom'), 'a current container still expands to its (renamed) leaves');

  // 3. an override saved under the old ids lands on the renamed nodes
  const { root } = preparePlot(svg, manifest);
  prefixIds(root!, 'el1');
  applyOverrides(root!, {
    'panel.counts.axis.x.spine': { hidden: true },
    'panel.counts.figure.background': { fill: '#123456' },
    'panel.counts.axis.y.spine-2': { stroke: '#ff0000' },
  }, 'el1', manifest);
  const node = (id: string) => root!.querySelector(`[id="el1__${id}"]`) as SVGElement | null;
  h.ok(!!node('panel.counts.axis.x.spine.bottom') && node('panel.counts.axis.x.spine.bottom')!.style.display === 'none', 'hidden by its old id: the bottom spine is hidden');
  h.eq(node('panel.counts.axis.x.spine'), null, 'no node carries the old id');
  const bg = node('figure.background');
  const bgDrawable = bg && (/^(path|rect)$/i.test(bg.tagName) ? bg : bg.querySelector('path,rect')) as SVGElement | null;
  h.ok(!!bgDrawable && bgDrawable.style.fill.replace(/\s/g, '') === '#123456', `filled by its old id: the figure background is repainted (${bgDrawable?.style.fill})`);
  const right = node('panel.counts.axis.y.spine.right');
  const rightDrawable = right && (/^path$/i.test(right.tagName) ? right : right.querySelector('path')) as SVGElement | null;
  h.ok(rightDrawable === null || rightDrawable.style.stroke.replace(/\s/g, '') === '#ff0000' || right === null, 'a right spine the plot does not draw is a no-op; a drawn one takes the stroke');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done();
