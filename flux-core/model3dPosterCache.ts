/** Native static poster resolution. Caller policy is explicit; collect stays cold. */
import * as fs from 'node:fs/promises';
import { boundedModelFile } from './model3dFile';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { userDataDir } from './fluxlib';
import { confinedRecoveryPath } from './recovery';
import { projectAssetPath, safeJoin, exists, readFigIndex, readCanvasFiles } from './model';
import { normalizeIndexAssets } from '../src/lib/project/figfiles';
import { planPosterBatches, renderModelPosterBatch, type PosterBatchOptions, type PosterRequest } from './model3dPosters';
import { collectModel3dSourceBindings } from '../src/lib/model3d/sourceBinding';
import { readScene3dSidecars } from '../src/lib/model3d/persistence';
import { collectModelPosters, model3dSvgContext, staticModelRequest, type StaticModelPosterRequest } from '../src/lib/model3d/static';
import { modelPosterWarning, type PosterSurface } from '../src/lib/model3d/poster';
import { GLB_LIMITS } from '../src/lib/model3d/glbCore.mjs';
import { missingModelFileMessage } from '../src/lib/project/figureSnapshot';
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
async function cached(file: string, size: { w: number; h: number }, root?: string): Promise<Buffer | undefined> {
  try { const bytes = await boundedModelFile(file, 300 * 1024 * 1024, root); return validModelPosterPng(bytes, size) ? bytes : undefined; } catch { return undefined; }
}
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
/** Metadata-only scene sidecar read, bound to every placement's original receipt. */
async function readModelManifest(root: string, asset: Asset, bindings: ReturnType<typeof collectModel3dSourceBindings>, signal?: AbortSignal): Promise<{ manifest?: Scene3dManifest; issues: string[] }> {
  try {
    const metadata = await readScene3dSidecars({ exists: async rel => { const file = safeJoin(root, rel); await confinedRecoveryPath(root, file); return exists(file); }, readText: async rel => {
      return (await boundedModelFile(safeJoin(root, rel), 4 * 1024 * 1024, root, signal)).toString('utf8');
    } }, 'fig/assets', asset.id, { binding: bindings.get(asset.id) });
    return { manifest: metadata.manifest, issues: metadata.issues ?? [] };
  } catch (error) {
    signal?.throwIfAborted();
    return { issues: [`3D model "${asset.name || asset.id}": scene metadata could not be read; showing the stored mesh. ${error instanceof Error ? error.message : String(error)}`] };
  }
}
const label = (request: StaticModelPosterRequest) => request.element.name || request.asset.name || request.element.id;
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();

