/** Native static poster resolution. Caller policy is explicit; collect stays cold. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { userDataDir } from './fluxlib';
import { confinedRecoveryPath } from './recovery';
import { projectAssetPath, safeJoin, exists } from './model';
import { renderModelPosterBatch, type PosterBatchOptions, type PosterRequest } from './model3dPosters';
import { collectModel3dSourceBindings } from '../src/lib/model3d/sourceBinding';
import { readScene3dSidecars } from '../src/lib/model3d/persistence';
import { collectModelPosters, model3dSvgContext, staticModelRequest, type StaticModelPosterRequest } from '../src/lib/model3d/static';
import { modelPosterWarning, type PosterSurface } from '../src/lib/model3d/poster';
import type { Asset, Figure } from '../src/lib/types';
import type { Scene3dManifest } from '../src/lib/model3d/types';

export type ModelPosterPolicy = 'project' | 'image' | 'collect';
export interface ModelPosterResolveOptions {
  policy: ModelPosterPolicy;
  surface?: PosterSurface;
  signal?: AbortSignal;
  /** Every saved placement participates in original-source binding. */
  allFigures?: readonly Figure[];
  /** Injectable native batch seam; callers normally use the production worker. */
  renderBatch?: (requests: readonly PosterRequest[], options: PosterBatchOptions) => ReturnType<typeof renderModelPosterBatch>;
}
export const machineModelPosterDir = () => path.join(userDataDir(), 'model3d-posters');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc(bytes: Uint8Array) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; }
/** Worker PNGs are non-interlaced 8-bit images. Validate chunks and scanline extent. */
export function validModelPosterPng(bytes: Buffer, expected: { w: number; h: number }): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return false;
  if (![expected.w, expected.h].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) return false;
  const data: Buffer[] = []; let at = 8, channels = 0, ended = false, first = true, afterData = false;
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at), end = at + 12 + size;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', at + 4, at + 8), content = bytes.subarray(at + 8, at + 8 + size);
    if (crc(bytes.subarray(at + 4, at + 8 + size)) !== bytes.readUInt32BE(at + 8 + size)) return false;
    if (first && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (!first || size !== 13 || content.readUInt32BE(0) !== expected.w || content.readUInt32BE(4) !== expected.h || content[8] !== 8 || content[10] || content[11] || content[12]) return false;
      // Canvas workers emit direct pixels, never indexed palettes. Restrict
      // this cache format rather than accepting an indexed PNG without PLTE.
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[content[9]] ?? 0;
      if (!channels) return false;
    } else if (type === 'IDAT') { if (afterData) return false; data.push(content); }
    else if (type === 'IEND') { if (size || end !== bytes.length) return false; ended = true; break; }
    else { if (!/^[a-z]/.test(type)) return false; if (data.length) afterData = true; }
    first = false; at = end;
  }
  if (!ended || !channels || !data.length) return false;
  const row = expected.w * channels + 1, size = row * expected.h;
  try {
    const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: size });
    if (pixels.length !== size) return false;
    for (let offset = 0; offset < size; offset += row) if (pixels[offset] > 4) return false;
    return true;
  } catch { return false; }
}
/** Bound allocation against the opened regular file, rechecking confinement
 * after open so a delayed provider cannot follow a substituted symlink. */
async function boundedFile(file: string, limit: number, root?: string, signal?: AbortSignal): Promise<Buffer> {
  const resolve = () => root ? projectAssetPath(root, path.relative(root, file)) : fs.realpath(file);
  signal?.throwIfAborted();
  const real = await resolve(), beforePath = await fs.lstat(real);
  if (!beforePath.isFile()) throw new Error('3D input must be a regular file');
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || await resolve() !== real) throw new Error('3D input changed before reading');
    if (before.size > limit) throw new Error(`3D input exceeds ${limit / 1024 / 1024} MiB`);
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw new Error('3D input changed while reading'); offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await resolve() !== real) throw new Error('3D input changed while reading');
    signal?.throwIfAborted(); return bytes;
  } finally { await handle.close(); }
}
async function cached(file: string, size: { w: number; h: number }, root?: string): Promise<Buffer | undefined> {
  try { const bytes = await boundedFile(file, 300 * 1024 * 1024, root); return validModelPosterPng(bytes, size) ? bytes : undefined; } catch { return undefined; }
}
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const label = (request: StaticModelPosterRequest) => request.element.name || request.asset.name || request.element.id;
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();

