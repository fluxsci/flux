/** Model hand-offs share the live model binding; cross-kind flights capture an
 * explicit bitmap plus vector furniture. A canvas DOM clone is never a frame.
 * The admitted model/video poster pair flies the video's stored poster: a
 * <video> has no SVG to clone (T36: the video would otherwise pop in at 1). */
import type { Element as FigElement } from '../../types';
import type { Model3dElement } from '../../model3d/types';
import { furnitureLayout } from '../../model3d/furnitureLayout';
import { furnitureNodes } from '../../model3d/furniture';
import { paintFurniture } from '../../model3d/furnitureDom';
import { framingBounds } from '../../model3d/framing';
import { modelSnapshotImage } from '../../model3d/snapshotImage';
import { orbitPose } from '../../model3d/orbit';
import { lerpElement } from '../tween';
import { applyWrapperBox, type SlideRenderCtx } from './render';
import { fillModel3d, modelContentFrame } from './model3d';
import type { HandoffMedia } from './handoff';

const SVG = 'http://www.w3.org/2000/svg';
let nextSnapshot = 0;
/** Position flight content drawn in the element's own box within the outline box. */
function placeContent(content: SVGGElement, element: FigElement, box: { x: number; y: number }) {
  const cx = element.x + element.width / 2 - box.x, cy = element.y + element.height / 2 - box.y;
  content.setAttribute('transform', `translate(${cx} ${cy}) rotate(${element.rotation ?? 0}) scale(${element.flipX ? -1 : 1} ${element.flipY ? -1 : 1}) translate(${-element.width / 2} ${-element.height / 2})`);
}
export function modelHandoffMedia(a: FigElement | undefined, b: FigElement | undefined, elements: readonly FigElement[], ctx: SlideRenderCtx): HandoffMedia | undefined {
  if (!elements.some(el => el.type === 'model3d')) return;
  let disposed = false;
  const snapshots: ReturnType<typeof modelSnapshotImage>[] = [];
  // Poster decodes gate readiness like snapshots; disposal settles them.
  const posters: Promise<void>[] = [], settlePosters: (() => void)[] = [];
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
      if (element?.type === 'video') {
        const href = ctx.assetUrl?.(element.posterAssetId);
        if (!href) return;
        const group = document.createElementNS(SVG, 'g'), content = document.createElementNS(SVG, 'g'), image = document.createElementNS(SVG, 'image');
        for (const [name, value] of [['x', 0], ['y', 0], ['width', element.width], ['height', element.height]] as const) image.setAttribute(name, String(value));
        // fillVideo stretches its clip and poster to the box (object-fit: fill).
        image.setAttribute('preserveAspectRatio', 'none'); image.dataset.videoPoster = element.id;
        posters.push(new Promise<void>(resolve => {
          const settle = () => { image.removeEventListener('load', settle); image.removeEventListener('error', settle); resolve(); };
          image.addEventListener('load', settle); image.addEventListener('error', settle); settlePosters.push(settle);
        }));
        image.setAttribute('href', href);
        content.append(image); placeContent(content, element, outline.bbox); group.append(content); parent.append(group);
        return { node: group, box: outline.bbox, opacity: outline.paint.opacity ?? 1 };
      }
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
      placeContent(content, element, box);
      group.append(content); parent.append(group);
      if (ctx.model3d?.snapshot && !disposed) {
        const scale = Math.max(.01, typeof ctx.pixelScale === 'function' ? ctx.pixelScale() : ctx.pixelScale ?? 1) * Math.max(1, window.devicePixelRatio || 1);
        const factor = Math.min(scale, 4096 / Math.max(viewport.width, viewport.height));
        snapshots.push(modelSnapshotImage(image, ctx.model3d, { assetId: element.assetId, element: local, manifest, w: Math.max(1, Math.round(viewport.width * factor)), h: Math.max(1, Math.round(viewport.height * factor)) }));
      }
      return { node: group, box, opacity: outline.paint.opacity ?? 1 };
    },
    async ready() {
      if (disposed) return;
      if (pair && ctx.model3d) {
        const frame = modelContentFrame(pair[0], pair[1], pair[0], .5, .5, ctx);
        await ctx.model3d.ready(pair.map(el => el.assetId), [{ assetId: pair[0].assetId, element: frame.element, w: 32, h: 32, manifest: ctx.modelManifest?.(pair[0].assetId), ...frame.extra }]);
      }
      await Promise.all([...snapshots.map(snapshot => snapshot.ready), ...posters]);
    },
    dispose() { disposed = true; for (const snapshot of snapshots) snapshot.cancel(); snapshots.length = 0; for (const settle of settlePosters) settle(); settlePosters.length = 0; },
  };
}
