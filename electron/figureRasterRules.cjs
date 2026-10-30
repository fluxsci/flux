'use strict';
const { MAX_SVG_BYTES, MAX_SIDE } = require('./sceneRasterRules.cjs');
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
function validateFigureRequest(request, root = request?.root) {
  if (!request || !identity(request.rid)) throw Error('Invalid figure raster identity');
  if (typeof request.root !== 'string' || !request.root || request.root !== root) throw Error('Figure raster root mismatch');
  const { width, height, scale, figure, assets, inlineAssets, manifests } = request;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= MAX_SIDE) || width * height > 3_000_000) throw Error('Figure raster exceeds pixel budget');
  if (!Number.isFinite(scale) || scale <= 0) throw Error('Invalid figure raster scale');
  if (!plainJson(figure) || !identity(figure?.id) || !Array.isArray(figure.elements) || ![figure.width, figure.height].every(n => Number.isFinite(n) && n > 0)) throw Error('Invalid figure raster model');
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
  return { rid: request.rid, root: request.root, figure, assets, width, height, scale, inlineAssets, manifests };
}
module.exports = { validateFigureRequest, MAX_MODEL_BYTES };
