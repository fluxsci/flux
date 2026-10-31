// A detail is view state, never atlas content. In particular, publishing one
// must not retire a zoom-proxy capture (atlasRevision is part of its key).
import { get, writable } from 'svelte/store';
import type { Figure } from '../types';
import { rotatedAABB, unionRect, type Rect } from '../geometry';
import { atlasDev, atlasStats, rasterScale, usable, type FigureRaster } from './atlas';

export const DETAIL_MAX_PIXELS = 9_000_000, DETAIL_MAX_SIDE = 8192;
export const DETAIL_MIN_EXTENT = 0.4, DETAIL_QUIET_MS = 400, DETAIL_SNAP = 64, DETAIL_KEEP_EXTRA = 2;
export interface FigureDetail {
  figureId: string; key: string; region: Rect; S: number; w: number; h: number;
  url: string; bytes: number; shown: boolean; lastShownAt: number;
}
export interface DetailRequest {
  figureId: string; key: string; scope: string; region: Rect; S: number; w: number; h: number; rid: string; zoomBucket?: number;
}
export interface DetailCandidate { figure: Figure; key: string; warming?: boolean }
export interface DetailInput {
  enabled: boolean; scope: string; viewBox: Rect; zoom: number; dpr: number;
  candidates: DetailCandidate[];
  /** Valid retained figures, including offscreen pictures and active warm-ups. */
  retain: ReadonlyMap<string, { key: string; warming: boolean }>;
}
export const figureDetails = writable<ReadonlyMap<string, FigureDetail>>(new Map());
export const neededScale = (zoom: number, dpr: number) => zoom * Math.min(dpr, 2);
export const wantsDetail = (fig: Figure, zoom: number, dpr: number) => neededScale(zoom, dpr) > 1.25 * rasterScale(fig, zoom, dpr);
export const contentExtent = (fig: Figure): Rect => unionRect([{ x: 0, y: 0, w: fig.width, h: fig.height }, ...fig.elements.map(rotatedAABB)])!;
export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
const contains = (a: Rect, b: Rect) => a.x <= b.x + 1e-7 && a.y <= b.y + 1e-7 && a.x + a.w + 1e-7 >= b.x + b.w && a.y + a.h + 1e-7 >= b.y + b.h;
export const localView = (view: Rect, fig: Figure): Rect | null => intersection({ x: view.x - fig.x, y: view.y - fig.y, w: view.w, h: view.h }, { x: 0, y: 0, w: fig.width, h: fig.height });
export function detailCovers(d: FigureDetail, key: string, view: Rect, zoom: number, dpr: number): boolean {
  return d.key === key && contains(d.region, view) && d.S * 1.25 >= neededScale(zoom, dpr);
}

export function detailCurrent(req: DetailRequest, state: {
  enabled: boolean; key?: string; activeId: string | null; mode?: string; scope: string;
  base?: FigureRaster; figure?: Figure; zoom: number; dpr: number; viewBox: Rect;
}): boolean {
  const { figure: fig } = state;
  return state.enabled && !!fig && state.key === req.key && state.scope === req.scope &&
    (fig.id !== state.activeId || state.mode === 'warming') && (state.mode === 'raster' || state.mode === 'warming') &&
    usable(state.base, req.key) && wantsDetail(fig, state.zoom, state.dpr) &&
    !!intersection(req.region, { x: state.viewBox.x - fig.x, y: state.viewBox.y - fig.y, w: state.viewBox.w, h: state.viewBox.h });
}

/** One pixel budget for the VIEW, not one screenful plus margin per figure.
 * The 0.4 extent floor is a resvg safety boundary; lower S, never that floor. */
export function detailWindow(viewBox: Rect, figs: Figure[], zoom: number, dpr: number, maxPixels = DETAIL_MAX_PIXELS): { regions: Map<string, Rect>; S: number; margin: number } {
  const grid = DETAIL_SNAP / zoom, need = neededScale(zoom, dpr);
  const windows = (margin: number) => new Map(figs.flatMap(fig => {
    const v = localView(viewBox, fig); if (!v) return [];
    const e = contentExtent(fig);
    const axis = (start: number, size: number, min: number, extent: number, viewSize: number) => {
      const end = Math.ceil((start + size + margin * viewSize) / grid) * grid;
      let lo = Math.floor((start - margin * viewSize) / grid) * grid;
      // Negative out-of-frame elements participate in the envelope too. A
      // region has nonnegative coordinates, so cover their left reach as well.
      const length = Math.min(min + extent, Math.max(end - lo, DETAIL_MIN_EXTENT * extent, -min / 2));
      lo = Math.max(0, Math.min(lo - Math.max(0, length - (end - lo)) / 2, min + extent - length));
      return [lo, length];
    };
    const [x, w] = axis(v.x, v.w, e.x, e.w, viewBox.w), [y, h] = axis(v.y, v.h, e.y, e.h, viewBox.h);
    return [[fig.id, { x, y, w, h }] as const];
  }));
  const fits = (regions: Map<string, Rect>, S: number) => {
    let px = 0;
    for (const r of regions.values()) {
      const w = Math.ceil(r.w * S), h = Math.ceil(r.h * S);
      if (w > DETAIL_MAX_SIDE || h > DETAIL_MAX_SIDE) return false;
      px += w * h;
    }
    return px <= Math.min(DETAIL_MAX_PIXELS, maxPixels);
  };
  let regions = windows(0), S = need, margin = 0;
  if (!fits(regions, S)) {
    let lo = 0, hi = S;
    for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (fits(regions, mid)) lo = mid; else hi = mid; }
    S = lo;
  } else for (const m of [0.25, 0.5]) { const grown = windows(m); if (!fits(grown, S)) break; regions = grown; margin = m; }
  return { regions, S, margin };
}

