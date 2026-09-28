/** Figure source status and explicit updates. Watching never imports or mutates. */
import { get, writable } from 'svelte/store';
import { project, projectDir, embeddedProjectRoot, commit } from '../store';
import { storeTenant } from '../tenancy';
import { fileBridge, joinPath, type FileBridge } from '../project/types';
import { storedAssetPath } from '../project/assetPath';
import { scene3dSidecarPaths } from './persistence';
import { linkedSourceFiles, plotSourceCandidates, sourceSidecarCandidates } from '../plot/source';
import { scene3dGeneration, scene3dManifests, cacheScene3dSidecars } from './store';
import { applyModelSourceUpdate, modelSourceIdentity, modelSourceStatus, type ModelSourceStatus } from './source';
import type { Model3dElement } from './types';
import { pushToast, errMsg } from '../toast';
import { finishModelOrbit } from './orbitSession';

export const modelSourceStatuses = writable<Record<string, ModelSourceStatus>>({});
export const modelSourceBusy = writable<Set<string>>(new Set());
const rootNow = () => get(embeddedProjectRoot) ?? get(projectDir);
let request = 0, ownerEpoch = 0, ownerRoot = rootNow();
for (const store of [projectDir, embeddedProjectRoot]) store.subscribe(() => {
  const root = rootNow(); if (root !== ownerRoot) { ownerRoot = root; ownerEpoch++; request++; }
});
/** Captured before recipe IO so leaving and returning to a root stays stale. */
export const modelSourceOwnerEpoch = () => ownerEpoch;
async function firstFile(fb: FileBridge, candidates: string[]) {
  for (const path of candidates) if (await fb.exists(path)) return path;
  return undefined;
}
export async function resolveModelSource(fb: FileBridge, root: string, element: Model3dElement) {
  if (!element.source?.glbPath) throw new Error('This model has no linked source');
  const source = element.source;
  const sourcePath = await firstFile(fb, plotSourceCandidates(root, source.glbPath, source));
  if (!sourcePath) throw new Error(`3D source file missing: ${source.glbPath}`);
  const sidecar = async (kind: 'manifest' | 'recipe') => {
    const candidates = sourceSidecarCandidates(root, source.glbPath, source, sourcePath, kind);
    return await firstFile(fb, candidates) ?? candidates[0];
  };
  return { sourcePath, manifestPath: await sidecar('manifest'), recipePath: await sidecar('recipe') };
}
export async function refreshModelSourceStatuses() {
  const fb = fileBridge(), root = rootNow(), owner = get(project), generation = get(scene3dGeneration), serial = ++request;
  const current = () => serial === request && rootNow() === root && get(project) === owner && get(scene3dGeneration) === generation && storeTenant() === 'figure';
  if (!root || !fb?.model3dSourceFingerprint || storeTenant() !== 'figure') { modelSourceStatuses.set({}); return; }
  if (!get(embeddedProjectRoot)) await (await import('../io')).awaitStandaloneProjectRoot(root);
  await fb.watchSourceFiles?.(root, 'fig', linkedSourceFiles(root, owner));
  const statuses: Record<string, ModelSourceStatus> = {};
  for (const figure of owner.figures) for (const element of figure.elements) {
    if (!current()) return;
    if (element.type !== 'model3d' || !element.source?.glbPath) continue;
    const identity = modelSourceIdentity(element);
    if (element.source.frozen) { statuses[element.id] = { status: 'frozen' }; continue; }
    try {
      const source = await resolveModelSource(fb, root, element);
      const asset = owner.assets.find(a => a.id === element.assetId);
      if (!asset) throw new Error('The saved 3D asset is missing');
      const relative = storedAssetPath(scene3dSidecarPaths(`${get(embeddedProjectRoot) ? 'fig/' : ''}assets`, asset.id).manifest);
      const storedManifestPath = fb.projectAssetPath ? await fb.projectAssetPath(root, relative) : joinPath(root, relative);
      const receipt = await fb.model3dSourceFingerprint({ root, ...source, storedManifestPath });
      if (modelSourceIdentity(element) === identity) statuses[element.id] = { ...modelSourceStatus(element, receipt), path: source.sourcePath };
    } catch (error) {
      statuses[element.id] = { status: /missing|ENOENT/i.test(errMsg(error)) ? 'missing' : 'error', detail: errMsg(error) };
    }
  }
  if (current()) modelSourceStatuses.set(statuses);
}
/** Mounted by the Figure rail. Native stat gating avoids repeat binary hashing;
 * idle debounce keeps source IO off pointer, typing and camera paths. */
