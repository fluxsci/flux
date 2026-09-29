/** Model hand-offs share the live model binding; cross-kind flights capture an
 * explicit bitmap plus vector furniture. A canvas DOM clone is never a frame. */
import type { Element as FigElement } from '../../types';
import type { Model3dElement } from '../../model3d/types';
import { furnitureLayout } from '../../model3d/furnitureLayout';
import { furnitureNodes } from '../../model3d/furniture';
import { paintFurniture } from '../../model3d/furnitureDom';
import { framingBounds } from '../../model3d/framing';
import { orbitPose } from '../../model3d/orbit';
import { lerpElement } from '../tween';
import { applyWrapperBox, type SlideRenderCtx } from './render';
import { fillModel3d, modelContentFrame } from './model3d';
import type { HandoffMedia } from './handoff';

const SVG = 'http://www.w3.org/2000/svg';
let nextSnapshot = 0;
export function modelHandoffMedia(a: FigElement | undefined, b: FigElement | undefined, elements: readonly FigElement[], ctx: SlideRenderCtx): HandoffMedia | undefined {
  if (!elements.some(el => el.type === 'model3d')) return;
  let disposed = false;
  const pending: Promise<void>[] = [], urls = new Set<string>(), cancelLoads = new Set<() => void>();
  const pair = a?.type === 'model3d' && b?.type === 'model3d' ? [a, b] as const : undefined;
  return {
    ...(pair ? { mount(parent: SVGElement) {
      const foreign = document.createElementNS(SVG, 'foreignObject');
      foreign.setAttribute('width', '100%'); foreign.setAttribute('height', '100%'); foreign.style.overflow = 'visible';
      const wrap = document.createElement('div'); wrap.style.cssText = 'position:absolute;transform-origin:center center'; foreign.append(wrap); parent.append(foreign);
      const binding = fillModel3d(wrap, pair[0], { ...ctx, model3d: ctx.model3d ? { ...ctx.model3d, view: canvas => (ctx.model3d!.flightView ?? ctx.model3d!.view)(canvas) } : undefined });
      return { seek(t: number, raw: number) {
        const sample = lerpElement(pair[0], pair[1], t, raw) as Model3dElement;
        applyWrapperBox(wrap, sample);
        const frame = modelContentFrame(pair[0], pair[1], sample, t, raw, ctx); binding.set(frame.element, frame.extra);
      }, dispose() { binding.dispose(); foreign.remove(); } };
    } } : {}),
    clone(outline, parent) {
      const element = !outline.owner.partId ? elements.find(el => el.id === outline.owner.elementId) : undefined;
      if (element?.type !== 'model3d') return;
      const box = outline.bbox, group = document.createElementNS(SVG, 'g'), content = document.createElementNS(SVG, 'g');
      const local = { ...element, x: 0, y: 0, opacity: 1 }, manifest = ctx.modelManifest?.(element.assetId), asset = ctx.modelAsset?.(element.assetId);
      const layout = furnitureLayout(manifest, local, local.overrides), viewport = layout.viewport;
      const bounds = asset?.model.bounds ?? manifest?.bounds ?? { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
      const furniture = furnitureNodes(manifest, { ...local, id: `snapshot-${++nextSnapshot}` }, orbitPose(local, framingBounds(bounds, manifest), viewport), layout);
      const under = document.createElementNS(SVG, 'g'), over = document.createElementNS(SVG, 'g'), image = document.createElementNS(SVG, 'image');
      for (const [name, value] of Object.entries(viewport)) image.setAttribute(name, String(value));
      image.setAttribute('preserveAspectRatio', 'none'); image.dataset.modelSnapshot = element.id;
      const fallback = ctx.modelPoster?.(element); if (fallback) image.setAttribute('href', fallback);
      paintFurniture(under, furniture.underNodes); paintFurniture(over, furniture.overNodes); content.append(under, image, over);
      const cx = element.x + element.width / 2 - box.x, cy = element.y + element.height / 2 - box.y;
      content.setAttribute('transform', `translate(${cx} ${cy}) rotate(${element.rotation ?? 0}) scale(${element.flipX ? -1 : 1} ${element.flipY ? -1 : 1}) translate(${-element.width / 2} ${-element.height / 2})`);
      group.append(content); parent.append(group);
      if (ctx.model3d?.snapshot) pending.push((async () => {
        const scale = Math.max(.01, typeof ctx.pixelScale === 'function' ? ctx.pixelScale() : ctx.pixelScale ?? 1) * Math.max(1, window.devicePixelRatio || 1);
        const factor = Math.min(scale, 4096 / Math.max(viewport.width, viewport.height));
        const spec = { assetId: element.assetId, element: local, manifest, w: Math.max(1, Math.round(viewport.width * factor)), h: Math.max(1, Math.round(viewport.height * factor)) };
        await ctx.model3d!.ready([element.assetId], [spec]); if (disposed) return;
        const bitmap = await ctx.model3d!.snapshot!(spec), canvas = document.createElement('canvas');
        try {
          if (disposed) return;
          canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); if (!context) throw new Error('Model snapshot canvas is unavailable');
          context.drawImage(bitmap, 0, 0);
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Model snapshot encoding failed')), 'image/png'));
          if (disposed) return; const url = URL.createObjectURL(blob); urls.add(url);
          await new Promise<void>((resolve, reject) => {
            const clear = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', failed); cancelLoads.delete(cancel); };
            const loaded = () => { clear(); resolve(); }, failed = () => { clear(); reject(new Error('Model snapshot image could not be decoded')); };
            const cancel = () => { clear(); resolve(); };
            cancelLoads.add(cancel); image.addEventListener('load', loaded, { once: true }); image.addEventListener('error', failed, { once: true }); image.setAttribute('href', url);
          });
        } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
      })());
      void pending.at(-1)?.catch(() => {}); // readiness owns the error, including idle prewarming
      return { node: group, box, opacity: outline.paint.opacity ?? 1 };
    },
    async ready() {
      if (pair && ctx.model3d) {
        const frame = modelContentFrame(pair[0], pair[1], pair[0], .5, .5, ctx);
        await ctx.model3d.ready(pair.map(el => el.assetId), [{ assetId: pair[0].assetId, element: frame.element, w: 32, h: 32, manifest: ctx.modelManifest?.(pair[0].assetId), ...frame.extra }]);
      }
      await Promise.all(pending);
    },
    dispose() { disposed = true; for (const cancel of cancelLoads) cancel(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); },
  };
}
