// Shared data-unit field contract for the Inspector, property menu and verbs.
import type { PlotView } from '../types';
import type { FluxPlotManifest } from './types';
import { viewFits } from './project';

export interface PlotViewFields {
  xMin?: number | null; xMax?: number | null;
  yMin?: number | null; yMax?: number | null;
  xScale?: 'linear' | 'log'; yScale?: 'linear' | 'log';
  reset?: boolean;
}
export const AXIS_VIEW_KEYS = { x: 'v', y: 'b' } as const;
export function plotViewPatch(view: PlotView | undefined, manifest: FluxPlotManifest | undefined, fields: PlotViewFields): Partial<PlotView> | null {
  if (fields.reset) {
    if (Object.entries(fields).some(([key, value]) => key !== 'reset' && value !== undefined)) throw new Error('Reset cannot be combined with axis limits or scales.');
    return null;
  }
  if (!manifest?.axes?.length || !manifest.series?.length) throw new Error('This plot has no axes/series to view.');
  if (manifest.axes.some(axes => !viewFits(manifest, undefined, axes.panelId))) throw new Error('This plot needs usable linear or log axes.');
  const patch: Partial<PlotView> = {};
  for (const key of ['x', 'y'] as const) {
    const min = fields[`${key}Min`], max = fields[`${key}Max`], scale = fields[`${key}Scale`];
    if (min === undefined && max === undefined && scale === undefined) continue;
    const defaults = manifest.axes[0][key];
    const axis = { ...view?.[key] };
    if (min !== undefined || max !== undefined) {
      const domain = axis.domain ?? defaults.domain;
      axis.domain = [min === undefined ? domain[0] : min ?? defaults.domain[0], max === undefined ? domain[1] : max ?? defaults.domain[1]];
    }
    if (scale !== undefined) axis.scale = scale;
    patch[key] = axis;
  }
  if (!Object.keys(patch).length) throw new Error('Set an axis limit or scale, or reset the view.');
  const next = { ...view, ...patch };
  if (manifest.axes.some(axes => !viewFits(manifest, next, axes.panelId))) throw new Error('Axis limits must be finite and different; log limits must be positive. This plot needs usable linear or log axes.');
  return patch;
}
