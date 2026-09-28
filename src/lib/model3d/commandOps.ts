/** Validated command policy shared by live and file-backed agent mutations. */
import type { Project } from '../types';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';
import { axisView, homeView, type AxisView } from './orbit';
import { setModelView, type ModelViewPatch } from './viewOps';
import { setModelStates, setModelFrame, setModelField, validateModelFieldPatch } from './semanticOps';
import { scene3dFields } from './scene3d';
import { buildScene3dPartIndex } from './parts';

export const MODEL_VIEW_PRESETS = ['front', 'back', 'right', 'left', 'top', 'bottom', 'home'] as const;
export interface ModelViewCommand {
  azimuth?: number; elevation?: number; roll?: number; zoom?: number; panX?: number; panY?: number; fov?: number;
  projection?: 'orthographic' | 'perspective'; color?: string; colors?: 'source' | 'uniform'; lighting?: 'studio' | 'unlit';
  preset?: typeof MODEL_VIEW_PRESETS[number]; states?: Record<string, number>; frame?: number;
}
export interface ModelFieldCommand { field: string; cmap?: string; min?: number; max?: number; reset?: boolean }
const numbers = { azimuth: 'orbitAzimuth', elevation: 'orbitElevation', roll: 'orbitRoll', zoom: 'orbitZoom', panX: 'orbitPanX', panY: 'orbitPanY', fov: 'orbitFov' } as const;

export function commandModels(project: Project, ids: readonly string[]): Model3dElement[] {
  if (!ids.length) throw new Error('Select a 3D model or pass its target element id');
  const byId = new Map(project.figures.flatMap(figure => figure.elements).map(element => [element.id, element]));
  return [...new Set(ids)].map(id => {
    const element = byId.get(id);
    if (element?.type !== 'model3d') throw new Error(`3D model not found: ${id}`);
    if (!project.assets.some(asset => asset.id === element.assetId && asset.kind === 'glb' && asset.model)) throw new Error(`3D model asset not found: ${element.assetId}`);
    return element;
  });
}

export function validateModelViewCommand(command: ModelViewCommand): void {
  for (const key of Object.keys(numbers) as Array<keyof typeof numbers>) if (command[key] !== undefined && (typeof command[key] !== 'number' || !Number.isFinite(command[key]))) throw new Error(`${key} must be finite`);
  for (const [key, choices] of Object.entries({ projection: ['orthographic', 'perspective'], colors: ['source', 'uniform'], lighting: ['studio', 'unlit'], preset: MODEL_VIEW_PRESETS })) {
    const value = command[key as keyof ModelViewCommand];
    if (value !== undefined && !choices.includes(value as never)) throw new Error(`Invalid 3D ${key}: ${String(value)}`);
  }
  if (command.color !== undefined && (typeof command.color !== 'string' || !command.color.trim())) throw new Error('3D color must be a nonempty string');
  if (command.frame !== undefined && (typeof command.frame !== 'number' || !Number.isFinite(command.frame))) throw new Error('Frame must be finite');
  if (command.states !== undefined) {
    if (!command.states || typeof command.states !== 'object' || Array.isArray(command.states)) throw new Error('states must map shape names to finite weights');
    for (const [name, weight] of Object.entries(command.states)) if (!name || !Number.isFinite(weight)) throw new Error(`Shape weight ${name} must be finite`);
  }
  if (command.states !== undefined && command.frame !== undefined) throw new Error('Use states or frame, not both');
}

/** Preset first, then explicit values. Named weights patch existing weights;
 * zero removes one state. Home restores the source defaults before the patch. */
