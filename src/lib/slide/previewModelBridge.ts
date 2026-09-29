/** Parent half of the live Paper preview's 3D bridge (the sandboxed preview
 * document's half is `previewModelClient.ts`). The preview re-renders its
 * srcdoc after every edit; carrying portable GLB bytes made each render
 * serialize (and the iframe re-parse and re-upload) every model, and a cached
 * copy kept showing a model whose file was deleted. Instead the document
 * carries metadata only and renders through the same worker service as the
 * live Paper widgets: this module answers its retain/render requests from the
 * repository's current snapshot, whose file reads re-check existence and the
 * prepared sha256 whenever the repository is invalidated.
 *
 * Only the owning iframe may call, only for the slides of the latest render,
 * only for model assets of that slide; manifests always come from the parent's
 * snapshot, never from the document. Worker holds outlive a single srcdoc (so
 * an edit does not reload geometry) and end when a slide leaves the rendered
 * set, its snapshot changes, or the preview closes. */
import { embedKey, validEmbedId } from './embed';
import type { SlideRepository, SlideSnapshot } from './embedRepository';
import type { ServiceHostBackend } from '../model3d/serviceHost';
import type { Model3dRenderSpec } from '../model3d/types';

export const PREVIEW_MODEL_MESSAGE = 'fluxModel3d';
export const PREVIEW_MODEL_REPLY = 'fluxModel3dReply';
const MAX_EDGE = 8192;
type Served = { backend: ServiceHostBackend; dispose(): void };
interface Entry { snapshot: SlideSnapshot; served: Served; loads: Map<string, Promise<unknown>>; ids: Set<string> }
export interface PreviewModelBridgeOptions {
  repository: SlideRepository;
  /** The preview iframe's window; messages from anything else are ignored. */
  frame(): Window | null | undefined;
  /** Test seam; production serves the repository snapshot through the worker. */
  serve?(snapshot: SlideSnapshot): Served | undefined;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}
const parseSource = (source: unknown) => {
  if (typeof source !== 'string' || source.length > 512) return null;
  try {
    const [deck, slide] = JSON.parse(source) as unknown[];
    return typeof deck === 'string' && typeof slide === 'string' && validEmbedId(deck) && validEmbedId(slide) && embedKey({ deck, slide }) === source ? { deck, slide } : null;
  } catch { return null; }
};
const size = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_EDGE;

