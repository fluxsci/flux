'use strict';
const { MAX_SVG_BYTES, MAX_SIDE } = require('./sceneRasterRules.cjs');
const DETAIL_MAX_SIDE = 8192, DETAIL_MAX_PIXELS = 9_000_000, DETAIL_MIN_EXTENT = 0.4;
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
const identity = value => typeof value === 'string' && /^[\w.:-]{1,160}$/.test(value);
// IPC supplies structured clones, but this validator also guards direct child inputs.
function plainJson(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 100 || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  // Figure ops can leave an optional object property explicitly undefined
  // (duplicateFigure's captions). JSON serialization omits it on the wire.
  const ok = Object.values(value).every(v => v === undefined && !Array.isArray(value) || plainJson(v, seen, depth + 1));
  seen.delete(value); return ok;
}
// Model-space envelope, including hidden/off-frame elements: resvg still parses them.
function contentExtent(figure) {
  let x = 0, y = 0, right = figure.width, bottom = figure.height;
  for (const e of figure.elements) {
    const line = ['x1', 'x2', 'y1', 'y2'].every(k => k in e);
    const bx = e.x + (line ? Math.min(e.x1, e.x2) : 0), by = e.y + (line ? Math.min(e.y1, e.y2) : 0);
    const w = line ? Math.abs(e.x2 - e.x1) : e.width, h = line ? Math.abs(e.y2 - e.y1) : e.height;
    const a = (e.rotation || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const rw = w * c + h * s, rh = w * s + h * c;
    if (![bx, by, rw, rh].every(Number.isFinite)) throw Error('Invalid figure raster element bounds');
    x = Math.min(x, bx + w / 2 - rw / 2); y = Math.min(y, by + h / 2 - rh / 2);
    right = Math.max(right, bx + w / 2 + rw / 2); bottom = Math.max(bottom, by + h / 2 + rh / 2);
  }
  return { x, y, w: right - x, h: bottom - y };
}
function validateFigureRequest(request, root = request?.root) {
  if (!request || !identity(request.rid)) throw Error('Invalid figure raster identity');
  if (typeof request.root !== 'string' || !request.root || request.root !== root) throw Error('Figure raster root mismatch');
  const { width, height, scale, figure, assets, inlineAssets, manifests, region, backdrop } = request;
  const detail = region !== undefined;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= (detail ? DETAIL_MAX_SIDE : MAX_SIDE)) || width * height > (detail ? DETAIL_MAX_PIXELS : 3_000_000)) throw Error(detail ? 'Figure raster detail exceeds pixel budget' : 'Figure raster exceeds pixel budget');
  if (!Number.isFinite(scale) || scale <= 0) throw Error('Invalid figure raster scale');
  if (!plainJson(figure) || !identity(figure?.id) || !Array.isArray(figure.elements) || ![figure.width, figure.height].every(n => Number.isFinite(n) && n > 0)) throw Error('Invalid figure raster model');
  if (detail) {
    const extent = contentExtent(figure), r = region;
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > extent.x + extent.w + 1e-7 || r.y + r.h > extent.y + extent.h + 1e-7) throw Error('Figure raster region out of bounds');
    if (r.w + 1e-7 < DETAIL_MIN_EXTENT * extent.w || r.h + 1e-7 < DETAIL_MIN_EXTENT * extent.h || extent.x < r.x - 2 * r.w - 1e-7 || extent.y < r.y - 2 * r.h - 1e-7 || extent.x + extent.w > r.x + 3 * r.w + 1e-7 || extent.y + extent.h > r.y + 3 * r.h + 1e-7) throw Error('Figure raster region below the resvg envelope');
  }
  if (backdrop !== undefined && (typeof backdrop !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(backdrop))) throw Error('Invalid figure raster backdrop');
  if (!Array.isArray(assets) || !plainJson(assets) || (manifests !== undefined && !plainJson(manifests))) throw Error('Invalid figure raster assets');
  if (Buffer.byteLength(JSON.stringify({ figure, assets, manifests })) > MAX_MODEL_BYTES) throw Error('Figure raster model exceeds 16 MiB');
  if (inlineAssets !== undefined) {
    if (!inlineAssets || Array.isArray(inlineAssets) || !plainJson(inlineAssets)) throw Error('Invalid figure inline assets');
    let size = 0;
    for (const value of Object.values(inlineAssets)) {
      if (typeof value !== 'string' || !/^data:/i.test(value)) throw Error('Invalid figure inline asset URL');
      size += Buffer.byteLength(value);
      if (size > MAX_SVG_BYTES) throw Error('Figure inline assets exceed 64 MiB');
    }
  }
  return { rid: request.rid, root: request.root, figure, assets, width, height, scale, inlineAssets, manifests, region, backdrop };
}
module.exports = { validateFigureRequest, MAX_MODEL_BYTES, DETAIL_MAX_SIDE, DETAIL_MAX_PIXELS, DETAIL_MIN_EXTENT, contentExtent };