export async function resolveModelPosters(root: string, figures: readonly Figure[], assets: readonly Asset[], options: ModelPosterResolveOptions) {
  const surface = options.surface ?? 'figure', manifests: Record<string, Scene3dManifest> = {}, warnings: string[] = [], urls: Record<string, string> = {};
  const bindings = collectModel3dSourceBindings((options.allFigures ?? figures).flatMap(figure => figure.elements));
  const used = new Set(figures.flatMap(figure => figure.elements.filter(element => element.type === 'model3d').map(element => element.assetId)));
  const paths = new Map<string, string>();
  if (!used.size) return { context: model3dSvgContext(assets, manifests, surface), urls, warnings, requests: [] as StaticModelPosterRequest[], manifests };
  for (const asset of assets) if (used.has(asset.id) && asset.kind === 'glb') {
    abort(options.signal);
    const modelPath = await projectAssetPath(root, `fig/${asset.path}`);
    if (!await exists(modelPath)) throw new Error(`Missing GLB asset "${asset.name || asset.id}"`);
    paths.set(asset.id, safeJoin(root, `fig/${asset.path}`));
    const metadata = await readScene3dSidecars({ exists: async rel => { const file = safeJoin(root, rel); await confinedRecoveryPath(root, file); return exists(file); }, readText: async rel => {
      return (await boundedFile(safeJoin(root, rel), 4 * 1024 * 1024, root, options.signal)).toString('utf8');
    } }, 'fig/assets', asset.id, { binding: bindings.get(asset.id) });
    if (metadata.manifest) manifests[asset.id] = metadata.manifest;
    warnings.push(...metadata.issues ?? []);
  }
  const context = model3dSvgContext(assets, manifests, surface), allRequests = collectModelPosters(figures, context, surface);
  const requests = [...new Map(allRequests.map(request => [request.key, request])).values()], missing: StaticModelPosterRequest[] = [];
  const projectDir = safeJoin(root, 'fig/renders/model3d'), machineDir = machineModelPosterDir();
  await confinedRecoveryPath(root, projectDir);
  for (const request of requests) {
    abort(options.signal);
    const bytes = await cached(path.join(projectDir, `${request.key}.png`), request, root) ?? await cached(path.join(machineDir, `${request.key}.png`), request);
    if (bytes) urls[request.ref] = url(bytes); else missing.push(request);
  }
  if (options.policy !== 'collect' && missing.length) {
    const outDir = options.policy === 'project' ? projectDir : machineDir;
    const chunks: StaticModelPosterRequest[][] = [], actualSizes = new Map<string, number>(); let chunk: StaticModelPosterRequest[] = [], models = new Set<string>(), totalBytes = 0;
    for (const request of missing) {
      let size = actualSizes.get(request.asset.id);
      try {
        if (!Number.isFinite(request.asset.bytes) || request.asset.bytes <= 0 || request.asset.bytes > 200 * 1024 * 1024) throw new Error('model byte limit prevents poster rendering');
        if (size === undefined) {
          const file = await projectAssetPath(root, `fig/${request.asset.path}`), stat = await fs.stat(file);
          if (!stat.isFile() || stat.size <= 0 || stat.size > 200 * 1024 * 1024) throw new Error('model byte limit prevents poster rendering');
          size = stat.size; actualSizes.set(request.asset.id, size);
        }
      } catch (error) { warnings.push(`3D model "${label(request)}": ${error instanceof Error ? error.message : String(error)}`); continue; }
      const extra = models.has(request.asset.id) ? 0 : size;
      if (chunk.length && (chunk.length === 64 || totalBytes + extra > 1024 * 1024 * 1024)) { chunks.push(chunk); chunk = []; models = new Set(); totalBytes = 0; }
      chunk.push(request); if (!models.has(request.asset.id)) { models.add(request.asset.id); totalBytes += size; }
    }
    if (chunk.length) chunks.push(chunk);
    for (const batch of chunks) {
      abort(options.signal);
      const byId = new Map(batch.map(request => [request.asset.id, request.asset]));
      try {
        await (options.renderBatch ?? renderModelPosterBatch)(batch.map(request => ({ key: request.key, spec: { assetId: request.asset.id, w: request.w, h: request.h, element: request.element, manifest: request.manifest } })), {
          outDir, signal: options.signal, modelBytes: async (id, signal) => {
            abort(options.signal);
            const asset = byId.get(id), file = paths.get(id); if (!asset || !file) throw new Error(`Missing GLB asset ${id}`);
            const bytes = await boundedFile(file, 200 * 1024 * 1024, root, signal ?? options.signal); abort(options.signal);
            if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`3D model "${asset.name || id}" changed since this view was captured`);
            return bytes;
          },
        });
        for (const request of batch) {
          const bytes = await cached(path.join(outDir, `${request.key}.png`), request, options.policy === 'project' ? root : undefined);
          if (bytes) urls[request.ref] = url(bytes);
        }
      } catch (error) {
        abort(options.signal);
        for (const request of batch) warnings.push(`3D model "${label(request)}": ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
  }
  for (const request of allRequests) if (!urls[request.ref]) {
    const stored = staticModelRequest(request.element, request.asset, request.manifest, 'figure');
    const bytes = stored.key === request.key ? undefined : await cached(path.join(projectDir, `${stored.key}.png`), stored, root) ?? await cached(path.join(machineDir, `${stored.key}.png`), stored);
    if (bytes) { urls[request.ref] = url(bytes); warnings.push(`3D model "${label(request)}": using the stored poster because the requested export resolution could not be rendered`); }
    else warnings.push(modelPosterWarning(label(request)));
  }
  abort(options.signal);
  return { context, urls, warnings: [...new Set(warnings)], requests: allRequests, manifests };
}
export type ResolvedModelPosters = Awaited<ReturnType<typeof resolveModelPosters>>;
/** Cold cache signature: new/deleted/corrected posters invalidate Connect pictures. No mkdir/mtime write. */
export async function modelPosterAvailabilitySignature(root: string): Promise<string> {
  const parts: string[] = [];
  const projectDir = safeJoin(root, 'fig/renders/model3d');
  await confinedRecoveryPath(root, projectDir);
  for (const directory of [projectDir, machineModelPosterDir()]) {
    for (const name of (await fs.readdir(directory).catch(() => [])).filter(name => /^m3d-[a-f0-9]{14}\.png$/.test(name)).sort()) {
      const stat = await fs.stat(path.join(directory, name)).catch(() => undefined);
      if (stat) parts.push(`${directory}/${name}:${stat.size}:${stat.mtimeMs}`);
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
