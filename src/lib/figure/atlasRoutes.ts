// IO adapters for the atlas policy. PNG data URLs also survive scene captures;
// blob URLs inside an SVG-as-image do not. No hosted GPU-canvas toBlob readback.
import type { Figure, Asset } from '../types';
import type { FileBridge } from '../project/types';
import type { AtlasRequest, FigureRaster } from './atlas';
import { serializeFigureRegion, snapshotFontCss } from '../interact/zoomProxy';
import { isAssetDirty } from '../assets';

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
export async function rasterLive(req: AtlasRequest, fig: Figure, group: SVGGElement, bridge: FileBridge | null, current: () => boolean): Promise<FigureRaster | null> {
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
export async function rasterCold(req: AtlasRequest, fig: Figure, assets: Asset[], bytes: Record<string, string>, root: string, bridge: FileBridge): Promise<FigureRaster | null> {
  if (!bridge.rasterizeFigure) throw new Error('unavailable');
  const width = Math.max(1, Math.ceil(fig.width * req.S)), height = Math.max(1, Math.ceil(fig.height * req.S));
  const inlineAssets: Record<string, string> = {};
  for (const asset of assets) if (isAssetDirty(asset.id) && bytes[asset.id]) inlineAssets[asset.id] = bytes[asset.id];
  const reply = await bridge.rasterizeFigure({ rid: `atlas-C:${req.figureId}:${Date.now()}`, root,
    figure: structuredClone(fig), assets, scale: req.S, width, height, inlineAssets });
  if (reply.cancelled) return null;
  if (!reply.png || reply.error || reply.width !== width || reply.height !== height) throw new Error(reply.error || 'Invalid figure raster dimensions');
  return result(req, width, height, new Blob([new Uint8Array(reply.png).buffer], { type: 'image/png' }));
}
