import { RENDERER_VERSION, createRenderCore, type RenderCore, type RenderSpec, type LoadedModelStats } from './renderCore';
import { homeView } from './orbit';
import type { Model3dElement, Scene3dManifest } from './types';
import type { ModelBytes } from './service';

interface Shared {
  canvas: HTMLCanvasElement; core: RenderCore; owners: number;
  version: string; sources: WeakMap<ModelBytes, string>; sourceCount: number; refs: Map<string, number>; loads: Map<string, Promise<LoadedModelStats>>;
}
export interface InlineHostOptions {
  modelBytes: ModelBytes;
  /** Stable project/payload identity. Same asset id in another project stays distinct. */
  sourceKey?: string;
  document?: Document;
  manifest?: (id: string) => Scene3dManifest | undefined;
}
// Symbol storage survives separate IIFE copies embedded in distinct notebook outputs.
const poolKey = Symbol.for('flux.model3d.inlineHost');
export function defaultRenderElement(assetId: string, manifest?: Scene3dManifest): Model3dElement {
  return { type: 'model3d', id: assetId, assetId, x: 0, y: 0, width: 256, height: 256, rotation: 0, fill: '#4385be', modelColors: 'source', modelLighting: manifest?.lighting ?? 'studio', ...homeView(undefined, manifest) };
}
/** All inline players/viewers in one document share one hidden WebGL canvas. */
export function createInlineHost(options: InlineHostOptions) {
  const doc = options.document ?? document;
  const owner = doc as unknown as Record<symbol, Shared | undefined>;
  let shared = owner[poolKey];
  if (shared && shared.version !== RENDERER_VERSION) throw new Error('A different 3D renderer version already owns this document');
  if (!shared) { const canvas = doc.createElement('canvas'); shared = { canvas, core: createRenderCore(canvas), owners: 0, version: RENDERER_VERSION, sources: new WeakMap(), sourceCount: 0, refs: new Map(), loads: new Map() }; owner[poolKey] = shared; }
  const pool = shared; pool.owners++;
  let source = options.sourceKey ?? pool.sources.get(options.modelBytes);
  if (!source) { source = `source-${++pool.sourceCount}`; pool.sources.set(options.modelBytes, source); }
  const prefix = `${source}\u0000`, retained = new Set<string>(), views = new Set<ReturnType<typeof view>>();
  let disposed = false;
  const lifetime = new AbortController();
  const cancelled = new Promise<never>((_, reject) => lifetime.signal.addEventListener('abort', () => reject(new DOMException('3D inline host disposed', 'AbortError')), { once: true }));
  void cancelled.catch(() => {});
  const internal = (id: string) => prefix + id;
  function translate(spec: RenderSpec): RenderSpec { return { ...spec, assetId: internal(spec.assetId), ...(spec.morph ? { morph: { ...spec.morph, to: internal(spec.morph.to) } } : {}) }; }
  async function ready(assetIds: string[], warm: RenderSpec[] = []) {
    if (disposed) throw new Error('3D inline host disposed');
    await pool.core.ready();
    await Promise.race([cancelled, Promise.all(assetIds.map(async (id) => {
      const key = internal(id);
      if (!retained.has(id)) { retained.add(id); pool.refs.set(key, (pool.refs.get(key) ?? 0) + 1); }
      let loading = pool.loads.get(key);
      if (!loading) {
        loading = Promise.resolve(options.modelBytes(id)).then((bytes) => { if (disposed && !pool.refs.get(key)) throw new Error('3D inline load cancelled'); return pool.core.load(key, bytes); });
        pool.loads.set(key, loading);
        loading.catch(() => { if (pool.loads.get(key) === loading) pool.loads.delete(key); });
      }
      await loading;
      if (disposed) return;
      const spec = warm.find((s) => s.assetId === id) ?? { assetId: id, w: 64, h: 64, element: defaultRenderElement(id, options.manifest?.(id)), manifest: options.manifest?.(id) };
      // Program compilation/upload happens before playback can call synchronous render.
      pool.core.render(translate(spec.morph ? { ...spec, morph: undefined } : spec));
    }))]);
    if (disposed) throw new Error('3D inline host disposed');
    for (const spec of warm) pool.core.render(translate(spec));
  }
  function view(canvas: HTMLCanvasElement) {
    if (disposed) throw new Error('3D inline host disposed');
    const context = canvas.getContext('2d'); if (!context) throw new Error('2D canvas unavailable');
    let released = false;
    const handle = {
      render(element: Model3dElement, w: number, h: number, extra: Partial<Omit<RenderSpec, 'element' | 'w' | 'h' | 'assetId'>> = {}) {
        if (disposed || released) throw new Error('3D inline view disposed');
        const spec: RenderSpec = { assetId: element.assetId, element, w, h, manifest: options.manifest?.(element.assetId), ...extra };
        const rendered = pool.core.render(translate(spec));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        context.clearRect(0, 0, w, h); context.drawImage(pool.canvas, 0, 0, w, h); return rendered;
      },
      dispose() { if (released) return; released = true; canvas.width = 0; canvas.height = 0; views.delete(handle); },
    };
    views.add(handle); return handle;
  }
  function dispose() {
    if (disposed) return; disposed = true; lifetime.abort();
    for (const handle of views) handle.dispose();
    for (const id of retained) {
      const key = internal(id), refs = (pool.refs.get(key) ?? 1) - 1;
      if (refs > 0) pool.refs.set(key, refs);
      else { pool.refs.delete(key); const loading = pool.loads.get(key); pool.loads.delete(key); void loading?.then(() => { if (!pool.refs.has(key)) pool.core.unload(key); }).catch(() => {}); }
    }
    retained.clear(); pool.owners--;
    if (!pool.owners) { pool.core.dispose(); delete owner[poolKey]; }
  }
  return { ready, view, flightView: view, dispose, stats: () => pool.core.stats(), modelStats: (id: string) => pool.loads.get(internal(id)), snapshot: (spec: RenderSpec) => pool.core.snapshot(translate(spec)) };
}
export type InlineHost = ReturnType<typeof createInlineHost>;
