/** Pure compatibility shared by authoring, compilation and both players. */
import type { Asset, Element } from '../types';
import { morphCompatible, morphFixHint, type MorphCompatibility } from '../model3d/morphPair';

export interface ModelAssetLookup {
  modelAsset?: (id: string) => Asset | undefined;
  assets?: readonly Asset[];
}

export function modelPair(a: Element | undefined, b: Element | undefined, lookup: ModelAssetLookup): MorphCompatibility | undefined {
  if (a?.type !== 'model3d' || b?.type !== 'model3d') return undefined;
  const find = (id: string) => lookup.modelAsset?.(id) ?? lookup.assets?.find(asset => asset.id === id);
  const A = find(a.assetId), B = find(b.assetId);
  if (A?.kind !== 'glb' || !A.model || B?.kind !== 'glb' || !B.model)
    return { ok: false, pairs: [], reason: 'Topology metadata is unavailable' };
  return morphCompatible(A.model, B.model);
}

export function modelPairIssue(pair: MorphCompatibility): string | undefined {
  return pair.ok ? undefined : `3D models crossfade: ${pair.reason}. ${morphFixHint}`;
}

/** The compile diagnostic for a model pair, or none. Only a pair that could not
 * be evaluated (no topology metadata on a side) is an issue: an evaluated
 * incompatible pair is a designed crossfade, which the Inspector badge explains,
 * and a warning the author can never clear is noise (owner policy). */
export function modelPairDiagnostic(a: Element | undefined, b: Element | undefined, lookup: ModelAssetLookup): string | undefined {
  if (a?.type !== 'model3d' || b?.type !== 'model3d') return undefined;
  const evaluable = (id: string) => {
    const asset = lookup.modelAsset?.(id) ?? lookup.assets?.find(entry => entry.id === id);
    return asset?.kind === 'glb' && !!asset.model?.topology?.parts?.length;
  };
  if (evaluable(a.assetId) && evaluable(b.assetId)) return undefined;
  const pair = modelPair(a, b, lookup);
  return pair && modelPairIssue(pair);
}

/** Video remains ineligible for ordinary Become/consume. Its stored poster can
 * take part in the specifically supported whole-model raster hand-off. */
export function modelVideoHandoff(a: Element | undefined, b: Element | undefined): boolean {
  return a?.type === 'model3d' && b?.type === 'video' || a?.type === 'video' && b?.type === 'model3d';
}

export function modelBecomeResult(a: Element | undefined, b: Element | undefined, lookup: ModelAssetLookup): { morph?: boolean; reason?: string } {
  if (a?.type !== 'model3d' && b?.type !== 'model3d') return {};
  const pair = modelPair(a, b, lookup);
  return pair ? { morph: pair.ok, ...(!pair.ok ? { reason: pair.reason } : {}) }
    : { morph: false, reason: 'Different element kinds use a bitmap crossfade' };
}
