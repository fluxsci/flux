import type { Model3dService } from './service';
import type { RenderSpec } from './renderCore';
import type { Model3dElement, Scene3dManifest } from './types';
let nextChannel = 0;
/** Paper adapter: parse, compile and draw stay in the service worker. */
export function createServiceHost(service: Model3dService, manifest?: (id: string) => Scene3dManifest | undefined) {
  const retained = new Set<string>(), views = new Set<ReturnType<typeof view>>();
  let disposed = false;
  const loads = new Map<string, Promise<unknown>>(), lifetime = new AbortController();
  const cancelled = new Promise<never>((_, reject) => lifetime.signal.addEventListener('abort', () => reject(new DOMException('3D service host disposed', 'AbortError')), { once: true }));
  void cancelled.catch(() => {});
  async function ready(ids: string[]) {
    if (disposed) throw new Error('3D service host disposed');
    await Promise.race([cancelled, Promise.all(ids.map((id) => {
      let load = loads.get(id);
      if (!load) {
        retained.add(id);
        load = service.retain(id).catch((error) => { loads.delete(id); if (retained.delete(id)) service.release(id); throw error; });
        loads.set(id, load);
      }
      return load;
    }))]);
    if (disposed) throw new Error('3D service host disposed');
  }
  function view(canvas: HTMLCanvasElement) {
    if (disposed) throw new Error('3D service host disposed');
    const context = canvas.getContext('2d'); if (!context) throw new Error('2D canvas unavailable');
    const channel = `model3d-view-${++nextChannel}`;
    let revision = 0, released = false, abort: AbortController | undefined;
    const handle = {
      async render(element: Model3dElement, w: number, h: number, extra: Partial<Omit<RenderSpec, 'element' | 'w' | 'h' | 'assetId'>> = {}) {
        if (disposed || released) return;
        const current = ++revision; abort?.abort(); abort = new AbortController();
        try {
          const bitmap = await service.renderBitmap({ assetId: element.assetId, element, w, h, manifest: manifest?.(element.assetId), ...extra }, { lane: 'interactive', channel, signal: abort.signal });
          try { if (disposed || released || current !== revision) return; if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } context.clearRect(0, 0, w, h); context.drawImage(bitmap, 0, 0, w, h); }
          finally { bitmap.close(); }
        } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) throw error; }
      },
      dispose() { if (released) return; released = true; revision++; abort?.abort(); canvas.width = 0; canvas.height = 0; views.delete(handle); },
    };
    views.add(handle); return handle;
  }
  function dispose() { if (disposed) return; disposed = true; lifetime.abort(); loads.clear(); for (const handle of views) handle.dispose(); for (const id of retained) service.release(id); retained.clear(); }
  return { ready, view, flightView: view, dispose };
}
