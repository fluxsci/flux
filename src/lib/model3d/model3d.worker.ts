/// <reference lib="webworker" />
import { createRenderCore, type RenderCore } from './renderCore';
const scope = self as unknown as DedicatedWorkerGlobalScope;
let core: RenderCore | undefined;
const canvas = new OffscreenCanvas(1, 1);
function getCore() {
  return core ??= createRenderCore(canvas, { onContextState: (lost) => scope.postMessage({ type: lost ? 'lost' : 'restored', stats: core?.stats() }) });
}
// Parsing is async, but no later render/unload can overtake an earlier load.
let queue = Promise.resolve();
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { type, reqId } = data;
    try {
      if (type === 'dispose') { core?.dispose(); core = undefined; scope.close(); return; }
      const renderer = getCore(); await renderer.ready();
      if (type === 'available') {
        const gl = canvas.getContext('webgl2')!, debug = gl.getExtension('WEBGL_debug_renderer_info');
        scope.postMessage({ type: 'available', reqId, ok: true, renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), stats: renderer.stats() });
      } else if (type === 'load') {
        const model = await renderer.load(data.assetId, data.bytes, data.bounds);
        scope.postMessage({ type: 'loaded', reqId, model, stats: renderer.stats() });
      } else if (type === 'unload') {
        renderer.unload(data.assetId); scope.postMessage({ type: 'unloaded', reqId, stats: renderer.stats() });
      } else if (type === 'render') {
        const start = performance.now(); const output = renderer.frame(data.spec).canvas as OffscreenCanvas; const renderMs = performance.now() - start;
        if (data.format === 'png') {
          const blob = await output.convertToBlob({ type: 'image/png' });
          scope.postMessage({ type: 'rendered', reqId, blob, ms: performance.now() - start, renderMs, encodeMs: performance.now() - start - renderMs, stats: renderer.stats() });
        } else {
          const bitmap = output.transferToImageBitmap();
          scope.postMessage({ type: 'rendered', reqId, bitmap, ms: performance.now() - start, renderMs, encodeMs: performance.now() - start - renderMs, stats: renderer.stats() }, [bitmap]);
        }
      } else throw new Error(`Unknown 3D worker request: ${type}`);
    } catch (error) {
      scope.postMessage({ type: 'error', reqId, reason: error instanceof Error ? error.message : String(error), stats: core?.stats() });
    }
  });
};
