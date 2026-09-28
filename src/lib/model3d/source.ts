/** Explicit source-update policy. No IO, stores, renderer, or automatic mutation. */
import type { Project } from '../types';
import type { Model3dAsset, Model3dElement, ModelBounds, Scene3dManifest } from './types';
import { buildScene3dPartIndex } from './parts';
import { makeImportedModel3dElement, type Model3dImportResult } from './importData';

export interface ModelSourceFingerprintRequest {
  root: string; sourcePath: string; manifestPath?: string; storedManifestPath?: string;
}
export interface ModelSourceFingerprint {
  sourceSha256: string; manifestHash: string | null; storedManifestHash: string | null;
}
export interface ModelSourceStatus {
  status: 'current' | 'changed' | 'missing' | 'error' | 'frozen' | 'unknown';
  detail?: string; path?: string;
}
export const modelSourceIdentity = (element: Model3dElement) => JSON.stringify([element.assetId, element.source]);
export function modelSourceStatus(element: Model3dElement, receipt: ModelSourceFingerprint): ModelSourceStatus {
  if (element.source?.frozen) return { status: 'frozen' };
  if (!element.source?.sha256) return { status: 'unknown', detail: 'Update once to record the original source version.' };
  return { status: element.source.sha256 !== receipt.sourceSha256 || receipt.manifestHash !== (element.manifestRef?.hash ?? receipt.storedManifestHash) ? 'changed' : 'current' };
}
function partIds(asset: Model3dAsset, manifest?: Scene3dManifest) {
  return new Set(manifest ? Object.keys(buildScene3dPartIndex(manifest)) : asset.model.partNames);
}
/** Bounds-relative framing is retained. Warn for a >25% span change or a center
 * displacement >25% of the old diagonal. Collapsed spans use the old diagonal. */
export function modelBoundsMoved(before: ModelBounds, after: ModelBounds): boolean {
  const spans = before.max.map((v, i) => v - before.min[i]);
  const diagonal = Math.hypot(...spans);
  const center = before.min.map((v, i) => ((after.min[i] + after.max[i]) - (v + before.max[i])) / 2);
  if (diagonal === 0) return JSON.stringify(before) !== JSON.stringify(after);
  return Math.hypot(...center) > diagonal * .25 || spans.some((span, i) => Math.abs(after.max[i] - after.min[i] - span) > (span || diagonal) * .25);
}
export interface ModelSourceTarget { id: string; identity: string }
/** Appends immutable bytes' asset and retargets only captured placements. Call
 * inside one ordinary Figure commit; prior assets remain available to Undo. */
export function applyModelSourceUpdate(project: Project, targets: ModelSourceTarget[], result: Model3dImportResult, root: string,
  oldManifests: Record<string, Scene3dManifest> = {}): string[] {
  if (!targets.length) throw new Error('No 3D model selected for source update');
  const elements = targets.map(target => {
    const element = project.figures.flatMap(f => f.elements).find(e => e.id === target.id);
    if (element?.type !== 'model3d' || modelSourceIdentity(element) !== target.identity) throw new Error('The source update target changed');
    return element;
  });
  if (project.assets.some(a => a.id === result.asset.id)) throw new Error('Source update requires a new immutable asset id');
  const imported = makeImportedModel3dElement(result, { root });
  const nextParts = partIds(result.asset, result.manifest), states = new Set(result.asset.model.states);
  const warnings = [...result.warnings];
  for (const element of elements) {
    const old = project.assets.find(a => a.id === element.assetId && a.kind === 'glb') as Model3dAsset | undefined;
    if (!old) throw new Error('The original 3D asset is missing');
    const removed = [...partIds(old, oldManifests[old.id])].filter(id => !nextParts.has(id) && !id.startsWith('@'));
    if (removed.length) warnings.push(`Parts removed from ${element.name ?? element.id}: ${removed.join(', ')}`);
    if (modelBoundsMoved(old.model.bounds, result.asset.model.bounds)) warnings.push(`Bounds of ${element.name ?? element.id} moved by more than 25%; check the framing.`);
  }
  project.assets.push(structuredClone(result.asset));
  for (const element of elements) {
    element.assetId = result.asset.id;
    if (imported.source) element.source = structuredClone(imported.source); else delete element.source;
    if (imported.manifestRef) element.manifestRef = { ...imported.manifestRef }; else delete element.manifestRef;
    for (const key of ['overrides', 'fields'] as const) if (element[key]) {
      const retained = Object.fromEntries(Object.entries(element[key]!).filter(([id]) => nextParts.has(id)));
      if (Object.keys(retained).length) element[key] = retained; else delete element[key];
    }
    if (element.modelStates) {
      element.modelStates = Object.fromEntries(Object.entries(element.modelStates).filter(([name]) => states.has(name)));
      if (!Object.keys(element.modelStates).length) delete element.modelStates;
    }
  }
  return [...new Set(warnings)];
}
