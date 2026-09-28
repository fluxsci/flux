/** Figure-only orchestration; native import owns binary preparation/publication. */
import { get } from 'svelte/store';
import { project, activeFigureId, embeddedProjectRoot, projectDir } from '../store';
import { storeTenant, storeTenantState } from '../tenancy';
import { fileBridge, type FileBridge } from '../project/types';
import { pushToast, errMsg } from '../toast';
import { cacheScene3dSidecars } from './store';
import { makeImportedModel3dElement, type Model3dImportRequest, type Model3dImportResult, type Model3dImportOwnership } from './importData';
import type { Incoming } from '../io';
import { trackModel3dImport } from './importProgress';
interface ImportBridge extends FileBridge {
  importModel3d?: (request: Model3dImportRequest) => Promise<Model3dImportResult>;
  importDroppedModel3d?: (file: File, request: Omit<Model3dImportRequest, 'sourcePath'>) => Promise<Model3dImportResult>;
  adoptModel3d?: (request: Model3dImportOwnership) => Promise<void>;
  discardModel3d?: (request: Model3dImportOwnership) => Promise<void>;
}
export function model3dImportRoot() { return get(embeddedProjectRoot) ?? get(projectDir); }
export async function ensureModel3dImportRoot() {
  if (storeTenant() !== 'figure') throw new Error('3D models can currently be imported into figures.');
  const owner = get(project), figure = get(activeFigureId);
  let root = model3dImportRoot();
  if (root) {
    if (!get(embeddedProjectRoot)) await (await import('../io')).awaitStandaloneProjectRoot(root);
    if (model3dImportRoot() !== root || get(project) !== owner || get(activeFigureId) !== figure || storeTenant() !== 'figure') throw new Error('The insertion destination changed');
    return root;
  }
  pushToast('info', 'Save this figure project before importing a 3D model');
  await (await import('../io')).saveProjectAs();
  root = model3dImportRoot();
  if (!root) throw new DOMException('3D import cancelled: no project location was selected', 'AbortError');
  if (get(project) !== owner || get(activeFigureId) !== figure || storeTenant() !== 'figure') throw new Error('The insertion destination changed');
  return root;
}
async function incoming(source: string | File, targetFigure?: string): Promise<Incoming> {
  const root = await ensureModel3dImportRoot(), owner = get(project), figureId = get(activeFigureId), bridge = fileBridge() as ImportBridge | null;
  if (!bridge?.importModel3d || !bridge.discardModel3d || !bridge.adoptModel3d) throw new Error('3D import requires an updated Flux desktop app.');
  const targetId = targetFigure ?? figureId;
  const current = () => model3dImportRoot() === root && get(project) === owner && get(activeFigureId) === figureId && storeTenant() === 'figure' && owner.figures.some(f => f.id === targetId);
  const finishProgress = trackModel3dImport(typeof source === 'string' ? source.split(/[\\/]/).pop()! : source.name, current,
    [project, activeFigureId, embeddedProjectRoot, projectDir, storeTenantState]);
  let result: Model3dImportResult;
  try {
    result = typeof source === 'string'
      ? await bridge.importModel3d({ root, sourcePath: source, target: { kind: 'figure' } })
      : await (bridge.importDroppedModel3d ? bridge.importDroppedModel3d(source, { root, target: { kind: 'figure' } }) : Promise.reject(new Error('Dropped 3D files require the Flux desktop app.')));
  } finally { finishProgress(); }
  const receipt: Model3dImportOwnership = { root, assetId: result.asset.id, receipt: result.receipt, target: { kind: 'figure' } };
  let adopted = false, discarded = false;
  const discard = async () => { if (adopted || discarded) return; discarded = true; await bridge.discardModel3d!(receipt); };
  try {
    if (!current()) throw new Error('The insertion destination changed');
    if (result.assetPrefix !== (get(embeddedProjectRoot) ? 'fig' : '')) throw new Error('The 3D import storage location does not match this editor');
    const element = makeImportedModel3dElement(result, { root, figureWidth: owner.figures.find(f => f.id === targetId)?.width });
    return { asset: result.asset, el: element, canInstall: current, discard, install() {
      if (!current()) throw new Error('The insertion destination changed');
      cacheScene3dSidecars(result.asset.id, { manifest: result.manifest, recipe: result.recipe, raw: result.raw, issues: result.warnings });
      adopted = true;
      void bridge.adoptModel3d!(receipt).catch(error => pushToast('error', '3D import ownership could not be confirmed', { detail: errMsg(error) }));
      if (result.warnings.length) pushToast('info', '3D model imported with notes', { detail: result.warnings.join('\n') });
    } };
  } catch (error) { await discard(); throw error; }
}
export const readIncomingModel3d = (path: string) => incoming(path);
export const readDroppedModel3d = (file: File, figureId?: string) => incoming(file, figureId);
