// Figure pictures are disposable view state. Position and interaction chrome
// deliberately do not enter their keys; a drag must never request a new image.
import { get, writable } from 'svelte/store';
import type { Figure } from '../types';

export interface FigureRaster {
  figureId: string; key: string; S: number; w: number; h: number;
  dataUrl: string; bytes: number; route: 'L' | 'C' | 'disk';
  producedAt: number; lastShownAt: number;
}
export interface AtlasRequest {
  figureId: string; key: string; S: number; priority: 1 | 2 | 3; route: 'L' | 'C';
  distance?: number;
}
export const figureRasters = writable<ReadonlyMap<string, FigureRaster>>(new Map());
export const atlasRevision = writable(0);
/** R3' (orchestrator ruling, 2026-10-30): which route pictures a DEACTIVATED figure.
 * At or below this many mounted SVG nodes it is Route L (Chromium decodes the
 * figure's own live DOM: pixel-identical to what was on screen, ~7 ms per 1k
 * nodes on the main thread, so ≈ 40 ms at idle, under the long-task bar). Above
 * it, Route C (the raster service, off the main thread). Measured on the owner
 * project copy: the Chromium decode of the 11.8k-node Supplementary Figure 2
 * took 65–150 ms on the main thread, while Route C pictures differ from the
 * live render on 11 of 13 figures by 4–10 % of 2×2 blocks (crisp image
 * interpolation, dense-stroke anti-aliasing, one bold label drawn regular),
 * which reads as a shimmer on every switch. Cold pictures (open, entering view)
 * stay Route C; the browser harness (no service) uses Route L for everything;
 * Route C remains the fallback when Route L fails. */
export const ATLAS_ROUTE_L_MAX_NODES = 6000;
/** ...and at most this many elements. Route L's cost tracks element wrappers as
 * well as nodes: the native 1,600-object fixture figure has only 5,336 nodes but
 * its Chromium decode took 152 ms (serialize 6 ms, draw 5 ms), and under the
 * node rule alone it landed on the next Arrange key / nudge (verify-figure-
 * polish-electron 0/3: openMs 108–111, first nudge 109 vs median 72). 1,000 is
 * the existing working-set cap (Canvas PARK_MAX_ELEMENTS); the owner's figures
 * hold 2–42 elements, so all of them at ≤ 6,000 nodes stay on Route L. */
export const ATLAS_ROUTE_L_MAX_ELEMENTS = 1000;
export const atlasStats = { rasters: 0, bytes: 0, budget: 256 * 1024 * 1024,
  routeL: 0, routeC: 0, disk: 0, swaps: 0, blankFrames: 0, failures: 0, queue: 0 };

export function rasterKey(fig: Figure, figureRev: number, plotGen: Record<string, number>, posterRev: number): string {
  return [figureRev, fig.elements.flatMap(e => e.type === 'plot' ? [`${e.assetId}:${plotGen[e.assetId] ?? 0}`] : []).join(','),
    posterRev, `${fig.width}x${fig.height}`, fig.background ?? ''].join('|');
}
export function rasterScale(fig: Pick<Figure, 'width' | 'height'>, renderZoom: number, dpr: number): number {
  if (!(fig.width > 0 && fig.height > 0 && renderZoom > 0 && dpr > 0)) return 0;
  let S = Math.min(renderZoom * Math.min(dpr, 2), 4096 / fig.width, 4096 / fig.height,
    Math.sqrt(3_000_000 / (fig.width * fig.height)));
  // Ceil, rather than floor, is the image contract. Account for its last row
  // and column at the caps as well (a square-root cap alone can exceed 3 MP).
  if (Math.ceil(fig.width * S) * Math.ceil(fig.height * S) > 3_000_000) {
    let lo = 0, hi = S;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (Math.ceil(fig.width * mid) * Math.ceil(fig.height * mid) <= 3_000_000) lo = mid; else hi = mid;
    }
    S = lo;
  }
  return S;
}
export const usable = (r: FigureRaster | undefined, key: string): boolean => !!r && r.key === key;
export const soft = (r: FigureRaster, needed: number): boolean => needed > 1.25 * r.S;
function replace(next: ReadonlyMap<string, FigureRaster>): void {
  atlasStats.rasters = next.size;
  atlasStats.bytes = [...next.values()].reduce((n, r) => n + r.bytes, 0);
  figureRasters.set(next);
  atlasRevision.update(n => n + 1);
}
export function publish(r: FigureRaster): void {
  const next = new Map(get(figureRasters)); next.set(r.figureId, r); replace(next);
}
export function drop(id: string): void {
  const next = new Map(get(figureRasters)); if (next.delete(id)) replace(next);
}
export function touch(id: string): void {
  const r = get(figureRasters).get(id); if (r) r.lastShownAt = Date.now();
}
export function evictToBudget(protectedIds: ReadonlySet<string>): void {
  if (atlasStats.bytes <= atlasStats.budget) return;
  const next = new Map(get(figureRasters)); let bytes = atlasStats.bytes;
  for (const r of [...next.values()].filter(r => !protectedIds.has(r.figureId)).sort((a, b) => a.lastShownAt - b.lastShownAt)) {
    if (bytes <= atlasStats.budget) break;
    next.delete(r.figureId); bytes -= r.bytes;
  }
  if (next.size !== atlasStats.rasters) replace(next);
}