export function createPreviewModelBridge(options: PreviewModelBridgeOptions) {
  const target = options.target ?? window;
  const entries = new Map<string, Promise<Entry>>(), calls = new Map<number, AbortController>();
  let kept = new Set<string>(), doc: string | null = null, disposed = false;
  const serve = options.serve ?? ((snapshot: SlideSnapshot) => loadServe().then(fn => fn(snapshot)));
  let served: Promise<(snapshot: SlideSnapshot) => Served | undefined> | undefined;
  function loadServe() { return served ??= import('./embedServiceHost').then(m => m.createEmbedServiceBackend); }

  function drop(source: string) {
    const entry = entries.get(source); entries.delete(source);
    void entry?.then(e => e.served.dispose(), () => {});
  }
  async function entryFor(source: string): Promise<Entry> {
    const ref = parseSource(source);
    if (!ref || !kept.has(source)) throw new Error('This slide is not part of the current preview');
    // The repository answers from its current generation's cache; after an
    // invalidation it is a new snapshot, whose holds re-read (and re-check) the files.
    const snapshot = await options.repository.load(ref);
    if (disposed || !kept.has(source)) throw new DOMException('Preview closed or changed', 'AbortError');
    const pending = entries.get(source);
    if (pending) {
      const entry = await pending.catch(() => undefined);
      if (entries.get(source) !== pending) return entryFor(source);
      if (entry?.snapshot === snapshot) return entry;
      drop(source);
    }
    const created = (async () => {
      const served = await serve(snapshot);
      if (!served) throw new Error('This slide has no 3D models');
      return { snapshot, served, loads: new Map<string, Promise<unknown>>(), ids: new Set((snapshot.modelSource?.assets ?? []).map(asset => asset.id)) };
    })();
    entries.set(source, created);
    const entry = await created;
    if (disposed || entries.get(source) !== created) { entry.served.dispose(); throw new DOMException('Preview closed or changed', 'AbortError'); }
    return entry;
  }
  function retain(entry: Entry, id: string) {
    if (!entry.ids.has(id)) throw new Error(`3D model "${id}" is not part of this slide`);
    let load = entry.loads.get(id);
    if (!load) {
      load = entry.served.backend.retain(id).catch(error => { if (entry.loads.get(id) === load) { entry.loads.delete(id); entry.served.backend.release(id); } throw error; });
      entry.loads.set(id, load);
    }
    return load;
  }
  /** The document supplies camera/state data only: model identities must be
   * this slide's, sizes are bounded and manifests come from the snapshot. */
  function trustedSpec(entry: Entry, spec: Model3dRenderSpec): Model3dRenderSpec {
    if (!spec || typeof spec !== 'object' || !entry.ids.has(spec.assetId) || !size(spec.w) || !size(spec.h)) throw new Error('Invalid 3D render request');
    const manifests = entry.snapshot.payload.modelManifests ?? {};
    const manifest = (id: string) => Object.hasOwn(manifests, id) ? manifests[id] : undefined;
    for (const to of [spec.morph?.to, spec.crossfade?.to]) if (to !== undefined && !entry.ids.has(to)) throw new Error('Invalid 3D render request');
    return { ...spec, manifest: manifest(spec.assetId),
      ...(spec.morph ? { morph: { ...spec.morph, toManifest: manifest(spec.morph.to) } } : {}),
      ...(spec.crossfade ? { crossfade: { ...spec.crossfade, toManifest: manifest(spec.crossfade.to) } } : {}) };
  }
  function reply(to: Window, message: Record<string, unknown>, transfer: Transferable[] = []) {
    to.postMessage({ ...message, doc }, '*', transfer);
  }
  async function handle(from: Window, data: Record<string, unknown>) {
    const op = data[PREVIEW_MODEL_MESSAGE], call = data.call;
    if (op === 'hello') {
      // One iframe shows one document, and a replaced srcdoc can no longer post:
      // a new document retires the old one's in-flight renders (worker holds
      // stay for the next document).
      if (doc !== data.doc) { for (const controller of calls.values()) controller.abort(); calls.clear(); }
      doc = data.doc as string; return;
    }
    if (data.doc !== doc) return;
    if (op === 'cancel') { if (typeof call === 'number') calls.get(call)?.abort(); return; }
    if (op === 'release') return; // holds follow the rendered set, not a srcdoc's lifetime
    if (typeof call !== 'number' || calls.has(call)) return;
    const controller = new AbortController(); calls.set(call, controller);
    try {
      const entry = await entryFor(data.source as string);
      if (op === 'retain') {
        const info = await retain(entry, data.id as string);
        if (data.doc === doc && calls.get(call) === controller) reply(from, { [PREVIEW_MODEL_REPLY]: call, ok: true, value: info });
        return;
      }
      if (op !== 'render') throw new Error('Unknown 3D bridge request');
      const spec = trustedSpec(entry, data.spec as Model3dRenderSpec);
      for (const id of [spec.assetId, spec.morph?.to, spec.crossfade?.to]) if (id !== undefined) await retain(entry, id);
      const lane = data.lane === 'idle' ? 'idle' : 'interactive';
      const channel = typeof data.channel === 'string' ? `paper-preview:${doc}:${data.channel.slice(0, 120)}` : undefined;
      const bitmap = await entry.served.backend.renderBitmap(spec, { lane, ...(channel ? { channel } : {}), fullResolution: data.fullResolution === true, signal: controller.signal });
      if (data.doc !== doc || calls.get(call) !== controller || disposed) { bitmap.close(); return; }
      reply(from, { [PREVIEW_MODEL_REPLY]: call, ok: true, value: bitmap }, [bitmap]);
    } catch (error) {
      if (data.doc !== doc || calls.get(call as number) !== controller) return;
      const name = error instanceof DOMException && error.name === 'AbortError' ? 'AbortError' : 'Error';
      reply(from, { [PREVIEW_MODEL_REPLY]: call, ok: false, name, error: error instanceof Error ? error.message : String(error) });
    } finally { if (calls.get(call as number) === controller) calls.delete(call as number); }
  }
  const listener = (event: Event) => {
    const e = event as MessageEvent, frame = options.frame();
    if (disposed || !frame || e.source !== frame) return;
    const data = e.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || typeof data[PREVIEW_MODEL_MESSAGE] !== 'string' || typeof data.doc !== 'string' || data.doc.length > 64) return;
    void handle(frame, data);
  };
  target.addEventListener('message', listener);
  return {
    /** The slides of the latest render; the others' holds are released. */
    keep(sources: Iterable<string>) {
      kept = new Set(sources);
      for (const [source, pending] of [...entries]) {
        if (!kept.has(source)) drop(source);
        // A retired repository generation's holds go too, even if the new
        // document never mounts that slide.
        else void pending.then(entry => { if (!entry.snapshot.modelSource?.isCurrent() && entries.get(source) === pending) drop(source); }, () => {});
      }
      if (kept.size && !options.serve) void loadServe().catch(() => {});
    },
    dispose() {
      if (disposed) return; disposed = true;
      target.removeEventListener('message', listener);
      for (const controller of calls.values()) controller.abort(); calls.clear();
      for (const source of [...entries.keys()]) drop(source);
    },
    stats: () => ({ entries: entries.size, calls: calls.size, doc }),
  };
}
export type PreviewModelBridge = ReturnType<typeof createPreviewModelBridge>;
