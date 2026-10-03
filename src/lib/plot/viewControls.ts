// Shared data-unit field contract for the Inspector, property menu and verbs.
import { PLOT_AXIS_KEYS, type PlotView, type PlotAxisKey } from '../types';
import type { FluxPlotManifest } from './types';
import { viewFits, usableAxis } from './project';

export interface PlotViewFields {
  xMin?: number | null; xMax?: number | null;
  yMin?: number | null; yMax?: number | null;
  xScale?: 'linear' | 'log'; yScale?: 'linear' | 'log';
  /** A twin value axis (fluxplot axes[].y2 / .x2), when the plot has one. */
  y2Min?: number | null; y2Max?: number | null; y2Scale?: 'linear' | 'log';
  x2Min?: number | null; x2Max?: number | null; x2Scale?: 'linear' | 'log';
  reset?: boolean;
}
export const AXIS_VIEW_KEYS = { x: 'v', y: 'b' } as const;
/** The view keys a manifest's first panel offers: its own axes and the twins it can project
 *  (a secondary axis on a functional scale has no anchors of its own and is not viewable — it
 *  follows its parent). */
export function plotAxisKeys(manifest: FluxPlotManifest | undefined): PlotAxisKey[] {
  const first = manifest?.axes?.[0] as unknown as Record<string, Parameters<typeof usableAxis>[0] | undefined> | undefined;
  return PLOT_AXIS_KEYS.filter((k) => k === 'x' || k === 'y' ? !!first?.[k] : !!first?.[k] && usableAxis(first[k]!));
}
export function plotViewPatch(view: PlotView | undefined, manifest: FluxPlotManifest | undefined, fields: PlotViewFields): Partial<PlotView> | null {
  if (fields.reset) {
    if (Object.entries(fields).some(([key, value]) => key !== 'reset' && value !== undefined)) throw new Error('Reset cannot be combined with axis limits or scales.');
    return null;
  }
  if (!manifest?.axes?.length || !manifest.series?.length) throw new Error('This plot has no axes/series to view.');
  if (manifest.axes.some(axes => !viewFits(manifest, undefined, axes.panelId))) throw new Error('This plot needs usable linear or log axes.');
  const patch: Partial<PlotView> = {};
  for (const key of PLOT_AXIS_KEYS) {
    const min = fields[`${key}Min`], max = fields[`${key}Max`], scale = fields[`${key}Scale`];
    if (min === undefined && max === undefined && scale === undefined) continue;
    const defaults = (manifest.axes[0] as unknown as Record<string, FluxPlotManifest['axes'][number]['x'] | undefined>)[key];
    if (!defaults) throw new Error(`This plot has no ${key} axis.`);
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
