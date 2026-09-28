/** Camera/look mutations shared by app controls and headless commands. */
import type { Id, Project } from '../types';
import type { Model3dElement } from './types';
export const MODEL_VIEW_NUMBERS = ['orbitAzimuth', 'orbitElevation', 'orbitRoll', 'orbitZoom', 'orbitPanX', 'orbitPanY', 'orbitFov'] as const;
export type ModelViewNumber = typeof MODEL_VIEW_NUMBERS[number];
export type ModelViewPatch = Partial<Pick<Model3dElement, ModelViewNumber | 'orbitProjection' | 'fill' | 'modelColors' | 'modelLighting'>>;
export function clampModelView(key: ModelViewNumber, value: number): number {
  if (key === 'orbitElevation') return Math.max(-90, Math.min(90, value));
  if (key === 'orbitZoom') return Math.max(.02, Math.min(50, value));
  if (key === 'orbitFov') return Math.max(5, Math.min(120, value));
  return value;
}
export function setModelView(project: Project, ids: readonly Id[], patch: ModelViewPatch): void {
  const selected = new Set(ids);
  for (const figure of project.figures) for (const element of figure.elements) {
    if (element.type !== 'model3d' || !selected.has(element.id)) continue;
    for (const key of MODEL_VIEW_NUMBERS) {
      const value = patch[key];
      if (typeof value === 'number' && Number.isFinite(value)) element[key] = clampModelView(key, value);
    }
    if (patch.orbitProjection === 'orthographic' || patch.orbitProjection === 'perspective') element.orbitProjection = patch.orbitProjection;
    if (patch.modelColors === 'source' || patch.modelColors === 'uniform') element.modelColors = patch.modelColors;
    if (patch.modelLighting === 'studio' || patch.modelLighting === 'unlit') element.modelLighting = patch.modelLighting;
    if (typeof patch.fill === 'string' && patch.fill.trim()) element.fill = patch.fill;
  }
}
