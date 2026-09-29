/** One model surface per placement; all surfaces share the host's renderer.
 * No WebGL imports and no animation clock: the player samples then flushes. */
import type { Model3dRenderExtra, Model3dView } from '../../model3d/host';
import type { Model3dElement, Model3dInfo, Model3dRenderSpec } from '../../model3d/types';
import { furnitureLayout } from '../../model3d/furnitureLayout';
import { furnitureNodes, type FurnitureNode } from '../../model3d/furniture';
import { paintFurniture } from '../../model3d/furnitureDom';
import { orbitPose } from '../../model3d/orbit';
import { framingBounds, sphereLerpBounds } from '../../model3d/framing';
import { modelSnapshotImage } from '../../model3d/snapshotImage';
import { modelPlaceholder } from '../../model3d/poster';
import { staticModelRequest } from '../../model3d/static';
import { partDomId } from '../../plot/parse';
import { scene3dFields } from '../../model3d/scene3d';
import { modelPair } from '../model3dMorph';
import { transformEndState, transformPreState } from '../tween';
import type { Slide } from '../types';
import type { SlideRenderCtx } from './render';

const SVG = 'http://www.w3.org/2000/svg';
const bindings = new WeakMap<HTMLElement, SlideModelBinding>();
const nodes = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-slide-model-root]')];
function liveVisible(node: HTMLElement): boolean {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hidden || current.style.display === 'none' || current.style.visibility === 'hidden' || current.style.opacity === '0' || current.getAttribute('visibility') === 'hidden' || current.getAttribute('display') === 'none' || current.getAttribute('opacity') === '0') return false;
  }
  return true;
}
function svgLayer(): SVGSVGElement {
  const layer = document.createElementNS(SVG, 'svg');
  layer.setAttribute('width', '100%'); layer.setAttribute('height', '100%'); layer.setAttribute('preserveAspectRatio', 'none');
  layer.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;display:block';
  return layer;
}

export interface SlideModelBinding {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  element: Model3dElement;
  set(element: Model3dElement, extra?: Model3dRenderExtra): void;
  activate(info?: Model3dInfo): void;
  posterOnly(value: boolean): void;
  flush(): void;
  settled(): Promise<void>;
  dispose(): void;
}

/** Pre-resolve only fields whose endpoints differ. Absent overrides mean the
 * manifest's real domain/map, never a guessed zero range. */
export function modelFieldEndpoints(a: Model3dElement, b: Model3dElement, ctx: SlideRenderCtx): [Model3dElement, Model3dElement] {
  if (JSON.stringify(a.fields) === JSON.stringify(b.fields)) return [a, b];
  const resolve = (el: Model3dElement) => {
    const fields = Object.create(null) as NonNullable<Model3dElement['fields']>;
    const defaults = scene3dFields(ctx.modelManifest?.(el.assetId));
    for (const key of new Set([...Object.keys(a.fields ?? {}), ...Object.keys(b.fields ?? {})])) {
      const own = Object.hasOwn(el.fields ?? {}, key) ? el.fields![key] : undefined, field = defaults[key];
      fields[key] = { ...(field ? { range: [...field.range] as [number, number], cmap: field.cmap.name } : {}), ...own };
    }
    return { ...el, fields };
  };
  return [resolve(a), resolve(b)];
}

/** Content geometry/appearance stays frozen at both ends while the camera and
 * box use the ordinary transform sampler. Discrete endpoint ownership uses raw. */
export function modelContentFrame(a: Model3dElement, b: Model3dElement, sample: Model3dElement, t: number, raw: number, ctx: SlideRenderCtx): { element: Model3dElement; extra: Model3dRenderExtra } {
  if (a.assetId === b.assetId || raw <= 0) return { element: raw <= 0 ? a : sample, extra: {} };
  if (raw >= 1) return { element: b, extra: {} };
  const pair = modelPair(a, b, ctx), common = { to: b.assetId, t, fromElement: a, toElement: b, toManifest: ctx.modelManifest?.(b.assetId) };
  return { element: { ...sample, assetId: a.assetId }, extra: pair?.ok ? { morph: { ...common, pairs: pair.pairs } } : { crossfade: common } };
}