export async function resolveModelPosters(root: string, figures: readonly Figure[], assets: readonly Asset[], options: ModelPosterResolveOptions) {
  const surface = options.surface ?? 'figure', manifests: Record<string, Scene3dManifest> = {}, warnings: string[] = [], urls: Record<string, string> = {};
  const bindings = collectModel3dSourceBindings((options.allFigures ?? figures).flatMap(figure => figure.elements));
  const used = new Set(figures.flatMap(figure => figure.elements.filter(element => element.type === 'model3d').map(element => element.assetId)));
  const paths = new Map<string, string>();
  // Project-relative GLB files that are absent. Posters are keyed by the stored
  // asset.sha256, so a missing file still serves cache hits; it only cannot render.
  const missingFiles = new Map<string, string>();
  if (!used.size) return { context: model3dSvgContext(assets, manifests, surface), urls, warnings, requests: [] as StaticModelPosterRequest[], manifests };
  for (const asset of assets) if (used.has(asset.id) && asset.kind === 'glb') {
    abort(options.signal);
    const rel = `fig/${asset.path}`;
    try {
      // Metadata-only presence probe; symlink/escape problems are named per model.
      if (await exists(await projectAssetPath(root, rel))) paths.set(asset.id, safeJoin(root, rel));
      else missingFiles.set(asset.id, rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missingFiles.set(asset.id, rel);
      else warnings.push(`3D model "${asset.name || asset.id}": ${error instanceof Error ? error.message : String(error)}`);
    }
    const metadata = await readModelManifest(root, asset, bindings, options.signal);
    if (metadata.manifest) manifests[asset.id] = metadata.manifest;
    warnings.push(...metadata.issues);
  }
  const context = model3dSvgContext(assets, manifests, surface);
  // One bad placement (missing metadata, unusable box) becomes a placeholder and
  // a named warning; the rest of the figure still renders.
  const allRequests = collectModelPosters(figures, context, surface, { onIssue: (_element, message) => warnings.push(`${message}; showing a placeholder`) });
  const requests = [...new Map(allRequests.map(request => [request.key, request])).values()], missing: StaticModelPosterRequest[] = [];
  const projectDir = safeJoin(root, 'fig/renders/model3d'), machineDir = machineModelPosterDir();
  let projectCache = true;
  try { await confinedRecoveryPath(root, projectDir); }
  catch (error) {
    // Never read or publish through an escaping cache directory; the machine
    // cache and placeholders still serve this request.
    abort(options.signal); projectCache = false;
    warnings.push(`3D poster cache fig/renders/model3d is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const request of requests) {
    abort(options.signal);
    let bytes = projectCache ? await cached(path.join(projectDir, `${request.key}.png`), request, root) : undefined;
    if (!bytes) {
      const machineFile = path.join(machineDir, `${request.key}.png`);
      bytes = await cached(machineFile, request);
      // Least-recently-used bookkeeping for the machine cache prune. Cold
      // collection (Connect) never writes any poster cache, not even times.
      if (bytes && options.policy !== 'collect') { const now = new Date(); await fs.utimes(machineFile, now, now).catch(() => {}); }
    }
    if (bytes) urls[request.ref] = url(bytes); else missing.push(request);
  }
  const renderable = missing.filter(request => paths.has(request.asset.id));
  if (options.policy !== 'collect' && renderable.length && (projectCache || options.policy !== 'project')) {
    const outDir = options.policy === 'project' ? projectDir : machineDir;
    const actualSizes = new Map<string, number>(), sized: StaticModelPosterRequest[] = [];
    for (const request of renderable) {
      try {
        if (!Number.isFinite(request.asset.bytes) || request.asset.bytes <= 0 || request.asset.bytes > GLB_LIMITS.maxBytes) throw new Error('model byte limit prevents poster rendering');
        if (!actualSizes.has(request.asset.id)) {
          const file = await projectAssetPath(root, `fig/${request.asset.path}`), stat = await fs.stat(file);
          if (!stat.isFile() || stat.size <= 0 || stat.size > GLB_LIMITS.maxBytes) throw new Error('model byte limit prevents poster rendering');
          actualSizes.set(request.asset.id, stat.size);
        }
        sized.push(request);
      } catch (error) { warnings.push(`3D model "${label(request)}": ${error instanceof Error ? error.message : String(error)}`); }
    }
    // Actual stat sizes plan sequential worker jobs under the per-page cap.
    const plan = planPosterBatches(sized, request => [request.asset.id], id => actualSizes.get(id) ?? Infinity);
    for (const request of plan.oversized) warnings.push(`3D model "${label(request)}": model byte limit prevents poster rendering`);
    const chunks = plan.batches;
    let publishedToMachine = false;
    for (const batch of chunks) {
      abort(options.signal);
      const byId = new Map(batch.map(request => [request.asset.id, request.asset]));
      try {
        await (options.renderBatch ?? renderModelPosterBatch)(batch.map(request => ({ key: request.key, spec: { assetId: request.asset.id, w: request.w, h: request.h, element: request.element, manifest: request.manifest } })), {
          outDir, ...(options.policy === 'project' ? { publicationRoot: root } : {}), signal: options.signal, modelBytes: async (id, signal) => {
            abort(options.signal);
            const asset = byId.get(id), file = paths.get(id); if (!asset || !file) throw new Error(`Missing GLB asset ${id}`);
            const bytes = await boundedModelFile(file, GLB_LIMITS.maxBytes, root, signal ?? options.signal); abort(options.signal);
            if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`3D model "${asset.name || id}" changed since this view was captured`);
            return bytes;
          },
        });
        for (const request of batch) {
          const bytes = await cached(path.join(outDir, `${request.key}.png`), request, options.policy === 'project' ? root : undefined);
          if (bytes) urls[request.ref] = url(bytes);
        }
        if (options.policy === 'image') publishedToMachine = true;
      } catch (error) {
        abort(options.signal);
        for (const request of batch) warnings.push(`3D model "${label(request)}": ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    // The machine cache only grows through explicit image requests, so it is
    // bounded right there (throttled, best effort, never this request's keys).
    if (publishedToMachine) await pruneMachineModelPostersThrottled(new Set(allRequests.map(request => request.key)));
  }
  const figureOf = new Map(figures.flatMap(figure => figure.elements.map(element => [element.id, figure] as const)));
  for (const request of allRequests) {
    const missingFile = missingFiles.get(request.asset.id);
    if (!urls[request.ref]) {
      const stored = staticModelRequest(request.element, request.asset, request.manifest, 'figure');
      const bytes = stored.key === request.key ? undefined : (projectCache ? await cached(path.join(projectDir, `${stored.key}.png`), stored, root) : undefined) ?? await cached(path.join(machineDir, `${stored.key}.png`), stored);
      if (bytes) { urls[request.ref] = url(bytes); warnings.push(`3D model "${label(request)}": using the stored poster because the requested export resolution could not be rendered`); }
      else if (!missingFile) warnings.push(modelPosterWarning(label(request)));
    }
    if (missingFile) {
      const figure = figureOf.get(request.element.id) ?? { id: '?' };
      warnings.push(`${missingModelFileMessage(missingFile, request.element, figure)} (${urls[request.ref] ? 'showing its cached poster' : 'showing a placeholder'})`);
    }
  }
  abort(options.signal);
  return { context, urls, warnings: [...new Set(warnings)], requests: allRequests, manifests };
}
export type ResolvedModelPosters = Awaited<ReturnType<typeof resolveModelPosters>>;
/** Machine cache bounds: the project-cache age rule plus a size cap. */
export const MACHINE_POSTER_CACHE_LIMITS = Object.freeze({ maxBytes: 1024 * 1024 * 1024, olderThanDays: 14 });
export interface CachedPosterEntry { name: string; size: number; mtimeMs: number }
/** Pure prune plan for the shared machine cache. Entries older than the age
 * rule go first (a cross-project cache has no live set; `protect` holds the
 * keys the current caller uses), then least recently used (mtime is touched on
 * every non-Connect hit) until the cache fits the size cap. */
export function planMachinePosterPrune(entries: readonly CachedPosterEntry[], protect: ReadonlySet<string>, now = Date.now(), limits: { maxBytes: number; olderThanDays: number } = MACHINE_POSTER_CACHE_LIMITS): string[] {
  const valid = entries.filter(entry => /^m3d-[\da-f]{14}\.png$/.test(entry.name) && Number.isFinite(entry.size) && Number.isFinite(entry.mtimeMs));
  const cutoff = now - limits.olderThanDays * 86400_000, removed = new Set<string>();
  for (const entry of valid) if (entry.mtimeMs < cutoff && !protect.has(entry.name.slice(0, -4))) removed.add(entry.name);
  let total = valid.filter(entry => !removed.has(entry.name)).reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of [...valid].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
    if (total <= limits.maxBytes) break;
    if (removed.has(entry.name) || protect.has(entry.name.slice(0, -4))) continue;
    removed.add(entry.name); total -= entry.size;
  }
  return valid.map(entry => entry.name).filter(name => removed.has(name));
}
/** Apply planMachinePosterPrune to `<userData>/model3d-posters`. Only regular
 * m3d-*.png files are candidates; returns the removed names. */
export async function pruneMachineModelPosters(options: { protect?: ReadonlySet<string>; now?: number; limits?: { maxBytes: number; olderThanDays: number } } = {}): Promise<string[]> {
  const dir = machineModelPosterDir(), entries: CachedPosterEntry[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!/^m3d-[\da-f]{14}\.png$/.test(name)) continue;
    const stat = await fs.lstat(path.join(dir, name)).catch(() => undefined);
    if (stat?.isFile()) entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const removed: string[] = [];
  for (const name of planMachinePosterPrune(entries, options.protect ?? new Set(), options.now, options.limits)) {
    try { await fs.rm(path.join(dir, name)); removed.push(name); } catch { /* another process pruned it */ }
  }
  return removed;
}
let lastMachinePrune = 0;
async function pruneMachineModelPostersThrottled(protect: ReadonlySet<string>) {
  if (Date.now() - lastMachinePrune < 10 * 60_000) return;
  lastMachinePrune = Date.now();
  await pruneMachineModelPosters({ protect }).catch(() => {});
}

/** The figure-surface poster keys this project's saved placements use now. */
export async function liveModelPosterKeys(root: string): Promise<string[]> {
  const index = await readFigIndex(root);
  if (!index) return [];
  const figures = Object.values((await readCanvasFiles(root, index)).byId);
  const assets = normalizeIndexAssets(index);
  const used = new Set(figures.flatMap(figure => figure.elements.filter(element => element.type === 'model3d').map(element => element.assetId)));
  if (!used.size) return [];
  const bindings = collectModel3dSourceBindings(figures.flatMap(figure => figure.elements)), manifests: Record<string, Scene3dManifest> = {};
  for (const asset of assets) if (used.has(asset.id) && asset.kind === 'glb') {
    const metadata = await readModelManifest(root, asset, bindings);
    if (metadata.manifest) manifests[asset.id] = metadata.manifest;
  }
  const context = model3dSvgContext(assets, manifests, 'figure');
  return [...new Set(collectModelPosters(figures, context, 'figure', { onIssue: () => {} }).map(request => request.key))].sort();
}
/** Cold cache signature: new/deleted/republished posters of THIS project's live
 * keys invalidate Connect pictures. Scoped to those keys (the machine cache is
 * shared by every project); size + inode identify a publication, so the LRU
 * touch on a cache hit does not invalidate. No mkdir or time write. */
export async function modelPosterAvailabilitySignature(root: string): Promise<string> {
  let keys: string[];
  try { keys = await liveModelPosterKeys(root); }
  catch (error) { return createHash('sha256').update(`unavailable:${error instanceof Error ? error.message : String(error)}`).digest('hex'); }
  const parts: string[] = [];
  const projectDir = safeJoin(root, 'fig/renders/model3d');
  const projectCache = await confinedRecoveryPath(root, projectDir).then(() => true, () => false);
  for (const key of keys) for (const [label, directory] of [['project', projectCache ? projectDir : ''], ['machine', machineModelPosterDir()]] as const) {
    const stat = directory ? await fs.stat(path.join(directory, `${key}.png`)).catch(() => undefined) : undefined;
    parts.push(`${label}:${key}:${stat ? `${stat.size}:${stat.ino || stat.mtimeMs}` : '-'}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
