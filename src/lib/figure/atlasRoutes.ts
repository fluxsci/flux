// IO adapters for the atlas policy. PNG data URLs also survive scene captures;
// blob URLs inside an SVG-as-image do not. No hosted GPU-canvas toBlob readback.
import type { Figure, Asset } from '../types';
import type { FileBridge } from '../project/types';
import type { AtlasRequest, FigureRaster } from './atlas';
import { tick } from 'svelte';
import { serializeFigureRegion, snapshotFontCss } from '../interact/zoomProxy';
import { isAssetDirty } from '../assets';
import { captureTiers, figureImagesPending, type DisplayScope } from './imageDisplay';

/** What the raster service embeds per asset: a display tier for every large image the figure places
 *  (figure/imageTiers.ts) — never its original, whose bytes alone can exceed the service's 64 MiB
 *  composition limit — and the resident bytes of an asset that is not on disk yet. */
async function inlineFor(fig: Figure, assets: Asset[], bytes: Record<string, string>, S: number, display: DisplayScope | undefined): Promise<Record<string, string>> {
  const tiers = display ? await captureTiers(display, fig, S) : {}, inline: Record<string, string> = { ...tiers };
  for (const asset of assets) if (!inline[asset.id] && isAssetDirty(asset.id) && bytes[asset.id]) inline[asset.id] = bytes[asset.id];
  return inline;
}

const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
async function result(req: AtlasRequest, w: number, h: number, blob: Blob): Promise<FigureRaster> {
  const url = await dataUrl(blob), decoded = new Image(); decoded.src = url;
  await decoded.decode(); // do not unmount live artwork before its PNG is drawable
  return { figureId: req.figureId, key: req.key, S: req.S, w, h, dataUrl: url, bytes: blob.size,
    route: req.route, producedAt: Date.now(), lastShownAt: Date.now() };
}
export async function rasterLive(req: AtlasRequest, fig: Figure, group: SVGGElement, bridge: FileBridge | null, current: () => boolean, display?: DisplayScope): Promise<FigureRaster | null> {
  // This route photographs the DOM: every large image must be SHOWING a tier sharp enough for the
  // picture first. A placeholder baked into a picture stays until the figure is next edited.
  if (display) {
    await captureTiers(display, fig, req.S, { show: true });
    await tick();
    if (!current()) return null;
    if (figureImagesPending(fig)) throw new Error('Figure images are not displayed yet');
  }
  const ser = serializeFigureRegion(group, fig, req.S);
  const fontCss = await snapshotFontCss(ser.svg);
  if (!current()) return null;
  const svg = fontCss ? ser.svg.replace('>', `><style>${fontCss}</style>`) : ser.svg;
  if (ser.nodes > 20_000) {
    if (!bridge?.rasterizeScene) throw new Error('Dense figure needs the scene raster service');
    const reply = await bridge.rasterizeScene({ rid: `atlas-L:${req.figureId}:${Date.now()}`, svg,
      regions: [{ bx: 0, by: 0, bw: fig.width, bh: fig.height, width: ser.w, height: ser.h }] });
    if (!current() || reply.cancelled) return null;
    const png = reply.rasters?.[0];
    if (!png || png.width !== ser.w || png.height !== ser.h) throw new Error(reply.error || 'Invalid figure raster dimensions');
    const raster = await result(req, ser.w, ser.h, new Blob([new Uint8Array(png.bytes).buffer], { type: 'image/png' }));
    return current() ? raster : null;
  }
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const image = new Image(); image.src = url;
  try {
    await image.decode();
    if (!current()) return null;
    const canvas = new OffscreenCanvas(ser.w, ser.h), ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No figure raster context');
    ctx.drawImage(image, 0, 0, ser.w, ser.h);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    canvas.width = canvas.height = 0;
    if (!current()) return null;
    const raster = await result(req, ser.w, ser.h, blob);
    return current() ? raster : null;
  } finally { URL.revokeObjectURL(url); }
}
export async function rasterCold(req: AtlasRequest, fig: Figure, assets: Asset[], bytes: Record<string, string>, root: string, bridge: FileBridge, display?: DisplayScope): Promise<FigureRaster | null> {
  if (!bridge.rasterizeFigure) throw new Error('unavailable');
  const width = Math.max(1, Math.ceil(fig.width * req.S)), height = Math.max(1, Math.ceil(fig.height * req.S));
  const inlineAssets = await inlineFor(fig, assets, bytes, req.S, display);
  const reply = await bridge.rasterizeFigure({ rid: `atlas-C:${req.figureId}:${Date.now()}`, root,
    figure: structuredClone(fig), assets, scale: req.S, width, height, inlineAssets });
  if (reply.cancelled) return null;
  if (!reply.png || reply.error || reply.width !== width || reply.height !== height) throw new Error(reply.error || 'Invalid figure raster dimensions');
  return result(req, width, height, new Blob([new Uint8Array(reply.png).buffer], { type: 'image/png' }));
}

/** Details stay as bytes until the dedicated scheduler's quiet publication.
 * Never call the base result() adapter here: it decodes a data URL immediately. */
export async function renderDetail(req: import('./atlasDetail').DetailRequest, fig: Figure, assets: Asset[], bytes: Record<string, string>, root: string, bridge: FileBridge, backdrop = '#ffffff', display?: DisplayScope): Promise<Blob | null> {
  if (!bridge.rasterizeFigure) throw new Error('unavailable');
  const inlineAssets = await inlineFor(fig, assets, bytes, req.S, display);
  const reply = await bridge.rasterizeFigure({ rid: req.rid, root, figure: structuredClone(fig), assets,
    scale: req.S, width: req.w, height: req.h, region: req.region, backdrop, inlineAssets });
  if (reply.cancelled) return null;
  if (!reply.png || reply.error || reply.width !== req.w || reply.height !== req.h) throw new Error(reply.error || 'Invalid figure detail dimensions');
  return new Blob([new Uint8Array(reply.png).buffer], { type: 'image/png' });
}
