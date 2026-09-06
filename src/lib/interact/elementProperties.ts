import type { Element, Project } from '../types';
import { setBoxDim, setElementStyle, detachOnManualEdit, supportsBoxDim } from '../ops';

export type NumericProperty = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'strokeWidth' | 'fontSize' | 'lineHeight' | 'cornerRadius';
export interface NumericDescriptor {
  label: string; shortLabel: string; key: string; group: string; step: number; min?: number; max?: number;
  read(element: Element): number | undefined;
}
const box = (e: Element, axis: 'width' | 'height') => supportsBoxDim(e.type) && axis in e ? e[axis] : undefined;
export const numericProperties: Record<NumericProperty, NumericDescriptor> = {
  x: { label: 'x position', shortLabel: 'X', key: 'x', group: 'Geometry', step: 1, read: e => e.x },
  y: { label: 'y position', shortLabel: 'Y', key: 'y', group: 'Geometry', step: 1, read: e => e.y },
  width: { label: 'width', shortLabel: 'W', key: 'w', group: 'Geometry', step: 1, min: 1, read: e => box(e, 'width') },
  height: { label: 'height', shortLabel: 'H', key: 'h', group: 'Geometry', step: 1, min: 1, read: e => box(e, 'height') },
  rotation: { label: 'rotation', shortLabel: 'Rotation°', key: 'r', group: 'Geometry', step: 1, read: e => e.rotation },
  opacity: { label: 'opacity', shortLabel: 'Opacity', key: 'o', group: 'Geometry', step: .05, min: 0, max: 1, read: e => e.opacity ?? 1 },
  strokeWidth: { label: 'stroke width', shortLabel: 'Stroke W', key: 'd', group: 'Stroke', step: .5, min: 0, read: e => 'strokeWidth' in e ? e.strokeWidth : undefined },
  fontSize: { label: 'font size (pt)', shortLabel: 'Size (pt)', key: 'e', group: 'Text', step: .5, min: 1, read: e => e.type === 'text' ? e.fontSize * .75 : undefined },
  lineHeight: { label: 'line height', shortLabel: 'Line height', key: 'l', group: 'Text', step: .05, min: .5, read: e => e.type === 'text' ? e.lineHeight ?? 1.2 : undefined },
  cornerRadius: { label: 'corner radius', shortLabel: 'Radius', key: 'u', group: 'Fill', step: 1, min: 0, read: e => e.type === 'rect' || e.type === 'path' ? e.cornerRadius ?? 0 : undefined },
};
export function propertyValue(elements: Element[], property: NumericProperty) {
  const values = elements.map(numericProperties[property].read).filter((v): v is number => v !== undefined);
  return { value: values[0] ?? 0, mixed: values.some(v => v !== values[0]), count: values.length };
}
/** Shared applicability, precision, physical units and named-style detachment. */
export function setNumericProperty(project: Project, element: Element, property: NumericProperty, value: number, base?: { w: number; h: number }) {
  const descriptor = numericProperties[property];
  if (!Number.isFinite(value) || descriptor.read(element) === undefined) return;
  value = Math.max(descriptor.min ?? -Infinity, Math.min(descriptor.max ?? Infinity, value));
  if (property === 'width' || property === 'height') setBoxDim(element, property === 'width' ? 'w' : 'h', value, base);
  else if (property === 'cornerRadius') setElementStyle(project, [element.id], { cornerRadius: value });
  else if (property === 'fontSize' || property === 'lineHeight') {
    if (element.type !== 'text') return;
    element[property] = property === 'fontSize' ? value * 4 / 3 : value;
    detachOnManualEdit(project, element, [property]);
  } else if (property === 'strokeWidth') { if ('strokeWidth' in element) element.strokeWidth = value; }
  else element[property] = value;
}