export function applyModelViewCommand(project: Project, ids: readonly string[], command: ModelViewCommand, manifests: Record<string, Scene3dManifest> = {}): void {
  validateModelViewCommand(command);
  const selected = commandModels(project, ids);
  const updates = selected.map(element => {
    const asset = project.assets.find(asset => asset.id === element.assetId) as Model3dAsset;
    const manifest = manifests[element.assetId];
    const home = command.preset === 'home' ? homeView(asset, manifest) : undefined;
    const patch: ModelViewPatch = home ? { ...home } : command.preset ? axisView(command.preset as AxisView, element.orbitAzimuth) : {};
    for (const key of Object.keys(numbers) as Array<keyof typeof numbers>) if (command[key] !== undefined) patch[numbers[key]] = command[key];
    if (command.projection !== undefined) patch.orbitProjection = command.projection;
    if (command.color !== undefined) patch.fill = command.color;
    if (command.colors !== undefined) patch.modelColors = command.colors;
    if (command.lighting !== undefined) patch.modelLighting = command.lighting;
    const states = home || command.states ? { ...(home ? home.modelStates : element.modelStates), ...command.states } : undefined;
    if (states) for (const [name, value] of Object.entries(states)) if (value !== 0 && !asset.model.states.includes(name)) throw new Error(`Unknown shape state ${name} for ${element.name ?? element.id}`);
    if (command.frame !== undefined && !manifest?.sequence) throw new Error(`Frame requires a sequence model: ${element.name ?? element.id}`);
    return { element, asset, patch, states };
  });
  for (const { element, asset, patch, states } of updates) {
    setModelView(project, [element.id], patch);
    if (states) setModelStates(project, [element.id], states);
    if (command.frame !== undefined) setModelFrame(project, [element.id], asset.model.states, command.frame);
  }
}

export function validateModelFieldCommand(command: ModelFieldCommand): void {
  if (!command.field || typeof command.field !== 'string') throw new Error('A value field id is required');
  if (command.reset !== undefined && typeof command.reset !== 'boolean') throw new Error('reset must be boolean');
  if (command.reset && [command.cmap, command.min, command.max].some(value => value !== undefined)) throw new Error('Field reset cannot be combined with cmap/min/max');
  for (const key of ['min', 'max'] as const) if (command[key] !== undefined && (typeof command[key] !== 'number' || !Number.isFinite(command[key]))) throw new Error(`Field ${key} must be finite`);
  validateModelFieldPatch(command.field, command.reset ? null : { ...(command.cmap !== undefined ? { cmap: command.cmap } : {}) });
}
export function applyModelFieldCommand(project: Project, ids: readonly string[], command: ModelFieldCommand, manifests: Record<string, Scene3dManifest> = {}): void {
  validateModelFieldCommand(command);
  const updates = commandModels(project, ids).map(element => {
    const fields = scene3dFields(manifests[element.assetId]);
    const field = Object.hasOwn(fields, command.field) ? fields[command.field] : undefined;
    if (!field) throw new Error(`Unknown value field ${command.field} on ${element.name ?? element.id}`);
    const existing = Object.hasOwn(element.fields ?? {}, command.field) ? element.fields![command.field] : undefined;
    const current = existing?.range ?? field.range;
    const range: [number, number] | undefined = command.min !== undefined || command.max !== undefined ? [command.min ?? current[0], command.max ?? current[1]] : undefined;
    if (range && range[0] > range[1]) throw new Error('Field minimum must be at or below maximum');
    const patch = command.reset ? null : { ...(command.cmap !== undefined ? { cmap: command.cmap } : {}), ...(range ? { range } : {}) };
    validateModelFieldPatch(command.field, patch);
    return { element, patch };
  });
  for (const { element, patch } of updates) setModelField(project, [element.id], command.field, patch);
}

export function assertModelPart(element: Model3dElement, asset: Model3dAsset, manifest: Scene3dManifest | undefined, partId: string): void {
  const ids = manifest ? Object.keys(buildScene3dPartIndex(manifest)) : asset.model.partNames;
  if (!ids.includes(partId)) throw new Error(`Unknown part "${partId}" on ${element.name ?? element.id}. Known parts: ${ids.slice(0, 40).join(', ')}`);
}
