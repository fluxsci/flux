/** Source previews are read-only and use the opener's worker, including pinned galleries. */
import { fileBridge } from '../project/types';
import { bytesToDataUrl } from '../assets';
import { appModel3dService, model3dAppScope } from './posterStore';
import { GLB_LIMITS } from './glbCore.mjs';
import { parseModel3dImportMetadata, sha256ModelBytes, makeImportedModel3dElement } from './importData';
import { furnitureLayout } from './furnitureLayout';
import { furnitureSvg } from './furniture';
import { orbitPose } from './orbit';
import { framingBounds } from './framing';
import type { Model3dAsset } from './types';
const cache = new Map<string, { url: string; semantic: boolean; warnings: string[] }>();
export async function model3dGalleryPreview(path: string, edge = 256, signal?: AbortSignal) {
  const fb = fileBridge(); if (!fb) throw new Error('No file bridge');
  const check = () => { if (signal?.aborted) throw new DOMException('Preview closed', 'AbortError'); };
  const stat = await fb.stat?.(path); check();
  if (stat && stat.size > GLB_LIMITS.maxBytes) throw new Error(`3D mesh exceeds ${GLB_LIMITS.maxBytes} bytes; export with max_faces`);
  const manifestStat = await fb.stat?.(path.replace(/\.glb$/i, '.fluxplot.json')); check();
  const key = `${model3dAppScope()}\0${path}\0${stat?.mtimeMs ?? ''}\0${stat?.size ?? ''}\0${manifestStat?.mtimeMs ?? ''}\0${manifestStat?.size ?? ''}\0${edge}`;
  const hit = cache.get(key); if (hit) return hit;
  const active = await appModel3dService(); check();
  const bytes = await fb.readFile(path); check();
  if (bytes.byteLength > GLB_LIMITS.maxBytes) throw new Error('3D preview is over the size limit; export with max_faces');
  if (!active.isCurrent()) throw new DOMException('Project changed', 'AbortError');
  const sha = await sha256ModelBytes(bytes); check();
  const id = `preview:${sha}:${path}`;
  let held = true;
  const release = () => { if (held) { held = false; active.service.release(id); } };
  const abort = () => release();
  // retain increments synchronously, so an abort during parse can release it.
  const ready = active.service.retain({ id, bytes });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const info = await ready; check();
    const sidecar = async (suffix: string) => {
      const sibling = path.replace(/\.glb$/i, suffix);
      try {
        if (!await fb.exists(sibling)) return undefined;
        const bounded = await fb.readTextBounded?.(sibling, 4 * 1024 * 1024 + 1);
        return bounded ? bounded.text : await fb.readText(sibling);
      } catch { return undefined; }
    };
    const [manifestText, recipeText] = await Promise.all([sidecar('.fluxplot.json'), sidecar('.recipe.json')]); check();
    const metadata = await parseModel3dImportMetadata({ info, sourceSha256: sha, manifestText, recipeText }); check();
    const asset: Model3dAsset = { id, kind: 'glb', path, name: path.split(/[\\/]/).pop() ?? '3D model', sha256: sha, bytes: bytes.byteLength, model: info, naturalWidth: 336, naturalHeight: 252 };
    const element = makeImportedModel3dElement({ ...metadata, asset, sourceSha256: sha });
    const layout = furnitureLayout(metadata.manifest, element, element.overrides), scale = edge / Math.max(element.width, element.height);
    const w = Math.max(1, Math.round(layout.viewport.width * scale)), h = Math.max(1, Math.round(layout.viewport.height * scale));
    const blob = await active.service.renderPng({ assetId: id, w, h, element, manifest: metadata.manifest }, { lane: 'idle', key: `gallery:${key}`, signal }); check();
    if (!active.isCurrent()) throw new DOMException('Project changed', 'AbortError');
    const mesh = bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), 'image/png');
    const furniture = furnitureSvg(metadata.manifest, element, orbitPose(element, framingBounds(info.bounds, metadata.manifest), layout.viewport), layout);
    const viewport = layout.viewport;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(element.width * scale)}" height="${Math.round(element.height * scale)}" viewBox="0 0 ${element.width} ${element.height}">${furniture.under}<image x="${viewport.x}" y="${viewport.y}" width="${viewport.width}" height="${viewport.height}" preserveAspectRatio="none" href="${mesh}"/>${furniture.over}</svg>`;
    const result = { url: bytesToDataUrl(new TextEncoder().encode(svg), 'image/svg+xml'), semantic: !!metadata.manifest, warnings: metadata.warnings };
    check(); cache.set(key, result);
    let used = [...cache.values()].reduce((sum, value) => sum + value.url.length * 2, 0);
    for (const [id, value] of cache) { if (cache.size <= 80 && used <= 32 * 1024 * 1024) break; cache.delete(id); used -= value.url.length * 2; }
    return result;
  } finally { signal?.removeEventListener('abort', abort); release(); }
}
