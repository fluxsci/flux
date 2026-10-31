import { get } from 'svelte/store';
import { harness } from './lib/harness.mjs';
import type { Figure, Element } from '../src/lib/types';

const h = harness('verify-figure-atlas');
let atlas: typeof import('../src/lib/figure/atlas');
let hitElementAt: typeof import('../src/lib/interact/modelHit')['hitElementAt'];
try {
  atlas = await import('../src/lib/figure/atlas');
  ({ hitElementAt } = await import('../src/lib/interact/modelHit'));
} catch (error) { h.fail(`atlas policy and model hit helper exist: ${error}`); await h.done(); process.exit(1); }
const { rasterKey, rasterScale, usable, soft, publish, drop, figureRasters, atlasStats, evictToBudget, touch, createAtlasQueue } = atlas;
const rect = (id: string, x = 10): Element => ({ id, type: 'rect', x, y: 10, width: 80, height: 40, rotation: 0,
  fill: '#4385be', stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
const fig: Figure = { id: 'a', canvasId: 'c', name: 'A', x: 0, y: 0, width: 500, height: 400, background: '#fff',
  elements: [rect('bottom'), { id: 'p', type: 'plot', assetId: 'asset', x: 100, y: 100, width: 100, height: 100, rotation: 0, overrides: {} }] };
const key = rasterKey(fig, 4, { asset: 2 }, 7);
h.eq(rasterKey({ ...fig, x: 1000, y: -300, name: 'Elsewhere' }, 4, { asset: 2 }, 7), key, 'position and frame naming do not invalidate picture');
for (const [label, changed] of [
  ['figure revision', rasterKey(fig, 5, { asset: 2 }, 7)], ['plot generation', rasterKey(fig, 4, { asset: 3 }, 7)],
  ['poster generation', rasterKey(fig, 4, { asset: 2 }, 8)], ['width', rasterKey({ ...fig, width: 501 }, 4, { asset: 2 }, 7)],
  ['height', rasterKey({ ...fig, height: 401 }, 4, { asset: 2 }, 7)], ['background', rasterKey({ ...fig, background: '#000' }, 4, { asset: 2 }, 7)],
] as const) h.ok(changed !== key, `${label} invalidates picture`);
for (const width of [1, 41.7, 500, 2345.9, 10_000]) for (const height of [1, 334.1, 10_000]) {
  const S = rasterScale({ width, height }, 10_000, 4), w = Math.ceil(width * S), hh = Math.ceil(height * S);
  h.ok(S > 0 && w <= 4096 && hh <= 4096 && w * hh <= 3_000_000, `scale caps including ceil: ${width}×${height} → ${w}×${hh}`);
}
const detailPolicy = await import('../src/lib/figure/atlasDetail');
h.ok(detailPolicy.wantsDetail({ ...fig, width: 769, height: 850 }, 4, 1.25), 'detail policy sharpens beyond the unchanged base cap');
h.ok(rasterScale({ width: 769, height: 850 }, 4, 1.25) < detailPolicy.neededScale(4, 1.25) / 1.25, 'whole-picture caps remain independent of detail scale');
h.eq(rasterScale(fig, 1, 4), 2, 'device scale stops at DPR 2');
const raster = (id: string, lastShownAt = 0): import('../src/lib/figure/atlas').FigureRaster => ({ figureId: id, key, S: 1, w: 500, h: 400, dataUrl: 'data:image/png;base64,AA==', bytes: 10, route: 'L', producedAt: 0, lastShownAt });
h.ok(usable(raster('a'), key) && !usable(raster('a'), key + '!') && !usable(undefined, key), 'usable means matching key, independent of scale');
h.ok(!soft(raster('a'), 1.25) && soft(raster('a'), 1.25001) && !soft(raster('a'), .2), 'only zoom-in beyond 1.25 requests a quality upgrade');
for (const id of get(figureRasters).keys()) drop(id);
const budget = atlasStats.budget; atlasStats.budget = 20;
publish(raster('old', 1)); publish(raster('protected', 0)); publish(raster('new', 2));
evictToBudget(new Set(['protected']));
h.eq([...get(figureRasters).keys()], ['protected', 'new'], 'LRU evicts oldest eligible picture and protects visible/active');
touch('protected'); h.ok(get(figureRasters).get('protected')!.lastShownAt > 0, 'showing updates LRU stamp');
atlasStats.budget = 0; evictToBudget(new Set(['protected']));
h.eq([...get(figureRasters).keys()], ['protected'], 'protected pictures survive even above budget');
drop('protected'); h.eq(atlasStats.bytes, 0, 'drop releases byte accounting'); atlasStats.budget = budget;

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let quiet = false;
const started: import('../src/lib/figure/atlas').AtlasRequest[] = [];
const finish = new Map<string, (r: import('../src/lib/figure/atlas').FigureRaster | null) => void>();
const route = (req: import('../src/lib/figure/atlas').AtlasRequest) => { started.push(req); return new Promise<import('../src/lib/figure/atlas').FigureRaster | null>(resolve => finish.set(req.figureId, resolve)); };
const queue = createAtlasQueue({ quiet: () => quiet, routeL: route, routeC: route, concurrency: { L: 1, C: 2 } });
const req = (id: string, priority: 1 | 2 | 3 = 1, route: 'L' | 'C' = 'L', distance = 0) => ({ figureId: id, key, S: 1, priority, route, distance });
queue.request(req('old')); queue.request({ ...req('old'), S: 2 });
h.eq(queue.size(), 1, 'queued requests replace by figure');
queue.drain(); await settle(); h.eq(started.length, 0, 'never starts while not quiet');
queue.request({ ...req('old'), S: .5 });
quiet = true; queue.drain(); await settle();
h.eq(started[0]?.S, .5, 'a smaller replacement also replaces an older queued request');
finish.get('old')!(null); await settle(); started.length = 0; quiet = false;
queue.cancel('old');
queue.request(req('upgrade', 3)); queue.request(req('deactivated', 2)); queue.request(req('visibleFar', 1, 'L', 50)); queue.request(req('visibleNear', 1, 'L', 1));
queue.request(req('cold1', 1, 'C')); queue.request(req('cold2', 1, 'C')); queue.request(req('cold3', 1, 'C'));
quiet = true; queue.drain(); await settle();
h.eq(started.map(r => r.figureId), ['cold1', 'cold2', 'visibleNear'], 'priority/distance ordering, one live and two cold jobs');
quiet = false;
finish.get('visibleNear')!({ ...raster('visibleNear'), key }); await settle();
h.eq(started.length, 3, 'completion while busy does not start queued work');
quiet = true; queue.drain(); await settle(); h.eq(started.at(-1)?.figureId, 'visibleFar', 'quiet transition re-arms remaining work');
queue.request({ ...req('visibleFar'), key: 'replacement' });
finish.get('visibleFar')!(raster('visibleFar')); await settle();
h.ok(!get(figureRasters).has('visibleFar'), 'in-flight replacement discards old completion');
h.eq(started.at(-1)?.key, 'replacement', 'replacement eventually starts');
queue.cancel('visibleFar'); finish.get('visibleFar')!({ ...raster('visibleFar'), key: 'replacement' }); await settle();
h.ok(!get(figureRasters).has('visibleFar'), 'cancel retires an in-flight result');
queue.dispose(); for (const [id, resolve] of finish) resolve(raster(id)); await settle();
h.eq(queue.size(), 0, 'dispose clears pending jobs');
let current = true;
const stale = createAtlasQueue({ quiet: () => true, current: () => current, routeL: route, routeC: route, concurrency: { L: 1, C: 1 } });
stale.request(req('stale')); stale.drain(); await settle(); current = false;
finish.get('stale')!(raster('stale')); await settle();
h.ok(!get(figureRasters).has('stale'), 'key/current check discards a changed model'); stale.dispose();

const hitFig = { ...fig, elements: [rect('bottom'), rect('top')] };
h.eq(hitElementAt(hitFig, { x: 30, y: 30 })?.element.id, 'top', 'topmost element wins');
h.eq(hitElementAt({ ...hitFig, elements: [rect('bottom'), { ...rect('top'), hidden: true }] }, { x: 30, y: 30 })?.element.id, 'bottom', 'hidden element skipped');
h.eq(hitElementAt({ ...hitFig, elements: [rect('bottom'), { ...rect('top'), locked: true }] }, { x: 30, y: 30 })?.element.id, 'bottom', 'locked element skipped');
const grouped: Figure = { ...hitFig, groups: { outer: { id: 'outer', name: 'Outer' }, inner: { id: 'inner', name: 'Inner', parentId: 'outer' } },
  elements: [{ ...rect('one'), groupId: 'inner' }, { ...rect('two', 200), groupId: 'inner' }, { ...rect('three', 300), groupId: 'outer' }] };
h.eq([...hitElementAt(grouped, { x: 30, y: 30 })!.ids], ['one', 'two', 'three'], 'plain press expands outer group');
h.eq([...hitElementAt(grouped, { x: 30, y: 30 }, { enteredGroupId: 'outer' })!.ids], ['one', 'two'], 'entered scope bounds group expansion');
h.eq([...hitElementAt(grouped, { x: 30, y: 30 }, { enteredGroupId: 'inner' })!.ids], ['one'], 'direct child in entered group selects itself');
const mixedGroup = structuredClone(grouped); mixedGroup.elements[1].locked = true; mixedGroup.elements[2].hidden = true;
h.eq([...hitElementAt(mixedGroup, { x: 30, y: 30 })!.ids], ['one', 'two', 'three'], 'selection unit matches plain group expansion, including its noneditable members');
grouped.groups!.outer.locked = true; h.eq(hitElementAt(grouped, { x: 30, y: 30 }), null, 'ancestor lock skipped');
grouped.groups!.outer.locked = false; grouped.groups!.outer.hidden = true; h.eq(hitElementAt(grouped, { x: 30, y: 30 }), null, 'ancestor eye skipped');
const rotated = { ...hitFig, elements: [{ ...rect('tilted'), rotation: 90 }] };
h.eq(hitElementAt(rotated, { x: 50, y: -5 })?.element.id, 'tilted', 'rotated box catches painted corner outside original box');
h.eq(hitElementAt(rotated, { x: 12, y: 12 }), null, 'rotated box excludes empty unrotated corner');
const lineFig = { ...hitFig, elements: [{ id: 'line', type: 'line', x: 10, y: 30, width: 100, height: 0,
  x1: 0, y1: 0, x2: 100, y2: 0, rotation: 0, stroke: '#000', strokeWidth: 1 } as Element] };
h.eq(hitElementAt(lineFig, { x: 50, y: 30 })?.element.id, 'line', 'point probe intersects a horizontal zero-height line box');
h.eq(hitElementAt(fig, { x: 110, y: 110 })?.element.id, 'p', 'plot without visible bounds uses placement');
h.eq(hitElementAt(fig, { x: 110, y: 110 }, { plotBounds: () => ({ x: 40, y: 40, w: 20, h: 20 }) }), null, 'cached plot ink excludes hidden whitespace');
h.eq(hitElementAt(fig, { x: 150, y: 150 }, { plotBounds: () => ({ x: 40, y: 40, w: 20, h: 20 }) })?.element.id, 'p', 'cached plot ink catches visible point');
h.eq(hitElementAt(fig, { x: 150, y: 150 }, { plotBounds: () => null }), null, 'empty plot ink is unselectable');
await h.done();
