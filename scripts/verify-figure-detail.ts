import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { get } from 'svelte/store';
import { harness } from './lib/harness.mjs';
import type { Figure } from '../src/lib/types';
import { atlasStats, atlasRevision, atlasDev } from '../src/lib/figure/atlas';
const h = harness('verify-figure-detail');
const base = process.env.FLUX_DETAIL_BASE;
let d: typeof import('../src/lib/figure/atlasDetail');
try { d = await import(base ? pathToFileURL(path.join(base, 'src/lib/figure/atlasDetail.ts')).href : '../src/lib/figure/atlasDetail'); }
catch (e) { h.fail(`detail policy exists: ${e}`); await h.done(); process.exit(1); }
const rules = createRequire(import.meta.url)('../electron/figureRasterRules.cjs');
const fig: Figure = { id: 'b', canvasId: 'c', name: 'B', x: 100, y: 50, width: 769, height: 850, background: '#fff', elements: [] };
const view = { x: 110, y: 70, w: 600, h: 340 };
const input = (f = fig): import('../src/lib/figure/atlasDetail').DetailInput => ({ enabled: true, scope: 'project', viewBox: view, zoom: 4, dpr: 1.25,
  candidates: [{ figure: f, key: 'k' }], retain: new Map([[f.id, { key: 'k', warming: false }]]) });