/** One running job (also owns its held result/decode), one latest pending job.
 * Re-entry is driven by sync/completion/a finite quiet timer; no idle polling. */
export function createDetailScheduler(opts: {
  quiet: () => boolean; current: (req: DetailRequest) => boolean;
  render: (req: DetailRequest) => Promise<Blob | null>;
  cancel?: (rid: string) => void;
  publish?: (detail: FigureDetail) => void; drop?: (id: string) => void;
  decode?: (blob: Blob) => Promise<string>; revoke?: (url: string) => void;
}) {
  let input: DetailInput | null = null, scope = '', signature = '', disposed = false, serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, quietAt = 0, wasQuiet = false;
  let pending: DetailRequest | null = null;
  type Job = { req: DetailRequest; blob?: Blob; url?: string; decoding?: boolean; done?: boolean; cancelled?: boolean };
  let running: Job | null = null;
  const owned = new Set<string>(), detailRefused = new Map<string, string>();
  const stats = atlasStats.detail;
  const revoke = opts.revoke ?? (url => requestAnimationFrame(() => requestAnimationFrame(() => URL.revokeObjectURL(url))));
  const decode = opts.decode ?? (async blob => {
    const url = URL.createObjectURL(blob), image = new Image(); image.src = url;
    try { await image.decode(); return url; } catch (error) { revoke(url); throw error; }
  });
  const bucket = () => Math.floor(Math.log(Math.max(1e-6, input!.zoom)) / Math.log(1.25));
  const refusal = (req: Pick<DetailRequest, 'key' | 'zoomBucket'>) => `${req.key}|${req.zoomBucket ?? bucket()}`;
  const quiet = () => !disposed && !!input?.enabled && atlasDev.detail.enabled && opts.quiet();
  const ready = () => quiet() && Date.now() >= quietAt;
  const valid = (req: DetailRequest) => !disposed && !!input?.enabled && req.scope === scope && opts.current(req);
  function recount() {
    const entries = [...get(figureDetails).values()];
    stats.bytes = entries.reduce((n, d) => n + d.bytes, 0); stats.px = entries.reduce((n, d) => n + d.w * d.h, 0);
    stats.maxEntries = Math.max(stats.maxEntries, entries.length);
  }
  function drop(id: string) {
    const next = new Map(get(figureDetails)), old = next.get(id);
    if (!old) return;
    next.delete(id); owned.delete(id); figureDetails.set(next); opts.drop?.(id); revoke(old.url); recount();
  }
  function put(detail: FigureDetail) {
    const next = new Map(get(figureDetails)), old = next.get(detail.figureId);
    next.set(detail.figureId, detail); owned.add(detail.figureId); figureDetails.set(next); opts.publish?.(detail);
    if (old && old.url !== detail.url) revoke(old.url);
    trim(); recount();
  }
  function trim() {
    if (!input) return;
    const inView = new Set(input.candidates.filter(c => localView(input!.viewBox, c.figure)).map(c => c.figure.id));
    const extras = [...owned].filter(id => !inView.has(id)).sort((a, b) => get(figureDetails).get(b)!.lastShownAt - get(figureDetails).get(a)!.lastShownAt);
    for (const id of extras.slice(DETAIL_KEEP_EXTRA)) drop(id);
  }
  function arm() {
    if (disposed || timer || !quiet()) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, Math.max(0, quietAt - Date.now()));
  }
  function refuse(req: DetailRequest) { if (valid(req)) { detailRefused.set(req.figureId, refusal(req)); stats.refused++; } }
  function choose() {
    if (!input) return;
    const candidates = input.candidates.filter(c => !c.warming && wantsDetail(c.figure, input!.zoom, input!.dpr));
    const { regions, S } = detailWindow(input.viewBox, candidates.map(c => c.figure), input.zoom, input.dpr, atlasDev.detail.maxPixels);
    const ordered = candidates.sort((a, b) => {
      const va = localView(input!.viewBox, a.figure), vb = localView(input!.viewBox, b.figure);
      return (vb ? vb.w * vb.h : 0) - (va ? va.w * va.h : 0);
    });
    let next: DetailRequest | null = null;
    for (const { figure, key } of ordered) {
      const region = regions.get(figure.id); if (!region || !(S > 0) || detailRefused.get(figure.id) === refusal({ key })) continue;
      const d = get(figureDetails).get(figure.id), v = localView(input.viewBox, figure)!;
      // When the envelope binds, S may be below need/1.25. Accept that
      // budget-limited scale too, rather than requesting the same PNG forever.
      if (d && (detailCovers(d, key, v, input.zoom, input.dpr) ||
        d.key === key && contains(d.region, v) && d.S + 1e-7 >= S)) { d.lastShownAt = Date.now(); continue; }
      if (running && running.req.figureId === figure.id && running.req.key === key && contains(running.req.region, region) && running.req.S + 1e-7 >= S) continue;
      next = { figureId: figure.id, key, scope, region, S, w: Math.max(1, Math.ceil(region.w * S)), h: Math.max(1, Math.ceil(region.h * S)), rid: `atlas-D:${figure.id}:${++serial}`, zoomBucket: bucket() };
      break;
    }
    pending = next;
  }
  async function drain() {
    if (!ready()) { arm(); return; }
    if (running) {
      const job = running;
      if (job.decoding || !job.done) return;
      if (!valid(job.req)) { if (job.url) revoke(job.url); running = null; }
      else if (job.blob) {
        if (!job.url) {
          job.decoding = true;
          try { stats.decodes++; job.url = await decode(job.blob); }
          catch { refuse(job.req); running = null; }
          finally { job.decoding = false; }
          if (disposed) { if (job.url) revoke(job.url); return; }
          if (running !== job) { void drain(); return; }
          if (!ready()) { stats.held++; arm(); return; }
        }
        if (valid(job.req)) {
          const start = performance.now();
          put({ ...job.req, url: job.url!, bytes: job.blob.size, shown: true, lastShownAt: Date.now() });
          stats.swaps++; stats.timeToSharpMs.push(Date.now() - quietAt + DETAIL_QUIET_MS);
          if (stats.timeToSharpMs.length > 128) stats.timeToSharpMs.shift();
          stats.swapSyncMs.push(performance.now() - start);
          if (stats.swapSyncMs.length > 128) stats.swapSyncMs.shift();
        } else if (job.url) revoke(job.url);
        running = null;
      } else running = null;
    }
    choose();
    if (!pending || !ready()) return;
    const req = pending; pending = null;
    if (!valid(req)) return;
    const job = { req, done: false } as Job; running = job; stats.requests++;
    try { job.blob = await opts.render(req) ?? undefined; }
    catch { refuse(req); }
    job.done = true;
    if (!job.blob) { if (running === job) running = null; }
    else if (!ready()) stats.held++;
    if (!disposed) { if (ready()) void drain(); else arm(); }
  }
  return {
    sync(next: DetailInput) {
      if (disposed) return;
      input = next;
      if (next.scope !== scope) { for (const id of [...owned]) drop(id); detailRefused.clear(); scope = next.scope; }
      const enabled = next.enabled && atlasDev.detail.enabled;
      if (running && (!enabled || !valid(running.req)) && !running.cancelled) {
        running.cancelled = true; opts.cancel?.(running.req.rid);
      }
      if (running?.done && !running.decoding && (!enabled || !valid(running.req))) {
        if (running.url) revoke(running.url); running = null;
      }
      for (const id of [...owned]) {
        const d = get(figureDetails).get(id), retained = next.retain.get(id);
        if (!enabled || !d || !retained || (!retained.warming && retained.key !== d.key)) drop(id);
      }
      if (!enabled || !quiet()) {
        wasQuiet = false;
        if (timer) clearTimeout(timer); timer = undefined; quietAt = Date.now() + DETAIL_QUIET_MS;
        if (pending) opts.cancel?.(pending.rid); pending = null;
        return;
      }
      if (!wasQuiet) quietAt = Date.now() + DETAIL_QUIET_MS;
      wasQuiet = true;
      const sig = JSON.stringify([next.scope, next.viewBox, next.zoom, next.dpr, next.candidates.map(c => [c.figure.id, c.key, c.warming, c.figure.x, c.figure.y]), atlasDev.detail.maxPixels]);
      if (sig !== signature) { signature = sig; quietAt = Date.now() + DETAIL_QUIET_MS; if (timer) clearTimeout(timer); timer = undefined; }
      trim();
      for (const id of owned) {
        const d = get(figureDetails).get(id)!, candidate = next.candidates.find(c => c.figure.id === id);
        const shown = !!candidate && (!!candidate.warming || wantsDetail(candidate.figure, next.zoom, next.dpr) && !!localView(next.viewBox, candidate.figure));
        if (d.shown !== shown) put({ ...d, shown });
      }
      // prune refusal entries with their figures; zoom/key changes are checked above.
      for (const id of detailRefused.keys()) if (!next.retain.has(id)) detailRefused.delete(id);
      arm();
    },
    dispose() {
      disposed = true; if (timer) clearTimeout(timer); if (pending) opts.cancel?.(pending.rid); pending = null;
      for (const id of [...owned]) drop(id);
      if (running?.url && !running.decoding) revoke(running.url);
      if (running && !running.cancelled) opts.cancel?.(running.req.rid);
      running = null;
    },
  };
}