export function watchModelSources() {
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; if (!stopped) void refreshModelSourceStatuses().catch(() => {}); }, 300); };
  const offs = [project.subscribe(schedule), projectDir.subscribe(schedule), embeddedProjectRoot.subscribe(schedule), scene3dGeneration.subscribe(schedule)];
  const offFs = fileBridge()?.onFsChanged?.(info => { if (info.subsystem === 'plots' || info.subsystem === 'fig') schedule(); });
  return () => { stopped = true; request++; if (timer) clearTimeout(timer); offs.forEach(off => off()); offFs?.(); modelSourceStatuses.set({}); };
}
/** One explicit update; no watcher may call this function. Source identity is
 * captured before IO, while unrelated placement/view edits remain live. */
export async function updateModelFromSource(id: string, options: { sourcePath?: string; manifestPath?: string; recipePath?: string; isCurrent?: () => boolean } = {}) {
  const fb = fileBridge(), root = rootNow(), owner = get(project), generation = get(scene3dGeneration), epoch = ownerEpoch;
  if (!root || !fb?.importModel3d || !fb.adoptModel3d || !fb.discardModel3d || storeTenant() !== 'figure') throw new Error('Open and save the figure before updating its 3D source');
  const element = owner.figures.flatMap(f => f.elements).find((e): e is Model3dElement => e.id === id && e.type === 'model3d');
  if (!element) throw new Error('The 3D model was removed');
  if (element.source?.frozen) throw new Error('This model has a frozen source');
  if (get(modelSourceBusy).has(id)) throw new Error('This source update is already running');
  const identity = modelSourceIdentity(element);
  const current = () => ownerEpoch === epoch && rootNow() === root && get(project) === owner && get(scene3dGeneration) === generation && storeTenant() === 'figure' && (!options.isCurrent || options.isCurrent()) && owner.figures.some(f => f.elements.some(e => e.type === 'model3d' && e.id === id && modelSourceIdentity(e) === identity));
  const assertCurrent = () => { if (!current()) throw new Error('The source update target changed'); };
  modelSourceBusy.update(ids => new Set(ids).add(id));
  let result: Awaited<ReturnType<NonNullable<FileBridge['importModel3d']>>> | undefined, installed = false;
  try {
    if (!get(embeddedProjectRoot)) await (await import('../io')).awaitStandaloneProjectRoot(root);
    await fb.watchSourceFiles?.(root, 'fig', linkedSourceFiles(root, owner));
    const source = options.sourcePath ? { sourcePath: options.sourcePath, manifestPath: options.manifestPath, recipePath: options.recipePath } : await resolveModelSource(fb, root, element);
    assertCurrent();
    result = await fb.importModel3d({ root, ...source, target: { kind: 'figure' } }); assertCurrent();
    if (result.assetPrefix !== (get(embeddedProjectRoot) ? 'fig' : '')) throw new Error('The source storage destination changed');
    finishModelOrbit(); assertCurrent();
    let warnings: string[] = [];
    commit(p => { warnings = applyModelSourceUpdate(p, [{ id, identity }], result!, root, get(scene3dManifests)); });
    installed = true;
    cacheScene3dSidecars(result.asset.id, { manifest: result.manifest, recipe: result.recipe, raw: result.raw, issues: result.warnings });
    // Installation is synchronous; adopting consumes native cleanup authority,
    // even if a late generation rejection retains safe unreferenced bytes.
    await fb.adoptModel3d({ root, assetId: result.asset.id, receipt: result.receipt, target: { kind: 'figure' } });
    if (warnings.length) pushToast('info', '3D source updated with notes', { detail: warnings.join('\n') });
    await refreshModelSourceStatuses();
    return { assetId: result.asset.id, warnings };
  } finally {
    try { if (result && !installed) await fb.discardModel3d({ root, assetId: result.asset.id, receipt: result.receipt, target: { kind: 'figure' } }); }
    finally { modelSourceBusy.update(ids => { const next = new Set(ids); next.delete(id); return next; }); }
  }
}