/** The routes own IO; the queue owns replacement, priority and publication.
 * A serial also retires an in-flight job replaced with the SAME content key
 * (e.g. a sharper request). No timer or frame loop runs at rest. */
export function createAtlasQueue(opts: {
  quiet: () => boolean;
  routeL: (req: AtlasRequest) => Promise<FigureRaster | null>;
  routeC: (req: AtlasRequest) => Promise<FigureRaster | null>;
  concurrency: { L: 1; C: number };
  current?: (req: AtlasRequest) => boolean;
  published?: (r: FigureRaster) => void;
  rearm?: () => void;
}) {
  const pending = new Map<string, AtlasRequest>(), versions = new Map<string, number>();
  const running = new Map<string, AtlasRequest>();
  const active = { L: 0, C: 0 };
  let disposed = false;
  const count = () => { atlasStats.queue = pending.size; };
  const valid = (req: AtlasRequest) => !disposed && (opts.current?.(req) ?? true);
  function drain(): void {
    if (disposed || !opts.quiet()) return;
    const ordered = [...pending.values()].sort((a, b) => a.priority - b.priority || (a.distance ?? 0) - (b.distance ?? 0));
    for (const req of ordered) {
      if (!opts.quiet()) break;
      if (running.has(req.figureId) || active[req.route] >= Math.max(1, opts.concurrency[req.route])) continue;
      pending.delete(req.figureId); count();
      if (!valid(req)) continue;
      const version = versions.get(req.figureId);
      running.set(req.figureId, req); active[req.route]++;
      void Promise.resolve().then(() => valid(req) && opts.quiet() ? (req.route === 'L' ? opts.routeL(req) : opts.routeC(req)) : null)
        .then(r => {
          if (!r || !valid(req) || versions.get(req.figureId) !== version || r.key !== req.key) return;
          publish(r); opts.published?.(r);
        }).catch(() => { atlasStats.failures++; }).finally(() => {
          running.delete(req.figureId); active[req.route]--;
          if (!disposed) { if (opts.rearm) opts.rearm(); else drain(); }
        });
    }
  }
  return {
    request(req: AtlasRequest) {
      if (disposed) return;
      const was = pending.get(req.figureId) ?? running.get(req.figureId);
      if (was && was.key === req.key && was.route === req.route &&
        (pending.has(req.figureId) ? was.S === req.S : was.S >= req.S)) {
        if (pending.has(req.figureId)) pending.set(req.figureId, { ...was, priority: Math.min(was.priority, req.priority) as 1 | 2 | 3, distance: req.distance });
        return;
      }
      versions.set(req.figureId, (versions.get(req.figureId) ?? 0) + 1);
      pending.set(req.figureId, req); count();
    },
    cancel(id: string) { pending.delete(id); versions.set(id, (versions.get(id) ?? 0) + 1); count(); },
    drain,
    size: () => pending.size,
    dispose() { disposed = true; pending.clear(); count(); },
  };
}

// Canvas installs its owner here. The dev handle imports policy only, never a
// Canvas component; split panes choose their active owner on demand.
export const atlasOwners = new Set<{ active: () => boolean; request: (req: AtlasRequest) => void; routeLNow: (id: string) => Promise<FigureRaster | null> }>();
export const atlasDev = {
  stats: atlasStats, rasters: figureRasters,
  request(req: AtlasRequest) { [...atlasOwners].find(o => o.active())?.request(req); },
  routeLNow(id: string) { return [...atlasOwners].find(o => o.active())?.routeLNow(id) ?? Promise.resolve(null); },
};