export function fillModel3d(parent: HTMLElement, element: Model3dElement, ctx: SlideRenderCtx): SlideModelBinding {
  const root = document.createElement('div'); root.dataset.slideModelRoot = element.id;
  const sequence = Symbol.for('flux.model3d.slideViewSequence'), owner = document as unknown as Record<symbol, number>;
  const paintId = `m3dv${owner[sequence] = (owner[sequence] ?? 0) + 1}:${element.id}`;
  root.style.cssText = 'position:absolute;inset:0';
  const under = svgLayer(), over = svgLayer(), fallback = svgLayer();
  const canvas = document.createElement('canvas'); canvas.dataset.slideModel3d = element.id;
  // Do not allocate a view/backing store for an unborn or hidden model.
  canvas.width = 0; canvas.height = 0; canvas.style.cssText = 'position:absolute;display:none';
  root.append(under, fallback, canvas, over); parent.append(root);
  let frame = element, extra: Model3dRenderExtra = {}, active = false, disposed = false;
  let view: Model3dView | undefined, info: Model3dInfo | undefined, key = '', pending = Promise.resolve(), revision = 0;
  let failed: Error | undefined, intersects = true, posterOnly = false;
  let snapshot: ReturnType<typeof modelSnapshotImage> | undefined;
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    const next = entries.at(-1)?.isIntersecting ?? false;
    if (next !== intersects) { intersects = next; handle.flush(); }
  }) : undefined;
  observer?.observe(root);
  function frameLayout() {
    const local = { ...frame, x: 0, y: 0 }, manifest = ctx.modelManifest?.(frame.assetId), asset = ctx.modelAsset?.(frame.assetId);
    const pair = extra.morph ?? extra.crossfade, t = pair ? Math.max(0, Math.min(1, pair.t)) : 0;
    const layout = furnitureLayout(manifest, local, local.overrides);
    const bound = (id: string, man: typeof manifest) => framingBounds(ctx.modelAsset?.(id)?.model.bounds ?? (id === frame.assetId ? info?.bounds : undefined) ?? man?.bounds ?? { min: [-1, -1, -1], max: [1, 1, 1] }, man);
    let box = layout.viewport, furniture: ReturnType<typeof furnitureNodes>;
    if (pair && pair.fromElement && pair.toElement) {
      const a = { ...pair.fromElement, x: 0, y: 0, width: frame.width, height: frame.height }, b = { ...pair.toElement, x: 0, y: 0, width: frame.width, height: frame.height };
      const B = pair.toManifest, la = furnitureLayout(manifest, a, a.overrides), lb = furnitureLayout(B, b, b.overrides);
      box = Object.fromEntries(Object.keys(la.viewport).map(key => [key, la.viewport[key as keyof typeof box] * (1 - t) + lb.viewport[key as keyof typeof box] * t])) as unknown as typeof box;
      const ba = bound(a.assetId, manifest), bb = bound(b.assetId, B), blended = sphereLerpBounds(ba, bb, t);
      const fa = furnitureNodes(manifest, { ...a, id: paintId + ':a' }, orbitPose(local, extra.morph ? blended : ba, box), { ...la, viewport: box });
      const fb = furnitureNodes(B, { ...b, id: paintId + ':b' }, orbitPose(local, extra.morph ? blended : bb, box), { ...lb, viewport: box });
      const blend = (A: FurnitureNode[], B: FurnitureNode[]): FurnitureNode[] => {
        const result: FurnitureNode[] = [], parts = new Map<string, FurnitureNode>();
        for (const [side, opacity, entries] of [['a', 1-t, A], ['b', t, B]] as const) for (const node of entries) {
          if (opacity <= 0) continue;
          const inner: FurnitureNode = { ...node, key: `${side}:${node.key}`, attrs: { ...node.attrs } };
          if (node.partId) {
            delete inner.attrs.id; delete inner.partId;
            let group = parts.get(node.partId);
            if (!group) { group = { tag: 'g', key: node.partId, partId: node.partId, attrs: { id: partDomId(frame.id, node.partId), 'data-part-id': node.partId, 'data-role': node.attrs['data-role'] }, children: [] }; parts.set(node.partId, group); result.push(group); }
            group.children!.push({ tag: 'g', key: 'endpoint-' + side, attrs: { opacity }, children: [inner] });
          } else result.push(inner);
        }
        return result;
      };
      furniture = { underNodes: blend(fa.underNodes, fb.underNodes), overNodes: blend(fa.overNodes, fb.overNodes) };
    } else furniture = furnitureNodes(manifest, { ...local, id: paintId }, orbitPose(local, bound(frame.assetId, manifest), box), layout);
    return { local, manifest, asset, box, furniture };
  }
  function decorate(forceFallback = false) {
    const { local, manifest, asset, box, furniture } = frameLayout();
    for (const svg of [under, over, fallback]) svg.setAttribute('viewBox', `0 0 ${Math.max(1, frame.width)} ${Math.max(1, frame.height)}`);
    // Paint servers must be unique across stage, filmstrip and presenter views;
    // semantic groups retain canonical IDs for the existing animation resolver.
    for (const node of [...furniture.underNodes, ...furniture.overNodes]) if (node.partId) node.attrs.id = partDomId(frame.id, node.partId);
    paintFurniture(under, furniture.underNodes); paintFurniture(over, furniture.overNodes);
    canvas.style.left = `${100 * box.x / Math.max(1, frame.width)}%`; canvas.style.top = `${100 * box.y / Math.max(1, frame.height)}%`;
    canvas.style.width = `${100 * box.width / Math.max(1, frame.width)}%`; canvas.style.height = `${100 * box.height / Math.max(1, frame.height)}%`;
    const ref = asset ? staticModelRequest(frame, asset, manifest, 'slide').ref : undefined;
    const url = ctx.modelPoster?.(frame) ?? (ref ? ctx.assetUrl?.(ref) : undefined);
    // A matching poster remains visible until the first actual live frame.
    if (forceFallback || !active || canvas.style.display === 'none') fallback.replaceChildren();
    if ((forceFallback || !active || canvas.style.display === 'none') && url) {
      const image = document.createElementNS(SVG, 'image'); image.setAttribute('data-model3d-poster', 'true');
      for (const [name, value] of Object.entries(box)) image.setAttribute(name, String(value));
      image.setAttribute('preserveAspectRatio', 'none'); image.setAttribute('href', url); fallback.append(image);
    } else if (forceFallback || !active || canvas.style.display === 'none') fallback.innerHTML = modelPlaceholder(frame.name || asset?.name || frame.id, box);
    return { local, manifest, box };
  }
  const handle: SlideModelBinding = {
    root, canvas, element,
    set(next, renderExtra = {}) { frame = next; handle.element = next; extra = renderExtra; },
    posterOnly(value) { if (posterOnly === value) return; posterOnly = value; revision++; snapshot?.cancel(); snapshot = undefined; key = ''; },
    activate(modelInfo) { if (disposed) return; active = true; info = modelInfo; key = ''; },
    flush() {
      if (disposed) return;
      // Hidden surfaces own no backing storage, even if this exact model view
      // was already rendered. Shared geometry remains the host's retained asset.
      if (!intersects || !liveVisible(root)) {
        if (view) { revision++; view.dispose(); view = undefined; }
        canvas.width = 0; canvas.height = 0; canvas.style.display = 'none';
        snapshot?.cancel(); snapshot = undefined;
        fallback.style.display = 'block'; key = ''; failed = undefined; pending = Promise.resolve();
        return;
      }
      // Pure moves/rotation are wrapper work. Retain the existing decoded frame.
      const { x: _x, y: _y, rotation: _rotation, opacity: _opacity, flipX: _flipX, flipY: _flipY, ...renderInputs } = frame;
      const scale = Math.max(.01, typeof ctx.pixelScale === 'function' ? ctx.pixelScale() : ctx.pixelScale ?? 1);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const nextKey = JSON.stringify([renderInputs, extra, scale, dpr, posterOnly]);
      if (nextKey === key) return;
      const { local, manifest, box } = frameLayout();
      if (!ctx.model3d) { decorate(); key = nextKey; return; }
      if (!active) { decorate(); return; }
      const factor = Math.min(scale * dpr, 4096 / Math.max(box.width, box.height));
      const w = Math.max(1, Math.round(box.width * factor)), h = Math.max(1, Math.round(box.height * factor));
      const token = ++revision;
      const publish = () => { if (disposed || token !== revision) return; decorate(); canvas.style.display = 'block'; fallback.style.display = 'none'; failed = undefined; delete root.dataset.model3dError; };
      const reject = (error: unknown) => { if (disposed || token !== revision) return; failed = error instanceof Error ? error : new Error(String(error)); canvas.style.display = 'none'; fallback.style.display = 'block'; root.dataset.model3dError = failed.message; decorate(true); };
      if (posterOnly) {
        view?.dispose(); view = undefined; canvas.width = 0; canvas.height = 0; canvas.style.display = 'none'; fallback.style.display = 'block'; decorate(true); key = nextKey;
        if (ctx.model3d.snapshot) {
          const image = document.createElementNS(SVG, 'image'); for (const [name, value] of Object.entries(box)) image.setAttribute(name, String(value));
          image.setAttribute('preserveAspectRatio', 'none'); image.dataset.modelSnapshot = frame.id;
          // Keep the matching poster/placeholder until this snapshot is decoded.
          fallback.append(image); snapshot?.cancel(); snapshot = modelSnapshotImage(image, ctx.model3d, { assetId: local.assetId, element: local, w, h, manifest, ...extra });
          pending = snapshot.ready.then(() => { if (disposed || token !== revision) return; fallback.replaceChildren(image); failed = undefined; }, reject);
        }
        return;
      }
      try {
        view ??= ctx.model3d.view(canvas);
        const result = view.render(local, w, h, { manifest, ...extra }); key = nextKey;
        if (result && typeof (result as Promise<unknown>).then === 'function') pending = Promise.resolve(result).then(publish, reject);
        else { publish(); pending = Promise.resolve(); }
      } catch (error) { reject(error); }
    },
    async settled() { await pending; if (failed) throw failed; },
    dispose() { if (disposed) return; disposed = true; revision++; observer?.disconnect(); snapshot?.cancel(); view?.dispose(); canvas.width = 0; canvas.height = 0; bindings.delete(root); },
  };
  bindings.set(root, handle); decorate();
  return handle;
}

