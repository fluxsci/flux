// Canvas owns mounting and gestures; this owner manages the atlas's bounded
// transitions and idle work. It never mutates project data or the viewport.
import { get, writable } from 'svelte/store';
import { tick } from 'svelte';
import type { Figure } from '../types';
import type { FileBridge } from '../project/types';
import { hasPlotDom } from '../plot/store';
import { effectiveHidden } from '../groups';
import { rectsIntersect, type Rect } from '../geometry';
import { rasterCold, rasterLive } from './atlasRoutes';
import { atlasStats, atlasOwners, atlasRevision, createAtlasQueue, drop, evictToBudget, figureRasters, rasterKey, rasterScale, soft, touch, usable,
  type AtlasRequest, type FigureRaster } from './atlas';

export type AtlasMode = 'live' | 'raster' | 'warming' | 'cold' | 'fallback';
interface Entry { mode: AtlasMode; key: string; pending: boolean; ready: string; preparing: string; refusedC: string; failedL: string;
  signature: string; global: number; revision: number; epoch: number; full: boolean; recheck: boolean }
/** View state per figure; `full` = a live non-active figure that must mount whole (its picture will be a Route-L capture). */
export interface AtlasViewEntry { mode: AtlasMode; pending: boolean; full: boolean }
export interface AtlasCanvasInput {
  enabled: boolean; activeId: string | null; scope: string; figures: Figure[]; visible: Figure[];
  revisions: Record<string, number>; global: number; plotGen: Record<string, number>; poster: number;
  zoom: number; dpr: number; root: string; bridge: FileBridge | null; assets: import('../types').Asset[]; bytes: Record<string, string>;
  center: { x: number; y: number };
  viewBox: Rect;
}
export function createCanvasAtlas(opts: {
  active: () => boolean;
  quiet: () => boolean;
  group: (id: string) => SVGGElement | null;
  /** The element ids Canvas mounts for a figure (the active figure's culled set). */
  wanted?: (id: string) => ReadonlySet<string> | undefined;
  rememberBounds: (fig: Figure) => void;
}) {
  const view = writable<ReadonlyMap<string, AtlasViewEntry>>(new Map());
  const entries = new Map<string, Entry>();
  let input: AtlasCanvasInput | null = null, scope = '', active: string | null = null, destroyed = false;
  let coldUnavailable = false;
  let idle: number | null = null;
  let viewQueued = false;
  let pendingView: ReadonlyMap<string, AtlasViewEntry> = new Map();
  const emit = () => {
    const previous = get(view);
    if (!viewQueued && previous.size === entries.size && ![...entries].some(([id, e]) => previous.get(id)?.mode !== e.mode || previous.get(id)?.pending !== e.pending || previous.get(id)?.full !== e.full)) return;
    pendingView = new Map([...entries].map(([id, e]) => [id, { mode: e.mode, pending: e.pending, full: e.full }]));
    if (viewQueued) return;
    viewQueued = true;
    // sync() runs from a legacy $: consumer of the mount list. Publish outside
    // that flush: an upstream store write inside it can leave the cull memo
    // computed from the preceding mode until the next unrelated input.
    queueMicrotask(() => {
      viewQueued = false;
      const previous = get(view);
      if (!destroyed && (previous.size !== pendingView.size || [...pendingView].some(([id, e]) => previous.get(id)?.mode !== e.mode || previous.get(id)?.pending !== e.pending || previous.get(id)?.full !== e.full))) {
        view.set(pendingView); atlasRevision.update(n => n + 1);
      }
    });
  };
  const figOf = (id: string) => input?.figures.find(f => f.id === id);
  const current = (req: AtlasRequest) => {
    const fig = figOf(req.figureId), raster = get(figureRasters).get(req.figureId);
    return !destroyed && !!input?.enabled && entries.get(req.figureId)?.key === req.key && !!fig &&
      (req.priority !== 3 || !raster || soft(raster, rasterScale(fig, input.zoom, input.dpr)));
  };
  const quiet = () => !destroyed && !!input?.enabled && opts.quiet();
  const coldConcurrency = Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 8) / 8)));
  const queue = createAtlasQueue({ quiet, current, concurrency: { L: 1, C: coldConcurrency }, rearm: () => { if (input) sync(input); },
    routeL: async req => {
      const e = entries.get(req.figureId), fig = figOf(req.figureId), group = opts.group(req.figureId);
      if (!e || !fig || !group || e.mode === 'raster' || e.mode === 'cold' || e.ready !== req.key || !quiet()) return null;
      atlasStats.routeL++;
      try {
        return await rasterLive(req, fig, group, input!.bridge, () => quiet() && current(req) && opts.group(req.figureId) === group && e.key === req.key);
      } catch { e.failedL = req.key; e.pending = false; e.mode = 'fallback'; atlasStats.failures++; emit(); return null; }
    },
    routeC: async req => {
      const e = entries.get(req.figureId), fig = figOf(req.figureId), source = input!;
      if (!e || !fig || !source.bridge || !quiet()) return null;
      atlasStats.routeC++;
      try { return await rasterCold(req, fig, source.assets, source.bytes, source.root, source.bridge); }
      catch (error) {
        if (current(req)) {
          if ((error instanceof Error ? error.message : String(error)) === 'unavailable') coldUnavailable = true;
          e.refusedC = req.key; e.ready = '';
          // A stale picture remains above the warming slots until they can
          // replace it. A cold refusal mounts immediately, as before the atlas.
          e.mode = get(figureRasters).has(fig.id) ? 'warming' : 'live';
          atlasStats.failures++; emit();
        }
        return null;
      }
    },
    published: r => {
      const e = entries.get(r.figureId), fig = figOf(r.figureId);
      if (!e || !fig) return;
      if (r.figureId !== input?.activeId) {
        opts.rememberBounds(fig); e.mode = 'raster'; e.pending = false; atlasStats.swaps++;
      }
      emit();
      if (input) sync(input);
    },
  });
  function schedule() {
    if (idle !== null || !queue.size() || !quiet()) return;
    const run = () => { idle = null; if (quiet()) queue.drain(); };
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run, { timeout: 300 });
    else idle = window.setTimeout(run, 0);
  }
  async function prepare(fig: Figure, entry: Entry) {
    const key = entry.key;
    if (entry.ready === key) return;
    // A check already in flight may have read the state just BEFORE this call's
    // trigger (e.g. the warm-up completing): it re-runs once it finishes.
    if (entry.preparing === key) { entry.recheck = true; return; }
    entry.recheck = false;
    entry.preparing = key;
    await tick();
    const group = opts.group(fig.id);
    // A non-active figure must be whole (its picture is complete); the active
    // figure is ready when its culled working set is (the swap shows only that).
    // The active figure's set comes from Canvas's warm-up (undefined = not fed
    // yet: the view store may still say 'raster' for this microtask).
    const satisfied = () => {
      const mounted = new Set(Array.from(group?.querySelectorAll('[data-editor-element-id]') ?? []).map(n => n.getAttribute('data-editor-element-id')));
      const active = fig.id === input?.activeId, want = active ? opts.wanted?.(fig.id) : undefined;
      if (active && opts.wanted && !want) return false;
      const needed = want ? fig.elements.filter(el => want.has(el.id)) : fig.elements;
      return !!group && needed.every(el => effectiveHidden(fig, el) || mounted.has(el.id)) &&
        needed.every(el => effectiveHidden(fig, el) || el.type !== 'plot' || !input?.bytes[el.assetId] || hasPlotDom(el.assetId));
    };
    if (satisfied()) {
      // One frame is painted BETWEEN these callbacks. No ambient readiness poll:
      // plot generations / mounting / quiet transitions re-enter sync instead.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!destroyed && entries.get(fig.id) === entry && entry.key === key && opts.group(fig.id) === group && (fig.id === input?.activeId || quiet()) && satisfied()) {
        entry.ready = key;
        if (entry.mode === 'warming') { entry.mode = 'live'; atlasStats.swaps++; emit(); }
      }
    }
    if (entry.preparing === key) entry.preparing = '';
    if (entry.ready === key && input && !destroyed) sync(input);
    else if (entry.recheck && !destroyed && entries.get(fig.id) === entry) { entry.recheck = false; void prepare(fig, entry); }
  }
  function requestFor(fig: Figure, priority: 1 | 2 | 3, route: 'L' | 'C') {
    const source = input!, entry = entries.get(fig.id)!;
    queue.request({ figureId: fig.id, key: entry.key, S: rasterScale(fig, source.zoom, source.dpr), priority, route,
      distance: Math.hypot(fig.x + fig.width / 2 - source.center.x, fig.y + fig.height / 2 - source.center.y) });
  }
  function sync(next: AtlasCanvasInput) {
    input = next;
    if (next.scope !== scope) {
      for (const id of entries.keys()) { queue.cancel(id); drop(id); }
      entries.clear(); scope = next.scope; active = null; coldUnavailable = false;
    }
    if (!next.enabled) {
      for (const id of entries.keys()) queue.cancel(id);
      entries.clear(); active = next.activeId; emit(); return;
    }
    const visible = new Set(next.visible.map(f => f.id)), existing = new Set(next.figures.map(f => f.id));
    const inView = new Set(next.figures.filter(f => rectsIntersect({ x: f.x, y: f.y, w: f.width, h: f.height }, next.viewBox)).map(f => f.id));
    const rasters = get(figureRasters);
    for (const id of entries.keys()) if (!existing.has(id)) { queue.cancel(id); entries.delete(id); drop(id); }
    for (const fig of next.figures) {
      const rev = next.revisions[fig.id] ?? 0;
      let e = entries.get(fig.id);
      if (!e) {
        e = { mode: fig.id !== next.activeId && next.bridge?.rasterizeFigure && !coldUnavailable ? 'cold' : 'live', key: '', pending: false,
          ready: '', preparing: '', refusedC: '', failedL: '', signature: '', global: -1, revision: -1, epoch: 0, full: false, recheck: false };
        entries.set(fig.id, e);
      }
      if (fig.id === next.activeId) {
        // The active figure is live; its picture is retaken on deactivation.
        // Every commit() bumps globalRev, so serializing a 5,000-object active
        // figure per edit cost ~10 ms of key-to-paint: a global-only notify
        // simply retires its key instead, and the comparison baseline is
        // re-taken once it is inactive again.
        if (e.global !== next.global && e.revision === rev) e.epoch++;
        e.signature = ''; e.global = next.global; e.revision = rev;
      } else if (e.global !== next.global || e.revision !== rev || !e.signature) {
        // Undo, bridge edits and cross-figure moves notify globalRev rather
        // than figureRev. Compare only picture data on THAT notification;
        // position-only commits and other figures' edits keep their pictures.
        const signature = JSON.stringify([fig.width, fig.height, fig.background, fig.elements, fig.groups]);
        if (e.signature && e.signature !== signature && e.revision === rev) e.epoch++;
        e.signature = signature; e.global = next.global; e.revision = rev;
      }
      e.key = rasterKey(fig, rev, next.plotGen, next.poster) + `|${e.epoch}`;
      if (coldUnavailable) {
        e.refusedC = e.key;
        if (e.mode === 'cold') { queue.cancel(fig.id); e.mode = 'live'; }
      }
      const raster = rasters.get(fig.id);
      // An evicted picture cannot cover the live warm-up.
      if (e.mode === 'warming' && !raster) { e.mode = 'live'; e.ready = ''; }
      if (e.mode === 'cold' && raster) e.mode = 'raster'; // a preloaded picture also covers a cold mount
      // A refused picture uses ordinary live culling, not the full-figure
      // capture mount. A different key may become renderable on the next idle.
      if (e.mode === 'fallback' && e.failedL !== e.key && quiet()) { e.mode = 'live'; e.ready = ''; }
      // D3 ruling (2026-10-30): with the raster service available, a live
      // non-active figure (just deactivated, or stale) is pictured by Route C
      // from its current model: no whole-figure mount, no main-thread SVG
      // parse. Route L stays the browser path and the fallback when the
      // service refuses this key or is unavailable. It stays live until then.
      const viaC = !!next.bridge?.rasterizeFigure && !coldUnavailable && e.refusedC !== e.key;
      if (fig.id === next.activeId) {
        queue.cancel(fig.id); e.pending = false;
        if (e.mode === 'raster') { e.mode = raster ? 'warming' : 'live'; e.ready = ''; }
        else if (e.mode === 'cold') e.mode = 'live';
      } else {
        // A known Route-L refusal keeps normal live culling; revisiting and
        // leaving the same key must not pin it forever awaiting a job we skip.
        if (fig.id === active && active !== next.activeId) e.pending = e.failedL !== e.key;
        const needsSharper = !!raster && soft(raster, rasterScale(fig, next.zoom, next.dpr));
        if ((e.mode === 'live' || e.mode === 'warming') && usable(raster, e.key) && !needsSharper) {
          opts.rememberBounds(fig); e.mode = 'raster'; e.pending = false; atlasStats.swaps++;
        }
        if (!visible.has(fig.id) && !e.pending) continue;
        if (e.mode === 'raster' || e.mode === 'cold') {
          if (!usable(raster, e.key) && e.refusedC !== e.key && (!raster || inView.has(fig.id))) requestFor(fig, 1, 'C');
          else if (!usable(raster, e.key) && e.refusedC === e.key && inView.has(fig.id) && (!raster || quiet())) { e.mode = raster ? 'warming' : 'live'; e.ready = ''; }
          else if (needsSharper && inView.has(fig.id)) {
            if (e.refusedC !== e.key) requestFor(fig, 3, 'C');
            else if (quiet()) { e.mode = 'warming'; e.ready = ''; }
          }
        } else if (viaC) {
          if (!usable(raster, e.key) || needsSharper) requestFor(fig, e.pending ? 2 : usable(raster, e.key) ? 3 : 1, 'C');
        } else if (e.ready === e.key && e.failedL !== e.key) requestFor(fig, e.pending ? 2 : usable(raster, e.key) ? 3 : 1, 'L');
      }
      e.full = fig.id !== next.activeId && (e.mode === 'live' || e.mode === 'warming') && !viaC;
      if ((e.full || e.mode === 'warming' && fig.id === next.activeId) && (visible.has(fig.id) || e.pending)) void prepare(fig, e);
      if (inView.has(fig.id) && raster) touch(fig.id);
    }
    active = next.activeId; emit();
    atlasStats.blankFrames = next.visible.filter(f => entries.get(f.id)?.mode === 'cold').length;
    evictToBudget(new Set([...inView, ...(next.activeId ? [next.activeId] : []), ...[...entries].filter(([, e]) => e.pending).map(([id]) => id)]));
    schedule();
  }
  const owner = { active: () => !!input?.enabled && opts.active(), request: queue.request,
    async routeLNow(id: string): Promise<FigureRaster | null> {
      const fig = figOf(id), e = entries.get(id), group = opts.group(id);
      if (!fig || !e || !group || !input) return null;
      const req: AtlasRequest = { figureId: id, key: e.key, S: rasterScale(fig, input.zoom, input.dpr), priority: 2, route: 'L' };
      return rasterLive(req, fig, group, input.bridge, () => current(req) && opts.group(id) === group);
    } };
  atlasOwners.add(owner);
  return { view, sync, rearm: schedule, key: (id: string) => entries.get(id)?.key,
    /** Canvas's warm-up finished mounting: judge readiness now (not via a later reactive pass). */
    recheck(id: string) { const e = entries.get(id), fig = figOf(id); if (e && fig && !destroyed) void prepare(fig, e); },
    destroy() {
      destroyed = true; queue.dispose(); atlasOwners.delete(owner);
      if (idle !== null) { if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle); else clearTimeout(idle); }
    } };
}
