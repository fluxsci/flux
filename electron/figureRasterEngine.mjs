// Cold figures use the export composer, with worker-local stat-validated IO.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { renderFigureSvgFromModel, figureRenderReaders, figureImageAssetIds } from '../flux-core/render.ts';
import { resolveModelPosters } from '../flux-core/model3dPosterCache.ts';
import { fontsFor, sceneDocument, prepareSceneImages } from './sceneRasterEngine.mjs';
import rules from './figureRasterRules.cjs';
const require = createRequire(import.meta.url);
const { renderAsync } = require('@resvg/resvg-js');
const { XMLSerializer } = require('@xmldom/xmldom');
const files = new Map();
let cachedBytes = 0;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;
async function cachedFile(file, kind) {
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT') { const old = files.get(file); if (old) cachedBytes -= old.size; files.delete(file); return undefined; } throw error; }
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error('Figure raster file exceeds 64 MiB');
  const hit = files.get(file);
  if (hit?.mtime === stat.mtimeMs && hit.size === stat.size && hit.kind === kind) { files.delete(file); files.set(file, hit); return hit.value; }
  const bytes = await fs.readFile(file);
  const value = kind === 'manifest' ? JSON.parse(bytes.toString('utf8')) : bytes;
  if (hit) { cachedBytes -= hit.size; files.delete(file); }
  files.set(file, { mtime: stat.mtimeMs, size: stat.size, kind, value }); cachedBytes += stat.size;
  while (cachedBytes > MAX_CACHE_BYTES || files.size > 512) { const key = files.keys().next().value; cachedBytes -= files.get(key).size; files.delete(key); }
  return value;
}
// Repeated scale upgrades still revalidate every file. Reusing their composed
// SVG avoids re-parsing the 5.5 MB plot that exceeds inlineMarkup's prepared
// cache budget (2026-10-29: 1.2 s warm composition without this bounded cache).
const compositions = new Map(), manifestVersions = new WeakMap();
let compositionBytes = 0, nextManifestVersion = 0;
export async function buildFigureSvg(request) {
  const readers = figureRenderReaders(request.root, request.assets, cachedFile);
  const models = await resolveModelPosters(request.root, [request.figure], request.assets, { policy: 'image', surface: 'figure' });
  const data = new Map(), manifests = new Map();
  const hash = createHash('sha256').update(JSON.stringify([request.root, request.figure, request.assets, models.urls]));
  const required = figureImageAssetIds(request.figure);
  for (const asset of request.assets) if (required.has(asset.id)) {
    const value = Object.hasOwn(request.inlineAssets ?? {}, asset.id) ? request.inlineAssets[asset.id] : await readers.readAsset(asset.id);
    data.set(asset.id, value); hash.update(JSON.stringify([asset.id, value]));
  }
  for (const el of request.figure.elements) if (el.type === 'plot') {
    const value = Object.hasOwn(request.manifests ?? {}, el.assetId) ? request.manifests[el.assetId] : await readers.readManifest(el.assetId, el);
    manifests.set(el.id, value);
    if (value && !manifestVersions.has(value)) manifestVersions.set(value, ++nextManifestVersion);
    hash.update(JSON.stringify([el.id, value ? manifestVersions.get(value) : null]));
  }
  const key = hash.digest('hex'), hit = compositions.get(key);
  if (hit) { compositions.delete(key); compositions.set(key, hit); return hit.svg; }
  const svg = await renderFigureSvgFromModel(request.figure, {
    assets: request.assets, models, readAsset: async id => data.get(id), readManifest: async (_id, el) => manifests.get(el.id),
  });
  const size = Buffer.byteLength(svg);
  if (size <= 64 * 1024 * 1024) {
    compositions.set(key, { svg, size }); compositionBytes += size;
    while (compositionBytes > 64 * 1024 * 1024 || compositions.size > 16) {
      const first = compositions.keys().next().value; compositionBytes -= compositions.get(first).size; compositions.delete(first);
    }
  }
  return svg;
}

export async function rasterizeFigure(input) {
  const request = rules.validateFigureRequest(input);
  const start = performance.now();
  const svg = await buildFigureSvg(request);
  const composeMs = performance.now() - start;
  if (Buffer.byteLength(svg) > 64 * 1024 * 1024) throw Error('Figure SVG exceeds 64 MiB');
  let doc;
  try { doc = sceneDocument(svg); }
  catch (error) { if (/node budget/.test(error.message)) throw Error('Figure exceeds the raster node budget'); throw error; }
  const root = doc.documentElement;
  root.setAttribute('width', String(request.width)); root.setAttribute('height', String(request.height)); root.setAttribute('preserveAspectRatio', 'none');
  const validateMs = performance.now() - start - composeMs;
  const font = await fontsFor(svg, doc);
  if (process.env.FLUX_FIGURE_RASTER_TRACE) console.error(JSON.stringify({ rid: request.rid, composeMs, validateMs, fontsMs: performance.now() - start - composeMs - validateMs }));
  prepareSceneImages(root);
  const build = performance.now() - start, rasterStart = performance.now();
  const image = await renderAsync(new XMLSerializer().serializeToString(doc), { fitTo: { mode: 'width', value: request.width }, font, logLevel: 'off' });
  if (image.width !== request.width || image.height !== request.height) throw Error('Invalid figure raster dimensions');
  const png = image.asPng();
  return { png, width: image.width, height: image.height, ms: { build, raster: performance.now() - rasterStart } };
}