export function modelBindingOf(root: HTMLElement): SlideModelBinding | undefined {
  return bindings.get(root) ?? (root.querySelector<HTMLElement>('[data-slide-model-root]') ? bindings.get(root.querySelector<HTMLElement>('[data-slide-model-root]')!) : undefined);
}
export function setSlideModelFrame(root: HTMLElement, element: Model3dElement, extra?: Model3dRenderExtra) { modelBindingOf(root)?.set(element, extra); }
export function flushSlideModels(root: HTMLElement) { for (const node of nodes(root)) bindings.get(node)?.flush(); }

/** Loading is scoped to the slide (including future content targets); invisible
 * ghosts retain shared geometry but acquire a surface only when they appear. */
export function createModel3dController(root: HTMLElement, slide: Slide, ctx: SlideRenderCtx, onIssue: (target: string, reason: string) => void = () => {}) {
  let disposed = false;
  const models = new Map<string, Model3dElement>();
  for (const element of slide.elements) if (element.type === 'model3d') models.set(element.assetId, element);
  for (const [bi, beat] of slide.beats.entries()) for (const track of beat.tracks) {
    if (track.disabled) continue;
    const pre = transformPreState(slide, track.target, bi); if (!pre) continue;
    const end = transformEndState(pre, track); if (end.type === 'model3d') models.set(end.assetId, end);
  }
  const warm: Model3dRenderSpec[] = [...models.values()].map(element => ({ assetId: element.assetId, element, w: 32, h: 32, manifest: ctx.modelManifest?.(element.assetId) }));
  for (const [bi, beat] of slide.beats.entries()) for (const track of beat.tracks) {
    if (track.disabled) continue; const pre = transformPreState(slide, track.target, bi);
    if (pre?.type !== 'model3d') continue; const end = transformEndState(pre, track);
    if (end.type !== 'model3d' || end.assetId === pre.assetId) continue;
    const frame = modelContentFrame(pre, end, pre, .5, .5, ctx);
    warm.push({ assetId: pre.assetId, element: frame.element, w: 32, h: 32, manifest: ctx.modelManifest?.(pre.assetId), ...frame.extra });
  }
  if (!ctx.model3d) for (const element of models.values()) onIssue(element.id, '3D model rendered as a still');
  let warmed = !ctx.model3d || !models.size, succeeded = !ctx.model3d || !models.size;
  const infos = new Map<string, Model3dInfo | undefined>(), activated = new WeakSet<SlideModelBinding>();
  function flush() {
    for (const node of nodes(root)) { const binding = bindings.get(node); if (!binding) continue;
      if (succeeded && ctx.model3d && !activated.has(binding)) { binding.activate(infos.get(binding.element.assetId)); activated.add(binding); }
      binding.flush();
    }
  }
  const ready = (ctx.model3d && models.size ? ctx.model3d.ready([...models.keys()], warm).then(async () => {
    if (disposed) return;
    await Promise.all([...models.keys()].map(async id => infos.set(id, await ctx.model3d?.modelStats?.(id))));
    warmed = true; succeeded = true; if (!disposed) flush();
  }) : Promise.resolve()).finally(() => { warmed = true; });
  // Callers see readiness failures through readyMedia, never an unhandled task.
  void ready.catch(error => { if (!disposed) for (const element of models.values()) onIssue(element.id, `3D model rendered as a still: ${error instanceof Error ? error.message : String(error)}`); });
  async function settled() { await ready; await Promise.all(nodes(root).map(node => bindings.get(node)?.settled())); }
  return { isReady: () => warmed, ready: settled, flush, settled, destroy() { if (disposed) return; disposed = true; for (const node of nodes(root)) bindings.get(node)?.dispose(); } };
}
