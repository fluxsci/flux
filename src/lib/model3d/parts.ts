/** Effective semantic hierarchy. Authored sidecars remain untouched. IDs with
 * `@` cannot collide with contract-valid source IDs (lowercase dotted tokens). */
import type { Scene3dManifest, Scene3dPart } from './types';

export interface IndexedScene3dPart extends Scene3dPart {
  kind: 'mesh' | 'field' | 'missing' | 'furniture';
  synthetic?: boolean;
}
export type Scene3dPartIndex = Record<string, IndexedScene3dPart>;
export const scene3dSeriesId = (series: string) => `@series:${series}`;
export const scene3dAxesId = (axis?: string) => axis ? `@axes:${axis}` : '@axes';
export const scene3dFieldId = (field: string) => `@field:${field}`;

export function buildScene3dPartIndex(manifest: Scene3dManifest): Scene3dPartIndex {
  const index: Scene3dPartIndex = Object.create(null);
  for (const part of manifest.parts ?? []) {
    if (part.id.startsWith('@')) throw new Error(`Reserved 3D part id ${part.id}`);
    index[part.id] = { ...part, kind: part.kind ?? (part.node ? typeof part.field === 'object' ? 'field' : part.id.endsWith('.missing') ? 'missing' : 'mesh' : 'furniture') };
  }
  const group = (id: string, label: string, role: string, parent?: string) => {
    index[id] ??= { id, label, role, kind: 'furniture', synthetic: true, ...(parent ? { parent } : {}) };
    return id;
  };
  const series = (name: string) => group(scene3dSeriesId(name), name, 'series');
  const axes = (axis: string) => group(scene3dAxesId(axis), `${axis.toUpperCase()} axis`, 'axis-group', group(scene3dAxesId(), 'Axes', 'axes-group'));
  // Group missing-value and colorbar furniture alongside their field mesh. The
  // actual field remains individually addressable for a mesh-only fill/hide.
  for (const part of Object.values(index)) if (typeof part.field === 'object' && !part.parent) {
    part.parent = group(scene3dFieldId(part.id), part.field.label ?? part.label ?? part.id, 'field-group', part.series ? series(part.series) : undefined);
  }
  for (const part of Object.values(index)) {
    if (part.synthetic || part.parent) continue;
    const field = typeof part.field === 'string' ? index[part.field] : undefined;
    if (field && field.parent === scene3dFieldId(field.id)) part.parent = field.parent;
    else if (!part.node && /^axes\.[xyz]\./.test(part.id)) part.parent = axes(part.id.split('.')[1]);
    else if (part.series) part.parent = series(part.series);
  }
  return index;
}

/** Parent-first order and leaf membership are exposed for X-ray, P4 targets and
 * headless semantic tools. A malformed unvalidated cycle is bounded/refused. */
export function scene3dPartLineage(index: Scene3dPartIndex, id: string): IndexedScene3dPart[] {
  const out: IndexedScene3dPart[] = [], seen = new Set<string>();
  let part = Object.hasOwn(index,id) ? index[id] : undefined;
  while (part) {
    if (seen.has(part.id)) throw new Error(`Cyclic 3D part parents at ${part.id}`);
    seen.add(part.id); out.push(part); part = part.parent && Object.hasOwn(index,part.parent) ? index[part.parent] : undefined;
  }
  return out.reverse();
}
export function scene3dPartTargets(index: Scene3dPartIndex, id: string): string[] {
  return scene3dTargetResolver(index)(id);
}
/** Reuse the child table when resolving a selection or many animation rows. */
export function scene3dTargetResolver(index: Scene3dPartIndex): (id: string) => string[] {
  const children = new Map<string, string[]>();
  for (const part of Object.values(index)) if (part.parent) {
    const siblings = children.get(part.parent);
    if (siblings) siblings.push(part.id); else children.set(part.parent, [part.id]);
  }
  return id => {
    if (!Object.hasOwn(index,id)) return [id];
    const out: string[] = [], queue = [id], seen = new Set<string>();
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) throw new Error(`Cyclic 3D part parents at ${current}`);
      seen.add(current); const part = index[current], nested = children.get(current);
      if (!part.synthetic && (part.node || !nested?.length)) out.push(current);
      if (nested) for (let i=nested.length-1;i>=0;i--) queue.push(nested[i]);
    }
    return out;
  };
}
