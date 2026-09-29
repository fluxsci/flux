/** Document half of the live Paper preview's 3D bridge (the parent half is
 * `previewModelBridge.ts`). The sandboxed preview carries model metadata only;
 * this host asks the parent's worker service for frames over postMessage and
 * draws the transferred bitmaps through the ordinary service host, so the
 * player behaves as it does in a live Paper widget. Bundled into the embed
 * runtime but used only when the document says `modelBridge` (live preview). */
import { createServiceHost, type ServiceHostBackend } from '../model3d/serviceHost';
import type { Model3dHost } from '../model3d/host';
import type { ExportPayload } from './payload';

const MESSAGE = 'fluxModel3d', REPLY = 'fluxModel3dReply';
const doc = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let calls = 0, listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', event => {
    const data = event.data as Record<string, unknown> | null;
    if (event.source !== parent || !data || data.doc !== doc || typeof data[REPLY] !== 'number') return;
    const waiter = pending.get(data[REPLY] as number); if (!waiter) return;
    pending.delete(data[REPLY] as number);
    if (data.ok) waiter.resolve(data.value);
    else waiter.reject(data.name === 'AbortError' ? new DOMException(String(data.error), 'AbortError') : new Error(String(data.error)));
  });
  parent.postMessage({ [MESSAGE]: 'hello', doc }, '*');
}
function request<T>(op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const call = ++calls;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { if (!pending.delete(call)) return; parent.postMessage({ [MESSAGE]: 'cancel', doc, call }, '*'); reject(new DOMException('3D render superseded', 'AbortError')); };
    pending.set(call, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value as T); }, reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
    signal?.addEventListener('abort', abort, { once: true });
    parent.postMessage({ [MESSAGE]: op, doc, call, ...body }, '*');
  });
}
export function previewModelHost(source: string, payload: ExportPayload): Model3dHost | undefined {
  if (parent === window || !payload.deck.assets.some(asset => asset.kind === 'glb')) return undefined;
  listen();
  const backend: ServiceHostBackend = {
    retain: asset => request('retain', { source, id: typeof asset === 'string' ? asset : asset.id }),
    release: id => { parent.postMessage({ [MESSAGE]: 'release', doc, source, id }, '*'); },
    renderBitmap: (spec, options) => request<ImageBitmap>('render', { source, spec, lane: options?.lane, channel: options?.channel, fullResolution: options?.fullResolution === true }, options?.signal),
  };
  return createServiceHost(backend, id => payload.modelManifests?.[id]);
}