const pause = (ms = d.DETAIL_QUIET_MS + 25) => new Promise(r => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
try {
  h.eq([d.DETAIL_MAX_PIXELS, d.DETAIL_MAX_SIDE, d.DETAIL_MIN_EXTENT], [rules.DETAIL_MAX_PIXELS, rules.DETAIL_MAX_SIDE, rules.DETAIL_MIN_EXTENT], 'renderer/main detail constants agree');
  h.ok(!d.wantsDetail(fig, 1, 1.25) && d.wantsDetail(fig, 4, 1.25), 'detail requested only beyond the base cap');
  h.eq(d.neededScale(4, 3), 8, 'detail DPR stops at two');
  const outside = { ...fig, elements: [{ id: 'rot', type: 'rect', x: -150, y: 800, width: 200, height: 300, rotation: 45 }] } as Figure;
  const extent = d.contentExtent(outside);
  h.ok(extent.x < -150 && extent.y + extent.h > 1100, 'content extent includes rotated out-of-frame boxes');
  const validated = rules.contentExtent(outside);
  h.ok(['x','y','w','h'].every(k => Math.abs(extent[k as keyof typeof extent] - validated[k]) < 1e-7), 'validator extent matches renderer rotated geometry');
  for (const x of [fig.x, fig.x + fig.width - 10]) for (const y of [fig.y, fig.y + fig.height - 10]) {
    const w = d.detailWindow({ x, y, w: 10, h: 10 }, [fig], 8, 1.25);
    const r = w.regions.get(fig.id)!;
    h.ok(r.w >= fig.width * .4 && r.h >= fig.height * .4, 'extent floor holds at both ends');
    rules.validateFigureRequest({ rid: 'floor', root: '/scratch', figure: fig, assets: [], region: r, width: Math.ceil(r.w * w.S), height: Math.ceil(r.h * w.S), scale: w.S });
  }
  // QA-P6: the validator's own 0.4 floor, not only the [-2, 3]x envelope. A centred 0.35
  // region satisfies the envelope arithmetic and must still be refused by name.
  const thin = { x: fig.width * .33, y: fig.height * .33, w: fig.width * .35, h: fig.height * .35 };
  let thinError = '';
  try { rules.validateFigureRequest({ rid: 'thin', root: '/scratch', figure: fig, assets: [], region: thin, width: Math.ceil(thin.w), height: Math.ceil(thin.h), scale: 1 }); } catch (e) { thinError = String(e); }
  h.ok(/below the resvg envelope/.test(thinError), `validator refuses a region under 0.4 of the extent even inside the envelope (${thinError || 'accepted'})`);
  const big = { ...fig, width: 2000, height: 2000 };
  const owner = d.detailWindow({ x: 200, y: 150, w: 3072 / 4, h: 1696 / 4 }, [big], 4, 1.25);
  h.eq(owner.margin, 0, 'owner viewport leaves no margin');
  const laptop = d.detailWindow({ x: 200, y: 150, w: 300, h: 180 }, [fig], 4, 1.25);
  h.ok(laptop.margin >= .25, 'laptop margin uses spare budget');
  const grid = d.detailWindow({ x: 217, y: 163, w: 500, h: 350 }, [big], 4, 1.25, 7_000_000).regions.get(big.id)!;
  // The extent floor is centred when it binds; use a box above the floor for snap identity.
  const snapFig = { ...fig, width: 1000, height: 1000 };
  const a = d.detailWindow({ x: 217, y: 163, w: 500, h: 500 }, [snapFig], 4, 1.25, 1).regions.get(fig.id)!;
  h.eq([a.x % 16, a.y % 16], [0, 0], 'snap grid is figure-local, anchored at its origin');
  const other = { ...fig, id: 'other', x: 0 };
  const multi = d.detailWindow({ x: 0, y: 50, w: 1000, h: 700 }, [fig, other], 8, 1.25);
  const pixels = [...multi.regions.values()].reduce((n, r) => n + Math.ceil(r.w * multi.S) * Math.ceil(r.h * multi.S), 0);
  h.ok(pixels <= d.DETAIL_MAX_PIXELS && multi.S < 10, 'SUM of detail windows lowers one uniform scale');
  const detail = { figureId: fig.id, key: 'k', region: { x: 0, y: 0, w: 600, h: 600 }, S: 5, w: 3000, h: 3000, url: 'blob:test', bytes: 4, shown: true, lastShownAt: 1 };
  h.ok(d.detailCovers(detail, 'k', { x: 20, y: 30, w: 100, h: 200 }, 4, 1.25), 'coverage accepts key, region and scale');
  h.ok(!d.detailCovers(detail, 'old', { x: 20, y: 30, w: 100, h: 200 }, 4, 1.25) && !d.detailCovers(detail, 'k', { x: 590, y: 30, w: 100, h: 200 }, 4, 1.25) && !d.detailCovers(detail, 'k', { x: 20, y: 30, w: 100, h: 200 }, 8, 1.25), 'coverage rejects stale key, uncovered region and low scale');
  const request = { ...detail, rid: 'atlas-D:b:1', scope: 'project' };
  const state = { enabled: true, key: 'k', activeId: 'a', mode: 'raster', scope: 'project', base: { ...detail, dataUrl: '', route: 'C' as const, producedAt: 0 }, figure: fig, zoom: 4, dpr: 1.25, viewBox: view };
  h.ok(d.detailCurrent(request, state), 'current accepts useful detail');
  h.ok(!d.detailCurrent(request, { ...state, key: 'new' }), 'current rejects old key even while stale base shows it');
  h.ok(!d.detailCurrent(request, { ...state, activeId: 'b' }) && d.detailCurrent(request, { ...state, activeId: 'b', mode: 'warming' }), 'current excludes active live but admits warming');
  h.ok(!d.detailCurrent(request, { ...state, scope: 'elsewhere' }), 'current rejects a different scope');

  let quiet = false, complete!: (blob: Blob) => void, decodes = 0, publications = 0;
  const started: import('../src/lib/figure/atlasDetail').DetailRequest[] = [], revoked: string[] = [];
  const revision = get(atlasRevision), failures = atlasStats.failures;
  const scheduler = d.createDetailScheduler({ quiet: () => quiet, current: () => true,
    render: req => { started.push(req); return new Promise(resolve => { complete = resolve; }); },
    decode: async () => { decodes++; return `blob:${decodes}`; }, revoke: url => revoked.push(url), publish: () => publications++ });
  const first = input(); scheduler.sync(first); await pause(); h.eq(started.length, 0, 'no detail request during a gesture');
  quiet = true; scheduler.sync(first); await pause(100); h.eq(started.length, 0, '400ms quiet gate delays detail work');
  quiet = false; scheduler.sync(first); quiet = true; scheduler.sync(first); await pause();
  h.eq(started.length, 1, 'one request after a full quiet window');
  quiet = false; scheduler.sync(first); complete(new Blob(['png'])); await flush();
  h.eq([decodes, publications], [0, 0], 'completion held undecoded and unpublished during gesture');
  quiet = true; scheduler.sync(first); await pause();
  h.eq([decodes, publications], [1, 1], 'held PNG decoded and published only after quiet');
  h.eq(get(atlasRevision), revision, 'detail publish never bumps atlasRevision');
  scheduler.sync({ ...first, viewBox: { ...first.viewBox, x: first.viewBox.x + 2 } }); await pause();
  h.eq(started.length, 1, 'pan inside coverage makes no request');
  scheduler.sync({ ...first, zoom: first.zoom * 1.05 }); await pause();
  h.eq(started.length, 1, 'zoom within 1.25 sharpness tolerance reuses the detail');
  const movedInput = { ...first, viewBox: { ...view, x: 600, w: 269 } };
  scheduler.sync(movedInput); await pause();
  h.eq(started.length, 2, 'pan beyond snap re-requests');
  scheduler.sync({ ...movedInput, viewBox: { ...view, x: 500, w: 300 } });
  complete(new Blob(['second'])); await pause();
  h.ok(publications >= 2, 'completed intersecting detail publishes with newer view pending');
  scheduler.sync({ ...first, retain: new Map([[fig.id, { key: 'new', warming: false }]]) });
  h.ok(!get(d.figureDetails).has(fig.id), 'key change immediately removes old detail');
  h.ok(revoked.length > 0, 'replacement/drop revokes old blob URLs');
  scheduler.dispose();
  h.eq(atlasStats.failures, failures, 'detail path does not touch base failures');

  let attempts = 0;
  const refused = d.createDetailScheduler({ quiet: () => true, current: () => true, render: async () => { attempts++; throw Error('forced detail refusal'); }, decode: async () => 'blob:unused', revoke: () => {} });
  refused.sync(first); await pause(); refused.sync(first); await pause(); h.eq(attempts, 1, 'refusal backs off for the same key and zoom bucket');
  refused.sync({ ...first, zoom: 5 }); await pause(); h.eq(attempts, 2, 'new zoom bucket retries a refused detail'); refused.dispose();
  h.eq(atlasStats.failures, failures, 'refusal cannot poison base failure counters');

  let cancellations = 0;
  const refusedBeforeCancellation = atlasStats.detail.refused;
  const cancelled = d.createDetailScheduler({ quiet: () => true, current: () => true,
    render: async () => ++cancellations === 1 ? null : new Blob(['retry']), decode: async () => 'blob:cancelled-retry', revoke: () => {} });
  cancelled.sync(first); await pause();
  h.eq(cancellations, 2, 'a queued cancellation retries when the view has become current again');
  h.eq(atlasStats.detail.refused, refusedBeforeCancellation, 'cancellation is not a detail refusal');
  cancelled.dispose();
  let lateAttempts = 0, rejectOld!: (error: Error) => void;
  const lateRefusal = d.createDetailScheduler({ quiet: () => true, current: () => true,
    render: async () => { lateAttempts++; if (lateAttempts === 1) return new Promise<Blob | null>((_resolve, reject) => { rejectOld = reject; }); return new Blob(['new zoom']); },
    decode: async () => 'blob:new-zoom', revoke: () => {} });
  lateRefusal.sync(first); await pause();
  lateRefusal.sync({ ...first, zoom: 5 }); rejectOld(new Error('old zoom failed')); await pause();
  h.eq(lateAttempts, 2, 'a late error backs off the request zoom bucket, not a newer view bucket');
  lateRefusal.dispose();

  const keep = new Map(Array.from({ length: 5 }, (_, i) => ['r' + i, { key: 'k', warming: false }]));
  const retention = d.createDetailScheduler({ quiet: () => true, current: () => true, render: async () => new Blob(['ok']), decode: async () => `blob:retained:${publications++}`, revoke: url => revoked.push(url) });
  for (let i = 0; i < 5; i++) { retention.sync({ ...first, candidates: [{ figure: { ...fig, id: 'r' + i }, key: 'k' }], retain: keep }); await pause(); }
  retention.sync({ ...first, candidates: [{ figure: { ...fig, id: 'r4' }, key: 'k' }], retain: keep });
  h.ok(get(d.figureDetails).size <= 3, 'retention bounded by in-view plus two');
  retention.dispose(); h.eq(get(d.figureDetails).size, 0, 'dispose releases every detail');
} catch (e) { h.fail(String(e)); }
finally { atlasDev.detail.enabled = true; }
await h.done();
