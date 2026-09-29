/** Pure semantic mutations shared by Figure controls, CLI and live commands. */
import type { Id, Project } from '../types';
import type { Model3dElement, ModelFieldOverride } from './types';
import { findColormap } from '../color/collections';
import { statesAtFrame } from './orbit';
export { modelDefaultStates } from './stateDefaults';

export interface ModelFieldPatch { cmap?: string | null; range?: [number, number] | null }
function models(project: Project, ids: readonly Id[]): Model3dElement[] {
  const selected = new Set(ids);
  return project.figures.flatMap(figure => figure.elements.filter(
    (element): element is Model3dElement => selected.has(element.id) && element.type === 'model3d'));
}

/** Null resets the field; null members reset only that setting to its source.
 * Applying a field makes source colors visible, retaining explicit part fills. */
export function validateModelFieldPatch(fieldId: string, patch: ModelFieldPatch | null): void {
  if (!fieldId || fieldId.includes('\0')) throw new Error('A value field id is required');
  if (patch?.cmap != null && !findColormap(patch.cmap)) throw new Error(`Unknown colormap ${patch.cmap}`);
  if (patch?.range != null && (patch.range.length !== 2 || !patch.range.every(Number.isFinite) || patch.range[0] > patch.range[1])) {
    throw new Error('Field minimum and maximum must be finite, with minimum at or below maximum');
  }
}
export function setModelField(project: Project, ids: readonly Id[], fieldId: string, patch: ModelFieldPatch | null): void {
  validateModelFieldPatch(fieldId, patch);
  for (const element of models(project, ids)) {
    const fields: Record<string, ModelFieldOverride> = Object.assign(Object.create(null), element.fields);
    const field: ModelFieldOverride = Object.hasOwn(fields, fieldId) ? { ...fields[fieldId] } : {};
    if (patch === null) delete fields[fieldId];
    else {
      if ('cmap' in patch) { if (patch.cmap == null) delete field.cmap; else field.cmap = patch.cmap.trim(); }
      if ('range' in patch) { if (patch.range == null) delete field.range; else field.range = [...patch.range]; }
      if (Object.keys(field).length) fields[fieldId] = field; else delete fields[fieldId];
    }
    if (Object.keys(fields).length) element.fields = fields; else delete element.fields;
    element.modelColors = 'source';
  }
}

/** Replace the complete named-weight vector. Finite stored weights are unclamped;
 * controls clamp user input to 0–1. Zero weights are stored as absence.
 * Geometry is authoritative for names; validate the whole batch before writing. */
export function setModelStates(project: Project, ids: readonly Id[], states: Record<string, number> | null): void {
  const weights: Record<string, number> = Object.create(null);
  for (const [name, value] of Object.entries(states ?? {})) {
    if (!Number.isFinite(value)) throw new Error(`Shape weight ${name} must be finite`);
    if (value !== 0) weights[name] = value;
  }
  const selected = models(project, ids);
  for (const element of selected) {
    const names = new Set(project.assets.find(asset => asset.id === element.assetId)?.model?.states ?? []);
    for (const name of Object.keys(weights)) if (!names.has(name)) throw new Error(`Unknown shape state ${name} for ${element.name ?? element.id}. ${names.size ? `Known shape states: ${[...names].slice(0, 40).join(', ')}` : 'This model has no shape states'}`);
  }
  for (const element of selected) {
    if (Object.keys(weights).length) element.modelStates = { ...weights }; else delete element.modelStates;
  }
}

export function modelStateWeight(states: Record<string, number> | undefined, name: string): number {
  return states && Object.hasOwn(states, name) ? states[name] : 0;
}

/** Frame zero is the base. Names follow stored GLB target order, never object
 * key order or optional manifest labels. There is no persisted frame property. */
export function setModelFrame(project: Project, ids: readonly Id[], names: readonly string[], frame: number): void {
  if (!Number.isFinite(frame)) throw new Error('Frame must be finite');
  if (new Set(names).size !== names.length) throw new Error('Shape state names must be unique');
  for (const element of models(project, ids)) {
    const stored = project.assets.find(asset => asset.id === element.assetId)?.model?.states ?? [];
    if (stored.length !== names.length || stored.some((name, index) => name !== names[index])) throw new Error('Frame state order must match the stored GLB');
  }
  setModelStates(project, ids, statesAtFrame(names, frame));
}

/** A custom weight combination is not one sequence frame. */
export function modelFrame(states: Record<string, number> | undefined, names: readonly string[]): number | null {
  if (new Set(names).size !== names.length) return null;
  const known = new Set(names);
  for (const [name, value] of Object.entries(states ?? {})) {
    if (!Number.isFinite(value) || value < 0 || value > 1 || (value !== 0 && !known.has(name))) return null;
  }
  const frame = names.reduce((sum, name, index) => sum + modelStateWeight(states, name) * (index + 1), 0);
  const expected = statesAtFrame(names, frame);
  return frame <= names.length && names.every(name => Math.abs(modelStateWeight(states, name) - modelStateWeight(expected, name)) <= 1e-6) ? frame : null;
}
