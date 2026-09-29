import { writable } from 'svelte/store';
import { selection, partSelection } from '../store';
import { inspectorHidden } from '../settings';

export const axisViewFocus = writable<{ elementId: string; axis: 'x' | 'y' } | null>(null);
export function focusAxisView(elementId: string, axis: 'x' | 'y') {
  selection.set(new Set([elementId]));
  partSelection.set(null);
  inspectorHidden.set(false);
  axisViewFocus.set({ elementId, axis });
}
